import * as core from '@actions/core'
import { environmentNickname } from './v2/env'
import { assertDigestRef } from './v2/gcp'
import { deployCloudRun } from './v2/deploy-cloudrun'
import { deployEcs } from './v2/deploy-ecs'
import { deployLambda } from './v2/deploy-lambda'
import { assertAttemptAuthorized } from './v2/attempt-guard'

// deploy: deploy a pre-built, digest-pinned image to a target environment.
// Enforces the v2 invariant that only digest references are deployed — a tag
// reference fails the action immediately.
//
// The router dispatches on `type` (cloudrun implemented; ecs/lambda stubbed).
//
// A deploy to production (anything but the two non-production environments
// below) is refused unless the authorize-actor check passed earlier in this
// job for this run attempt (src/v2/attempt-guard.js). That stops a re-run of a
// run made before promote and rollback checked every attempt: its old
// workflow file has no such check, but it still loads this action.
export const NON_PRODUCTION_ENVIRONMENTS = Object.freeze(['release-candidate', 'preview'])

export async function run () {
  try {
    const type = core.getInput('type', { required: true })
    const projectName = core.getInput('project-name', { required: true })
    const environment = core.getInput('environment', { required: true })
    const image = core.getInput('image', { required: true })
    const runtimeProject = core.getInput('runtime-project', { required: false })
    const appUrl = core.getInput('app-url', { required: false })

    // Enforce the digest invariant before touching any infrastructure.
    assertDigestRef(image)
    // Validate the long environment name eagerly (throws on an unknown name).
    core.info(`environment ${environment} -> ${environmentNickname(environment)}`)
    // Before anything touches infrastructure.
    if (!NON_PRODUCTION_ENVIRONMENTS.includes(environment)) {
      assertAttemptAuthorized(`deploy to ${environment}`)
    }

    const result = await dispatch(type, { projectName, environment, image, runtimeProject, appUrl })

    core.info(`deployed image: ${result.deployedImage}`)
    core.info(`updated services: ${JSON.stringify(result.services)}`)
    core.setOutput('deployed-image', result.deployedImage)
    core.setOutput('services', (result.services ?? []).join(','))

    // Source-map upload is telemetry: it never fails the deploy, so the only
    // way an operator learns a map did not land is if the outcome is reported.
    // Counted, not just logged, so a run summary or a later step can act on it.
    const sourcemaps = result.sourcemaps ?? { status: 'skipped', uploaded: 0, failed: 0 }
    core.setOutput('sourcemaps-status', sourcemaps.status)
    core.setOutput('sourcemaps-uploaded', String(sourcemaps.uploaded ?? 0))
    core.setOutput('sourcemaps-failed', String(sourcemaps.failed ?? 0))
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

// The action's entry point is src/entry/deploy.js, which always calls run().
