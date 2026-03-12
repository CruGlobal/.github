import * as core from '@actions/core'
import assert from 'assert'
import {cloudrunListServices, gcrImageTag, listSecrets, updateService} from "./gcp";
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

async function updateCloudRun(projectName, project, environment, buildNumber) {
    const imageUri = gcrImageTag(project, projectName, environment, buildNumber)
    core.info(`imageUri: ${imageUri}`)

    // List all Cloud Run services
    const services = await cloudrunListServices(project)
    core.info(`services: ${JSON.stringify(services.map(s => s.name))}`)
    const secrets = await listSecrets(project, RUNTIME_PARAM_TYPES)

    // Update each CloudRun service
    // TODO: selectively update services?
    for (const service of services) {
        const container = service.template.containers[0]
        container.image = imageUri

        const envVars = []

        // Persist non-secret ENV vars
        if (container.env !== null) {
            for (const env of container.env) {
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

        container.env = envVars
        core.info(`updating service: ${service.name}`)
        await updateService(service.name, container)
    }
}

run()
