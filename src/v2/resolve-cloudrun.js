import * as core from '@actions/core'
import { cloudrunGetRevision, cloudrunListJobs, cloudrunListServices } from '../gcp'
import {
  findAppContainer,
  isDigestRef,
  isPlaceholderImage,
  parseImageRef,
  resolveTag,
  sharedRegistryImage,
  tagsForDigest
} from './gcp'

// The database-migrations job (see src/v2/deploy-cloudrun.js) runs the app
// image too, but it is refreshed *before* the rest of a deploy and executed;
// it is never a witness of what is currently serving. Skip it when reading a
// running image back out of an environment.
const DB_MIGRATE_JOB = 'db-migrate'

// Traffic that follows the service's latest ready revision. The generated
// client decodes enums as their string names.
const TRAFFIC_LATEST = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'

// A job's/service's `name` is a full resource path (projects/.../<kind>/<name>).
const shortName = resource => resource.split('/').pop()

// Resolve a Cloud Run image to a digest reference in the shared registry.
//
// mode=tag:         resolve <tag> against the shared registry -> digest.
// mode=environment: read the app container image the target env's runtime
//                   project is SERVING (the revision that takes the traffic,
//                   not the service template); return it if already a digest
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

  // The services a deploy puts the app image on (see src/v2/deploy-cloudrun.js).
  const appServices = services.filter(service => findAppContainer(service.template?.containers ?? [], repo))

  let runningImage
  if (appServices.length > 0) {
    runningImage = await servingImage(appServices, repo, runtimeProject)
    if (!runningImage) {
      throw new Error(
        `Could not find a running app container image in project ${runtimeProject}: no Cloud Run ` +
        'service has a ready revision serving the app image yet (a service still on the Cloud Run ' +
        'placeholder image has never been deployed)'
      )
    }
  } else {
    // Jobs-only apps (no Cloud Run services at all) still carry the deployed
    // app image on their jobs, since deploy-cloudrun.js updates every job's
    // image. Fall back to them so such an app can be resolved (and therefore
    // promoted). Jobs have no traffic, so the template is the right answer.
    // Never used when the app has services: a deploy updates the jobs before
    // the services, so a job can name an image no service ever served.
    const jobs = await cloudrunListJobs(runtimeProject)
    core.info(`jobs in ${runtimeProject}: ${JSON.stringify(jobs.map(j => j.name))}`)
    for (const job of jobs) {
      if (shortName(job.name) === DB_MIGRATE_JOB) continue
      const container = findAppContainer(job.template?.template?.containers ?? [], repo)
      if (container?.image && !isPlaceholderImage(container.image)) {
        runningImage = container.image
        core.info(`app container image in ${job.name}: ${runningImage}`)
        break
      }
    }
    if (!runningImage) {
      throw new Error(
        `Could not find a running app container image in project ${runtimeProject} ` +
        '(checked Cloud Run services and jobs; any job still on the Cloud Run placeholder image ' +
        'has never been deployed)'
      )
    }
  }

  if (isDigestRef(runningImage)) {
    const { digest } = parseImageRef(runningImage)
    // Report tags opportunistically; the running digest may predate the shared
    // registry, in which case there are simply no shared-registry tags for it.
    const tags = await tagsForDigest(projectName, digest).catch(() => [])
    return { image: runningImage, digest, tags }
  }

  // Running a tag ref: resolve it to the digest the tag currently points at.
  const { name, tag } = parseImageRef(runningImage)
  if (name !== repo) {
    // Pre-v2 deployment: a tag-pinned image in another registry (the app's old
    // per-project registry) — every app's state on its first v2 deploy after
    // v1. Its tag means nothing in the shared registry, so there is no digest
    // to compare against; report "no comparable deployment" instead of failing.
    core.info(`running image ${runningImage} is a pre-v2 tag ref outside the shared registry; nothing to compare`)
    return { image: runningImage, digest: '', tags: [] }
  }
  core.info(`running image is a tag ref (${tag}); resolving to a digest`)
  const resolved = await resolveTag(projectName, tag)
  return resolved
}

