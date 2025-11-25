import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

export async function run () {
  try {
    const projectName = core.getInput('project-name', { required: true })
    const environment = core.getInput('environment', { required: true })
    const buildNumber = core.getInput('build-number', { required: true })
    const githubToken = core.getInput('github-token', { required: true })
    const deployType = core.getInput('deploy-type', { required: false }) || 'ecs'
    const project = core.getInput('project', { required: deployType === 'cloudrun' })
    const workflowRef = core.getInput('workflow-ref', { required: false }) || 'main'

    const octokit = getOctokit(githubToken)

    let workflowId
    let inputs = {}
    switch (deployType) {
      case 'ecs':
        workflowId = 'promote-ecs.yml'
        break
      case 'lambda':
        workflowId = 'deploy-lambda.yml'
        break
      case 'cloudrun':
        workflowId = 'deploy-cloudrun.yml'
        inputs = {
          'project': project,
        }
        break
      default:
          throw new Error(`Unknown deploy type: ${deployType}. Supported types are: ecs, lambda.`)
    }

    await octokit.rest.actions.createWorkflowDispatch({
        owner: 'CruGlobal',
        repo: 'cru-deploy',
        ref: workflowRef,
        workflow_id: workflowId,
        inputs: {
          'project-name': projectName,
          'environment': environment,
          'build-number': buildNumber,
          ...inputs,
        }
    })
    core.notice(`Successfully triggered a deployment at https://github.com/CruGlobal/cru-deploy/actions/workflows/${workflowId}.`)
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
