import * as core from '@actions/core'
import { addTag, sharedRegistryRepo } from './v2/gcp'
import { ecrRetagDigest } from './v2/aws'
import { assertAttemptAuthorized } from './v2/attempt-guard'

// tag-image: provider-agnostic release tagging for pipeline v2. Adds a tag
// (e.g. release-10038) to an already-pushed digest in the shared registry,
// WITHOUT rebuilding or re-pushing layers. Replaces promote.yml's gcloud CLI
// tagging step with a single provider-routed action.
//
//   cloudrun -> Artifact Registry REST tag create/move (src/v2/gcp.js addTag)
//   ecs/lambda -> ECR manifest re-tag (src/v2/aws.js ecrRetagDigest)
//
// The router dispatches on `type`. The digest must be a bare sha256:... value
// (the same form resolve-image / promote surface as `digest`).
//
// A release tag is a trusted record: rollback deploys whatever digest a
// release-* tag names. So adding one is refused unless the authorize-actor
// check passed earlier in this job for this run attempt
// (src/v2/attempt-guard.js). Other tags are not checked.

// The shared GCP Artifact Registry project. Overridable for non-default
// registries; the app's repo/package within it is always the project name.
const DEFAULT_REGISTRY_PROJECT = 'cru-shared-artifacts'

export function assertDigest (digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Expected a bare digest "sha256:<64 hex>" but got "${digest}"`)
  }
}

export async function run () {
  try {
    const type = core.getInput('type', { required: true })
    const projectName = core.getInput('project-name', { required: true })
    const digest = core.getInput('digest', { required: true })
    const tag = core.getInput('tag', { required: true })
    const registryProject = core.getInput('registry-project', { required: false }) || DEFAULT_REGISTRY_PROJECT

    if (/^release-/i.test(tag)) assertAttemptAuthorized(`add the release tag ${tag}`)
    assertDigest(digest)

    const result = await dispatch(type, { projectName, digest, tag, registryProject })

    core.info(`tagged ${result.image} as ${tag}`)
    core.setOutput('image', result.image)
    core.setOutput('tag', tag)
  } catch (error) {
    core.setFailed(error.message)
  }
}

function dispatch (type, { projectName, digest, tag, registryProject }) {
  switch (type) {
    case 'cloudrun':
      // Repo == package == project name in the shared Artifact Registry.
      return addTag(registryProject, sharedRegistryRepo(projectName), projectName, digest, tag)
    case 'ecs':
    case 'lambda':
      return ecrRetagDigest(projectName, digest, tag)
    default:
      throw new Error(`Unknown type "${type}". Expected one of: ecs, lambda, cloudrun.`)
  }
}

// The action's entry point is src/entry/tag-image.js, which always calls run().
