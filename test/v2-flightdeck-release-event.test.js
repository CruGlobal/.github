import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock @actions/core the way the sibling action tests do: `inputs` backs
// getInput (enforcing `required`), and every reporter is a spy so the tests
// can assert the telemetry policy -- warnings, never setFailed.
const { setOutputMock, setFailedMock, warningMock, infoMock, inputs } = vi.hoisted(() => ({
  setOutputMock: vi.fn(),
  setFailedMock: vi.fn(),
  warningMock: vi.fn(),
  infoMock: vi.fn(),
  inputs: {}
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  },
  setOutput: setOutputMock,
  setFailed: setFailedMock,
  warning: warningMock,
  info: infoMock
}))

import {
  run, buildEvent, buildNumberFromTag, shaFromTags, parseReasons, normalizeEndpoint, FlightdeckClient
} from '../src/flightdeck-release-event.js'
import { AUTHORIZED_ATTEMPT_MARKER } from '../src/v2/attempt-guard.js'

const SHA = 'b0f98798c3a1807599503af8eb10e626769ebdde'
const TAGS = `candidate-2026-09-04-10123,sha-${SHA},release-2026-09-04-10123`

function jsonResponse (status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body }
}

function projectsPage (results, page, totalPages) {
  return jsonResponse(200, { results, meta: { count: results.length, page, per_page: 100, total_pages: totalPages } })
}

function output (name) {
  const call = setOutputMock.mock.calls.filter(([key]) => key === name).pop()
  return call ? call[1] : undefined
}

function happyInputs () {
  inputs.token = 'fd_pat_secret'
  inputs.project = 'BILLS'
  inputs.environment = 'production'
  inputs.kind = 'deploy'
  inputs['release-tag'] = 'release-2026-09-04-10123'
  inputs['image-tags'] = TAGS
  inputs['rollback-safety'] = 'safe'
  inputs['rollback-safety-reasons'] = '["2 additive migration(s)"]'
}

beforeEach(() => {
  setOutputMock.mockReset()
  setFailedMock.mockReset()
  warningMock.mockReset()
  infoMock.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
  vi.unstubAllGlobals()
  // As in a promote or rollback job after authorize-actor passed for this attempt.
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
  vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '1')
})

afterEach(() => vi.unstubAllEnvs())

describe('buildEvent', () => {
  it('builds the wrapped body fields, deriving build number and sha', () => {
    const event = buildEvent({
      environment: 'production', kind: 'deploy', releaseTag: 'release-2026-09-04-10123',
      imageTags: TAGS, rollbackSafety: 'safe', rollbackSafetyReasons: '["no migration changes in this release"]'
    })
    expect(event).toEqual({
      environment: 'production',
      kind: 'deploy',
      release_tag: 'release-2026-09-04-10123',
      build_number: '10123',
      sha: SHA,
      rollback_safe: true,
      rollback_safe_reasons: ['no migration changes in this release']
    })
  })

  it('omits blank optional fields, and sends nothing at all when no verdict was asked for', () => {
    const event = buildEvent({ environment: 'production', kind: 'rollback', releaseTag: 'release-10038' })
    expect(event).toEqual({ environment: 'production', kind: 'rollback', release_tag: 'release-10038', build_number: '10038' })
    expect(event).not.toHaveProperty('rollback_safe')
    expect(event).not.toHaveProperty('sha')
    expect(event).not.toHaveProperty('deployed_at')
  })

  it('withdraws a stored verdict when the classifier ran and returned unclassified', () => {
    const event = buildEvent({ environment: 'production', kind: 'rollback', releaseTag: 'release-10038', rollbackSafety: 'unclassified', rollbackSafetyReasons: '["no production baseline"]' })
    // Present and null, not absent: absent means "I did not classify", and a
    // restate that says nothing leaves a stale verdict standing.
    expect(event).toHaveProperty('rollback_safe')
    expect(event.rollback_safe).toBeNull()
    // The pair is withdrawn together — a cleared verdict beside the previous
    // run's reasons reads as a contradiction.
    expect(event.rollback_safe_reasons).toEqual([])
  })

  it('serialises a withdrawal as an explicit null rather than dropping the key', () => {
    const event = buildEvent({ environment: 'production', releaseTag: 'release-10038', rollbackSafety: 'unclassified' })
    expect(JSON.parse(JSON.stringify(event))).toHaveProperty('rollback_safe', null)
  })

  it('maps an unsafe verdict to rollback_safe false with its reasons', () => {
    const event = buildEvent({ environment: 'production', rollbackSafety: 'unsafe', rollbackSafetyReasons: '["drops column x"]' })
    expect(event.rollback_safe).toBe(false)
    expect(event.rollback_safe_reasons).toEqual(['drops column x'])
  })

  it('prefers explicit build-number, sha and deployed-at over derivation', () => {
    const event = buildEvent({ environment: 'staging', releaseTag: 'release-7', buildNumber: '99', sha: 'a'.repeat(40), imageTags: TAGS, deployedAt: '2026-09-04T18:20:00Z' })
    expect(event.build_number).toBe('99')
    expect(event.sha).toBe('a'.repeat(40))
    expect(event.deployed_at).toBe('2026-09-04T18:20:00Z')
  })

  it('defaults kind to deploy and refuses an unknown kind', () => {
    expect(buildEvent({ environment: 'production' }).kind).toBe('deploy')
    expect(() => buildEvent({ environment: 'production', kind: 'redeploy' })).toThrow(/unknown kind "redeploy"/)
  })

  it('requires environment', () => {
    expect(() => buildEvent({ environment: '  ' })).toThrow(/environment is required/)
  })

  it('sends app, trimmed, when one is given', () => {
    const event = buildEvent({ app: '  bills ', environment: 'production', kind: 'rollback', releaseTag: 'release-10038' })
    expect(event).toEqual({ app: 'bills', environment: 'production', kind: 'rollback', release_tag: 'release-10038', build_number: '10038' })
  })

  it('leaves the app key out entirely when app is unset or blank', () => {
    // Absent, not empty or null: the endpoint refuses keys it does not know,
    // so a caller that passes no app must keep posting the body it always has.
    for (const app of [undefined, '', '   ']) {
      const event = buildEvent({ app, environment: 'production' })
      expect(event).not.toHaveProperty('app')
      expect(JSON.parse(JSON.stringify(event))).not.toHaveProperty('app')
    }
  })
})