// The one app image every service is serving, or null when no service serves
// anything yet. Throws when there is no single answer.
//
// Why the template is not enough: the template changes as soon as a deploy
// sends UpdateService, whether or not the new revision ever becomes ready. A
// revision that went live after its deploy gave up, or one that never starts
// while the old one keeps serving, both leave the template naming the new
// image. Only the revision that takes the traffic says what is running.
//
// Why "no single answer" throws instead of picking one: resolve-image can only
// say "nothing to report" in one way that every caller already handles, and
// that is failing. deploy-candidate reads the running image under
// continue-on-error and treats a failure as "not deployed yet", so its no-op
// guard does not skip and the deploy goes ahead, which puts every service on
// the same image. promote reads it without continue-on-error, so the promote
// stops at that step with this message instead of going on with an empty
// digest and failing later with a confusing "no candidate tag" error. Picking
// one image would be wrong for both: a guard that trusts the service that
// landed leaves the other one behind, and a promote could take to production
// an image that never served everywhere in release-candidate.
async function servingImage (services, repo, runtimeProject) {
  const serving = []
  for (const service of services) {
    serving.push(await servingImageOf(service, repo))
  }

  if (serving.every(entry => entry.state === 'none')) return null

  const images = new Set(serving.map(entry => entry.image))
  if (serving.every(entry => entry.state === 'serving') && images.size === 1) {
    return serving[0].image
  }

  const details = serving.map(entry => {
    const name = shortName(entry.service.name)
    if (entry.state === 'split') return `${name} splits its traffic between revisions`
    if (entry.state === 'none') return `${name} has no ready revision serving the app image`
    return `${name} serves ${entry.image}`
  })
  throw new Error(
    `The Cloud Run services in ${runtimeProject} do not all serve one app image (${details.join('; ')}), ` +
    'so there is no single running image to resolve. This is what a rollout that is stuck, failed or ' +
    'still in progress looks like, or traffic split by hand. Deploy to this environment again or let ' +
    'the rollout finish, then retry.'
  )
}

// What one service is serving:
//   { state: 'serving', image }  one revision takes all traffic and runs the app image
//   { state: 'none' }            no ready revision yet, or it runs the placeholder image
//   { state: 'split' }           traffic is split, so no single revision is serving
async function servingImageOf (service, repo) {
  const templateImage = findAppContainer(service.template?.containers ?? [], repo)?.image
  const target = servingRevision(service)
  if (target === 'split') {
    core.info(`${service.name}: traffic is split between revisions`)
    return { service, state: 'split' }
  }

  let image = null
  if (target) {
    const revision = await cloudrunGetRevision(target)
    const container = findAppContainer(revision?.containers ?? [], repo)
    if (container?.image && !isPlaceholderImage(container.image)) image = container.image
  }

  if (templateImage && !isPlaceholderImage(templateImage) && templateImage !== image) {
    core.warning(
      `${service.name}: the service template names ${templateImage}, but ` +
      (image ? `the revision serving its traffic (${shortName(target)}) runs ${image}` : 'no ready revision is serving it') +
      '. A rollout looks stuck, failed or still in progress; going by what is serving.'
    )
  }

  if (!image) {
    core.info(`${service.name}: no ready revision is serving the app image`)
    return { service, state: 'none' }
  }
  core.info(`app container image serving in ${target}: ${image}`)
  return { service, state: 'serving', image }
}

// The full resource name of the revision that takes all of a service's
// traffic, null when no revision is serving yet, or 'split'.
//
// trafficStatuses is the traffic as Cloud Run resolved it, and it keeps
// describing the last serving revision when a rollout fails. Its entries name
// a revision by its short id; latestReadyRevision is a full resource name.
function servingRevision (service) {
  const statuses = service.trafficStatuses ?? []
  if (statuses.length > 0) {
    const all = statuses.find(status => status.percent === 100)
    if (!all) return 'split'
    const name = all.revision || (all.type === TRAFFIC_LATEST ? service.latestReadyRevision : '')
    return name ? revisionPath(service, name) : null
  }

  // No resolved traffic. When traffic follows the latest ready revision (no
  // traffic block at all means the same), that revision is the one serving.
  // An empty latestReadyRevision means no revision has become ready yet.
  const followsLatest = (service.traffic ?? []).every(target => target.type === TRAFFIC_LATEST)
  const name = followsLatest ? service.latestReadyRevision : ''
  return name ? revisionPath(service, name) : null
}

const revisionPath = (service, revision) =>
  revision.includes('/') ? revision : `${service.name}/revisions/${revision}`
