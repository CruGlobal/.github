import * as core from '@actions/core'
import { assertAttemptAuthorized } from './v2/attempt-guard.js'

// flightdeck-release-event: post a pipeline v2 deploy/hotfix/rollback to the
// app's Flightdeck project timeline (GateOps Phase 0). The project comes from
// app-info's FlightdeckProject identifier and the credential is ONE fleet
// PAT, the CruDeploy service user's, held by cru-deploy like the Slack bot
// token -- so nothing is plumbed per app beyond the app-info field.
//
//   GET  /api/v1/projects?page=N&per_page=100   -> find id by identifier
//   POST /api/v1/projects/:id/release-events    -> { release_event: {...} }
//        201 = new row on the timeline, 200 = existing (project, environment,
//        release_tag, kind) row restated. The natural-key upsert is what makes
//        a retried post safe, so no Idempotency-Key is sent (a later
//        deployed_at under a reused key would 409 instead of updating).
//
// Telemetry policy, same as the ledger and Slack steps: this NEVER fails the
// run. Unset token/project => skipped; any error => warning + status=failed.
//
// Three fields are display-only: actor, run_url and image_digest. Flightdeck
// checks each one's shape and refuses the WHOLE post when one is wrong, which
// would leave the release off the timeline. So each is sent only when it is
// non-blank and passes Flightdeck's rule (DISPLAY_FIELDS below). One that
// would fail is left out with a warning, and the event is still posted.
//
// A Flightdeck older than these fields refuses them as unknown keys, which
// would refuse every event after a Flightdeck rollback. So a 422 that names
// them as unknown is retried once without them (postReleaseEvent below).
//
// One exception. A production release event is a trusted record, so it is
// refused, and the step fails, unless the authorize-actor check passed earlier
// in this job for this run attempt (src/v2/attempt-guard.js). Only the
// non-production names below skip that check. The production callers run this
// step with continue-on-error, so a refusal here does not change the run's
// result; the deploy step before it has already refused by then.

export const DEFAULT_ENDPOINT = 'https://flightdeck.cru.org'
export const KINDS = ['deploy', 'hotfix', 'rollback']
const PER_PAGE = 100
const MAX_PAGES = 50
const TIMEOUT_MS = 10000
export const NON_PRODUCTION_ENVIRONMENTS = Object.freeze(['staging', 'release-candidate', 'preview', 'lab'])

