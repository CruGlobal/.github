import * as core from '@actions/core'
import * as github from '@actions/github'
import { environmentFromBranch, taskRoleARN } from './ecs-config'
import { ecsBuildNumber } from './aws.js'

async function run () {
  const projectName = core.getInput('project-name', { required: false }) || github.context.repo.repo
  const environment = core.getInput('environment', { required: false }) || environmentFromBranch(github.context.payload.ref_name)
  const buildNumber = core.getInput('build-number', { required: false }) || await ecsBuildNumber(projectName)

  const outputs = {
    'project-name': projectName,
    'environment': environment,
    'build-number': parseInt(buildNumber)
  }

  for (const [key, value] of Object.entries(outputs)) {
    core.setOutput(key, value)
    core.exportVariable(key.toUpperCase().replaceAll(/[-.]/g, '_'), value)
  }

  core.setOutput('ecs-task-role-arn', taskRoleARN(outputs['project-name'], outputs.environment))
}

run()
