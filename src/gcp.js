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
// stalled, how often we ask, and how long we will wait for a cancellation to
// finalise. A healthy execution starts in one to two minutes, so the first is
// generous.
//
// Cloud Run has its own start deadline of TWO HOURS, and it is not tunable: the
// job spec exposes only containers, maxRetries, serviceAccountName and
// timeoutSeconds, and that last one caps how long a task may RUN. Waiting that
// deadline out failed a 05:15 nightly at 07:15, so the useful deadline is ours.
export const START_DEADLINE_MS = 15 * 60 * 1000
export const POLL_INTERVAL_MS = 15 * 1000
export const CANCEL_TIMEOUT_MS = 2 * 60 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// What we learned while waiting for the execution to start.
const RAN = "ran"                // a task began; only the task's own result matters now
const NEVER_RAN = "never-ran"    // terminal, and no task ever began
const PENDING = "pending"        // our deadline passed with nothing terminal either way

// Reject a promise that takes too long, so a hung long-running operation cannot
// put back the two-hour wait this function exists to remove.
function withTimeout(promise, ms, label) {
    let timer
    const expiry = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms)
    })
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

const count = value => Number(value ?? 0)

// Did any task ever run? `start_time` is the direct signal, but the proto warns
// it "is not guaranteed to be set in happens-before order across separate
// operations", so a task that ran can be corroborated by the counters even when
// the timestamp has not landed yet.
//
// `cancelled_count` is deliberately NOT one of them: cancelling an execution
// that never started is exactly what the stall path does, so counting it as
// evidence of running would make the retry refuse itself every time. A task that
// ran and was then cancelled still trips start_time or running_count.
function ranAnything(execution) {
    return Boolean(execution.startTime) ||
        count(execution.runningCount) > 0 ||
        count(execution.succeededCount) > 0 ||
        count(execution.failedCount) > 0 ||
        count(execution.retriedCount) > 0
}

const describeCounts = execution =>
    `startTime=${execution.startTime ? "set" : "unset"} running=${count(execution.runningCount)} ` +
    `succeeded=${count(execution.succeededCount)} failed=${count(execution.failedCount)} ` +
    `cancelled=${count(execution.cancelledCount)} retried=${count(execution.retriedCount)}`

// Execute a job and wait for the execution to complete. The returned
// long-running operation only resolves once the execution finishes, and
// rejects if it fails.
//
// A task that RAN and failed is never re-run: the only job a deploy executes is
// database migrations, and a half-applied schema change must fail the deploy
// loudly (the module fixes the job's own max_retries at 0 for the same reason).
// But the invariant that protects is "never run a migration twice", not "never
// call RunJob twice" — and an execution that never started ran nothing at all.
// That one case is retried ONCE; every other failure fails the deploy on the
// first attempt, as before.
//
// The bar for calling it that case is deliberately high, because a stalled
// deploy is recoverable and a migration applied twice may not be. Before the
// job runs again the execution must be TERMINAL and show no evidence that any
// task ever ran — cancelled first if Cloud Run could still schedule it, and
// re-read afterwards whatever the cancellation did. Anything we cannot confirm
// throws instead.
export async function runJob(name, options = {}) {
    const {
        startDeadlineMs = START_DEADLINE_MS,
        pollIntervalMs = POLL_INTERVAL_MS,
        cancelTimeoutMs = CANCEL_TIMEOUT_MS
    } = options

    let attempt = await executeJob(name, startDeadlineMs, pollIntervalMs)

    if (attempt.stalled) {
        // Throws unless nothing ran, so reaching the next line IS the proof.
        await confirmNothingRan(attempt.executionName, attempt.verdict, cancelTimeoutMs)
        core.warning(
            `${attempt.executionName} never started and ran no task, so it is safe to execute the job ` +
            "again. Running it once more."
        )
        attempt = await executeJob(name, startDeadlineMs, pollIntervalMs)
        if (attempt.stalled) {
            const outcome = await cancelForAbandon(attempt.executionName, attempt.verdict, cancelTimeoutMs)
            throw new Error(
                `Job execution failed to start twice, most recently ${attempt.executionName} (${outcome}). ` +
                "Confirm that execution is not running before executing the job again."
            )
        }
    }

    const execution = attempt.execution
    if ((execution.failedCount ?? 0) > 0 || (execution.succeededCount ?? 0) < (execution.taskCount ?? 1)) {
        throw new Error(`Job execution did not succeed: ${execution.name}`)
    }
    return execution
}

