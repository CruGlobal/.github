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

/** Where uploads go when the app container names no endpoint. */
export const DEFAULT_ENDPOINT = 'https://flightdeck.cru.org'

/** Path of the Rollbar-compatible source-map ingestion API. */
export const UPLOAD_PATH = '/api/1/sourcemap'

/** Header carrying the ingestion token. */
export const TOKEN_HEADER = 'X-Rollbar-Access-Token'

// A code version is a short opaque token (a build number, a release tag, a git
// sha). Whitespace and control characters cannot survive the round trip through
// a multipart field and a browser payload intact, and a 40-character ceiling
// comfortably covers a full git sha.
export const MAX_VERSION_LENGTH = 40

/**
 * Per-map ceiling. Real chunk maps are tens to a few hundred KB; a map that
 * exceeds this is a build accident (a whole vendor bundle, an inlined
 * `sourcesContent` of the world) and uploading it would spend the entire time
 * budget on one file.
 */
export const MAX_MAP_BYTES = 16 * 1024 * 1024

/** Uploads in flight at once. */
export const CONCURRENCY = 4

/** Per-request ceiling. */
export const REQUEST_TIMEOUT_MS = 60 * 1000

/**
 * Overall ceiling for the whole upload phase, after which the remaining maps
 * are abandoned and the deploy proceeds.
 *
 * This code path runs on ROLLBACK, which is the emergency path, and an
 * unbounded step between an operator and a restored production is not
 * acceptable at any level of usefulness. ~40 maps normally finish in seconds;
 * the budget only bites when the ingestion service is slow or down, and that is
 * exactly when nobody wants to wait for it.
 */
export const BUDGET_MS = 3 * 60 * 1000

/** Attempts per map, first included. */
export const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  // eslint-disable-next-line no-control-regex
  const invalid = version === '' || version.length > MAX_VERSION_LENGTH || /[\s\u0000-\u001f\u007f]/.test(version)
  if (invalid) {
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

  const invalid =
    target === '' ||
    target.startsWith('/') ||
    target.includes('\\') ||
    target.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (invalid) {
    throw new Error(
      `"${relativePath}" is not a usable source-map path — expected a relative path with no ` +
      'empty, "." or ".." segments.'
    )
  }

  // Always resolve against a directory: without the trailing slash, URL()
  // treats the app URL's last segment as a file and replaces it, so an app
  // served at https://host/app would lose the /app.
  const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`
  return new URL(target, base).toString()
}

/**
 * Full upload URL for this environment.
 *
 * Read from the app container's ROLLBAR_ENDPOINT, keeping only its ORIGIN: the
 * var holds whatever ingestion path the app's own reporter posts occurrences
 * to, which is not the source-map path. Falls back to the shared default when
 * the var is unset — the common case, since only apps pointed at something
 * other than the default set it.
 */
export function sourceMapsEndpoint (services, repo) {
  for (const service of services) {
    const app = findAppContainer(service.template?.containers ?? [], repo)
    const raw = app?.env?.find(entry => entry.name === ENDPOINT_ENV)?.value
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

// POST one map. Rollbar-compatible multipart: the token rides in a header, the
// map rides as a file part named `source_map`, and the code-version field is
// spelled `version` (NOT `code_version`, which is the spelling the occurrence
// payload uses).
//
// Content-Type is deliberately not set: fetch derives it from the FormData,
// boundary included, and setting it by hand produces a body the server cannot
// split.
async function postMap ({ url, token, version, minified, name, contents, timeoutMs }) {
  const form = new FormData()
  form.append('version', version)
  form.append('minified_url', minified)
  form.append('source_map', new Blob([contents], { type: 'application/json' }), name)

  const response = await fetch(url, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: token },
    body: form,
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (response.ok) return

  // Errors come back as {"err":1,"message":"..."} and the message is the whole
  // value of the failure: a map the parser rejected is a 422 that NAMES what it
  // could not parse. "HTTP 422" alone would send someone hunting for an
  // afternoon; the message usually makes it a five-minute fix.
  const body = await response.json().catch(() => null)
  const error = new Error(
    `HTTP ${response.status}${body?.message ? `: ${body.message}` : ` ${response.statusText || ''}`.trimEnd()}`
  )
  error.status = response.status
  throw error
}

// Which failures are worth another go. A 4xx is the server's considered answer
// about THIS request — a bad map, a bad version, a rejected token — and sending
// it again produces the same answer more slowly. 429 and 5xx are about the
// moment, and a network error never got an answer at all.
function retryable (error) {
  const { status } = error
  if (status === undefined) return true // network / abort: no answer received
  return status === 429 || status >= 500
}

// An auth failure is not per-map: every remaining upload carries the same
// token and would fail identically, so the run stops rather than spending the
// budget proving it 39 more times.
function fatal (error) {
  return error.status === 401 || error.status === 403
}

async function uploadWithRetries (request, { attempts, retryDelayMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await postMap(request)
    } catch (error) {
      // retryable() already refuses every 4xx, auth failures included.
      if (attempt >= attempts || !retryable(error)) throw error
      await sleep(retryDelayMs * 2 ** (attempt - 1))
    }
  }
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
        url: endpoint,
        token,
        version,
        minified: minifiedUrl(appUrl, file.name),
        name: file.name.split('/').pop(),
        contents: file.contents,
        timeoutMs: requestTimeoutMs,
        file: file.path
      })
    } catch (error) {
      core.warning(`skipping ${file.path}: ${error.message}`)
      result.skipped++
    }
  }

  const attempted = queue.length
  if (attempted === 0) return { ...result, reason: 'no-maps' }
  core.info(`uploading ${attempted} source map(s) for version ${version} to ${endpoint}`)

  const deadline = Date.now() + budgetMs
  let abort = null

  const worker = async () => {
    for (;;) {
      if (abort) return
      if (Date.now() >= deadline) return
      const request = queue.shift()
      if (!request) return
      try {
        await uploadWithRetries(request, { attempts, retryDelayMs })
        result.uploaded++
      } catch (error) {
        result.failed++
        result.failures.push({ file: request.file, message: error.message })
        core.warning(`source map ${request.file} not uploaded: ${error.message}`)
        if (fatal(error)) abort = error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, attempted) }, worker))

  // Anything still queued was never attempted: an auth failure stopped the run,
  // or the budget ran out.
  if (queue.length > 0) {
    result.skipped += queue.length
    core.warning(
      abort
        ? `${queue.length} source map(s) not uploaded: the ingestion token was rejected (${abort.message}), ` +
          'so the remaining uploads would have failed identically.'
        : `${queue.length} source map(s) not uploaded: the ${Math.round(budgetMs / 1000)}s upload budget ran ` +
          'out. Every map that did land still resolves its own chunk; the deploy is unaffected.'
    )
  }

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
