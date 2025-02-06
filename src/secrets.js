import * as core from '@actions/core'
import { secrets, PARAM_TYPES, RUNTIME_PARAM_TYPES, BUILD_PARAM_TYPES } from './ecs-config'

async function run () {
  try {
    const projectName = core.getInput('project-name', { required: false }) || process.env.PROJECT_NAME
    const environment = core.getInput('environment', { required: false }) || process.env.ENVIRONMENT
    const type = core.getInput('type', { required: false }) || 'BUILD'

    core.debug(`Project Name: ${projectName}`)
    core.debug(`Environment: ${environment}`)
    core.debug(`Type: ${type}`)

    let types
    switch (type) {
      case 'ALL':
        types = PARAM_TYPES
        break
      case 'RUNTIME':
        types = RUNTIME_PARAM_TYPES
        break
      case 'BUILD':
      default:
        types = BUILD_PARAM_TYPES
    }

    const selectedSecrets = await secrets(projectName, environment, types)
    for (const key in selectedSecrets) {
      // Only mark the value of a secret as secret if it doesn't match projectName or environment
      // And is more than 2 characters long
      if (![projectName, environment].includes(selectedSecrets[key]) && selectedSecrets[key].length > 2) {
        core.setSecret(selectedSecrets[key])
      }
      core.exportVariable(key, selectedSecrets[key])
    }

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
