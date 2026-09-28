import * as core from "@actions/core";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";
import {v2} from "@google-cloud/run"
import {PARAM_TYPES} from "./ecs-config";
import {isAborted, retryTransient} from "./grpc-retry";

const {ServicesClient, JobsClient, ExecutionsClient, RevisionsClient} = v2

export const DEFAULT_REGION = "us-central1"

export function gcrRegistry(project, projectName, region = DEFAULT_REGION) {
    return `${region}-docker.pkg.dev/${project}/container/${projectName}`
}

export function gcrImageTag(project, projectName, environment, buildNumber) {
    return `${gcrRegistry(project, projectName)}:${environment}-${buildNumber}`
}

// How Cloud Run reports a new revision that did not become ready in time: the
// update's operation fails after about fourteen minutes with code 13 and the
// message "Deploying Revision. Resource readiness deadline exceeded.", while
// Cloud Run keeps retrying the revision, which can still become ready and take
// the traffic (src/v2/cloudrun-rollout.js waits for it).
//
// gax builds an operation's error from the status's code and message alone
// (no details, metadata or status details reach us), so for an error the
// message is what is matched. The same test also reads a revision's or
// service's condition (src/v2/cloudrun-rollout.js), and only a condition
// carries a `reason`. These two are the place to adjust if Cloud Run words it
// differently.
const READINESS_DEADLINE_MESSAGE = /readiness deadline exceeded/i
const READINESS_DEADLINE_REASON = "PROGRESS_DEADLINE_EXCEEDED"

export function isReadinessDeadline(errorOrCondition) {
    if (errorOrCondition == null) return false
    if (errorOrCondition.reason === READINESS_DEADLINE_REASON) return true
    return typeof errorOrCondition.message === "string" && READINESS_DEADLINE_MESSAGE.test(errorOrCondition.message)
}

// Our own bound on an operation ran out before the operation finished. The
// mutation was sent and may well have been accepted; what it leads to is the
// caller's question, and a replay would not answer it.
export class OperationWaitExpired extends Error {
    constructor(label, waitMs, cause) {
        super(`${label}: the operation had not finished after ${Math.round(waitMs / 1000)}s (${cause?.message})`)
        this.name = "OperationWaitExpired"
        this.cause = cause
    }
}

// Polling settings for an operation that is waited on for a bounded time. gax
// polls with these instead of its defaults, which never give up, and fails the
// wait once the time left is spent. Only the delays and the total are used
// when polling an operation.
const OPERATION_BACKOFF = {
    initialRetryDelayMillis: 1000,
    retryDelayMultiplier: 1.5,
    maxRetryDelayMillis: 15000
}

function operationOptions(waitUntil) {
    if (waitUntil === undefined) return undefined
    return {longrunning: {...OPERATION_BACKOFF, totalTimeoutMillis: Math.max(1, waitUntil - Date.now())}}
}

