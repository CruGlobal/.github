import * as core from '@actions/core'
import { RequestIdTaken } from './signed-request.js'

// The one-time request id store, as authorize-actor uses it: the deploy
// gate's claim route. The gate wrote a record for each request when it signed
// it, and this asks the gate to bind that record to this run attempt. The
// rules it applies are the ones above the claimRequestId call in
// src/authorize-actor.js; the gate applies them with its own clock, and only
// the gate writes its table.
//
// The run is not named in the request. The job asks the runner for a GitHub
// OIDC token for the gate's audience, and sends it as a bearer token. GitHub
// signs the token's repository, run id, run attempt, workflow_ref and
// job_workflow_ref, so the gate takes the run from there, and checks the
// workflow is a deploy workflow for the request's action. The job needs
// `permissions: id-token: write`; without it the runner hands out no token,
// and the claim fails.
//
// The body is what authorize-actor already verified in the signed request:
//
//   { "requestId": jti, "app", "action", "target", "environment",
//     "expired": true when the runner's clock says the request expired }
//
// The gate's answers:
//   200 {"result": "claimed" | "held"}  returned as is; authorize-actor
//                                       decides which answers pass
//   code request_id_taken               throws RequestIdTaken
//   code request_expired                throws RequestExpired
//   anything else                       throws GateClaimRefused, or
//                                       GateClaimUnreadable for a 2xx it
//                                       cannot read
//
// authorize-actor shows only an error's name, so each failure here is named
// for what happened, and the gate's status and code go into the step's log
// as a warning. A refusal code is a fixed word from the gate; nothing else
// from its answer is shown.
//
// Time: authorize-actor gives the whole claim a time limit and aborts
// `signal` when it runs out. Each request here also has its own timeout, so
// a socket is not left open to hold the step, and with it the production
// lock. A request that gets no answer, or a 5xx, is tried once more within
// that limit: a claim is safe to repeat, since a repeat of a claim that
// landed answers held.
//
// The OIDC token is asked for the way core.getIDToken asks for it (the
// runner's ACTIONS_ID_TOKEN_REQUEST_URL with &audience=, the bearer
// ACTIONS_ID_TOKEN_REQUEST_TOKEN, the token in the answer's value, masked at
// once), but with fetch, so it takes the signal. The toolkit's own request
// takes none, and its socket outlives an abort: three minutes, or until the
// job's timeout when the other end stops reading, all inside the production
// lock.
//
// One delay is left, and it is bounded: Node's fetch keeps a connection it
// is still setting up (TCP or TLS) until its own 10-second connect timeout,
// abort or not. A connection that is up ends at once. The octokit requests
// in authorize-actor share that. It only delays the end of a step that has
// already refused.

export const CLAIM_ATTEMPTS = 2
export const CLAIM_TRY_TIMEOUT_MS = 6000
export const TOKEN_TRY_TIMEOUT_MS = 4000
const RETRY_DELAY_MS = 500
const MAX_ANSWER_LENGTH = 64 * 1024
const CODE = /^[a-z][a-z0-9_]{0,63}$/

// The signed request is expired by the gate's clock, so it will not bind or
// move its id. Named for authorize-actor, which shows the name.
export class RequestExpired extends Error {
  constructor (message = 'the deploy gate says the signed request has expired') {
    super(message)
    this.name = 'RequestExpired'
  }
}

