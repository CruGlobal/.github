import * as core from '@actions/core'
import { ecrImageRef, ecrResolveDigest, ecrTagsForDigest } from './aws'
import { INDEX_KEY, readLiveRelease, staticSiteTarget } from './static-site'

// Resolve a static site's image to a digest reference in the shared ECR
// registry. A site's candidate is an image in the app's ECR repository, like an
// ECS app's, so tag mode is the same.
//
// mode=tag:         resolve <tag> against the app's ECR repo -> digest, and
//                   report every tag on that digest. A bare release number
//                   (release-<n>) finds its dated tag, as for ECS and Lambda.
// mode=environment: a bucket runs nothing, so "what is live" is what the last
//                   deploy recorded on index.html: its cru-digest metadata
//                   (./static-site.js). The tags are then that digest's tags
//                   in ECR.
//
// Returns { image, digest, tags } where `image` is a full ECR digest reference.
export async function resolveStatic ({ mode, projectName, tag, environment }) {
  if (mode === 'tag') {
    core.info(`resolving ECR tag "${tag}" for ${projectName}`)
    const { digest, tags } = await ecrResolveDigest(projectName, tag)
    return { image: ecrImageRef(projectName, digest), digest, tags }
  }

  if (mode === 'environment') {
    return resolveLiveRelease(projectName, environment)
  }

  throw new Error(`Unknown resolve mode "${mode}". Expected "tag" or "environment".`)
}

// How every "nothing is live" error ends, so it reads right for any caller:
// deploy-candidate carries on past it (the first deploy), promote stops on it.
const NEXT_STEPS =
  'Nothing was resolved, so a deploy to this environment goes ahead and a promote from it stops here. ' +
  'To promote, run deploy-candidate for a candidate first.'

async function resolveLiveRelease (projectName, environment) {
  const { bucket } = await staticSiteTarget(projectName, environment)
  const live = await readLiveRelease(bucket)
  if (!live) {
    throw new Error(`Nothing is live in ${environment} for ${projectName} yet: s3://${bucket}/${INDEX_KEY} does not exist. ${NEXT_STEPS}`)
  }
  if (!live.digest) {
    throw new Error(
      `s3://${bucket}/${INDEX_KEY} names no release (it has no cru-digest metadata), so pipeline v2 has not deployed ` +
      `${projectName} to ${environment} yet. ${NEXT_STEPS}`
    )
  }
  core.info(
    `s3://${bucket}/${INDEX_KEY} says ${environment} serves ${live.digest}` +
    ` (${live.revision || 'no revision recorded'}, sha ${live.sha || 'not recorded'})`
  )
  // Reported opportunistically: an ECR read that fails leaves the tags empty,
  // and a promote then stops for want of a candidate tag rather than guess one.
  const tags = await ecrTagsForDigest(projectName, live.digest).catch(() => [])
  return { image: ecrImageRef(projectName, live.digest), digest: live.digest, tags }
}