// Run a Cloud Run mutation (the RPC plus the long-running operation it returns)
// under the shared transient-gRPC retry. `request` is built ONCE by the caller
// and closed over, so every replay sends byte-identical desired state — see
// ./grpc-retry.js for why that makes a replayed update a no-op rather than a
// second deploy.
//
// `waitMs`, when given, bounds the wait on the operation, across every
// attempt. Left out, the operation is waited on for as long as it takes.
//
// `onAccepted`, when given, is called as soon as an attempt's RPC returns an
// operation, which is how the caller knows the mutation was accepted. It gets
// the generation the service moved to, read off the operation's metadata (a
// Service): the metadata already carries the new generation then, and later
// follows the live service, so it is read once, there. It may be undefined if
// the metadata has none. It is not called on the ABORTED path below, which has
// no operation.
//
// Two outcomes are never replayed, because in both the mutation was accepted
// and a replay would only wait on the same rollout again: the readiness
// deadline above, and our own wait running out. Both are held outside the
// retry and thrown once it returns, so neither depends on how grpc-retry.js
// classifies its code. The deadline's code 13 is not one it replays, so for
// that one the hold only makes sure; but gax reports a wait that ran out as
// DEADLINE_EXCEEDED, which it does replay.
async function mutate(label, apply, {waitMs, onAccepted} = {}) {
    const waitUntil = waitMs === undefined ? undefined : Date.now() + waitMs
    let settled = null
    const response = await retryTransient(label, async attempt => {
        try {
            const [operation] = await apply(operationOptions(waitUntil))
            if (onAccepted) onAccepted(operation.metadata?.generation)
            const [response] = await operation.promise()
            return response
        } catch (error) {
            if (isReadinessDeadline(error)) {
                settled = error
                return null
            }
            if (waitUntil !== undefined && Date.now() >= waitUntil) {
                settled = new OperationWaitExpired(label, waitMs, error)
                return null
            }
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
    if (settled) throw settled
    return response
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

// How long accessSecret will spend on ONE secret, retries included. gax folds a
// call-option `timeout` into the retry's totalTimeoutMillis, so this bounds the
// whole call rather than a single attempt.
//
// The GAPIC default is TEN MINUTES. That is the right default for a value a
// deploy cannot proceed without, and the wrong one for accessSecret's caller
// (src/v2/sourcemaps.js), which is optional telemetry sitting on the rollback
// path — the emergency path — and must never be what stands between an operator
// and a restored production.
export const ACCESS_SECRET_TIMEOUT_MS = 30 * 1000

// Read the current value of ONE secret by short name, e.g. ROLLBAR_ACCESS_TOKEN.
//
// Returns null when the secret does not exist in this project, which callers
// use as a signal rather than an error: `secrets()` below reads whatever
// listSecrets found, but a caller asking for a specific name is asking a
// question ("is this environment wired for X?") whose answer may legitimately
// be no.
//
// NOT wrapped in retryTransient, for the reason stated below — bounded instead.
export async function accessSecret(project, secretId) {
    const client = new SecretManagerServiceClient()
    const name = `projects/${project}/secrets/${secretId}/versions/latest`
    try {
        const [version] = await client.accessSecretVersion({name}, {timeout: ACCESS_SECRET_TIMEOUT_MS})
        return version.payload.data.toString()
    } catch (error) {
        if (error?.code === GRPC_NOT_FOUND) return null
        throw error
    }
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

// One client of each kind for the reads below, made on first use and kept for
// the life of the step. A rollout wait (src/v2/cloudrun-rollout.js) reads a
// service and its revision every 15 seconds for up to 45 minutes, and every
// new client does its own credential exchange (with workload identity, a
// token exchange and an impersonation call) before its first request.
let servicesReader = null
let revisionsReader = null

// How long one attempt at a read may take. GetService already retries
// UNAVAILABLE in its GAPIC config, with a ten-minute budget, and a call-option
// timeout bounds that whole budget (see ACCESS_SECRET_TIMEOUT_MS). Bounded
// because a rollout wait reads inside the deploy's rollout budget
// (src/v2/rollout-budget.js), and one read must not be able to spend ten
// minutes of it.
export const READ_TIMEOUT_MS = 30 * 1000

// A quick read is ONE attempt with a short timeout: for a caller that polls,
// so its own next look is the retry, or one close to its deadline, which
// cannot afford the shared retry's several attempts.
export const QUICK_READ_TIMEOUT_MS = 15 * 1000

function read(label, call, quick) {
    const timeout = quick ? QUICK_READ_TIMEOUT_MS : READ_TIMEOUT_MS
    return retryTransient(label, () => call({timeout}), quick ? {attempts: 1} : {})
}

// Read one revision by its full resource name
// (projects/<p>/locations/<l>/services/<s>/revisions/<r>). GetRevision, like
// ListJobs, is classified non_idempotent and carries no retry. A get is a pure
// read; replaying it is free.
export async function cloudrunGetRevision(name, {quick = false} = {}) {
    if (revisionsReader === null) revisionsReader = new RevisionsClient()
    const client = revisionsReader
    const [revision] = await read(`cloudrunGetRevision ${name}`, options => client.getRevision({name}, options), quick)
    return revision
}

// Read one service by its full resource name. It is wrapped in the shared retry
// as well, which adds DEADLINE_EXCEEDED and socket errors to the UNAVAILABLE
// gax covers. A get is a pure read, so replaying it is free, and the timeout
// above keeps the two layers together to about three minutes at worst.
export async function cloudrunGetService(name, {quick = false} = {}) {
    if (servicesReader === null) servicesReader = new ServicesClient()
    const client = servicesReader
    const [service] = await read(`cloudrunGetService ${name}`, options => client.getService({name}, options), quick)
    return service
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

// The annotation whose fresh value on every deploy forces Cloud Run to mint a
// new revision, even when nothing else in the template changed. The v2 API
// accepts it but never shows it: it reads back as absent on both the service
// template and the revision, so it cannot tell revisions apart.
const FORCE_REVISION_ANNOTATION = "client.knative.dev/force-revision"

const ALL_TRAFFIC_TO_LATEST = [{type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100}]

// `containers` is the full container list for the service template (the app
// container plus any sidecars), so deploys preserve sidecars instead of
// collapsing the service to a single container.
//
// The request — force-revision annotation included — is built once, outside the
// retry, so a replay after a transient failure asks for the state the first
// attempt already asked for. Cloud Run mints a revision per distinct template,
// so an identical replay is a no-op rather than a second revision.
//
// `forceRevision` is the annotation's value. A caller that picks it can send
// the same value back with a later traffic-only update (pinServiceTraffic), so
// the template stays as it is. `waitMs` bounds the wait on the operation, and
// `onAccepted` hears when the update was accepted and the generation it moved
// the service to (see mutate).
//
// `trafficToLatest` also sends ALL traffic to the latest ready revision, with
// "traffic" in the mask. The v2 deploy always asks for it; v1 does not, and
// its updates are as they always were. That is already every deployed
// service's traffic (one LATEST entry at 100%, no tags, no splits), so a normal
// deploy changes nothing by it. It matters after a rollout that ran out of time:
// src/v2/cloudrun-rollout.js then pins the traffic to the revision that was
// serving, and a pin survives any update whose mask leaves `traffic` out. Left
// in place, it would keep the service on the pinned revision through every
// later deploy, and the resolver, which reads the serving revision, would
// report that old image to every re-run and promote. Rollbacks deploy through
// here too, so they release a pin the same way. A service that ever needs
// tagged or split traffic would lose it here.
//
// The new template and LATEST go in ONE call, which makes exactly one revision
// and gives it all the traffic. Never release a pin with LATEST alone: that
// routes to the newest template, which after a stall is the stuck revision.
export async function updateService(name, containers, options = {}) {
    const {forceRevision = Date.now().toString(), waitMs, onAccepted, trafficToLatest = false} = options
    const client = new ServicesClient()
    const request = {
        service: {
            name: name,
            template: {
                containers: containers,
                annotations: {
                    [FORCE_REVISION_ANNOTATION]: forceRevision,
                }
            },
            ...(trafficToLatest ? {traffic: ALL_TRAFFIC_TO_LATEST} : {})
        },
        updateMask: {
            paths: ["template.containers", "template.annotations", ...(trafficToLatest ? ["traffic"] : [])],
        }
    }
    return mutate(`updateService ${name}`, callOptions => client.updateService(request, callOptions), {waitMs, onAccepted})
}

// Send all of a service's traffic to one revision by name, and create no
// revision. `revision` is the short name: traffic entries refuse a full path
// (INVALID_ARGUMENT).
//
// Why the template's annotations ride along: the v2 API drops the hidden
// force-revision value from any request that leaves it out, so a "traffic"
// mask alone reads as a template change, and Cloud Run mints a copy of the
// current revision. Sending back `forceRevision`, the value the template
// already carries (the one the deploy's update sent), changes nothing. A
// replay is as safe as an update's: it is the same desired state. `waitMs`
// bounds the wait on the operation.
export async function pinServiceTraffic(name, revision, forceRevision, waitMs) {
    const client = new ServicesClient()
    const request = {
        service: {
            name: name,
            template: {
                annotations: {
                    [FORCE_REVISION_ANNOTATION]: forceRevision,
                }
            },
            traffic: [{type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: revision, percent: 100}]
        },
        updateMask: {
            paths: ["traffic", "template.annotations"],
        }
    }
    return mutate(`pinServiceTraffic ${name}`, callOptions => client.updateService(request, callOptions), {waitMs})
}
