import * as core from '@actions/core'
import { cloudrunGetRevision, cloudrunListJobs, cloudrunListServices } from '../gcp'
import {
  SHARED_PROJECT,
  findAppContainer,
  isDigestRef,
  isPlaceholderImage,
  listDockerImages,
  parseImageRef,
  resolveTag,
  sharedRegistryImage,
  sharedRegistryRepo
} from './gcp'
import { platformManifestDigest } from './oci'
import { servingRevision } from './cloudrun-traffic'

// The database-migrations job (see src/v2/deploy-cloudrun.js) runs the app
// image too, but it is refreshed *before* the rest of a deploy and executed;
// it is never a witness of what is currently serving. Skip it when reading a
// running image back out of an environment.
const DB_MIGRATE_JOB = 'db-migrate'

// A job's/service's `name` is a full resource path (projects/.../<kind>/<name>).
const shortName = resource => resource.split('/').pop()

// How every "nothing was resolved" error for a service-ful app ends, so it
// reads right for any caller: deploy-candidate carries on past it, promote
// stops on it.
const NEXT_STEPS =
  'Nothing was resolved, so a deploy to this environment goes ahead and a promote from it stops here. ' +
  'To promote, re-run deploy-candidate for the candidate, then promote.'

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
  const registry = sharedRegistryListing(projectName)
  const services = await cloudrunListServices(runtimeProject)
  core.info(`services in ${runtimeProject}: ${JSON.stringify(services.map(s => s.name))}`)

  // The services a deploy puts the app image on (see src/v2/deploy-cloudrun.js).
  const appServices = services.filter(service => findAppContainer(service.template?.containers ?? [], repo))

  let runningImage
  if (appServices.length > 0) {
    runningImage = await servingImage(appServices, repo, runtimeProject, registry)
    if (!runningImage) {
      throw new Error(
        `Could not find a running app container image in project ${runtimeProject}: no Cloud Run ` +
        'service has a ready revision serving the app image yet (a service still on the Cloud Run ' +
        `placeholder image has never been deployed). ${NEXT_STEPS}`
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

  // Anything outside the shared registry is a pre-v2 deployment: an image in
  // the app's old per-project registry, which is every app's state on its
  // first v2 deploy after v1. A serving revision reports it as a digest ref
  // even when the template names a tag, and that digest means nothing in the
  // shared registry, so there is nothing to compare against. Report "no
  // comparable deployment" instead of failing. This check comes before the
  // digest check for that reason.
  const { name, digest, tag } = parseImageRef(runningImage)
  if (name !== repo) {
    core.info(`running image ${runningImage} is a pre-v2 image outside the shared registry; nothing to compare`)
    return { image: runningImage, digest: '', tags: [] }
  }

  if (digest) {
    // Report tags opportunistically; a digest may simply carry none.
    const tags = await registry.tagsFor(digest).catch(() => [])
    return { image: runningImage, digest, tags }
  }

  // A tag ref (a job template can carry one): resolve it to the digest the tag
  // currently points at.
  core.info(`running image is a tag ref (${tag}); resolving to a digest`)
  const resolved = await resolveTag(projectName, tag)
  return resolved
}

// The app's images in the shared registry, listed at most once per resolve, so
// mapping a serving image back to its candidate and reporting its tags share
// one registry call.
function sharedRegistryListing (projectName) {
  let listing
  const images = () => {
    if (!listing) listing = listDockerImages(SHARED_PROJECT, sharedRegistryRepo(projectName))
    return listing
  }
  return {
    async tagsFor (digest) {
      return (await images()).find(image => parseImageRef(image.uri).digest === digest)?.tags ?? []
    },
    async digestFor (tag) {
      const match = (await images()).find(image => (image.tags ?? []).includes(tag))
      return match ? parseImageRef(match.uri).digest : null
    }
  }
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
// an image that never served everywhere in release-candidate. That includes a
// service added after the candidate was deployed, which is still on the
// placeholder: the candidate never ran there.
async function servingImage (services, repo, runtimeProject, registry) {
  const serving = []
  for (const service of services) {
    serving.push(await servingImageOf(service, repo))
  }

  for (const entry of serving) {
    if (entry.state === 'serving') await asDeployedImage(entry, repo, registry)
    if (entry.state !== 'split') warnIfTemplateDiffers(entry)
  }

  if (serving.every(entry => entry.state === 'none')) return null

  const untagged = serving.filter(entry => entry.untagged)
  if (untagged.length > 0) {
    const details = untagged.map(entry =>
      `${shortName(entry.service.name)} serves ${entry.image}, an untagged image that is neither the image ` +
      `its template names (${entry.templateImage ?? 'none'}) nor that image's linux/amd64 child` +
      (entry.manifestError ? ` (could not read the template's manifest: ${entry.manifestError})` : '')
    )
    throw new Error(
      `A Cloud Run service in ${runtimeProject} serves an image that cannot be traced to a candidate ` +
      `(${details.join('; ')}). ${NEXT_STEPS}`
    )
  }

  const images = new Set(serving.map(entry => entry.image))
  if (serving.every(entry => entry.state === 'serving') && images.size === 1) {
    return serving[0].image
  }

  const details = serving.map(entry => {
    const name = shortName(entry.service.name)
    if (entry.state === 'split') return `${name} splits its traffic between revisions`
    if (entry.state === 'none') return `${name} ${entry.reason}`
    return `${name} serves ${entry.image}`
  })
  const split = serving.some(entry => entry.state === 'split')
  throw new Error(
    `The Cloud Run services in ${runtimeProject} do not all serve one app image (${details.join('; ')}). ` +
    NEXT_STEPS +
    (split ? ' Where traffic is split by hand, send all of it to one revision first.' : '')
  )
}

// What one service is serving:
//   { state: 'serving', image }  one revision takes all traffic and runs the app image
//   { state: 'none', reason }    no ready revision, or the one serving has no app image
//   { state: 'split' }           traffic is split, so no single revision is serving
async function servingImageOf (service, repo) {
  const templateImage = findAppContainer(service.template?.containers ?? [], repo)?.image
  const target = servingRevision(service)
  if (target === 'split') {
    core.info(`${service.name}: traffic is split between revisions`)
    return { service, state: 'split' }
  }

  let image = null
  let reason = 'has no ready revision'
  if (target) {
    const revision = await cloudrunGetRevision(target)
    const container = findAppContainer(revision?.containers ?? [], repo)
    if (!container?.image) {
      reason = `serves revision ${shortName(target)}, which has no app container`
    } else if (isPlaceholderImage(container.image)) {
      reason = `still serves the Cloud Run placeholder image (revision ${shortName(target)})`
    } else {
      image = container.image
    }
  }

  if (!image) {
    core.info(`${service.name}: ${reason}`)
    return { service, state: 'none', reason, target, templateImage }
  }
  core.info(`app container image serving in ${target}: ${image}`)
  return { service, state: 'serving', image, target, templateImage }
}

// A revision reports the digest Cloud Run pulled. When the deploy named an
// image index (a multi-platform build), that is the index's linux/amd64 child,
// and the child carries none of the candidate's tags. Map it back to the index
// the service template names, so the service reads as serving the image that
// was deployed. A serving digest with no tags that is neither the template's
// image nor that image's child is marked `untagged`: nothing traces it to a
// candidate.
//
// The manifest is read only when it can matter, which is when the serving
// digest is not the template's digest. A healthy single-manifest service reads
// nothing extra. A read that fails (or an index with no linux/amd64 child) is
// logged and treated as "not the template's child", so the checks below still
// decide: a tagged image is reported, an untagged one fails the resolve.
async function asDeployedImage (entry, repo, registry) {
  const serving = parseImageRef(entry.image)
  if (serving.name !== repo || !serving.digest) return
  const template = entry.templateImage ? parseImageRef(entry.templateImage) : null
  const templateDigest = template?.name === repo
    ? template.digest ?? await registry.digestFor(template.tag)
    : null
  if (templateDigest === serving.digest) return

  if (templateDigest) {
    let child = null
    try {
      child = await platformManifestDigest(`${repo}@${templateDigest}`)
    } catch (error) {
      entry.manifestError = String(error?.message ?? error).split('\n')[0]
      core.warning(
        `${entry.service.name}: could not read the linux/amd64 image of its template ${repo}@${templateDigest}: ` +
        entry.manifestError
      )
    }
    if (child === serving.digest) {
      core.info(`${entry.service.name}: ${entry.image} is the linux/amd64 image of the index ${repo}@${templateDigest}`)
      entry.image = `${repo}@${templateDigest}`
      return
    }
  }
  if ((await registry.tagsFor(serving.digest)).length === 0) entry.untagged = true
}

function warnIfTemplateDiffers ({ service, state, image, reason, target, templateImage }) {
  if (!templateDiffers(templateImage, image)) return
  core.warning(
    `${service.name}: the service template names ${templateImage}, but ` +
    (state === 'serving' ? `the revision serving its traffic (${shortName(target)}) runs ${image}` : `the service ${reason}`) +
    '. A rollout looks stuck, failed or still in progress; going by what is serving.'
  )
}

// Does the template name a different image than the one serving? A revision
// always reports a digest, even when the template names a tag, so only a
// digest template can be compared like for like (same repo, same digest). A
// tag template would have to be resolved first, so it is never compared, and
// neither is the placeholder a new service starts on.
function templateDiffers (templateImage, image) {
  if (!templateImage || isPlaceholderImage(templateImage) || !isDigestRef(templateImage)) return false
  if (!image) return true
  if (!isDigestRef(image)) return false
  const template = parseImageRef(templateImage)
  const serving = parseImageRef(image)
  return template.name !== serving.name || template.digest !== serving.digest
}
