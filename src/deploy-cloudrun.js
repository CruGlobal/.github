import * as core from '@actions/core'
import assert from 'assert'
import {cloudrunListJobs, cloudrunListServices, gcrImageTag, listSecrets, runJob, updateJob, updateService} from "./gcp";
import {RUNTIME_PARAM_TYPES} from "./ecs-config";

async function run() {
    const isDefined = i => !!i

    try {
        const projectName = core.getInput('project-name', {required: false}) || process.env.PROJECT_NAME
        core.debug(`projectName: ${projectName}`)
        const project = core.getInput('project', {required: false}) || process.env.GCP_PROJECT
        core.debug(`project: ${project}`)
        const environment = core.getInput('environment', {required: false}) || process.env.ENVIRONMENT
        core.debug(`environment: ${environment}`)
        const buildNumber = core.getInput('build-number', {required: false}) || process.env.BUILD_NUMBER
        core.debug(`buildNumber: ${buildNumber}`)

        assert(
            [projectName, project, environment, buildNumber].every(isDefined),
            'Missing required input or environment value. Has "setup-env" action been run?'
        )

        await updateCloudRun(projectName, project, environment, buildNumber)
    } catch (error) {
        core.setFailed(error.message)
    }
}

// Name of the optional database migrations Cloud Run job, created by the
// gcp/cloudrun/app terraform module when `database_migrations` is enabled.
// Every other job (e.g. scheduled_jobs) gets its image/secrets refreshed but
// is only executed by its own Cloud Scheduler cron, never by the deploy.
const DB_MIGRATE_JOB = 'db-migrate'

// The job's `name` is a full resource path (projects/.../jobs/<name>).
const shortName = resource => resource.split('/').pop()

async function updateCloudRun(projectName, project, environment, buildNumber) {
    const imageUri = gcrImageTag(project, projectName, environment, buildNumber)
    core.info(`imageUri: ${imageUri}`)

    const services = await cloudrunListServices(project)
    core.info(`services: ${JSON.stringify(services.map(s => s.name))}`)
    const jobs = await cloudrunListJobs(project)
    core.info(`jobs: ${JSON.stringify(jobs.map(j => j.name))}`)
    const secrets = await listSecrets(project, RUNTIME_PARAM_TYPES)

    // Run database migrations (if the db-migrate job exists) to completion
    // before updating anything else. A failed migration fails the deploy and
    // leaves the running services and scheduled jobs untouched.
    const migrateJob = jobs.find(job => shortName(job.name) === DB_MIGRATE_JOB)
    if (migrateJob) {
        await updateJobImage(migrateJob, imageUri, secrets)
        core.info(`executing job: ${migrateJob.name}`)
        await runJob(migrateJob.name)
    }

    // Refresh the image/secrets on the remaining jobs (e.g. scheduled_jobs).
    // They run on their own cron, so they are updated but not executed here.
    for (const job of jobs) {
        if (job === migrateJob) continue
        await updateJobImage(job, imageUri, secrets)
    }

    // Update each CloudRun service
    // TODO: selectively update services?
    for (const service of services) {
        const container = service.template.containers[0]
        container.image = imageUri
        container.env = mergeEnvVars(container.env, secrets)
        core.info(`updating service: ${service.name}`)
        await updateService(service.name, container)
    }
}

// Update a Cloud Run job's container image and secrets in place
async function updateJobImage(job, imageUri, secrets) {
    const container = job.template.template.containers[0]
    container.image = imageUri
    container.env = mergeEnvVars(container.env, secrets)
    core.info(`updating job: ${job.name}`)
    await updateJob(job)
}

// Persist a container's non-secret ENV vars and (re)add all secret ENV vars
function mergeEnvVars(currentEnv, secrets) {
    const envVars = []

    // Persist non-secret ENV vars
    if (currentEnv) {
        for (const env of currentEnv) {
            if (env.value !== undefined) {
                envVars.push(env)
            }
        }
    }

    // Add secret ENV vars
    for (const secret of secrets) {
        envVars.push({
            name: secret.name.split('/').pop(),
            valueSource: {
                secretKeyRef: {
                    secret: secret.name,
                    version: "latest" // TODO: pin to specific secret version
                }
            }
        })
    }

    return envVars
}

run()
