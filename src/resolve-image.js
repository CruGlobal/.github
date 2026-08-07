import * as core from '@actions/core'
import { environmentNickname } from './v2/env'
import { resolveCloudRun } from './v2/resolve-cloudrun'
import { resolveEcs } from './v2/resolve-ecs'
import { resolveLambda } from './v2/resolve-lambda'

// resolve-image: resolve a tag or a running environment to a digest-pinned
// image reference in the shared registry. v2's build-once/promote model means
// callers never deploy a tag — they resolve it here first.
//
// The router dispatches on `type` (cloudrun implemented; ecs/lambda stubbed).
async function run () {
  try {
    const type = core.getInput('type', { required: true })
    const projectName = core.getInput('project-name', { required: true })
    const mode = core.getInput('mode', { required: true })
    const environment = core.getInput('environment', { required: false })
    const tag = core.getInput('tag', { required: false })
    const runtimeProject = core.getInput('runtime-project', { required: false })

    if (mode !== 'environment' && mode !== 'tag') {
      throw new Error(`Invalid mode "${mode}". Expected "environment" or "tag".`)
    }
    if (mode === 'environment' && !environment) {
      throw new Error('environment is required when mode=environment')
    }
    if (mode === 'tag' && !tag) {
      throw new Error('tag is required when mode=tag')
    }
    // Validate the long environment name eagerly (throws on an unknown name),
    // even though cloudrun keys off runtime-project rather than the nickname.
    if (mode === 'environment') {
      core.info(`environment ${environment} -> ${environmentNickname(environment)}`)
    }

    const resolved = await dispatch(type, { mode, projectName, environment, tag, runtimeProject })

    core.info(`resolved image: ${resolved.image}`)
    core.setOutput('image', resolved.image)
    core.setOutput('digest', resolved.digest)
    core.setOutput('tags', (resolved.tags ?? []).join(','))
  } catch (error) {
    core.setFailed(error.message)
  }
}

function dispatch (type, args) {
  switch (type) {
    case 'cloudrun':
      return resolveCloudRun(args)
    case 'ecs':
      return resolveEcs(args)
    case 'lambda':
      return resolveLambda(args)
    default:
      throw new Error(`Unknown type "${type}". Expected one of: ecs, lambda, cloudrun.`)
  }
}

run()
