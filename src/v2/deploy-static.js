import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'
import { isPermanentAwsError, ssmParameterValue } from '../aws'
import { environmentNickname } from './env'
import {
  STATIC_DEPLOY_ROLE,
  cloudfrontCreateInvalidation,
  cloudfrontInvalidationStatus,
  ecrImageRef,
  ecrTagsForDigest,
  isAccessDenied,
  s3PutObject
} from './aws'
import { assertDigestRef, parseImageRef } from './image-ref'
import { openImage } from './oci'
import { POLL_INTERVAL_MS, STEP_CAP_MS, formatDuration, progressLogger, rolloutBudget } from './rollout-budget'
import { SOURCEMAPS_LABEL, publishSourceMaps, sourceMapsEndpointFor } from './sourcemaps'
import { INDEX_KEY, SITE_DIR, planSite, readLiveRelease, releaseMetadata, staticSiteTarget } from './static-site'

// Deploy a static site: copy the files a pre-built, digest-pinned image holds
// under /site into the environment's S3 bucket, and invalidate its CloudFront
// distribution. The bucket and distribution come from the app's app-info row
// (./static-site.js), and the image contract is described there too.
//
// THE ORDER IS THE WHOLE DESIGN. A browser that loaded the old index.html
// keeps asking for the old release's files, and one that loads the new
// index.html asks for the new release's at once. So:
//
//   1. Read the whole site out of the image first, without docker, and check
//      it. A site the deploy cannot copy whole fails here, with nothing changed.
//   2. Upload the content-hashed files. Their names are new, so no live page
//      asks for them yet, and this changes nothing a visitor sees.
//   3. Upload the source maps to Flightdeck, before any page can load the new
//      code and report an error against it. Same never-fails policy as the ECS
//      and Cloud Run deploys. It runs before anything a live page uses has
//      changed, so the minutes it can take are minutes of the old release
//      served whole.
//   4. Upload the files that are not hashed and not HTML. A live page may ask
//      for these by name (a service worker, a module federation entry, a
//      loader script), and they may name hashed files, which are all in place
//      by now. This is the first step a visitor can see.
//   5. Upload the HTML, index.html very last. index.html carries the release's
//      digest, revision and sha as metadata, so it is the record of which
//      release the bucket serves (resolve-image reads it back), and it only
//      changes once everything it points at is in place.
//   6. Invalidate /* and wait a bounded time. If the wait runs out, the deploy
//      still succeeds: the files are live at the origin, and the edges catch up
//      when the invalidation finishes.
//
// Nothing is ever deleted. A page already open in a browser still asks for the
// old release's hashed files, so they have to stay. Pruning is a separate job.
// The deploy role cannot delete anyway: the bucket policy grants it put, get
// and list only.
//
// WHEN IT FAILS. Before anything changes, the deploy reads which release
// index.html says is live. If the deploy then fails after it may have
// overwritten an object a live page uses (step 4 on), the files that release
// served under those names are put back from its own image, HTML last, and the
// step still fails. So a failed promote leaves production on the release the
// records name, as a failed ECS or Lambda deploy does. A failure in steps 2 and
// 3 needs nothing put back. A rollback (`stopRolloutOnFailure` false) puts
// nothing back, as on ECS and Lambda: going back would mean the release it is
// rolling away from.
//
// The uploads stop starting PUT_BACK_RESERVE_MS before the deploy step's own
// cap (./rollout-budget.js), so a put-back still has time to run and the steps
// that record the release still get theirs.
//
// Returns { deployedImage, services, sourcemaps }, where `services` names the
// bucket.

/** SSM parameter (under /ecs/<project>/<nick>/) holding the source-map upload token. */
export const SITE_TOKEN_PARAMETER = 'FLIGHTDECK_SOURCEMAP_TOKEN'

// The largest one file in a site may be. The whole layer is held in memory
// (./oci.js), so this is a sanity bound rather than a hard one: big enough for
// a video or a large bundle, small enough that a runaway build fails here
// rather than filling the runner. The layer caps in ./oci.js bound the site
// as a whole.
export const MAX_SITE_FILE_BYTES = 100 * 1024 * 1024

/** Uploads in flight at once. */
export const UPLOAD_CONCURRENCY = 8

// How long the deploy waits for CloudFront to finish the invalidation. They
// normally finish in a minute or two. The wait also never runs past the deploy
// step's own cap (./rollout-budget.js), so the steps that record the release
// always get to run.
export const INVALIDATION_WAIT_MS = 10 * 60 * 1000

// What the deploy's own uploads leave of the step's cap for a put-back.
export const PUT_BACK_RESERVE_MS = 5 * 60 * 1000

