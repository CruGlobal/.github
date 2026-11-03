// Upload the browser source maps that ship inside the app image, so a minified
// stack frame from production resolves to original source.
//
// Background: this is the sibling of src/v2/signin.js and exists for the same
// reason. Source maps are a per-build artifact that must be registered with the
// error tracker under the code version the browser reports, and the obvious
// place to do that — a step in the app repo's build workflow — does not survive
// v2. Production promotes an ALREADY-BUILT image, so no app-repo workflow fires
// on a prod deploy, and a rollback would leave the tracker holding maps for a
// build that is no longer running. So the maps travel *in the image* and the
// deploy uploads them: same artifact, same digest, promote and rollback carry
// the matching maps for free.
//
// Contract with the app image:
//   LABEL org.cru.sourcemaps=<code_version>
//   COPY  <built maps> /cru/sourcemaps/<public url path>.map
//
// The directory MIRRORS THE PUBLIC URL PATH. A map staged at
// /cru/sourcemaps/_next/static/chunks/abc.js.map is declared as the map for
// https://<app url>/_next/static/chunks/abc.js — that rule is the whole URL
// story, and it is the app build's job to make the staged names match the
// served chunk names. Nothing here knows about Next, Vite, webpack or any other
// bundler; this step runs for the whole fleet and must stay bundler-agnostic.
//
// The label value is the code version the app's browser reporter sends with an
// occurrence. It has to match exactly or the tracker holds maps it will never
// look up, which is why the label — not a build number this action happens to
// know — is the single source of truth.
import * as core from '@actions/core'
import { findAppContainer } from './gcp'
import {
  BUDGET_MS,
  CONCURRENCY,
  DEFAULT_ENDPOINT,
  MAX_ATTEMPTS,
  MAX_MAP_BYTES,
  MAX_VERSION_LENGTH,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  UPLOAD_PATH,
  isUsableCodeVersion,
  publicUrl,
  uploadMaps
} from '../sourcemap-upload'

// The upload itself (the multipart post, retries, concurrency, the time budget
// and the log lines about them) lives in src/sourcemap-upload.js, shared with
// the flightdeck-sourcemaps action. Its constants are re-exported here, where
// pipeline v2 has always read them.
export {
  BUDGET_MS,
  CONCURRENCY,
  DEFAULT_ENDPOINT,
  MAX_ATTEMPTS,
  MAX_MAP_BYTES,
  MAX_VERSION_LENGTH,
  REQUEST_TIMEOUT_MS,
  TOKEN_HEADER,
  UPLOAD_PATH
} from '../sourcemap-upload'

/** Image label naming the code version. Absent = this app ships no maps. */
export const SOURCEMAPS_LABEL = 'org.cru.sourcemaps'

/** Conventional directory the maps are COPYed to inside the image. */
export const SOURCEMAPS_IMAGE_DIR = '/cru/sourcemaps'

/**
 * Runtime secret holding the app's SERVER-scope ingestion token for the
 * environment being deployed to. Its ABSENCE is the signal that this
 * environment is not wired for error tracking — a silent no-op, not a warning:
 * most environments of most apps have no such secret, and warning about it on
 * every deploy would train everyone to ignore the annotation.
 */
export const TOKEN_SECRET = 'ROLLBAR_ACCESS_TOKEN'

/** Env var on the app container naming the ingestion endpoint. */
export const ENDPOINT_ENV = 'ROLLBAR_ENDPOINT'

/**
 * Read and validate the code version from an image's labels.
 *
 * Returns null when the image carries no source-map label — the overwhelmingly
 * common case, and the one that must cost nothing. Throws when the label is
 * present but unusable; the caller turns that into a warning and a skip, since
 * a bad label is a build bug and not a reason to fail a deploy.
 */
export function sourceMapsVersion (labels) {
  const raw = labels?.[SOURCEMAPS_LABEL]
  if (raw == null) return null

  const version = raw.trim()
  if (!isUsableCodeVersion(version)) {
    throw new Error(
      `Image label ${SOURCEMAPS_LABEL}="${raw}" is not a usable code version — expected 1-` +
      `${MAX_VERSION_LENGTH} characters with no whitespace or control characters.`
    )
  }
  return version
}

/**
 * Compose the public URL of the minified file a staged map belongs to.
 *
 * `relativePath` is the map's path BELOW /cru/sourcemaps — which mirrors the
 * public URL path — so the answer is that path minus its trailing `.map`,
 * resolved against the environment's app URL. That is the entire rule.
 *
 * Throws on anything that is not a plain relative `.map` path: an absolute
 * path, a `.`/`..`/empty segment, or a non-map file. The caller reports and
 * skips.
 */
export function minifiedUrl (appUrl, relativePath) {
  if (!relativePath.endsWith('.map')) {
    throw new Error(`"${relativePath}" is not a source map (expected a .map file)`)
  }
  // Exactly one suffix: a file staged as "abc.js.map.map" is declaring itself
  // the map of "abc.js.map", odd as that is, and guessing otherwise would
  // silently upload it against the wrong URL.
  const target = relativePath.slice(0, -'.map'.length)

  // The path checks and the stays-under-the-app check are shared with the
  // flightdeck-sourcemaps action, and name the staged .map path when they
  // refuse it.
  return publicUrl(appUrl, target, relativePath)
}

