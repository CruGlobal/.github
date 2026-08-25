import * as core from "@actions/core";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";
import {v2} from "@google-cloud/run"
import {PARAM_TYPES} from "./ecs-config";
import {isAborted, retryTransient} from "./grpc-retry";

const {ServicesClient, JobsClient} = v2

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
            // the guess visible on the run, and re-running the deploy is the
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

// Execute a job and wait for the execution to complete. The returned
// long-running operation only resolves once the execution finishes, and
// rejects if it fails.
//
// NOT retried, unlike the updates above: a replayed RunJob can start a SECOND
// execution of a job the server already accepted, and the only job a deploy
// executes is database migrations. Failing a rerunnable deploy beats running
// migrations twice.
export async function runJob(name) {
    const client = new JobsClient()
    const [operation] = await client.runJob({name})
    const [execution] = await operation.promise()
    if ((execution.failedCount ?? 0) > 0 || (execution.succeededCount ?? 0) < (execution.taskCount ?? 1)) {
        throw new Error(`Job execution did not succeed: ${execution.name}`)
    }
    return execution
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