const INVALIDATION_PATHS = ['/*']

// `clock` holds `now`, `sleep` and `stepStartedAt`, for tests that drive the
// time limits through a fake clock.
export async function deployStatic ({ projectName, environment, image, appUrl, revision = '', stopRolloutOnFailure = true }, clock = {}) {
  assertDigestRef(image) // defensive; the router validates too
  const { digest } = parseImageRef(image)
  const nickname = environmentNickname(environment)
  // The deploy step's own cap, which every upload is bounded by.
  const step = rolloutBudget({ budgetMs: STEP_CAP_MS, ...clock })
  step.start()

  // --- Before anything changes ---------------------------------------------
  const { bucket, distributionId } = await nothingChangedIfItFails(() => staticSiteTarget(projectName, environment))
  core.info(`deploying ${image} to s3://${bucket} (CloudFront ${distributionId}), env ${environment} -> ${nickname}`)

  const handle = await openSiteImage(image)
  const site = await readSite(handle, image)
  core.info(
    `site: ${site.hashed.length} content-hashed files, ${site.unhashed.length} other files, ${site.html.length + 1} HTML files`
  )
  if (site.maps.length > 0) {
    core.info(`not uploading ${site.maps.length} .map files under ${SITE_DIR} to the bucket; source maps go under /cru/sourcemaps`)
  }

  // What was live before, so a failed deploy can put it back.
  const previous = await nothingChangedIfItFails(() => readLiveRelease(bucket))
  if (!previous) {
    core.info(`s3://${bucket}/${INDEX_KEY} does not exist yet, so this is the site's first deploy`)
  } else if (!previous.digest) {
    core.info(`s3://${bucket}/${INDEX_KEY} names no release, so pipeline v2 has not deployed this site before`)
  } else {
    core.info(`s3://${bucket} serves ${previous.revision || 'an unnamed release'} (${previous.digest})`)
  }

  const metadata = releaseMetadata({ digest, ...releaseIdentity(await ecrTagsForDigest(projectName, digest), revision) })

  // --- Changes ---------------------------------------------------------------
  const state = { overwrote: false, indexChanged: false }
  const limits = { step, reserveMs: PUT_BACK_RESERVE_MS }
  let invalidation
  let sourcemaps
  try {
    core.info(`uploading ${site.hashed.length} content-hashed files`)
    await uploadFiles(bucket, site.hashed, state, limits)

    sourcemaps = await uploadSourceMaps({ projectName, nickname, appUrl, handle })

    core.info(`uploading ${site.unhashed.length} other files`)
    await uploadFiles(bucket, site.unhashed, state, limits)

    core.info(`uploading ${site.html.length + 1} HTML files, ${INDEX_KEY} last`)
    await uploadFiles(bucket, site.html, state, limits)
    await uploadFiles(bucket, [{ ...site.index, metadata, isIndex: true }], state, limits)
    if (environment === 'release-candidate') {
      // In the log, for a step that is stopped from outside from here on and
      // so never reaches its own error message.
      core.info(`${INDEX_KEY} now names this release. If this step stops before it finishes, ${FORCE_ADVICE}`)
    }

    invalidation = await cloudfrontCreateInvalidation(distributionId, INVALIDATION_PATHS, callerReference())
    core.info(`created CloudFront invalidation ${invalidation} for ${INVALIDATION_PATHS.join(' ')} on ${distributionId}`)
  } catch (error) {
    let putBack = { index: false }
    if (state.overwrote) {
      if (stopRolloutOnFailure) {
        putBack = await putBackPrevious({ projectName, bucket, distributionId, previous, error, step })
      } else {
        addSentence(error, 'This is a rollback, so nothing was put back: the bucket holds part of this release ' +
          'over the one before. Run the rollback again once the cause is fixed.')
      }
    } else {
      addSentence(error, 'No file a live page uses had been changed yet.')
    }
    if (state.indexChanged && !putBack.index && environment === 'release-candidate') {
      addSentence(error, `${INDEX_KEY} may already name this release, so ${FORCE_ADVICE}`)
    }
    throw error
  }

  await waitForInvalidation(distributionId, invalidation, clock)
  return { deployedImage: image, services: [bucket], sourcemaps }
}

// What to do when a stage deploy did not finish but index.html names its
// release: deploy-candidate's no-op guard reads index.html, finds the release
// it wants already there, and would skip the deploy that never finished.
const FORCE_ADVICE = 'run deploy-candidate for it again with force set: without force, the run finds this release ' +
  'live and stops at "Already deployed", with the deploy unfinished.'

