import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

export async function run () {
  try {
    const projectName = core.getInput('project-name', { required: true })
    const environment = core.getInput('environment', { required: true })
    const buildNumber = core.getInput('build-number', { required: true })
    const githubToken = core.getInput('github-token', { required: true })
    const type = core.getInput('type')

    const octokit = getOctokit(githubToken)

    await octokit.rest.actions.createWorkflowDispatch({
        owner: 'CruGlobal',
        repo: 'cru-deploy',
        ref: 'main',
        workflow_id: 'promote-ecs.yml',
        inputs: {
          'project-name': projectName,
          'environment': environment,
          'build-number': buildNumber,
        }
    })
    core.notice('Successfully triggered a deployment on [cru-deploy](https://github.com/CruGlobal/cru-deploy/actions/workflows/promote-ecs.yml).')
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
