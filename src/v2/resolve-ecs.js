import * as core from '@actions/core'
import { ecsDescribeServices, ecsDescribeTaskDefinition, ecsListServices } from '../aws'
import { ecsCluster } from '../ecs-config'
import { environmentNickname, legacyEnvironment } from './env'
import { ecrImageRef, ecrResolveDigest, ecrTagsForDigest, ecsServiceRegExp, isEcsAppContainer } from './aws'
import { isDigestRef, parseImageRef } from './image-ref'

// Resolve an ECS image to a digest reference in the shared ECR registry.
//
// mode=tag:         resolve <tag> against the app's ECR repo -> digest, and
//                   report every tag on that digest.
// mode=environment: read the app-container image the target env's ECS services
//                   are SERVING (each one's completed PRIMARY deployment, not
//                   the task definition the service was last updated to);
//                   return it if already a digest ref, otherwise resolve its
//                   tag against ECR.
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
  core.info(`services matching ${regexp} in ${cluster}: ${JSON.stringify(serviceArns.map(shortName))}`)
  if (serviceArns.length === 0) {
    throw new Error(`No ECS services matching ${regexp} found in cluster "${cluster}"`)
  }

  const runningImage = await servingImage(await ecsDescribeServices(serviceArns, cluster), projectName, cluster)
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

// How every "no single serving image" error ends, so it reads right for any
// caller: deploy-candidate carries on past it, promote stops on it.
const NEXT_STEPS =
  'Nothing was resolved, so a deploy to this environment goes ahead and a promote from it stops here. ' +
  'To promote, re-run deploy-candidate for the candidate, then promote.'

const shortName = arn => String(arn).split('/').pop()

// The one app image all of the app's services serve. Throws when there is
// none, or no single one.
//
// Why the service's taskDefinition is not enough: it follows the PRIMARY
// deployment, which a deploy makes the moment it calls UpdateService, whether
// or not any new task ever gets healthy. During a rollout the old tasks still
// serve; after a failed one the circuit breaker brings the old deployment back
// and the failed task definition lingers until it has. Only a PRIMARY
// deployment that has COMPLETED, with nothing else still running, says what is
// serving.
//
// Why "no single answer" throws instead of picking one (the Cloud Run resolver
// throws too, for the same reasons): deploy-candidate reads the running
// image under continue-on-error and takes a failure as "not deployed yet", so
// its no-op guard does not skip and the deploy goes ahead, which puts every
// service on one image. promote reads it without continue-on-error, so it stops
// at that step with this message instead of promoting an image that never
// served everywhere in release-candidate.
//
// That includes a service still on the scratch placeholder beside others that
// serve the app image: a service added after the candidate was deployed, which
// the candidate never ran on. Only when every service is on the placeholder has
// the app never been deployed at all. A matched service whose task definition
// has no app container is not one of the app's, and is left out, as before.
async function servingImage (services, projectName, cluster) {
  const images = appImages(projectName)
  const serving = []
  for (const service of services) serving.push(await servingImageOf(service, images))

  const app = serving.filter(entry => entry.state !== 'other')
  if (app.length === 0) {
    throw new Error(
      `Could not find a running app container image for ${projectName} in cluster "${cluster}" ` +
      `(no matching service runs a container from the ${projectName} repository)`
    )
  }
  if (app.every(entry => entry.state === 'placeholder')) {
    throw new Error(
      `Could not find a running app container image for ${projectName} in cluster "${cluster}" ` +
      '(a service still on the scratch placeholder has never been deployed)'
    )
  }

  const distinct = new Set(app.map(entry => entry.image))
  if (app.every(entry => entry.state === 'serving') && distinct.size === 1) return app[0].image

  const details = app.map(entry => entry.detail).join('; ')
  if (app.some(entry => entry.state === 'unsettled')) {
    throw new Error(`No single app image is serving for ${projectName} in cluster "${cluster}": ${details}. ${NEXT_STEPS}`)
  }
  throw new Error(
    `The ECS services for ${projectName} in cluster "${cluster}" do not all serve one app image (${details}). ` +
    NEXT_STEPS
  )
}

// What one service serves:
//   { state: 'serving', image }      its PRIMARY deployment has COMPLETED
//   { state: 'unsettled' }           a rollout is in progress or has failed
//   { state: 'placeholder' }         it has never been deployed
//   { state: 'other' }               it runs no app container at all
// each with a `detail` that says so, for the error when there is no one answer.
async function servingImageOf (service, images) {
  const name = service.serviceName ?? shortName(service.serviceArn)
  const deployments = service.deployments ?? []
  const primary = deployments.find(deployment => deployment.status === 'PRIMARY')
  if (!primary) return { name, state: 'unsettled', detail: `${name} has no PRIMARY deployment` }

  const image = await images(primary.taskDefinition)
  if (!image) {
    core.info(`${name}: its PRIMARY deployment runs no app container; left out`)
    return { name, state: 'other' }
  }
  if (image === 'scratch') {
    const detail = `${name} still runs the scratch placeholder (deployment ${primary.id}), so it has never been deployed`
    core.info(detail)
    return { name, state: 'placeholder', detail }
  }

  const others = deployments.filter(deployment => deployment !== primary)
  if (settled(primary, others)) {
    core.info(`${name}: deployment ${primary.id} (${shortName(primary.taskDefinition)}) serves ${image}`)
    return { name, state: 'serving', image, detail: `${name} serves ${image}` }
  }

  const parts = []
  for (const deployment of [primary, ...others]) {
    parts.push(
      `deployment ${deployment.id} (${deployment.status}, rolloutState ${deployment.rolloutState ?? 'unknown'}) ` +
      `runs ${await images(deployment.taskDefinition) ?? 'no app image'} with ${deployment.runningCount ?? 0} of ` +
      `${deployment.desiredCount ?? 0} tasks`
    )
  }
  const detail = `${name} is in the middle of a rollout, or its last one failed: ${parts.join(', ')}`
  core.info(detail)
  return { name, state: 'unsettled', detail }
}

// A service scaled to zero still counts: its COMPLETED deployment is the
// release it would run. AWS leaves rolloutState out for a service behind a
// Classic Load Balancer (none in the pipeline is); for one, a PRIMARY that is
// the only deployment left stands in for COMPLETED.
function settled (primary, others) {
  if (others.some(deployment => (deployment.runningCount ?? 0) > 0)) return false
  if (primary.rolloutState) return primary.rolloutState === 'COMPLETED'
  return others.length === 0
}

// The app container's image in a task definition, each task definition read
// at most once per resolve.
function appImages (projectName) {
  const cache = new Map()
  return taskDefinition => {
    if (!cache.has(taskDefinition)) {
      cache.set(taskDefinition, ecsDescribeTaskDefinition(taskDefinition).then(({ taskDefinition: definition }) =>
        (definition?.containerDefinitions ?? []).find(container => isEcsAppContainer(container, projectName))?.image ?? null
      ))
    }
    return cache.get(taskDefinition)
  }
}