// Run a step that comes before any change, adding to its error that nothing
// was changed.
async function nothingChangedIfItFails (read) {
  try {
    return await read()
  } catch (error) {
    addSentence(error, 'Nothing was changed.')
    throw error
  }
}

async function openSiteImage (image) {
  try {
    return await openImage(image)
  } catch (error) {
    throw new Error(`Could not read the image ${image}: ${error.message}. Nothing was changed.`, { cause: error })
  }
}

async function readSite (handle, image) {
  try {
    return planSite(await handle.readTree(SITE_DIR, { maxBytes: MAX_SITE_FILE_BYTES }), { maxBytes: MAX_SITE_FILE_BYTES, image })
  } catch (error) {
    throw new Error(`Could not deploy the site in ${image}: ${error.message}. Nothing was changed.`, { cause: error })
  }
}

// The release's sha and name, for index.html's metadata. The sha is the
// sha-<gitsha> tag every candidate carries, as the ledger reads it. The name is
// the one the workflow passed (the candidate tag on a stage deploy, the release
// tag on a promote or rollback); an older workflow passes none, and then the
// image's own release or candidate tag stands in.
export function releaseIdentity (tags, revision = '') {
  const sha = (tags.find(tag => /^sha-[0-9a-f]{7,40}$/.test(tag)) ?? '').slice('sha-'.length)
  const name = revision.trim() ||
    tags.find(tag => /^release-/.test(tag)) ||
    tags.find(tag => /^candidate-/.test(tag)) ||
    ''
  return { revision: name, sha }
}

