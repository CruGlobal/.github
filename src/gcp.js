import {SecretManagerServiceClient} from "@google-cloud/secret-manager";
import {PARAM_TYPES} from "./ecs-config";

export async function secrets (project, types = PARAM_TYPES) {
    const client = new SecretManagerServiceClient()
    const [secrets] = await client.listSecrets({
        parent: `projects/${project}`,
        filter: types.map(type => `labels.param_type=${type.toLowerCase()}`).join(" OR ")
    })

    return await secrets.reduce(async (acc, secret) => {
        const [version] = await client.accessSecretVersion({name: `${secret.name}/versions/latest`})
        return { ...acc, [secret.name.split('/').pop()]: version.payload.data.toString() }
    }, Promise.resolve({}))
}