describe('helpers', () => {
  it('buildNumberFromTag reads the number out of either tag prefix', () => {
    expect(buildNumberFromTag('release-2026-09-04-10123')).toBe('10123')
    expect(buildNumberFromTag('release-10038')).toBe('10038')
    // A candidate and the release promoted from it share one number, so the
    // staging and production events on one artifact agree.
    expect(buildNumberFromTag('candidate-2026-09-04-10123')).toBe('10123')
    expect(buildNumberFromTag('candidate-10038')).toBe('10038')
    expect(buildNumberFromTag('preview-10038')).toBe('')
    expect(buildNumberFromTag('candidate-2026-09-04')).toBe('')
    expect(buildNumberFromTag('')).toBe('')
  })

  it('shaFromTags finds the sha- tag and ignores everything else', () => {
    expect(shaFromTags(TAGS)).toBe(SHA)
    expect(shaFromTags('release-1, sha-notahash')).toBe('')
    expect(shaFromTags('')).toBe('')
  })

  it('parseReasons tolerates garbage and keeps only strings', () => {
    expect(parseReasons('["a","b"]')).toEqual(['a', 'b'])
    expect(parseReasons('[1, "b", {"x":1}, null]')).toEqual(['1', 'b'])
    expect(parseReasons('not json')).toEqual([])
    expect(parseReasons('{"a":1}')).toEqual([])
    expect(parseReasons('')).toEqual([])
  })

  it('normalizeEndpoint strips trailing slashes', () => {
    expect(normalizeEndpoint('https://flightdeck.cru.org/')).toBe('https://flightdeck.cru.org')
    expect(normalizeEndpoint(' https://x.test// ')).toBe('https://x.test')
  })
})

