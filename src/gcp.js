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

// How long we will wait for a task to BEGIN, and how often we ask. A healthy
// execution starts in one to two minutes, so this is generous.
//
// Cloud Run has its own start deadline of TWO HOURS, and it is not tunable: the
// job spec exposes only containers, maxRetries, serviceAccountName and
// timeoutSeconds, and that last one caps how long a task may RUN. Waiting that
// deadline out failed a 05:15 nightly at 07:15, so the useful deadline is ours.
export const START_DEADLINE_MS = 15 * 60 * 1000
export const POLL_INTERVAL_MS = 15 * 1000

// Polling settings for the cancellation's own long-running operation. gax
// leaves `totalTimeoutMillis` unset by default, which is an INFINITE deadline —
// and an abandoned poller keeps a ref'd timer chain alive, so the step would
// outlive the failure it is reporting.
const CANCEL_BACKOFF = {
    initialRetryDelayMillis: 1000,
    retryDelayMultiplier: 1.5,
    maxRetryDelayMillis: 10000,
    initialRpcTimeoutMillis: 20000,
    rpcTimeoutMultiplier: 1,
    maxRpcTimeoutMillis: 20000,
    totalTimeoutMillis: 120000
}

const GRPC_NOT_FOUND = 5
const GRPC_PERMISSION_DENIED = 7

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const count = value => Number(value ?? 0)

// Has any task begun? `start_time` is the direct signal, but the proto warns it
// "is not guaranteed to be set in happens-before order across separate
// operations", so the counters corroborate it.
function ranAnything(execution) {
    return Boolean(execution.startTime) ||
        count(execution.runningCount) > 0 ||
        count(execution.succeededCount) > 0 ||
        count(execution.failedCount) > 0 ||
        count(execution.cancelledCount) > 0 ||
        count(execution.retriedCount) > 0
}

const conditionSummary = execution => (execution?.conditions ?? [])
    .filter(condition => condition.message)
    .map(condition => `${condition.type}: ${condition.message}`)
    .join("; ")

// Execute a job and wait for the execution to complete. The returned
// long-running operation only resolves once the execution finishes, and
// rejects if it fails.
//
// NOT retried, and the job's own max_retries is fixed at 0 by the Terraform
// module for the same reason: the only job a deploy executes is database
// migrations, and a half-applied schema change must fail the deploy loudly.
//
// What this does add is a deadline of OUR own on the execution starting. Cloud
// Run will sit on an execution it cannot schedule for two hours before saying
// so, which is two hours of a deploy job holding a runner to report a failure
// it could have reported in fifteen minutes. On the deadline the pending
// execution is cancelled — best effort, and only so it cannot start later and
// collide with whatever the operator runs next — and the deploy fails with the
// execution named.
export async function runJob(name, options = {}) {
    const {startDeadlineMs = START_DEADLINE_MS, pollIntervalMs = POLL_INTERVAL_MS} = options
    const jobs = new JobsClient()
    const [operation] = await jobs.runJob({name})
    const executionName = operation.metadata?.name

    // With no execution name there is nothing to poll, so wait on the operation
    // exactly as this function always did.
    if (executionName) {
        await awaitStart(executionName, startDeadlineMs, pollIntervalMs)
    }

    const [execution] = await operation.promise()
    if ((execution.failedCount ?? 0) > 0 || (execution.succeededCount ?? 0) < (execution.taskCount ?? 1)) {
        throw new Error(`Job execution did not succeed: ${execution.name}`)
    }
    return execution
}

// Returns once a task has begun, or once the execution is terminal either way —
// the run operation is then the authoritative account of what happened, so it
// reports the outcome rather than this. Throws only when our deadline passes
// first, which is the stall this function exists for.
async function awaitStart(executionName, startDeadlineMs, pollIntervalMs) {
    const client = new ExecutionsClient()
    const deadline = Date.now() + startDeadlineMs
    let last = null
    try {
        for (;;) {
            let execution
            try {
                execution = await getExecution(client, executionName)
            } catch (error) {
                // A permission problem will not fix itself, and quietly falling
                // back would turn the whole deadline off. Anything else may be
                // read-after-write lag on the first poll or a passing blip, and
                // the deadline still bounds us either way.
                if (error.code === GRPC_PERMISSION_DENIED) throw error
                if (error.code !== GRPC_NOT_FOUND) {
                    core.warning(
                        `${executionName}: could not read the execution (${error.message}); waiting on the run ` +
                        "operation instead, without a start deadline."
                    )
                    return
                }
                execution = null
            }

            if (execution) {
                if (ranAnything(execution) || execution.completionTime) return
                last = execution
            }

            const remaining = deadline - Date.now()
            if (remaining <= 0) break
            await sleep(Math.min(pollIntervalMs, remaining))
        }

        const outcome = await cancelStalled(client, executionName)
        const reason = conditionSummary(last)
        throw new Error(
            `${executionName} had not started ${Math.round(startDeadlineMs / 60000)} minutes after it was ` +
            `created, so Cloud Run scheduled no task${reason ? ` (${reason})` : ""}. ${outcome} Nothing ran, ` +
            "so the deploy can simply be run again."
        )
    } finally {
        try { await client.close() } catch { /* the deploy's outcome does not turn on closing a channel */ }
    }
}

// One read, retried the way every other call in this file is.
async function getExecution(client, executionName) {
    const [execution] = await retryTransient(
        `getExecution ${executionName}`,
        () => client.getExecution({name: executionName})
    )
    return execution
}

// Best effort, and deliberately not load bearing: nothing re-runs the job
// automatically, so this only stops a late start colliding with whatever the
// operator does next. Bounded inside gax rather than raced against a timer, so
// a cancellation that hangs cannot outlive the step reporting the failure.
// Whether it worked goes in the message either way.
async function cancelStalled(client, executionName) {
    try {
        const [cancellation] = await client.cancelExecution({name: executionName}, {longrunning: CANCEL_BACKOFF})
        const [execution] = await cancellation.promise()
        return ranAnything(execution)
            ? `It STARTED while being cancelled — check ${executionName} before running the job again.`
            : "It has been cancelled."
    } catch (error) {
        return `It could NOT be cancelled (${error.message}), so Cloud Run may still start it within two hours ` +
            "of its creation — confirm it is not running before running the job again."
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
