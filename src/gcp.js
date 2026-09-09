import * as core from "@actions/core";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";
import {v2} from "@google-cloud/run"
import {PARAM_TYPES} from "./ecs-config";
import {isAborted, retryTransient} from "./grpc-retry";

const {ServicesClient, JobsClient, ExecutionsClient} = v2

export const DEFAULT_REGION = "us-central1"

export function gcrRegistry(project, projectName, region = DEFAULT_REGION) {
    return `${region}-docker.pkg.dev/${project}/container/${projectName}`
}

export function gcrImageTag(project, projectName, environment, buildNumber) {
    return `${gcrRegistry(project, projectName)}:${environment}-${buildNumber}`
}

// Run a Cloud Run mutation (the RPC plus the long-running operation it returns)
// under the shared transient-gRPC retry. `request` is built ONCE by the caller
// and closed over, so every replay sends byte-identical desired state — see
// ./grpc-retry.js for why that makes a replayed update a no-op rather than a
// second deploy.
async function mutate(label, apply) {
    return retryTransient(label, async attempt => {
        try {
            const [operation] = await apply()
            const [response] = await operation.promise()
            return response
        } catch (error) {
            // Cloud Run rejects an update that arrives while a previous update of
            // the same resource is still reconciling. On a REPLAY that is the
            // expected shape of "the attempt we are retrying actually landed", so
            // treat it as applied instead of failing a deploy that worked. Only
            // ever from attempt 2 on: a first-attempt ABORTED is a genuine
            // conflict (a concurrent deploy) and still fails. The warning keeps
            // the guess visible on the run, and the pipeline's verify leg is the
            // backstop if it is ever wrong.
            if (attempt > 1 && isAborted(error)) {
                core.warning(
                    `${label}: ABORTED on attempt ${attempt} — the replay collided with the update the ` +
                    "previous attempt had already started. Treating it as applied."
                )
                return null
            }
            throw error
        }
    })
}

export async function listSecrets(project, types = PARAM_TYPES) {
    const client = new SecretManagerServiceClient()
    const request = {
        parent: `projects/${project}`,
        filter: types.map(type => `labels.param_type=${type.toLowerCase()}`).join(" OR ")
    }
    // ListSecrets is classified non_idempotent by the generated client and so
    // carries no retry of its own. A list is a pure read; replaying it is free.
    const [secrets] = await retryTransient(
        `listSecrets ${project}`,
        () => client.listSecrets(request)
    )
    return secrets
}

// accessSecretVersion is NOT wrapped: its GAPIC config already retries
// UNAVAILABLE (and RESOURCE_EXHAUSTED) with a 10-minute budget, and stacking a
// second retry loop on top would multiply the worst case. listSecrets above is
// the call that had no protection.
export async function secrets(project, types = PARAM_TYPES) {
    const client = new SecretManagerServiceClient()
    const secrets = await listSecrets(project, types)

    return await secrets.reduce(async (acc, secret) => {
        const [version] = await client.accessSecretVersion({name: `${secret.name}/versions/latest`})
        return {...acc, [secret.name.split('/').pop()]: version.payload.data.toString()}
    }, Promise.resolve({}))
}

// Not wrapped: ListServices is the one Cloud Run call whose GAPIC config already
// retries UNAVAILABLE / DEADLINE_EXCEEDED, with a 10-minute budget. An outer
// retry would only multiply that worst case.
export async function cloudrunListServices(project) {
    const client = new ServicesClient()
    const [services] = await client.listServices({parent: `projects/${project}/locations/${DEFAULT_REGION}`})
    return services
}

// ListJobs, unlike ListServices, is classified non_idempotent and carries no
// retry. A list is a pure read; replaying it is free.
export async function cloudrunListJobs(project) {
    const client = new JobsClient()
    const request = {parent: `projects/${project}/locations/${DEFAULT_REGION}`}
    const [jobs] = await retryTransient(
        `cloudrunListJobs ${project}`,
        () => client.listJobs(request)
    )
    return jobs
}

// Update a job with a full read-modify-write of the job resource (output-only
// fields are ignored by the API). UpdateJobRequest has no updateMask support.
// The full-desired-state shape is exactly what makes the retry safe.
export async function updateJob(job) {
    const client = new JobsClient()
    const request = {job}
    return mutate(`updateJob ${job.name}`, () => client.updateJob(request))
}