/**
 * Full upload URL for this environment, given the ROLLBAR_ENDPOINT values the
 * app container declares — one per place it could be declared, best first.
 *
 * Only the ORIGIN of the first value present is kept: the var holds whatever
 * ingestion path the app's own reporter posts occurrences to, which is not the
 * source-map path. Falls back to the shared default when nothing names one —
 * the common case, since only apps pointed at something other than the default
 * set it.
 *
 * Takes raw values rather than a service or a task definition, because the two
 * runtimes shape their container definitions differently and neither shape
 * belongs in here. Each runtime's deploy digs out its own values; this decides
 * what they mean.
 */
export function sourceMapsEndpointFor (rawValues) {
  for (const raw of rawValues) {
    if (!raw) continue
    try {
      return `${new URL(raw).origin}${UPLOAD_PATH}`
    } catch {
      core.warning(`${ENDPOINT_ENV}="${raw}" is not a URL; uploading source maps to ${DEFAULT_ENDPOINT} instead.`)
      break
    }
  }
  return `${DEFAULT_ENDPOINT}${UPLOAD_PATH}`
}

/** sourceMapsEndpointFor, reading Cloud Run services. */
export function sourceMapsEndpoint (services, repo) {
  return sourceMapsEndpointFor(services.map(service => {
    const app = findAppContainer(service.template?.containers ?? [], repo)
    return app?.env?.find(entry => entry.name === ENDPOINT_ENV)?.value
  }))
}

/**
 * Extract the browser source maps from a digest-pinned image and upload them.
 *
 * `oci` is an OPEN image handle (src/v2/oci.js) rather than a reference, so the
 * caller can share one handle — and its layer cache — with the sign-in publish.
 *
 * Never throws for an expected condition; the result says what happened:
 *   skipped  nothing was attempted (no label, no app URL, no maps in the image)
 *   uploaded every map landed
 *   partial  some landed
 *   failed   none landed, though some were attempted
 */
export async function publishSourceMaps ({
  oci,
  appUrl,
  token,
  endpoint = `${DEFAULT_ENDPOINT}${UPLOAD_PATH}`,
  maxMapBytes = MAX_MAP_BYTES,
  concurrency = CONCURRENCY,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  budgetMs = BUDGET_MS,
  attempts = MAX_ATTEMPTS,
  retryDelayMs = RETRY_BASE_DELAY_MS
} = {}) {
  // Before anything that could put it in a log line, an error message or an
  // annotation. Everything below this line is allowed to be loud.
  if (token) core.setSecret(token)

  const result = { status: 'skipped', version: null, endpoint, uploaded: 0, failed: 0, skipped: 0, failures: [] }
  if (!token) return { ...result, reason: 'no-token' }

  let version
  try {
    version = sourceMapsVersion(oci.labels)
  } catch (error) {
    core.warning(`source maps not uploaded (deploy unaffected): ${error.message}`)
    return { ...result, reason: 'invalid-label' }
  }
  if (version === null) return { ...result, reason: 'no-label' }
  result.version = version

  if (!appUrl) {
    core.warning(
      `${SOURCEMAPS_LABEL}="${version}" declares browser source maps, but this environment has no app URL ` +
      'to resolve them against, so they cannot be uploaded.'
    )
    return { ...result, reason: 'no-app-url' }
  }

  const files = await oci.readDir(SOURCEMAPS_IMAGE_DIR, { maxBytes: maxMapBytes })
  if (files.length === 0) {
    core.warning(
      `Image declares ${SOURCEMAPS_LABEL}="${version}" but has no files under ${SOURCEMAPS_IMAGE_DIR}. ` +
      'The Dockerfile must COPY the built maps there.'
    )
    return { ...result, reason: 'no-files' }
  }

  // Everything under the prefix ending in .map is a map; anything else is
  // reported and left alone, because the directory's whole meaning is "these
  // are maps" and a stray file there is a build mistake worth seeing.
  const queue = []
  for (const file of files) {
    if (!file.name.endsWith('.map')) {
      core.warning(`ignoring ${file.path}: not a .map file`)
      continue
    }
    if (file.contents === null) {
      core.warning(`skipping ${file.path}: ${file.size} bytes, over the ${maxMapBytes}-byte limit`)
      result.skipped++
      continue
    }
    try {
      queue.push({
        minified: minifiedUrl(appUrl, file.name),
        name: file.name.split('/').pop(),
        contents: file.contents,
        file: file.path
      })
    } catch (error) {
      core.warning(`skipping ${file.path}: ${error.message}`)
      result.skipped++
    }
  }

  if (queue.length === 0) {
    // An app that ships no maps and an app whose every map was unusable both
    // upload nothing, but only the second is a build mistake. Reading the same
    // on the action output would hide it.
    return result.skipped > 0
      ? { ...result, status: 'failed', reason: 'no-usable-maps' }
      : { ...result, reason: 'no-maps' }
  }

  const upload = await uploadMaps(queue, {
    endpoint, token, version, concurrency, requestTimeoutMs, budgetMs, attempts, retryDelayMs
  })
  result.uploaded = upload.landed
  result.failed = upload.failed
  result.failures = upload.failures
  // Never attempted, because a rejected token or the budget stopped the run.
  result.skipped += upload.notAttempted

  // `uploaded` means EVERY map this image ships landed, so a map skipped for
  // being oversized or unusably named makes the run partial just as a failed
  // one does. A non-.map file under the prefix does not: it was never a map.
  result.status = result.uploaded === 0
    ? 'failed'
    : (result.failed + result.skipped > 0 ? 'partial' : 'uploaded')
  core.info(
    `source maps ${result.status}: ${result.uploaded} uploaded, ${result.failed} failed, ${result.skipped} skipped`
  )
  return result
}
