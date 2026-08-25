import * as core from '@actions/core'

// Retry wrapper for the gRPC Google Cloud calls in src/gcp.js.
//
// Why this exists: a deploy died in production with
// "14 UNAVAILABLE: The service is currently unavailable" at the Cloud Run
// UpdateService call — a transient server-side blip that a single re-attempt
// would have ridden out. The generated Google clients retry only the methods
// their GAPIC config marks idempotent, and UpdateService, UpdateJob, ListJobs
// (Cloud Run) and ListSecrets (Secret Manager) are all classified
// non_idempotent, so they carry NO retry at all. One blip failed the whole run.
//
// The AWS side of the same deploy already has this tolerance: those clients run
// with maxAttempts 5 (src/aws.js). This is the same idea for the Google gRPC
// paths.
//
// Retry safety for the mutations: UpdateService and UpdateJob send a full
// DESIRED STATE, not a delta. If a first attempt actually landed server-side
// before the transport failed, the replay asks for exactly the state that is
// already there — a no-op update, not a second deploy. src/gcp.js builds the
// request (including the force-revision annotation) ONCE, outside the retry, so
// a replay is byte-identical and cannot mint a second revision on its own.
//
// Deliberately NOT retried here: RunJob (see src/gcp.js). A replayed RunJob can
// start a SECOND execution of a job whose first execution the server already
// accepted, and the only job a deploy executes is database migrations. Failing
// a rerunnable deploy beats running migrations twice.

/** gRPC status codes we care about (grpc.status). */
export const GRPC_UNKNOWN = 2
export const GRPC_DEADLINE_EXCEEDED = 4
export const GRPC_ABORTED = 10
export const GRPC_UNAVAILABLE = 14

const CODE_NAMES = {
  [GRPC_UNKNOWN]: 'UNKNOWN',
  [GRPC_DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [GRPC_ABORTED]: 'ABORTED',
  [GRPC_UNAVAILABLE]: 'UNAVAILABLE'
}

// Socket-level failures. grpc-js maps a connection it cannot classify to
// UNKNOWN (2) and keeps the original errno in the message/details; a bare Node
// error arrives with the errno as a string `code`. Both forms are the same
// "the network wobbled" event and are safe to replay for these calls.
const NETWORK_ERRNOS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN'
]

/** 5 attempts, ~2s base, total sleep capped at ~30s. */
export const DEFAULT_ATTEMPTS = 5
export const DEFAULT_BASE_DELAY_MS = 2000
export const DEFAULT_MAX_TOTAL_DELAY_MS = 30000

function networkErrno (error) {
  const haystack = [
    error.code,
    error.details,
    error.message,
    error.cause?.code,
    error.cause?.message
  ].filter(value => typeof value === 'string').join(' ')
  return NETWORK_ERRNOS.some(errno => haystack.includes(errno))
}

/**
 * Is this a transient failure worth replaying?
 *
 * UNAVAILABLE (14) is the canonical "the server is momentarily not there";
 * DEADLINE_EXCEEDED (4) is the same event seen from the client side. Anything
 * else — NOT_FOUND, PERMISSION_DENIED, INVALID_ARGUMENT, a plain Error from our
 * own validation — is a real answer and must propagate immediately.
 */
export function isTransientError (error) {
  if (error == null) return false
  const { code } = error
  if (code === GRPC_UNAVAILABLE || code === GRPC_DEADLINE_EXCEEDED) return true
  // A wrapped socket error: UNKNOWN, an errno string, or no code at all.
  if (code === GRPC_UNKNOWN || code === undefined || typeof code === 'string') {
    return networkErrno(error)
  }
  return false
}

/** ABORTED (10) — a concurrency conflict, handled at the call site. */
export function isAborted (error) {
  return error?.code === GRPC_ABORTED
}

function statusName (error) {
  return CODE_NAMES[error?.code] ?? (typeof error?.code === 'string' ? error.code : 'a transient error')
}

// Exponential backoff with equal jitter: half the window fixed, half random, so
// a fleet of runners riding out the same blip does not come back in lockstep.
function backoff (attempt, baseDelayMs) {
  const exponential = baseDelayMs * 2 ** (attempt - 1)
  return exponential / 2 + Math.random() * (exponential / 2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Run `fn` and replay it on transient gRPC failures.
 *
 * `fn` receives the 1-based attempt number, so a call site can tell a first
 * attempt from a replay (src/gcp.js uses it to decide what an ABORTED means).
 * A non-transient error propagates from the first attempt; exhausting the
 * attempts propagates the last error unchanged. Every retry logs a ::warning
 * annotation, so a run that only passed because of a retry says so.
 *
 * `maxTotalDelayMs` bounds the total time spent sleeping, not the number of
 * attempts: with the defaults the four backoffs sum to 15-30s.
 */
export async function retryTransient (label, fn, options = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxTotalDelayMs = DEFAULT_MAX_TOTAL_DELAY_MS
  } = options

  let budget = maxTotalDelayMs
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (attempt >= attempts || !isTransientError(error)) throw error
      const delay = Math.max(0, Math.min(backoff(attempt, baseDelayMs), budget))
      budget -= delay
      core.warning(
        `${label}: retrying after ${statusName(error)} (attempt ${attempt}/${attempts}) ` +
        `in ${Math.round(delay)}ms — ${error.message}`
      )
      await sleep(delay)
    }
  }
}
