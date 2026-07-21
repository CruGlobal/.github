import * as core from '@actions/core'
import { ecsListServices, ecsServiceTaskDefinitions } from '../aws'
import { ecsCluster } from '../ecs-config'
import { environmentNickname, legacyEnvironment } from './env'
import { ecrImageRef, ecrResolveDigest, ecrTagsForDigest, ecsServiceRegExp, isEcsAppContainer } from './aws'
import { isDigestRef, parseImageRef } from './image-ref'

// Resolve an ECS image to a digest reference in the shared ECR registry.
//
// mode=tag:         resolve <tag> against the app's ECR repo -> digest, and
//                   report every tag on that digest.
// mode=environment: read the app-container image currently running in the target
//                   env's ECS services; return it if already a digest ref,
//                   otherwise resolve its tag against ECR.
//
// ECS derives everything from the env nickname + naming conventions — unlike
// cloudrun it needs no runtime-project input.
//
// Returns { image, digest, tags } where `image` is a full ECR digest reference.
export async function resolveEcs ({ mode, projectName, tag, environment }) {
  if (mode === 'tag') {
    core.info(`resolving ECR tag "${tag}" for ${projectName}`)
    const { digest, tags } = await ecrResolveDigest(projectName, tag)
    return { image: ecrImageRef(projectName, digest), digest, tags }
  }

  if (mode === 'environment') {
    return resolveRunningImage(projectName, environment)
  }

  throw new Error(`Unknown resolve mode "${mode}". Expected "tag" or "environment".`)
}

async function resolveRunningImage (projectName, environment) {
  const nickname = environmentNickname(environment)
  const cluster = ecsCluster(nickname)
  const regexp = ecsServiceRegExp(projectName, legacyEnvironment(environment), nickname)

  const serviceArns = await ecsListServices(regexp, cluster)
  core.info(`services matching ${regexp} in ${cluster}: ${JSON.stringify(serviceArns.map(a => a.split('/').pop()))}`)
  if (serviceArns.length === 0) {
    throw new Error(`No ECS services matching ${regexp} found in cluster "${cluster}"`)
  }

  const taskDefs = await ecsServiceTaskDefinitions(serviceArns, cluster)
  let runningImage
  for (const taskDef of Object.values(taskDefs)) {
    const container = (taskDef?.containerDefinitions ?? []).find(c => isEcsAppContainer(c, projectName))
    // Skip the `scratch` placeholder: a service that has never actually been
    // deployed carries no resolvable image.
    if (container?.image && container.image !== 'scratch') {
      runningImage = container.image
      break
    }
  }

  if (!runningImage) {
    throw new Error(`Could not find a running app container image for ${projectName} in cluster "${cluster}"`)
  }
  core.info(`running app container image: ${runningImage}`)

  if (isDigestRef(runningImage)) {
    const { digest } = parseImageRef(runningImage)
    // Report tags opportunistically; a digest that predates the v2 tag families
    // simply has no candidate/release tags.
    const tags = await ecrTagsForDigest(projectName, digest).catch(() => [])
    return { image: ecrImageRef(projectName, digest), digest, tags }
  }

  // Running a tag ref: resolve it to the digest the tag currently points at.
  const { tag } = parseImageRef(runningImage)
  core.info(`running image is a tag ref (${tag}); resolving to a digest`)
  const { digest, tags } = await ecrResolveDigest(projectName, tag)
  return { image: ecrImageRef(projectName, digest), digest, tags }
}
