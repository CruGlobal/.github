// The upload half of browser source maps, shared by both places that send them
// to the error tracker:
//
//   src/v2/sourcemaps.js          pipeline v2: the maps an app image carries,
//                                 uploaded at deploy, promote and rollback
//   src/flightdeck-sourcemaps.js  the flightdeck-sourcemaps action: the maps in
//                                 a directory of built files, uploaded from an
//                                 app's own workflow
//
// Each caller decides WHICH maps go and under WHICH chunk URL. This module only
// sends them: the Rollbar-compatible multipart post, retries for the failures
// worth retrying, a stop when the token is rejected, a few uploads at a time,
// and one time budget over all of it. There is one copy so that a fix to any of
// that reaches both callers.
import * as core from '@actions/core'

/** Where uploads go when nothing names an endpoint. */
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
 * are abandoned and the caller carries on.
 *
 * Pipeline v2 runs this on ROLLBACK, which is the emergency path, and an
 * unbounded step between an operator and a restored production is not
 * acceptable at any level of usefulness. The action runs it in a deploy job,
 * where the same reasoning holds on a smaller scale. ~40 maps normally finish
 * in seconds; the budget only bites when the ingestion service is slow or down,
 * and that is exactly when nobody wants to wait for it.
 */
export const BUDGET_MS = 3 * 60 * 1000

/** Attempts per map, first included. */
export const MAX_ATTEMPTS = 3
export const RETRY_BASE_DELAY_MS = 500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Whether a (trimmed) value can be sent as a code version. */
export function isUsableCodeVersion (version) {
  // eslint-disable-next-line no-control-regex
  return version !== '' && version.length <= MAX_VERSION_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(version)
}

/**
 * Compose the public URL of `target`, a path below `baseUrl`.
 *
 * Throws on anything that is not a plain relative path: an absolute path, a
 * `.`/`..`/empty segment, a backslash or a colon. `shown` is how the path is
 * named in the error, since a caller may have derived `target` from something
 * else (pipeline v2 strips a `.map` suffix first).
 */
export function publicUrl (baseUrl, target, shown = target) {
  // Segments are checked DECODED, because URL() decodes before it resolves: a
  // raw ".." is caught below, but so must "%2e%2e" be, or it walks up out of the
  // tree the path is supposed to mirror. A colon is refused outright — a first
  // segment containing one parses as a SCHEME, so "http:host/x.js" and
  // "javascript:alert(1).js" both resolve somewhere that is not this app, and no
  // chunk path has ever contained one.
  const invalid =
    target === '' ||
    target.startsWith('/') ||
    target.includes('\\') ||
    target.includes(':') ||
    target.split('/').some(segment => {
      const decoded = decodeSegment(segment)
      return decoded === null || decoded === '' || decoded === '.' || decoded === '..'
    })
  if (invalid) {
    throw new Error(
      `"${shown}" is not a usable source-map path — expected a relative path with no ` +
      'empty, ".", ".." or scheme-like segments.'
    )
  }

  // Always resolve against a directory: without the trailing slash, URL()
  // treats the base URL's last segment as a file and replaces it, so an app
  // served at https://host/app would lose the /app.
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const composed = new URL(target, base).toString()
  // The belt behind those checks. Whatever URL() made of the path, the result
  // has to still be under this app: a map uploaded against another host matches
  // no frame and reports nothing, which is the silent failure this step exists
  // to avoid.
  if (!composed.startsWith(base)) {
    throw new Error(`"${shown}" resolves to ${composed}, which is outside ${base}`)
  }
  return composed
}

