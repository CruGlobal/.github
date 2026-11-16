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
// The gate's answers, decided on the HTTP status first:
//   202 naming the workflow   started; the JSON body names the run
//                             {"project","workflow","target"?,"runUrl","runId"?,"message"}
//   any other 2xx             GateMayHaveStarted: not the gate's answer to a
//                             start (gate-url may point somewhere else), or
//                             a 202 whose body never arrived. Something said
//                             yes, so it is never tried again or sent with
//                             the token
//   5xx, 408, 429,
//   or no answer at all       tried again, then GateUnavailable
//   anything else             GateRefused: the gate says no, and its code
//                             and message are shown
//
// The gate says not_configured with a 503. A not_configured with a 4xx is
// not the gate being unready but a refusal like any other 4xx.
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
// message. A 2xx is different: once one comes in, something answered yes,
// and nothing here tries again or falls back, whatever the rest of the answer
// holds. The person reading the failure checks the deploy repo's runs.
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
// The wait before the second and the third try. Together they are all the
// tries wait, a Retry-After from the gate included.
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

// The gate, or something at gate-url, answered with a 2xx that is not the
// gate's answer to a start, or whose body did not arrive. Something may have
// started, so this is never a reason to try again or fall back.
export class GateMayHaveStarted extends Error {
  constructor (message, { status }) {
    super(message)
    this.name = 'GateMayHaveStarted'
    this.status = status
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
  const code = errorCode(error)
  return code ? `no answer (${code})` : 'no answer'
}

// Why the body of an answer could not be read, in words for the log.
function bodyLost (error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `did not arrive within ${timeoutMs / 1000} seconds`
  const code = errorCode(error)
  return code ? `broke off (${code})` : 'broke off'
}

function errorCode (error) {
  const code = error?.cause?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : ''
}

class TimeLimitReached extends Error {
  constructor (timeoutMs) {
    super(`no answer within ${timeoutMs / 1000} seconds`)
    this.name = 'TimeoutError'
  }
}

// promise, or a TimeoutError once timeoutMs has passed, whichever comes
// first. The time limit also aborts controller, so a fetch or a body that
// listens to it stops too, and one that does not is no longer waited for.
// The timer is a plain one, unlike AbortSignal.timeout's, so Node keeps
// running until one or the other.
async function within (promise, timeoutMs, controller) {
  let timer
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TimeLimitReached(timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

// One request. Throws when no answer starts within timeoutMs. Once one has,
// resolves { status, ok, headers, body, code, unread } whatever its body
// does: body is the parsed JSON (undefined when it is not JSON), and unread
// says why the body could not be read, when it could not. The body gets a
// time limit of its own, and a body that stalls or breaks off is not thrown,
// so the caller decides on the status, which is in.
async function send (url, init, timeoutMs) {
  const controller = new AbortController()
  const response = await within(globalThis.fetch(url, {
    ...init,
    // A redirect is an answer, never followed: the bearer token goes to this
    // URL only.
    redirect: 'manual',
    signal: controller.signal
  }), timeoutMs, controller)

  let text = ''
  let unread = ''
  try {
    text = await within(response.text(), timeoutMs, controller)
  } catch (error) {
    unread = bodyLost(error, timeoutMs)
  }
  let body
  try {
    body = unread || text.length > MAX_ANSWER_LENGTH ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  const code = typeof body?.code === 'string' && CODE.test(body.code) ? body.code : ''
  return { status: response.status, ok: response.ok, headers: response.headers, body, code, unread }
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
    throw new Error(`the runner's OIDC token service answered HTTP ${answer.status} with no token${answer.unread ? ` (the body ${answer.unread})` : ''}`)
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

// The gate answers a start with a 202 whose JSON names the workflow it
// started. A 2xx that is anything else is not that answer: a gate-url that
// points at some other site, or at a load balancer's default page, can answer
// 200 with a web page. Something said yes, though, so the step stops here
// rather than send the request again.
function startedOrThrow ({ status, body, unread }, workflow) {
  let what = ''
  if (unread) {
    what = `the deploy gate answered HTTP ${status}, but the rest of its answer ${unread}`
  } else if (status !== 202 || body?.workflow !== workflow) {
    const named = status === 202 && typeof body?.workflow === 'string' ? clean(body.workflow) : ''
    what = `gate-url answered HTTP ${status}${named ? ` naming ${named}` : ''}, not the deploy gate's HTTP 202 naming ${workflow}, so gate-url may not point at the deploy gate`
  }
  if (what) {
    throw new GateMayHaveStarted(
      `${what}. ${workflow} may have started, so this step does not try again or fall back to github-token: check the deploy repo's runs of it before starting it again`,
      { status }
    )
  }
  return { runUrl: runLink(body), message: clean(body?.message) }
}

// Answers that say the gate did not take the request this time, and a later
// try may do better.
const tryAgain = (status) => status >= 500 || status === 408 || status === 429

// How long a Retry-After header asks to wait, in milliseconds: a number of
// seconds or an HTTP date. 0 when there is none or it cannot be read.
function retryAfterMs (headers) {
  const value = String(headers?.get?.('retry-after') ?? '').trim()
  if (value === '') return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now())
}

const tries = (n) => `${n} ${n === 1 ? 'try' : 'tries'}`

// Ask the gate at route to start workflow with inputs. Resolves
// { runUrl, message } when it did (either may be ''). Throws GateRefused
// when the gate says no, GateMayHaveStarted when a 2xx came that is not the
// gate's answer to a start, and GateUnavailable when no try got an answer
// the gate meant. The caller has already checked oidcAvailable().
export async function gateDispatch ({ route, audience, workflow, inputs }, {
  attempts = GATE_ATTEMPTS,
  delaysMs = RETRY_DELAYS_MS,
  tryTimeoutMs = GATE_TRY_TIMEOUT_MS,
  tokenTryTimeoutMs = TOKEN_TRY_TIMEOUT_MS,
  sleep = pause
} = {}) {
  const body = JSON.stringify({ workflow, inputs })
  const plannedDelay = (attempt) => delaysMs[Math.min(attempt - 2, delaysMs.length - 1)] ?? 0
  // All the tries wait, together. A Retry-After longer than a planned wait
  // comes out of the later waits; one longer than what is left ends the
  // tries, since the gate has said it will not take the request before then.
  let waitLeft = 0
  for (let attempt = 2; attempt <= attempts; attempt++) waitLeft += plannedDelay(attempt)
  let reason = ''
  let asked = 0
  let tried = 0
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      if (asked > waitLeft) {
        reason = `${reason}, and asked for a wait of ${Math.ceil(asked / 1000)} seconds, longer than the tries have left`
        break
      }
      const delay = Math.min(Math.max(plannedDelay(attempt), asked), waitLeft)
      waitLeft -= delay
      core.info(`the deploy gate did not take the request (${reason}); trying again in ${delay / 1000} seconds (${attempt}/${attempts})`)
      await sleep(delay)
    }
    asked = 0
    tried = attempt

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
    if (answer.ok) return startedOrThrow(answer, workflow)
    if (tryAgain(status)) {
      reason = `the deploy gate answered HTTP ${status}${code ? ` ${code}` : ''}`
      asked = retryAfterMs(answer.headers)
      continue
    }
    const message = clean(answer.body?.message)
    throw new GateRefused(
      `the deploy gate refused to start ${workflow}: HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
      { status, code }
    )
  }
  throw new GateUnavailable(`the deploy gate did not take the request to start ${workflow} after ${tries(tried)} (last: ${reason})`)
}
