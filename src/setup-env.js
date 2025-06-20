import * as core from '@actions/core'
import * as github from '@actions/github'
import { environmentFromBranch, taskRoleARN } from './ecs-config'

async function run () {
  try {
    if (core.isDebug()) {
      core.debug(JSON.stringify(github.context, undefined, 2))
    }

    const branchTag = github.context.ref.split('/').pop()
    const projectName = core.getInput('project-name', { required: false }) || github.context.repo.repo
    const environment = core.getInput('environment', { required: false }) || environmentFromBranch(branchTag)
    const roleSuffix = core.getInput('role-suffix', { required: false }) || 'TaskRole'

    const outputs = {
      'project-name': projectName,
      'environment': environment,
    }

    for (const [key, value] of Object.entries(outputs)) {
      core.setOutput(key, value)
      core.exportVariable(key.toUpperCase().replaceAll(/[-.]/g, '_'), value)
    }

    core.setOutput('role-arn', taskRoleARN(outputs['project-name'], outputs.environment, roleSuffix))
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
