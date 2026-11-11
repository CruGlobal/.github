import * as core from '@actions/core'
import { assertAttemptAuthorized, deployRunVerifiedFor } from './v2/attempt-guard.js'

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
// Four fields are display-only: actor, requested_by, run_url and
// image_digest. Flightdeck checks each one's shape and refuses the WHOLE post
// when one is wrong, which would leave the release off the timeline. So each
// is sent only when it is non-blank and passes Flightdeck's rule
// (DISPLAY_FIELDS below). One that would fail is left out with a warning, and
// the event is still posted.
//
// A Flightdeck older than a field refuses it as an unknown key, which would
// refuse every event after a Flightdeck rollback, or before Flightdeck has
// shipped a new field. So a 422 that names display fields as unknown is
// retried once without the ones it names (postReleaseEvent below).
//
// One exception. A production release event is a trusted record, so it is
// refused, and the step fails, unless the authorize-actor check passed earlier
// in this job for this run attempt (src/v2/attempt-guard.js). Only the
// non-production names below skip that check. The production callers run this
// step with continue-on-error, so a refusal here does not change the run's
// result; the deploy step before it has already refused by then.
//
// The other way a production event passes is narrower. record-deploy posts a
// deploy an app made itself, outside the pipeline, and nobody there started a
// production change to check. Instead verify-deploy-run checks the app's own
// run and marks the job for that Flightdeck project, app, environment and
// commit. That mark lets through a deploy event whose project, app,
// environment and `sha` inputs are exactly those, and nothing else: not
// another project, app or commit, not a rollback or a hotfix, and not the
// deploy or tag-image actions.
//
// With `previous-environment` set, the action also reads that environment's
// newest earlier release event before it posts, and outputs its sha and tag,
// so a caller can link "what's in this release". A failed read is a warning
// and the event is still posted.

export const DEFAULT_ENDPOINT = 'https://flightdeck.cru.org'
export const KINDS = ['deploy', 'hotfix', 'rollback']
const PER_PAGE = 100
const MAX_PAGES = 50
const RELEASE_EVENTS_PER_PAGE = 20
const TIMEOUT_MS = 10000
export const NON_PRODUCTION_ENVIRONMENTS = Object.freeze(['staging', 'release-candidate', 'preview', 'lab'])