// decodeURIComponent throws on a malformed escape. A segment we cannot decode is
// one we cannot check, so it is refused rather than trusted.
export function decodeSegment (segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// POST one map. Rollbar-compatible multipart: the token rides in a header, the
// map rides as a file part named `source_map`, and the code-version field is
// spelled `version` (NOT `code_version`, which is the spelling the occurrence
// payload uses).
//
// Content-Type is deliberately not set: fetch derives it from the FormData,
// boundary included, and setting it by hand produces a body the server cannot
// split.
async function postMap ({ url, token, version, minified, name, contents, timeoutMs, phase, readResult }) {
  const form = new FormData()
  form.append('version', version)
  form.append('minified_url', minified)
  form.append('source_map', new Blob([contents], { type: 'application/json' }), name)

  const response = await fetch(url, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: token },
    body: form,
    signal: phase ? AbortSignal.any([AbortSignal.timeout(timeoutMs), phase]) : AbortSignal.timeout(timeoutMs)
  })
  if (response.ok) {
    // A 200 says whether the server already held these exact bytes
    // ({"err":0,"result":{"unchanged":true}}). Only a caller that reports that
    // reads it: pipeline v2 counts landed maps and nothing more, and reading a
    // body it does not need would put one more wait on its rollback path. The
    // map has landed either way, so a body that cannot be read is not a
    // failure, just not known to be unchanged.
    if (!readResult) return { unchanged: false }
    const body = await response.json().catch(() => null)
    return { unchanged: body?.result?.unchanged === true }
  }

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
      // An aborted phase is the budget expiring, not a flake — and retryable()
      // treats an abort as retryable because no answer came back, so without
      // this the ceiling would be retried straight through.
      if (request.phase?.aborted) throw new Error('the upload budget ran out', { cause: error })
      // retryable() already refuses every 4xx, auth failures included.
      if (attempt >= attempts || !retryable(error)) throw error
      await sleep(retryDelayMs * 2 ** (attempt - 1))
    }
  }
}

/**
 * Upload prepared maps, a few at a time, inside one time budget.
 *
 * `maps` is a list of { minified, name, contents, file }: the public URL of the
 * chunk the map belongs to, the file name to send it under, its bytes, and how
 * to name it in a log line. The caller has already masked the token.
 *
 * Never throws for an expected condition. Returns
 *   landed        maps the server accepted, unchanged ones included
 *   unchanged     of those, the ones it said it already held byte for byte
 *                 (only counted with `readResult`)
 *   failed        maps attempted that did not land
 *   notAttempted  maps never sent, because a rejected token or the budget
 *                 stopped the run
 *   failures      { file, message } for each failed map
 */
export async function uploadMaps (maps, {
  endpoint,
  token,
  version,
  concurrency = CONCURRENCY,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  budgetMs = BUDGET_MS,
  attempts = MAX_ATTEMPTS,
  retryDelayMs = RETRY_BASE_DELAY_MS,
  readResult = false
}) {
  const result = { landed: 0, unchanged: 0, failed: 0, notAttempted: 0, failures: [] }
  if (maps.length === 0) return result

  // The per-map timeout bounds a single attempt; this bounds all of them
  // together, including retries and anything already in flight. Without it a
  // worker starting just under the deadline could run three more attempts past
  // it, and every worker could be doing that at once — on the rollback path,
  // where the budget exists to keep this step from standing between an operator
  // and a restored production.
  const deadline = Date.now() + budgetMs
  // Clamped: AbortSignal.timeout refuses a negative delay, and a budget already
  // spent is a legitimate caller input meaning "do not start".
  const phase = AbortSignal.timeout(Math.max(0, budgetMs))

  const queue = maps.map(map => ({
    url: endpoint,
    token,
    version,
    minified: map.minified,
    name: map.name,
    contents: map.contents,
    timeoutMs: requestTimeoutMs,
    phase,
    readResult,
    file: map.file
  }))
  core.info(`uploading ${queue.length} source map(s) for version ${version} to ${endpoint}`)

  let abort = null

  const worker = async () => {
    for (;;) {
      if (abort) return
      if (Date.now() >= deadline) return
      const request = queue.shift()
      if (!request) return
      try {
        const { unchanged } = await uploadWithRetries(request, { attempts, retryDelayMs })
        result.landed++
        if (unchanged) result.unchanged++
      } catch (error) {
        result.failed++
        result.failures.push({ file: request.file, message: error.message })
        core.warning(`source map ${request.file} not uploaded: ${error.message}`)
        if (fatal(error)) abort = error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, maps.length) }, worker))

  // Anything still queued was never attempted: an auth failure stopped the run,
  // or the budget ran out.
  if (queue.length > 0) {
    result.notAttempted = queue.length
    core.warning(
      abort
        ? `${queue.length} source map(s) not uploaded: the ingestion token was rejected (${abort.message}), ` +
          'so the remaining uploads would have failed identically.'
        : `${queue.length} source map(s) not uploaded: the ${Math.round(budgetMs / 1000)}s upload budget ran ` +
          'out. Every map that did land still resolves its own chunk; the deploy is unaffected.'
    )
  }
  return result
}