// Upload files a few at a time. The first failure stops new uploads from
// starting; the ones already in flight are let finish, so nothing is still
// writing once this throws.
//
// `state.overwrote` turns true once an object a live page may use (anything
// not content-hashed) may have been replaced: its upload worked, or it failed
// in a way that does not prove it did not land (a timeout on our side, a 5xx).
// A 4xx such as access denied is S3 refusing the write, so that one does not
// count. `state.indexChanged` is the same, for index.html alone. Every upload
// in flight has finished by the time this returns or throws, so the flags are
// complete when the caller reads them.
//
// No upload starts once the step's cap, less `reserveMs`, has come, and each
// one is given only the time left before it.
async function uploadFiles (bucket, files, state, { step, reserveMs = 0 }) {
  let next = 0
  let failure = null
  const changed = file => {
    if (!file.immutable) state.overwrote = true
    if (file.isIndex) state.indexChanged = true
  }
  const worker = async () => {
    while (failure === null && next < files.length) {
      const left = step.remaining(reserveMs)
      if (left <= 0) {
        failure = new Error(
          `The deploy step is within ${formatDuration(reserveMs)} of its ${formatDuration(STEP_CAP_MS)} cap, so ` +
          `no more uploads were started; ${next} of ${files.length} in this phase were.`
        )
        break
      }
      const file = files[next++]
      try {
        await s3PutObject(bucket, file.key, file.contents, {
          contentType: file.contentType,
          cacheControl: file.cacheControl,
          metadata: file.metadata,
          timeoutMs: left
        })
        changed(file)
      } catch (error) {
        if (!isPermanentAwsError(error.cause ?? error)) changed(file)
        if (failure === null) failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))
  if (failure !== null) throw failure
}

// Upload the browser source maps the image carries, never failing the deploy.
//
// The same policy as the ECS deploy's: no token means this environment is not
// wired for error tracking, which is a silent skip; anything else that goes
// wrong is a warning and the deploy carries on. The label is checked first
// because the image's labels are already in hand, so a site that ships no maps
// costs no SSM read. The token is the parameter /ecs/<project>/<nick>/
// FLIGHTDECK_SOURCEMAP_TOKEN, and the endpoint is the default one, since a
// static site has no container to declare another.
async function uploadSourceMaps ({ projectName, nickname, appUrl, handle }) {
  const skipped = { status: 'skipped', uploaded: 0, failed: 0 }
  if (handle.labels?.[SOURCEMAPS_LABEL] == null) return skipped

  const parameter = `/ecs/${projectName}/${nickname}/${SITE_TOKEN_PARAMETER}`
  try {
    let token
    try {
      token = await ssmParameterValue(parameter)
    } catch (error) {
      if (!isAccessDenied(error)) throw error
      throw new Error(
        `${error.message} (the ${STATIC_DEPLOY_ROLE} role's policy must allow ssm:GetParameters on ${parameter})`,
        { cause: error }
      )
    }
    if (!token) return skipped
    return await publishSourceMaps({ oci: handle, appUrl, token, endpoint: sourceMapsEndpointFor([]) })
  } catch (error) {
    core.warning(`source maps not uploaded (deploy unaffected): ${error.message}`)
    return { status: 'failed', uploaded: 0, failed: 0 }
  }
}

// Unique per call, so each deploy (and a put-back after it) gets an
// invalidation of its own, and fixed for the call, so the SDK's retries of it
// cannot start a second one.
function callerReference () {
  return `cru-pipeline-v2-${randomUUID()}`
}

// Put back what the release that was live before served under the names this
// deploy may have overwritten: its unhashed files, then its HTML, index.html
// last with its own metadata. Content-hashed files need nothing, since this
// deploy never changed one a page of that release asks for.
//
// Never throws: it adds what it did, or why it could not, to the deploy's own
// error, which the caller then throws. Returns { index }, true when index.html
// was put back and so names the release before again.
async function putBackPrevious ({ projectName, bucket, distributionId, previous, error, step }) {
  const state = { overwrote: false, indexChanged: false }
  if (!previous?.digest) {
    addSentence(error, `Pipeline v2 had not deployed this site before, so there was no release to put back: s3://${bucket} ` +
      'now holds part of this one.')
    return { index: false }
  }
  const name = previous.revision || previous.digest
  const previousImage = ecrImageRef(projectName, previous.digest)
  core.warning(`the deploy failed after it may have changed files a live page uses; putting back ${name} (${previous.digest})`)
  try {
    const handle = await openImage(previousImage)
    const site = planSite(await handle.readTree(SITE_DIR, { maxBytes: MAX_SITE_FILE_BYTES }), {
      maxBytes: MAX_SITE_FILE_BYTES,
      image: previousImage
    })
    const limits = { step, reserveMs: 0 }
    await uploadFiles(bucket, site.unhashed, state, limits)
    await uploadFiles(bucket, site.html, state, limits)
    await uploadFiles(bucket, [{ ...site.index, metadata: releaseMetadata(previous) }], state, limits)
  } catch (putBackError) {
    addSentence(error, `Putting back ${name} (${previous.digest}) failed as well: ${putBackError.message.replace(/\.$/, '')}. ` +
      `s3://${bucket} may serve a mix of the two releases until a deploy or rollback finishes.`)
    return { index: false }
  }
  try {
    await cloudfrontCreateInvalidation(distributionId, INVALIDATION_PATHS, callerReference())
  } catch (invalidationError) {
    addSentence(error, `The files ${name} served were put back in s3://${bucket}, but invalidating CloudFront ` +
      `afterwards failed (${invalidationError.message}), so its edges may serve this release's HTML until their ` +
      'cache expires.')
    return { index: true }
  }
  addSentence(error, `The files ${name} served were put back in s3://${bucket}, so it serves ${name} again.`)
  return { index: true }
}

// Add a sentence to an error's message, ending the one before it first: the
// causes come from S3, CloudFront and the image reader, and not all of them
// end with a full stop.
function addSentence (error, sentence) {
  error.message = `${/[.!?]$/.test(error.message) ? error.message : `${error.message}.`} ${sentence}`
}

// Wait for the invalidation, within INVALIDATION_WAIT_MS and the step's cap.
// Never throws: the files are live at the origin by now, so a wait that runs
// out, or a status read that fails, is a warning and the deploy is done.
async function waitForInvalidation (distributionId, id, clock) {
  if (!id) {
    core.warning(`CloudFront did not say which invalidation it made on ${distributionId}, so the deploy does not wait for it`)
    return
  }
  const budget = rolloutBudget({ budgetMs: INVALIDATION_WAIT_MS, ...clock })
  budget.start()
  const progress = progressLogger(budget)
  for (;;) {
    let status
    try {
      status = await cloudfrontInvalidationStatus(distributionId, id)
    } catch (error) {
      core.warning(
        `could not check CloudFront invalidation ${id}: ${error.message.replace(/\.$/, '')}. The files are live at the ` +
        'origin, so the deploy is done; the edges serve them once the invalidation finishes.'
      )
      return
    }
    if (status === 'Completed') {
      core.info(`CloudFront invalidation ${id} completed after ${formatDuration(budget.elapsed())}`)
      return
    }
    const left = budget.remaining()
    if (left <= 0) {
      core.warning(
        `CloudFront invalidation ${id} on ${distributionId} had not completed after ${formatDuration(budget.elapsed())}. ` +
        'The files are live at the origin, so the deploy is done; the edges may serve cached copies until it finishes.'
      )
      return
    }
    progress(`waiting for CloudFront invalidation ${id} (${status ?? 'unknown'}, ${formatDuration(budget.elapsed())} so far)`)
    await budget.sleep(Math.min(POLL_INTERVAL_MS, left))
  }
}