// Flightdeck's rules for the display-only fields, copied from its release-event
// API. Flightdeck strips each value and then matches the whole string, so the
// action trims first and sends the trimmed value.
//
//   actor         a GitHub login: 1 to 39 letters, digits or hyphens, starting
//                 with a letter or digit, optionally followed by "[bot]".
//   requested_by  an email address by the HTML form rule ("valid email
//                 address"), any domain, 254 characters at most: the person
//                 who asked the deploy gate for this change. Flightdeck needs
//                 a sign-in to read, so this is the full address.
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
  // Flightdeck's pattern as given, except that the "/" in the first class is
  // not escaped. It means the same there, and lint refuses the escape.
  requested_by: {
    format: /^(?=.{1,254}$)[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    rule: 'an email address (the HTML form rule, at most 254 characters)'
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
    // The inputs as given, compared exactly, so what is posted is what was
    // verified.
    const kind = (core.getInput('kind') || 'deploy').trim()
    const verifiedDeploy = kind === 'deploy' && deployRunVerifiedFor({
      project,
      app: core.getInput('app'),
      environment: core.getInput('environment'),
      sha: core.getInput('sha')
    })
    if (!verifiedDeploy) {
      try {
        assertAttemptAuthorized(`post a release event for ${environment || 'an unnamed environment'}`)
      } catch (error) {
        core.setFailed(error.message)
        core.setOutput('status', 'failed')
        return
      }
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
      requestedBy: core.getInput('requested-by'),
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
    // Read before the post, or the newest event would be this one.
    const previousEnvironment = core.getInput('previous-environment').trim()
    if (previousEnvironment) {
      let previous = null
      try {
        previous = previousReleaseEvent(await client.listReleaseEvents(projectId, previousEnvironment), event)
      } catch (error) {
        core.warning(`Flightdeck: could not read the previous ${previousEnvironment} release event (non-blocking; the event is still posted): ${error.message}`)
      }
      core.setOutput('previous-sha', previous?.sha ?? '')
      core.setOutput('previous-release-tag', previous?.release_tag ?? '')
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
export function buildEvent ({ app, environment, kind, releaseTag, buildNumber, sha, imageTags, rollbackSafety, rollbackSafetyReasons, deployedAt, actor, requestedBy, runUrl, imageDigest }, { warn = () => {} } = {}) {
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
  Object.assign(event, displayFields({ actor, requested_by: requestedBy, run_url: runUrl, image_digest: imageDigest }, warn))
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

// Post the event. A Flightdeck from before a display-only field answers 422
// invalid_attribute with "unknown key(s): <names> (settable: ...)" for it.
// The display fields are nice to have and the rest of the event is not, so on
// that answer, and only that one, the event is posted once more without the
// display fields it names. The rest of the event, other display fields
// included, goes again as it was. Any other refusal, and a refusal of the
// retry, is thrown as it is.
export async function postReleaseEvent (client, projectId, event, warn = () => {}) {
  try {
    return await client.postReleaseEvent(projectId, event)
  } catch (error) {
    const dropped = refusedDisplayFields(error, event)
    if (dropped.length === 0) throw error
    const retry = Object.fromEntries(Object.entries(event).filter(([key]) => !dropped.includes(key)))
    warn(`Flightdeck release event: Flightdeck refused keys it does not know (${error.message}). Posting the event again without ${dropped.join(', ')}.`)
    return client.postReleaseEvent(projectId, retry)
  }
}

// The display-only fields in `event` to leave out of the retry when `error`
// is Flightdeck refusing unknown keys. [] for any other error, and for a
// refusal that names only keys that are not display fields, which no retry
// could fix.
//
// Flightdeck says "unknown key: a (settable: ...)" or "unknown keys: a, b
// (settable: ...)": the unknown keys sorted, at most five of them, "and N
// more" when there were more, and then every key it does accept. Only the
// part before the "(" names unknown keys. The settable list names display
// fields Flightdeck takes, so reading it would drop good ones. The list is
// also cut at the word "settable", in case a later Flightdeck drops the "(".
//
// Usually that part names exactly the display fields to drop, and only those
// are dropped, so a Flightdeck that lacks one field still gets the others.
// When it cannot say which, because the list ends in "and N more" or holds
// no name at all, every display field the event carries is dropped, so the
// retry cannot fail the same way over one the message did not name.
export function refusedDisplayFields (error, event) {
  if (error?.status !== 422) return []
  const code = error.body?.code
  if (code !== undefined && code !== 'invalid_attribute') return []
  const message = typeof error.body?.error === 'string' ? error.body.error : ''
  const match = /^\s*unknown keys?:\s*([^(]*)/i.exec(message)
  if (!match) return []
  const carried = Object.keys(DISPLAY_FIELDS).filter((key) => key in event)
  if (carried.length === 0) return []
  const MORE = /(?:^|\s)and\s+\d+\s+more\s*$/i
  const list = match[1].split(/\bsettable\b/i)[0].replace(/[\s;.,:]+$/, '').trim()
  const names = list.replace(MORE, '').split(/,|\s+and\s+/).map((name) => name.trim()).filter(Boolean)
  if (MORE.test(list) || names.length === 0) return carried
  return carried.filter((key) => names.includes(key))
}

// The release that came before `event`, from `events` (one environment's
// timeline, newest first, as Flightdeck lists it): the newest one that has a
// sha, is not `event` itself restated, and was not deployed after it. A
// recorded deploy can be dated earlier than events already on the timeline,
// when its run finished before they were posted, and a link from a later
// release would read backwards. null when there is none.
export function previousReleaseEvent (events, event) {
  const stated = event.deployed_at ? Date.parse(event.deployed_at) : NaN
  const before = Number.isNaN(stated) ? Infinity : stated
  for (const candidate of Array.isArray(events) ? events : []) {
    if (typeof candidate?.sha !== 'string' || candidate.sha.trim() === '') continue
    if (candidate.environment === event.environment && candidate.release_tag === event.release_tag) continue
    const at = Date.parse(candidate.deployed_at)
    if (!(at <= before)) continue
    return candidate
  }
  return null
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

  // The newest release events in one environment, newest first (by
  // deployed_at). One page is enough to find the release before a new one.
  async listReleaseEvents (projectId, environment) {
    const { body } = await this.request('GET', `/api/v1/projects/${projectId}/release-events?environment=${encodeURIComponent(environment)}&per_page=${RELEASE_EVENTS_PER_PAGE}`)
    if (!Array.isArray(body?.results)) throw new Error('the release events list had no results array')
    return body.results
  }
}

// The action's entry point is src/entry/flightdeck-release-event.js, which
// always calls run().
