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
// OIDC token for the gate's audience (core.getIDToken), and sends it as a
// bearer token. GitHub signs the token's repository, run id, run attempt and
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
//                                       GateClaimUnreadable for an answer it
//                                       cannot read
//
// authorize-actor shows only an error's name, so each failure here is named
// for what happened, and the gate's status and code go into the step's log
// as a warning. A refusal code is a fixed word from the gate; nothing else
// from its answer is shown.
//
// Time: authorize-actor gives the whole claim a time limit and aborts
// `signal` when it runs out. Each request to the gate also has its own
// timeout, so a socket is not left open to hold the step, and with it the
// production lock. A request that gets no answer, or a 5xx, is tried once
// more within that limit: a claim is safe to repeat, since a repeat of a
// claim that landed answers held.
//
// Two sockets can outlive an abort, each for a bounded time. Node's fetch
// keeps a connection it is still setting up (TCP or TLS) until its own
// 10-second connect timeout, abort or not; a connection that is up ends at
// once. The octokit requests in authorize-actor share that. And the OIDC
// token request is the toolkit's own (core.getIDToken), which takes no
// signal: the claim stops waiting for it when the signal aborts, and the
// toolkit's request ends on its own socket timeout. Both only delay the end
// of a step that has already refused.

export const CLAIM_ATTEMPTS = 2
export const CLAIM_TRY_TIMEOUT_MS = 4000
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

async function idToken (audience, signal) {
  let token
  try {
    token = await untilAborted(Promise.resolve().then(() => core.getIDToken(audience)), signal)
  } catch {
    if (signal?.aborted) throw signal.reason
    core.warning(process.env.ACTIONS_ID_TOKEN_REQUEST_URL
      ? 'the runner did not hand out a GitHub OIDC token for the deploy gate\'s claim'
      : 'the runner did not hand out a GitHub OIDC token for the deploy gate\'s claim; the job needs permissions: id-token: write')
    throw failure('IdTokenUnavailable', 'no GitHub OIDC token')
  }
  if (typeof token !== 'string' || token === '') {
    throw failure('IdTokenUnavailable', 'the GitHub OIDC token is empty')
  }
  return token
}

// The answer's status, its JSON (or undefined) and the refusal code in it.
async function readAnswer (response) {
  let text
  try {
    text = await response.text()
  } catch {
    return { status: response.status }
  }
  if (text.length > MAX_ANSWER_LENGTH) return { status: response.status }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { status: response.status }
  }
  const code = typeof body?.code === 'string' && CODE.test(body.code) ? body.code : ''
  return { status: response.status, body, code }
}

// The claimRequestId hook authorize-actor calls, for the gate at url (an
// https URL, checked by the caller) and an OIDC token for audience.
export function gateClaim ({ url, audience, attempts = CLAIM_ATTEMPTS, tryTimeoutMs = CLAIM_TRY_TIMEOUT_MS }) {
  return async function claimRequestId ({ claims, expired, signal }) {
    const token = await idToken(audience, signal)
    const body = JSON.stringify({
      requestId: claims.jti,
      app: claims.app,
      action: claims.action,
      target: claims.target,
      environment: claims.environment,
      expired: expired === true
    })
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw signal.reason
      const timeout = AbortSignal.timeout(tryTimeoutMs)
      let response, answer
      try {
        response = await globalThis.fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body,
          // The bearer token goes to this URL only, never where a redirect
          // points.
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        })
        answer = await readAnswer(response)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (attempt < attempts) {
          core.info(`the deploy gate's claim route did not answer (${error?.name === 'TimeoutError' ? `no answer within ${tryTimeoutMs / 1000} seconds` : 'no answer'}); trying again (${attempt + 1}/${attempts})`)
          await pause(RETRY_DELAY_MS, signal)
          continue
        }
        throw failure('GateClaimUnreachable', 'the deploy gate did not answer')
      }

      const { status, code } = answer
      if (response.ok) {
        const result = answer.body?.result
        if (typeof result === 'string') return result
        core.warning(`the deploy gate answered the claim with HTTP ${status} and no result it could read`)
        throw failure('GateClaimUnreadable', 'the deploy gate\'s answer has no result')
      }
      if (code === 'request_id_taken') throw new RequestIdTaken()
      if (code === 'request_expired') throw new RequestExpired()
      if (status >= 500 && attempt < attempts) {
        core.info(`the deploy gate's claim route answered HTTP ${status}${code ? ` (${code})` : ''}; trying again (${attempt + 1}/${attempts})`)
        await pause(RETRY_DELAY_MS, signal)
        continue
      }
      core.warning(`the deploy gate refused the claim: HTTP ${status}${code ? `, ${code}` : ''}`)
      throw failure('GateClaimRefused', 'the deploy gate refused the claim')
    }
  }
}
