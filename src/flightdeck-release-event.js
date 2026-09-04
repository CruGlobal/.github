import * as core from '@actions/core'

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

export const DEFAULT_ENDPOINT = 'https://flightdeck.cru.org'
export const KINDS = ['deploy', 'hotfix', 'rollback']
const PER_PAGE = 100
const MAX_PAGES = 50
const TIMEOUT_MS = 10000

export async function run () {
  const token = core.getInput('token')
  const project = core.getInput('project')
  if (!token || !project) {
    core.info(`Flightdeck release event skipped (${!token ? 'no token' : 'no FlightdeckProject in app-info'})`)
    core.setOutput('status', 'skipped')
    return
  }
  try {
    const endpoint = normalizeEndpoint(core.getInput('endpoint') || DEFAULT_ENDPOINT)
    const event = buildEvent({
      environment: core.getInput('environment', { required: true }),
      kind: core.getInput('kind'),
      releaseTag: core.getInput('release-tag'),
      buildNumber: core.getInput('build-number'),
      sha: core.getInput('sha'),
      imageTags: core.getInput('image-tags'),
      rollbackSafety: core.getInput('rollback-safety'),
      rollbackSafetyReasons: core.getInput('rollback-safety-reasons'),
      deployedAt: core.getInput('deployed-at')
    })
    const client = new FlightdeckClient(endpoint, token)
    const projectId = await client.findProjectId(project)
    if (projectId === null) {
      core.warning(`Flightdeck release event not recorded (non-blocking): no project with identifier "${project}" is readable by the token's user at ${endpoint}`)
      core.setOutput('status', 'failed')
      return
    }
    const { status, body } = await client.postReleaseEvent(projectId, event)
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
// opinion" for every field but environment.
export function buildEvent ({ environment, kind, releaseTag, buildNumber, sha, imageTags, rollbackSafety, rollbackSafetyReasons, deployedAt }) {
  environment = (environment || '').trim()
  if (!environment) throw new Error('environment is required')
  kind = (kind || 'deploy').trim()
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (expected one of ${KINDS.join(', ')})`)

  const event = { environment, kind }
  releaseTag = (releaseTag || '').trim()
  if (releaseTag) event.release_tag = releaseTag
  const build = (buildNumber || '').trim() || buildNumberFromTag(releaseTag)
  if (build) event.build_number = build
  const gitSha = (sha || '').trim() || shaFromTags(imageTags)
  if (gitSha) event.sha = gitSha

  const safety = (rollbackSafety || '').trim()
  if (safety === 'safe' || safety === 'unsafe') {
    event.rollback_safe = safety === 'safe'
    event.rollback_safe_reasons = parseReasons(rollbackSafetyReasons)
  }
  deployedAt = (deployedAt || '').trim()
  if (deployedAt) event.deployed_at = deployedAt
  return event
}

// release-[<yyyy-mm-dd>-]<n> -> <n>; anything else has no build number.
export function buildNumberFromTag (releaseTag) {
  const match = /^release-(?:\d{4}-\d{2}-\d{2}-)?(\d+)$/.exec(releaseTag || '')
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
      throw new Error(`${method} ${path}: HTTP ${res.status} ${detail}`)
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

// Auto-run as the action entrypoint, but stay import-safe under test.
if (!process.env.VITEST) run()