// How long we will wait for a task to BEGIN before treating the execution as
// stalled, and how often we ask. A healthy execution starts in one to two
// minutes, so this is generous.
//
// Cloud Run has its own start deadline of TWO HOURS, and it is not tunable: the
// job spec exposes only containers, maxRetries, serviceAccountName and
// timeoutSeconds, and that last one caps how long a task may RUN. Waiting that
// deadline out failed a 05:15 nightly at 07:15, so the useful deadline is ours.
export const START_DEADLINE_MS = 15 * 60 * 1000
export const POLL_INTERVAL_MS = 15 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Execute a job and wait for the execution to complete. The returned
// long-running operation only resolves once the execution finishes, and
// rejects if it fails.
//
// A task that RAN and failed is never re-run: the only job a deploy executes is
// database migrations, and a half-applied schema change must fail the deploy
// loudly (the module fixes the job's own max_retries at 0 for the same reason).
// But the invariant that protects is "never run a migration twice", not "never
// call RunJob twice" — and Cloud Run tells us which happened. `start_time` is
// set the moment a task begins and stays null for an execution that was never
// scheduled, so an execution that never started provably ran nothing and is
// safe to run again. That case is retried ONCE; every other failure still fails
// the deploy on the first attempt, as before.
//
// The stalled execution is cancelled before the retry so a late start cannot
// race it into a second concurrent migration.
export async function runJob(name, {startDeadlineMs = START_DEADLINE_MS, pollIntervalMs = POLL_INTERVAL_MS} = {}) {
    let attempt = await executeJob(name, startDeadlineMs, pollIntervalMs)

    if (attempt.stalled) {
        core.warning(
            `${attempt.executionName} never started within ${Math.round(startDeadlineMs / 60000)}m, so ` +
            "Cloud Run scheduled no task and nothing ran. Cancelling it and executing the job once more."
        )
        await cancelQuietly(attempt.executionName)
        attempt = await executeJob(name, startDeadlineMs, pollIntervalMs)
        if (attempt.stalled) {
            await cancelQuietly(attempt.executionName)
            throw new Error(`Job execution failed to start twice, most recently ${attempt.executionName}`)
        }
    }

    const execution = attempt.execution
    if ((execution.failedCount ?? 0) > 0 || (execution.succeededCount ?? 0) < (execution.taskCount ?? 1)) {
        throw new Error(`Job execution did not succeed: ${execution.name}`)
    }
    return execution
}

// One RunJob call: either the finished execution, or `stalled` when no task ever
// began. The RunJob operation carries the Execution as its metadata, so the
// execution can be polled and cancelled while the operation is still pending.
async function executeJob(name, startDeadlineMs, pollIntervalMs) {
    const client = new JobsClient()
    const [operation] = await client.runJob({name})
    const executionName = operation.metadata?.name

    // With no execution name we cannot tell a stall from a failure, so keep the
    // original behaviour rather than guess: wait however long Cloud Run takes.
    if (!executionName) {
        const [execution] = await operation.promise()
        return {execution}
    }

    if (!await waitForStart(executionName, startDeadlineMs, pollIntervalMs)) {
        return {stalled: true, executionName}
    }
    const [execution] = await operation.promise()
    return {execution}
}

// True once a task has begun. False when the execution reaches a terminal state
// without ever starting (Cloud Run's own deadline beat ours) or when our
// deadline passes first.
async function waitForStart(executionName, startDeadlineMs, pollIntervalMs) {
    const client = new ExecutionsClient()
    const deadline = Date.now() + startDeadlineMs
    for (;;) {
        const [execution] = await client.getExecution({name: executionName})
        if (execution.startTime) return true
        if (execution.completionTime) return false
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        await sleep(Math.min(pollIntervalMs, remaining))
    }
}

// Best effort. The point is only to stop a late start racing the retry, and an
// execution that has already reached a terminal state refuses cancellation —
// which is the same outcome we wanted.
async function cancelQuietly(executionName) {
    try {
        const client = new ExecutionsClient()
        const [operation] = await client.cancelExecution({name: executionName})
        await operation.promise()
    } catch (error) {
        core.warning(`cancelExecution ${executionName} failed, continuing: ${error.message}`)
    }
}

// `containers` is the full container list for the service template (the app
// container plus any sidecars), so deploys preserve sidecars instead of
// collapsing the service to a single container.
//
// The request — force-revision annotation included — is built once, outside the
// retry, so a replay after a transient failure asks for the state the first
// attempt already asked for. Cloud Run mints a revision per distinct template,
// so an identical replay is a no-op rather than a second revision.
export async function updateService(name, containers) {
    const client = new ServicesClient()
    const request = {
        service: {
            name: name,
            template: {
                containers: containers,
                annotations: {
                    "client.knative.dev/force-revision": Date.now().toString(),
                }
            }
        },
        updateMask: {
            paths: ["template.containers", "template.annotations"],
        }
    }
    return mutate(`updateService ${name}`, () => client.updateService(request))
}
