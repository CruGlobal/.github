import * as core from '@actions/core'
import assert from 'assert'
import {cloudrunGetJob, cloudrunListServices, gcrImageTag, listSecrets, runJob, updateJob, updateService} from "./gcp";
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
const DB_MIGRATE_JOB = 'db-migrate'

async function updateCloudRun(projectName, project, environment, buildNumber) {
    const imageUri = gcrImageTag(project, projectName, environment, buildNumber)
    core.info(`imageUri: ${imageUri}`)

    // List all Cloud Run services
    const services = await cloudrunListServices(project)
    core.info(`services: ${JSON.stringify(services.map(s => s.name))}`)
    const secrets = await listSecrets(project, RUNTIME_PARAM_TYPES)

    // Run database migrations (if the db-migrate job exists) to completion
    // before updating services. A failed migration fails the deploy and
    // leaves the running services untouched.
    const job = await cloudrunGetJob(project, DB_MIGRATE_JOB)
    if (job) {
        const container = job.template.template.containers[0]
        container.image = imageUri
        container.env = mergeEnvVars(container.env, secrets)
        core.info(`updating job: ${job.name}`)
        await updateJob(job)
        core.info(`executing job: ${job.name}`)
        await runJob(job.name)
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