// Flightdeck's rules for the display-only fields, copied from its release-event
// API. Flightdeck strips each value and then matches the whole string, so the
// action trims first and sends the trimmed value.
//
//   actor         a GitHub login: 1 to 39 letters, digits or hyphens, starting
//                 with a letter or digit, optionally followed by "[bot]".
//   run_url       https://github.com/<owner>/<repo>/actions/runs/<id>, optionally
//                 followed by /attempts/<n>, and nothing else: no other host or
//                 scheme, no query, fragment, port or trailing slash. <owner>
//                 follows the login rule without "[bot]"; <repo> is 1 to 100
//                 letters, digits, ".", "_" or "-", and not "." or "..".
//   image_digest  "sha256:" and 64 lowercase hex characters.
export const DISPLAY_FIELDS = Object.freeze({
  actor: {
    format: /^(?=[A-Za-z0-9-]{1,39}(?:\[bot\])?$)[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/,
    rule: 'a GitHub login (1-39 letters, digits or hyphens, starting with a letter or digit, optionally followed by [bot])'
  },
  run_url: {
    format: /^https:\/\/github\.com\/(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?\/)[A-Za-z0-9._-]{1,100}\/actions\/runs\/[0-9]{1,20}(?:\/attempts\/[0-9]{1,20})?$/,
    rule: 'a GitHub Actions run URL (https://github.com/<owner>/<repo>/actions/runs/<id>, optionally followed by /attempts/<n>)'
  },
  image_digest: {
    format: /^sha256:[0-9a-f]{64}$/,
    rule: 'sha256: followed by 64 lowercase hex characters'
  }
})

export async function run () {
  const token = core.getInput('token')
  const project = core.getInput('project')
  if (!token || !project) {
    core.info(`Flightdeck release event skipped (${!token ? 'no token' : 'no FlightdeckProject in app-info'})`)
    core.setOutput('status', 'skipped')
    return
  }
  const environment = core.getInput('environment').trim()
  if (!NON_PRODUCTION_ENVIRONMENTS.includes(environment.toLowerCase())) {
    try {
      assertAttemptAuthorized(`post a release event for ${environment || 'an unnamed environment'}`)
    } catch (error) {
      core.setFailed(error.message)
      core.setOutput('status', 'failed')
      return
    }
  }
  try {
    const endpoint = normalizeEndpoint(core.getInput('endpoint') || DEFAULT_ENDPOINT)
    const event = buildEvent({
      app: core.getInput('app'),
      environment: core.getInput('environment', { required: true }),
      kind: core.getInput('kind'),
      releaseTag: core.getInput('release-tag'),
      buildNumber: core.getInput('build-number'),
      sha: core.getInput('sha'),
      imageTags: core.getInput('image-tags'),
      rollbackSafety: core.getInput('rollback-safety'),
      rollbackSafetyReasons: core.getInput('rollback-safety-reasons'),
      deployedAt: core.getInput('deployed-at'),
      actor: core.getInput('actor'),
      runUrl: core.getInput('run-url'),
      imageDigest: core.getInput('image-digest')
    }, { warn: core.warning })
    const client = new FlightdeckClient(endpoint, token)
    const projectId = await client.findProjectId(project)
    if (projectId === null) {
      core.warning(`Flightdeck release event not recorded (non-blocking): no project with identifier "${project}" is readable by the token's user at ${endpoint}`)
      core.setOutput('status', 'failed')
      return
    }
    const { status, body } = await postReleaseEvent(client, projectId, event, core.warning)
    const outcome = status === 201 ? 'created' : 'updated'
    core.info(`Flightdeck: ${outcome} ${event.kind} of ${event.release_tag ?? '(untagged)'} in ${event.environment} on project ${project} (event ${body.id})`)
    core.setOutput('status', outcome)
    core.setOutput('event-id', String(body.id))
  } catch (error) {
    core.warning(`Flightdeck release event not recorded (non-blocking): ${error.message}`)
    core.setOutput('status', 'failed')
  }
}

export function normalizeEndpoint (endpoint) {
  return endpoint.trim().replace(/\/+$/, '')
}

// The wrapped body's inner object. Blank optional fields are OMITTED rather
// than sent empty: the /api/v1 side is strict, and an absent key means "no
// opinion" for every field but environment. `warn` hears about each
// display-only field left out because Flightdeck would refuse it.
export function buildEvent ({ app, environment, kind, releaseTag, buildNumber, sha, imageTags, rollbackSafety, rollbackSafetyReasons, deployedAt, actor, runUrl, imageDigest }, { warn = () => {} } = {}) {
  environment = (environment || '').trim()
  if (!environment) throw new Error('environment is required')
  kind = (kind || 'deploy').trim()
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (expected one of ${KINDS.join(', ')})`)

  const event = { environment, kind }
  // The pipeline project name. A blank one leaves the key out entirely, not
  // sent empty: the endpoint refuses keys it does not know, so a caller that
  // passes no `app` keeps posting exactly the body it always has.
  app = (app || '').trim()
  if (app) event.app = app
  releaseTag = (releaseTag || '').trim()
  if (releaseTag) event.release_tag = releaseTag
  const build = (buildNumber || '').trim() || buildNumberFromTag(releaseTag)
  if (build) event.build_number = build
  const gitSha = (sha || '').trim() || shaFromTags(imageTags)
  if (gitSha) event.sha = gitSha

  // Three cases, and the third is the subtle one. A verdict is applied as sent.
  // `unclassified` means the classifier RAN and produced nothing, which is a real
  // statement about this release — so it withdraws any verdict already stored,
  // rather than staying silent and letting a stale one stand. An absent input is
  // the different case: the caller never classified at all (deploy-candidate does
  // not), so it says nothing and leaves whatever is there alone.
  //
  // Withdrawing sends the reasons too: the pair is only meaningful together, and a
  // cleared verdict beside the previous run's reasons reads as a contradiction.
  const safety = (rollbackSafety || '').trim()
  if (safety === 'safe' || safety === 'unsafe') {
    event.rollback_safe = safety === 'safe'
    event.rollback_safe_reasons = parseReasons(rollbackSafetyReasons)
  } else if (safety === 'unclassified') {
    event.rollback_safe = null
    event.rollback_safe_reasons = []
  }
  deployedAt = (deployedAt || '').trim()
  if (deployedAt) event.deployed_at = deployedAt
  Object.assign(event, displayFields({ actor, run_url: runUrl, image_digest: imageDigest }, warn))
  return event
}

// The display-only fields that are safe to send, keyed as Flightdeck names
// them. A blank value is no opinion and is left out quietly. A value that
// breaks Flightdeck's rule is left out too, with a warning, because sending it
// would get the whole event refused.
export function displayFields (values, warn = () => {}) {
  const fields = {}
  for (const [key, { format, rule }] of Object.entries(DISPLAY_FIELDS)) {
    const value = (values[key] || '').trim()
    if (!value) continue
    if (format.test(value)) {
      fields[key] = value
    } else {
      warn(`Flightdeck release event: leaving out ${key} ${JSON.stringify(value)}, which is not ${rule}. Flightdeck would refuse the whole event over it; the event is still posted without it.`)
    }
  }
  return fields
}

// {candidate,release}-[<yyyy-mm-dd>-]<n> -> <n>; anything else has no build
// number. Both spellings carry the SAME number for one artifact -- promote
// renames candidate-<suffix> to release-<suffix> -- so a candidate deploy and
// the promotion that follows it report one build across two environments.
export function buildNumberFromTag (releaseTag) {
  const match = /^(?:candidate|release)-(?:\d{4}-\d{2}-\d{2}-)?(\d+)$/.exec(releaseTag || '')
  return match ? match[1] : ''
}

// The sha-<40 hex> tag resolve-image surfaces alongside the candidate/release tags.
export function shaFromTags (imageTags) {
  for (const tag of (imageTags || '').split(',')) {
    const match = /^sha-([0-9a-f]{40})$/.exec(tag.trim())
    if (match) return match[1]
  }
  return ''
}

// Post the event. A Flightdeck from before the display-only fields answers
// 422 invalid_attribute with "unknown key(s): <names> (settable: ...)" for
// them. The display fields are nice to have and the rest of the event is
// not, so on that answer, and only that one, the event is posted once more
// without them. Any other refusal, and a refusal of the retry, is thrown as
// it is.
export async function postReleaseEvent (client, projectId, event, warn = () => {}) {
  try {
    return await client.postReleaseEvent(projectId, event)
  } catch (error) {
    const dropped = refusedDisplayFields(error, event)
    if (dropped.length === 0) throw error
    const retry = Object.fromEntries(Object.entries(event).filter(([key]) => !dropped.includes(key)))
    warn(`Flightdeck release event: Flightdeck does not accept ${dropped.join(', ')} yet (${error.message}). Posting the event again without ${dropped.length === 1 ? 'it' : 'them'}.`)
    return client.postReleaseEvent(projectId, retry)
  }
}

// The display-only fields in `event` to drop when `error` is Flightdeck
// refusing unknown keys and it names at least one of those fields; [] for
// any other error. Every display field the event carries is dropped, not just
// the named ones, so the retry cannot fail the same way over another.
export function refusedDisplayFields (error, event) {
  if (error?.status !== 422) return []
  const code = error.body?.code
  if (code !== undefined && code !== 'invalid_attribute') return []
  const message = typeof error.body?.error === 'string' ? error.body.error : ''
  const match = /^\s*unknown keys?:\s*([^(]*)/i.exec(message)
  if (!match) return []
  const named = match[1].split(/,|\s+and\s+/).map((name) => name.trim())
  const carried = Object.keys(DISPLAY_FIELDS).filter((key) => key in event)
  return carried.some((key) => named.includes(key)) ? carried : []
}

// classify-rollback-safety emits `reasons` as a JSON array of strings. Anything
// else (unset, malformed, wrong shape) is sent as no reasons rather than
// letting a malformed advisory 422 the whole event.
export function parseReasons (raw) {
  if (!raw || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(reason => typeof reason === 'string' || typeof reason === 'number').map(String)
  } catch {
    return []
  }
}

export class FlightdeckClient {
  constructor (endpoint, token) {
    this.endpoint = endpoint
    this.token = token
  }

  headers () {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  }

  async request (method, path, body) {
    const res = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const detail = json?.error ? `${json.error}${json.code ? ` [${json.code}]` : ''}` : res.statusText
      // status and body ride along so a caller can tell one refusal from another.
      throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status} ${detail}`), { status: res.status, body: json })
    }
    return { status: res.status, body: json }
  }

  // The projects index has no identifier filter, so page through the token's
  // readable projects (100 per page, the API maximum) until the identifier
  // matches. null when no page has it.
  async findProjectId (identifier) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { body } = await this.request('GET', `/api/v1/projects?page=${page}&per_page=${PER_PAGE}`)
      const match = (body?.results ?? []).find(project => project.identifier === identifier)
      if (match) return match.id
      const totalPages = Number(body?.meta?.total_pages ?? 1)
      if (page >= totalPages) return null
    }
    return null
  }

  postReleaseEvent (projectId, event) {
    return this.request('POST', `/api/v1/projects/${projectId}/release-events`, { release_event: event })
  }
}

// The action's entry point is src/entry/flightdeck-release-event.js, which
// always calls run().
