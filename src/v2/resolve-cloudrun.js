import * as core from '@actions/core'
import { cloudrunListServices } from '../gcp'
import {
  findAppContainer,
  isDigestRef,
  parseImageRef,
  resolveTag,
  sharedRegistryImage,
  tagsForDigest
} from './gcp'

// Resolve a Cloud Run image to a digest reference in the shared registry.
//
// mode=tag:         resolve <tag> against the shared registry -> digest.
// mode=environment: read the app container image currently running in the
//                   target env's runtime project; return it if already a digest
//                   ref, otherwise resolve its tag against the shared registry.
//
// Returns { image, digest, tags } where `image` is a full digest reference.
export async function resolveCloudRun ({ mode, projectName, tag, runtimeProject }) {
  if (mode === 'tag') {
    core.info(`resolving tag "${tag}" for ${projectName} in the shared registry`)
    return resolveTag(projectName, tag)
  }

  if (mode === 'environment') {
    if (!runtimeProject) {
      throw new Error('runtime-project is required to resolve a cloudrun image by environment')
    }
    return resolveRunningImage(projectName, runtimeProject)
  }

  throw new Error(`Unknown resolve mode "${mode}". Expected "tag" or "environment".`)
}

async function resolveRunningImage (projectName, runtimeProject) {
  const repo = sharedRegistryImage(projectName)
  const services = await cloudrunListServices(runtimeProject)
  core.info(`services in ${runtimeProject}: ${JSON.stringify(services.map(s => s.name))}`)

  let runningImage
  for (const service of services) {
    const container = findAppContainer(service.template?.containers ?? [], repo)
    if (container?.image) {
      runningImage = container.image
      core.info(`app container image in ${service.name}: ${runningImage}`)
      break
    }
  }

  if (!runningImage) {
    throw new Error(`Could not find a running app container image in project ${runtimeProject}`)
  }

  if (isDigestRef(runningImage)) {
    const { digest } = parseImageRef(runningImage)
    // Report tags opportunistically; the running digest may predate the shared
    // registry, in which case there are simply no shared-registry tags for it.
    const tags = await tagsForDigest(projectName, digest).catch(() => [])
    return { image: runningImage, digest, tags }
  }

  // Running a tag ref: resolve it to the digest the tag currently points at.
  const { tag } = parseImageRef(runningImage)
  core.info(`running image is a tag ref (${tag}); resolving to a digest`)
  const resolved = await resolveTag(projectName, tag)
  return resolved
}