function failure (name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

// Wait for promise, or stop when signal aborts, with its reason.
function untilAborted (promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  let onAbort
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}

const pause = (ms, signal) => untilAborted(new Promise((resolve) => setTimeout(resolve, ms)), signal)

// One request, tried up to `attempts` times, each with its own timeout as
// well as `signal`. Resolves { status, ok, body, code } for any answer, with
// body the parsed JSON (undefined when it is not JSON). Tries again only
// when there was no answer (no response, or a body that could not be read)
// or a 5xx. Throws signal.reason when the signal aborts, and a failure named
// unreachable when no try got an answer.
async function send (url, init, { signal, attempts, timeoutMs, what, unreachable }) {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason
    const timeout = AbortSignal.timeout(timeoutMs)
    let answer
    try {
      const response = await globalThis.fetch(url, {
        ...init,
        // A redirect is an answer, never followed: the bearer token goes to
        // this URL only.
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      const text = await response.text()
      let body
      try {
        body = text.length > MAX_ANSWER_LENGTH ? undefined : JSON.parse(text)
      } catch {
        body = undefined
      }
      const code = typeof body?.code === 'string' && CODE.test(body.code) ? body.code : ''
      answer = { status: response.status, ok: response.ok, body, code }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (attempt < attempts) {
        core.info(`${what} did not answer (${error?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} seconds` : 'no answer'}); trying again (${attempt + 1}/${attempts})`)
        await pause(RETRY_DELAY_MS, signal)
        continue
      }
      throw failure(unreachable, `${what} did not answer`)
    }
    if (answer.status >= 500 && attempt < attempts) {
      core.info(`${what} answered HTTP ${answer.status}${answer.code ? ` (${answer.code})` : ''}; trying again (${attempt + 1}/${attempts})`)
      await pause(RETRY_DELAY_MS, signal)
      continue
    }
    return answer
  }
}

// The runner's OIDC token for audience. See the notes above.
async function idToken (audience, { signal, attempts, timeoutMs }) {
  const base = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!base || !requestToken) {
    core.warning('the runner did not hand out a GitHub OIDC token for the deploy gate\'s claim; the job needs permissions: id-token: write')
    throw failure('IdTokenUnavailable', 'no GitHub OIDC token')
  }
  const answer = await send(`${base}&audience=${encodeURIComponent(audience)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${requestToken}`, accept: 'application/json' }
  }, { signal, attempts, timeoutMs, what: 'the runner\'s OIDC token service', unreachable: 'IdTokenUnavailable' })
  const token = answer.ok ? answer.body?.value : undefined
  if (typeof token !== 'string' || token === '') {
    core.warning(`the runner did not hand out a GitHub OIDC token for the deploy gate's claim (HTTP ${answer.status})`)
    throw failure('IdTokenUnavailable', 'no GitHub OIDC token')
  }
  core.setSecret(token)
  return token
}

// The claimRequestId hook authorize-actor calls, for the gate at url (an
// https URL, checked by the caller) and an OIDC token for audience.
export function gateClaim ({ url, audience, attempts = CLAIM_ATTEMPTS, tryTimeoutMs = CLAIM_TRY_TIMEOUT_MS, tokenTryTimeoutMs = TOKEN_TRY_TIMEOUT_MS }) {
  return async function claimRequestId ({ claims, expired, signal }) {
    if (signal?.aborted) throw signal.reason
    const token = await idToken(audience, { signal, attempts, timeoutMs: tokenTryTimeoutMs })
    const answer = await send(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        requestId: claims.jti,
        app: claims.app,
        action: claims.action,
        target: claims.target,
        environment: claims.environment,
        expired: expired === true
      })
    }, { signal, attempts, timeoutMs: tryTimeoutMs, what: 'the deploy gate\'s claim route', unreachable: 'GateClaimUnreachable' })

    const { status, code } = answer
    if (answer.ok) {
      const result = answer.body?.result
      if (typeof result === 'string') return result
      core.warning(`the deploy gate answered the claim with HTTP ${status} and no result it could read`)
      throw failure('GateClaimUnreadable', 'the deploy gate\'s answer has no result')
    }
    if (code === 'request_id_taken') throw new RequestIdTaken()
    if (code === 'request_expired') throw new RequestExpired()
    core.warning(`the deploy gate refused the claim: HTTP ${status}${code ? `, ${code}` : ''}`)
    throw failure('GateClaimRefused', 'the deploy gate refused the claim')
  }
}
