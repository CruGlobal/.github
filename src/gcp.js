import {SecretManagerServiceClient} from "@google-cloud/secret-manager";
import {v2} from "@google-cloud/run"
import {PARAM_TYPES} from "./ecs-config";

const {ServicesClient} = v2

export const DEFAULT_REGION = "us-central1"

export function gcrRegistry(project, projectName, region = DEFAULT_REGION) {
    return `${region}-docker.pkg.dev/${project}/container/${projectName}`
}

export function gcrImageTag(project, projectName, environment, buildNumber) {
    return `${gcrRegistry(project, projectName)}:${environment}-${buildNumber}`
}

export async function listSecrets(project, types = PARAM_TYPES) {
    const client = new SecretManagerServiceClient()
    const [secrets] = await client.listSecrets({
        parent: `projects/${project}`,
        filter: types.map(type => `labels.param_type=${type.toLowerCase()}`).join(" OR ")
    })
    return secrets
}

export async function secrets(project, types = PARAM_TYPES) {
    const client = new SecretManagerServiceClient()
    const secrets = await listSecrets(project, types)

    return await secrets.reduce(async (acc, secret) => {
        const [version] = await client.accessSecretVersion({name: `${secret.name}/versions/latest`})
        return {...acc, [secret.name.split('/').pop()]: version.payload.data.toString()}
    }, Promise.resolve({}))
}

export async function cloudrunListServices(project) {
    const client = new ServicesClient()
    const [services] = await client.listServices({parent: `projects/${project}/locations/${DEFAULT_REGION}`})
    return services
}

export async function updateService(name, template) {
    const client = new ServicesClient()
    const [operation] = await client.updateService({
        service: {
            name: name,
            template: {
                containers: [template],
            }
        },
        updateMask: "template.containers"
    })
    const [response] = await operation.promise()
    return response
}