describe('run', () => {
  it('skips without a token and never calls the API', async () => {
    inputs.project = 'BILLS'
    inputs.environment = 'production'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(output('status')).toBe('skipped')
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(warningMock).not.toHaveBeenCalled()
  })

  it('skips without a FlightdeckProject', async () => {
    inputs.token = 'fd_pat_secret'
    inputs.environment = 'production'
    vi.stubGlobal('fetch', vi.fn())
    await run()
    expect(output('status')).toBe('skipped')
  })

  it('resolves the project by identifier and posts the wrapped event (201 -> created)', async () => {
    happyInputs()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 7, identifier: 'FD' }, { id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 901, release_tag: 'release-2026-09-04-10123' }))
    vi.stubGlobal('fetch', fetchMock)

    await run()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [listUrl, listInit] = fetchMock.mock.calls[0]
    expect(listUrl).toBe('https://flightdeck.cru.org/api/v1/projects?page=1&per_page=100')
    expect(listInit.method).toBe('GET')
    expect(listInit.headers.Authorization).toBe('Bearer fd_pat_secret')

    const [postUrl, postInit] = fetchMock.mock.calls[1]
    expect(postUrl).toBe('https://flightdeck.cru.org/api/v1/projects/42/release-events')
    expect(postInit.method).toBe('POST')
    expect(postInit.headers['Content-Type']).toBe('application/json')
    expect(Object.keys(postInit.headers)).not.toContain('Idempotency-Key')
    expect(JSON.parse(postInit.body)).toEqual({
      release_event: {
        environment: 'production',
        kind: 'deploy',
        release_tag: 'release-2026-09-04-10123',
        build_number: '10123',
        sha: SHA,
        rollback_safe: true,
        rollback_safe_reasons: ['2 additive migration(s)']
      }
    })
    expect(output('status')).toBe('created')
    expect(output('event-id')).toBe('901')
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(warningMock).not.toHaveBeenCalled()
  })

  it('posts the app input as app in the wrapped event', async () => {
    happyInputs()
    inputs.app = 'bills'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 902 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    const posted = JSON.parse(fetchMock.mock.calls[1][1].body).release_event
    expect(posted.app).toBe('bills')
    expect(posted.environment).toBe('production')
    expect(output('status')).toBe('created')
  })

  it('posts no app key when the app input is unset', async () => {
    happyInputs()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 903 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).release_event).not.toHaveProperty('app')
  })

  it('reports a restated release as updated (200)', async () => {
    happyInputs()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(200, { id: 901 })))
    await run()
    expect(output('status')).toBe('updated')
    expect(output('event-id')).toBe('901')
  })

  it('pages through the project list until the identifier matches', async () => {
    happyInputs()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 1, identifier: 'A' }], 1, 2))
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 2, 2))
      .mockResolvedValueOnce(jsonResponse(201, { id: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock.mock.calls[1][0]).toContain('page=2')
    expect(fetchMock.mock.calls[2][0]).toBe('https://flightdeck.cru.org/api/v1/projects/42/release-events')
    expect(output('status')).toBe('created')
  })

  it('warns and reports failed when no project has the identifier', async () => {
    happyInputs()
    const fetchMock = vi.fn().mockResolvedValueOnce(projectsPage([{ id: 1, identifier: 'A' }], 1, 1))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(output('status')).toBe('failed')
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('no project with identifier "BILLS"'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('surfaces the API error envelope as a warning, never a failure', async () => {
    happyInputs()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden', code: 'forbidden' })))
    await run()
    expect(output('status')).toBe('failed')
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('HTTP 403 Forbidden [forbidden]'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('treats a network error as non-blocking', async () => {
    happyInputs()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    await run()
    expect(output('status')).toBe('failed')
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('refuses an unknown kind before touching the API', async () => {
    happyInputs()
    inputs.kind = 'redeploy'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(output('status')).toBe('failed')
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('unknown kind'))
  })

  it('honours a custom endpoint', async () => {
    happyInputs()
    inputs.endpoint = 'https://flightdeck-stage.example.test/'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock.mock.calls[0][0]).toBe('https://flightdeck-stage.example.test/api/v1/projects?page=1&per_page=100')
  })
})

describe('production events need a checked attempt', () => {
  const posted = () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'BILLS' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 901 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  // What an old promote or rollback job looks like when it is re-run: it
  // never ran authorize-actor, so no marker.
  it.each(['production', 'Production', 'prod', ''])('refuses environment %j with no marker, and fails the step', async (environment) => {
    happyInputs()
    inputs.environment = environment
    vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '')
    const fetchMock = posted()
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/^refusing to post a release event for .*: no authorize-actor check passed/))
    expect(output('status')).toBe('failed')
  })

  it('refuses a marker from an earlier attempt', async () => {
    happyInputs()
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
    const fetchMock = posted()
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringContaining('passed for attempt 1, not for this attempt (attempt 2)'))
  })

  it('posts when the marker matches this attempt', async () => {
    happyInputs()
    const fetchMock = posted()
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(output('status')).toBe('created')
  })

  it.each(['staging', 'release-candidate', 'preview', 'lab'])('posts a %s event with no marker, as deploy-candidate does', async (environment) => {
    happyInputs()
    inputs.environment = environment
    vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '')
    const fetchMock = posted()
    await run()
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('still skips silently with no token, marker or not', async () => {
    inputs.project = 'BILLS'
    inputs.environment = 'production'
    vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '')
    await run()
    expect(output('status')).toBe('skipped')
    expect(setFailedMock).not.toHaveBeenCalled()
  })
})

describe('FlightdeckClient.request', () => {
  it('bounds every call with a timeout signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    await new FlightdeckClient('https://x.test', 't').request('GET', '/api/v1/projects')
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})
