import * as core from '@actions/core'
import { PARAM_TYPES, RUNTIME_PARAM_TYPES, BUILD_PARAM_TYPES } from './ecs-config'
import { secrets } from './gcp'

async function run () {
  try {
    const project = core.getInput('project', { required: false }) || process.env.GCP_PROJECT
    const type = core.getInput('type', { required: false }) || 'BUILD'

    core.debug(`Project: ${project}`)
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

    const selectedSecrets = await secrets(project, types)
    for (const key in selectedSecrets) {
      core.debug(`Secret key: ${key}`)
      // Only mark the value of a secret as secret if it doesn't match project
      // And is more than 2 characters long
      if (![project].includes(selectedSecrets[key]) && selectedSecrets[key].length > 2) {
        core.setSecret(selectedSecrets[key])
      }
      core.exportVariable(key, selectedSecrets[key])
    }

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
