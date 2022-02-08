import * as core from '@actions/core'
import {buildSecrets} from './ecs-config'

async function run () {
  try {
    const projectName = core.getInput('project-name', {required: false}) || process.env.PROJECT_NAME
    const environment = core.getInput('environment', {required: false}) || process.env.ENVIRONMENT

    core.debug(`Project Name: ${projectName}`)
    core.debug(`Environment: ${environment}`)

    const secrets = await buildSecrets(projectName, environment)
    for (const key in secrets) {
      core.setSecret(secrets[key])
      core.exportVariable(key, secrets[key])
    }

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()