// One RunJob call: either the finished execution, or `stalled` when no task
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

    let verdict
    try {
        verdict = await awaitStart(executionName, startDeadlineMs, pollIntervalMs)
    } catch (error) {
        // Polling is an optimisation over waiting on the operation. If it fails
        // outright, fall back to the operation rather than fail a deploy whose
        // migration may well be running — the pre-poll behaviour, which tolerated
        // this because gax retries the operation for us.
        core.warning(
            `${executionName}: could not read the execution (${error.message}); waiting on the run operation instead.`
        )
        const [execution] = await operation.promise()
        return {execution}
    }

    if (verdict === RAN) {
        const [execution] = await operation.promise()
        return {execution}
    }
    return {stalled: true, verdict, executionName}
}

// Poll until a task begins, the execution ends without one, or our deadline
// passes. `ranAnything` is tested FIRST so an execution that both started and
// finished reads as RAN whichever timestamp landed first.
async function awaitStart(executionName, startDeadlineMs, pollIntervalMs) {
    const deadline = Date.now() + startDeadlineMs
    for (;;) {
        const execution = await getExecution(executionName)
        if (ranAnything(execution)) return RAN
        if (execution.completionTime) return NEVER_RAN
        const remaining = deadline - Date.now()
        if (remaining <= 0) return PENDING
        await sleep(Math.min(pollIntervalMs, remaining))
    }
}

// The last observation before the job runs again, and the only thing standing
// between a scheduling hiccup and a migration applied twice. Returns only when
// the execution is terminal and nothing ever ran; throws otherwise.
async function confirmNothingRan(executionName, verdict, cancelTimeoutMs) {
    if (verdict !== NEVER_RAN) {
        // Still pending at our deadline, so Cloud Run may yet schedule it inside
        // its own two-hour window. Cancel before running the job again, or the
        // two race. A cancellation we cannot complete is a refusal to retry, not
        // a warning to step past.
        await cancelExecution(executionName, cancelTimeoutMs)
    }

    // One authoritative read decides, whatever the cancellation did — it also
    // closes the gap between the last poll and the cancel landing, in which a
    // task could have started.
    const execution = await getExecution(executionName)
    if (ranAnything(execution)) {
        throw new Error(
            `${executionName} ran a task after all (${describeCounts(execution)}); refusing to execute the job ` +
            "again, because a migration must never run twice."
        )
    }
    if (!execution.completionTime) {
        throw new Error(
            `${executionName} is neither finished nor cancelled, so Cloud Run could still start it; refusing ` +
            "to execute the job again."
        )
    }
}

// Second stall: we are failing the deploy either way, so this only reports
// whether the stuck execution was seen off, for whoever re-runs it.
async function cancelForAbandon(executionName, verdict, cancelTimeoutMs) {
    if (verdict === NEVER_RAN) return "already terminal"
    try {
        await cancelExecution(executionName, cancelTimeoutMs)
        return "cancelled"
    } catch (error) {
        return `NOT cancelled: ${error.message}`
    }
}

async function getExecution(executionName) {
    const client = new ExecutionsClient()
    const [execution] = await retryTransient(
        `getExecution ${executionName}`,
        () => client.getExecution({name: executionName})
    )
    return execution
}

async function cancelExecution(executionName, cancelTimeoutMs) {
    const label = `cancelExecution ${executionName}`
    const client = new ExecutionsClient()
    return retryTransient(label, async () => {
        const [operation] = await client.cancelExecution({name: executionName})
        return withTimeout(operation.promise(), cancelTimeoutMs, label)
    })
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
