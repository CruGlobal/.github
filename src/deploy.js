import * as core from '@actions/core'
import { environmentNickname } from './v2/env'
import { assertDigestRef } from './v2/gcp'
import { deployCloudRun } from './v2/deploy-cloudrun'
import { deployEcs } from './v2/deploy-ecs'
import { deployLambda } from './v2/deploy-lambda'

// deploy: deploy a pre-built, digest-pinned image to a target environment.
// Enforces the v2 invariant that only digest references are deployed — a tag
// reference fails the action immediately.
//
// The router dispatches on `type` (cloudrun implemented; ecs/lambda stubbed).
async function run () {
  try {
    const type = core.getInput('type', { required: true })
    const projectName = core.getInput('project-name', { required: true })
    const environment = core.getInput('environment', { required: true })
    const image = core.getInput('image', { required: true })
    const runtimeProject = core.getInput('runtime-project', { required: false })

    // Enforce the digest invariant before touching any infrastructure.
    assertDigestRef(image)
    // Validate the long environment name eagerly (throws on an unknown name).
    core.info(`environment ${environment} -> ${environmentNickname(environment)}`)

    const result = await dispatch(type, { projectName, environment, image, runtimeProject })

    core.info(`deployed image: ${result.deployedImage}`)
    core.info(`updated services: ${JSON.stringify(result.services)}`)
    core.setOutput('deployed-image', result.deployedImage)
    core.setOutput('services', (result.services ?? []).join(','))
  } catch (error) {
    core.setFailed(error.message)
  }
}

function dispatch (type, args) {
  switch (type) {
    case 'cloudrun':
      return deployCloudRun(args)
    case 'ecs':
      return deployEcs(args)
    case 'lambda':
      return deployLambda(args)
    default:
      throw new Error(`Unknown type "${type}". Expected one of: ecs, lambda, cloudrun.`)
  }
}

run()
