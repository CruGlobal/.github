import * as core from '@actions/core'

// The deploy gate's pipeline route, as the dispatch action uses it: a way for
// an app's pipeline to start a workflow in the shared deploy repo with the
// run's own GitHub OIDC token, so the app repo does not need to hold a token
// that can dispatch there.
//
// The request:
//
//   POST <gate-url>/pipeline
//   Authorization: Bearer <OIDC token for the audience <gate-url>/pipeline>
//   { "workflow": "deploy-candidate.yml", "inputs": { ...string values } }
//
// The run is not named in the body. GitHub signs the token's repository,
// ref, event, workflow_ref and job_workflow_ref, and the gate decides from
// those whether this job may start the workflow. So the job needs
// `permissions: id-token: write`.
//
// The gate's answers:
//   2xx                           started; the body names the run
//                                 {"project","workflow","target"?,"runUrl","runId"?,"message"}
//   5xx, or the code not_configured,
//   or no answer at all           tried again, then GateUnavailable
//   anything else                 GateRefused: the gate says no, and its
//                                 code and message are shown
//
// Each token works once: the gate refuses a token it has seen with
// token_replayed. So every try asks the runner for a fresh token.
//
// A try that gets no answer may still have reached the gate, and the gate
// may have started the workflow. Trying again, or falling back to the token
// (in src/dispatch.js), can then start it a second time. Both workflows this
// route starts take that: deploy-candidate queues behind the app's
// release-candidate lock and does nothing when release-candidate already
// runs the image, and a second build-failure notice is only a second
// message.
//
// The OIDC token is asked for the way core.getIDToken asks for it (the
// runner's ACTIONS_ID_TOKEN_REQUEST_URL with &audience=, the bearer
// ACTIONS_ID_TOKEN_REQUEST_TOKEN, the token in the answer's value, masked at
// once), but with fetch and a time limit, as src/v2/gate-claim.js does, so a
// token service that stops answering cannot hold the job.

export const GATE_WORKFLOWS = ['deploy-candidate.yml', 'notify-build-failure.yml']
export const GATE_ATTEMPTS = 3
export const GATE_TRY_TIMEOUT_MS = 20000
export const TOKEN_TRY_TIMEOUT_MS = 10000
// The wait before the second and the third try.
export const RETRY_DELAYS_MS = [2000, 5000]
const MAX_ANSWER_LENGTH = 64 * 1024
const MAX_MESSAGE_LENGTH = 500
const CODE = /^[a-z][a-z0-9_]{0,63}$/

// The gate did not take the request after every try. The dispatch action
// may fall back to github-token.
export class GateUnavailable extends Error {
  constructor (message) {
    super(message)
    this.name = 'GateUnavailable'
  }
}

// The gate answered, and said no. Never a reason to fall back: the request
// is not allowed, and the token would only get round that.
export class GateRefused extends Error {
  constructor (message, { status, code }) {
    super(message)
    this.name = 'GateRefused'
    this.status = status
    this.code = code
  }
}

// The gate-url input: the gate's base URL, like https://gate.example.com/gate.
// Returns null when it is empty, and otherwise the pipeline route, which is
// also the audience of the OIDC token sent to it. Only https, since the
// request carries the token, and nothing after the path, since the route is
// added to the end of it.
export function parseGateUrl (raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return null
  let url
  try {
    url = new URL(value)
  } catch {
    url = null
  }
  // A user name or password is refused without showing the value, which
  // would print it.
  if (url && (url.username || url.password)) {
    throw new Error('gate-url must be an https URL with no user name or password in it, like https://gate.example.com/gate')
  }
  if (!url || url.protocol !== 'https:' || !url.hostname || url.search || url.hash || /[?#]/.test(value)) {
    throw new Error(`gate-url must be an https URL with nothing after the path, like https://gate.example.com/gate, not '${value}'`)
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/pipeline`
  return { route: url.href, audience: url.href }
}

// Whether the runner will hand this job an OIDC token. It sets both
// variables only for a job with id-token: write.
export function oidcAvailable () {
  return Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Text from the gate, made safe for one line of the log.
function clean (text) {
  return String(text ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, MAX_MESSAGE_LENGTH)
}

// Why a fetch got no answer, in words for the log.
function noAnswer (error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `no answer within ${timeoutMs / 1000} seconds`
  const code = error?.cause?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? `no answer (${code})` : 'no answer'
}

// One request. Resolves { status, ok, body, code } for any answer, with body
// the parsed JSON (undefined when it is not JSON).
async function send (url, init, timeoutMs) {
  const response = await globalThis.fetch(url, {
    ...init,
    // A redirect is an answer, never followed: the bearer token goes to this
    // URL only.
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  let body
  try {
    body = text.length > MAX_ANSWER_LENGTH ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  const code = typeof body?.code === 'string' && CODE.test(body.code) ? body.code : ''
  return { status: response.status, ok: response.ok, body, code }
}

// A fresh OIDC token for audience, or throws with why there is none.
async function idToken (audience, timeoutMs) {
  const base = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  let answer
  try {
    answer = await send(`${base}&audience=${encodeURIComponent(audience)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${requestToken}`, accept: 'application/json' }
    }, timeoutMs)
  } catch (error) {
    throw new Error(`the runner's OIDC token service gave ${noAnswer(error, timeoutMs)}`, { cause: error })
  }
  const token = answer.ok ? answer.body?.value : undefined
  if (typeof token !== 'string' || token === '') {
    throw new Error(`the runner's OIDC token service answered HTTP ${answer.status} with no token`)
  }
  core.setSecret(token)
  return token
}

// The run link from a 2xx answer, when it is a plain https URL.
function runLink (body) {
  const value = body?.runUrl
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

// Ask the gate at route to start workflow with inputs. Resolves
// { runUrl, message } when it did (either may be ''). Throws GateRefused
// when the gate says no, and GateUnavailable when no try got an answer the
// gate meant. The caller has already checked oidcAvailable().
export async function gateDispatch ({ route, audience, workflow, inputs }, {
  attempts = GATE_ATTEMPTS,
  delaysMs = RETRY_DELAYS_MS,
  tryTimeoutMs = GATE_TRY_TIMEOUT_MS,
  tokenTryTimeoutMs = TOKEN_TRY_TIMEOUT_MS
} = {}) {
  const body = JSON.stringify({ workflow, inputs })
  let reason = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      const delay = delaysMs[Math.min(attempt - 2, delaysMs.length - 1)] ?? 0
      core.info(`the deploy gate did not take the request (${reason}); trying again in ${delay / 1000} seconds (${attempt}/${attempts})`)
      await pause(delay)
    }

    let token
    try {
      token = await idToken(audience, tokenTryTimeoutMs)
    } catch (error) {
      reason = error.message
      continue
    }

    let answer
    try {
      answer = await send(route, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body
      }, tryTimeoutMs)
    } catch (error) {
      reason = `the deploy gate gave ${noAnswer(error, tryTimeoutMs)}`
      continue
    }

    const { status, code } = answer
    if (answer.ok) {
      return { runUrl: runLink(answer.body), message: clean(answer.body?.message) }
    }
    if (status >= 500 || code === 'not_configured') {
      reason = `the deploy gate answered HTTP ${status}${code ? ` ${code}` : ''}`
      continue
    }
    const message = clean(answer.body?.message)
    throw new GateRefused(
      `the deploy gate refused to start ${workflow}: HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
      { status, code }
    )
  }
  throw new GateUnavailable(`the deploy gate did not take the request to start ${workflow} after ${attempts} tries (last: ${reason})`)
}
