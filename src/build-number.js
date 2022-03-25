import * as core from '@actions/core'
import { ecsBuildNumber } from './aws'

async function run () {
  try {
    const projectName = core.getInput('project-name', { required: false }) || process.env.PROJECT_NAME
    const buildNumber = parseInt(await ecsBuildNumber(projectName))

    core.setOutput('build-number', buildNumber)
    core.exportVariable('BUILD_NUMBER', buildNumber)
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
