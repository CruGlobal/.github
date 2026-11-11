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
  run, buildEvent, buildNumberFromTag, shaFromTags, parseReasons, normalizeEndpoint, FlightdeckClient, displayFields, DEFAULT_ENDPOINT,
  refusedDisplayFields
} from '../src/flightdeck-release-event.js'
import { AUTHORIZED_ATTEMPT_MARKER } from '../src/v2/attempt-guard.js'
import { loadYaml, resolveExpressions } from './support/workflow-steps.js'

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
  inputs.project = 'EXAMPLE'
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
    const event = buildEvent({ app: '  example-app ', environment: 'production', kind: 'rollback', releaseTag: 'release-10038' })
    expect(event).toEqual({ app: 'example-app', environment: 'production', kind: 'rollback', release_tag: 'release-10038', build_number: '10038' })
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
    inputs.project = 'EXAMPLE'
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
      .mockResolvedValueOnce(projectsPage([{ id: 7, identifier: 'OTHER' }, { id: 42, identifier: 'EXAMPLE' }], 1, 1))
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
    inputs.app = 'example-app'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 902 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    const posted = JSON.parse(fetchMock.mock.calls[1][1].body).release_event
    expect(posted.app).toBe('example-app')
    expect(posted.environment).toBe('production')
    expect(output('status')).toBe('created')
  })

  it('posts no app key when the app input is unset', async () => {
    happyInputs()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 903 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).release_event).not.toHaveProperty('app')
  })

  it('reports a restated release as updated (200)', async () => {
    happyInputs()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(200, { id: 901 })))
    await run()
    expect(output('status')).toBe('updated')
    expect(output('event-id')).toBe('901')
  })

  it('pages through the project list until the identifier matches', async () => {
    happyInputs()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 1, identifier: 'A' }], 1, 2))
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 2, 2))
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
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('no project with identifier "EXAMPLE"'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('surfaces the API error envelope as a warning, never a failure', async () => {
    happyInputs()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 1, 1))
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
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock.mock.calls[0][0]).toBe('https://flightdeck-stage.example.test/api/v1/projects?page=1&per_page=100')
  })
})

describe('production events need a checked attempt', () => {
  const posted = () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }], 1, 1))
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
    inputs.project = 'EXAMPLE'
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

// ---------------------------------------------------------------------------
// Display-only fields: actor, run_url and image_digest. Flightdeck refuses the
// whole event over one that breaks its rule, so each is sent only when it
// would pass, and left out with a warning otherwise.

const RUN_URL = 'https://github.com/example-org/deploy-wrappers/actions/runs/9001'
const DIGEST = 'sha256:' + '0123456789abcdef'.repeat(4)

describe('display-only fields', () => {
  it('sends each field, trimmed, when Flightdeck would accept it', () => {
    const warn = vi.fn()
    const event = buildEvent({ environment: 'production', actor: '  octo-dev ', runUrl: ` ${RUN_URL}/attempts/2\n`, imageDigest: `${DIGEST} ` }, { warn })
    expect(event).toMatchObject({ actor: 'octo-dev', run_url: `${RUN_URL}/attempts/2`, image_digest: DIGEST })
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    'a', 'octo-dev', 'OctoDev99', '1st-user', 'release-helper[bot]', 'a--b-', 'x'.repeat(39), 'x'.repeat(39) + '[bot]'
  ])('accepts the login %j', (actor) => {
    expect(displayFields({ actor })).toEqual({ actor })
  })

  it.each([
    '-lead', 'has space', 'x'.repeat(40), 'x'.repeat(40) + '[bot]', 'name[bot]x', '[bot]', 'a[bot][bot]',
    'octo_dev', 'octo.dev', 'user@example.test', 'ünï', 'oc\nto'
  ])('leaves out the login %j with a warning', (actor) => {
    const warn = vi.fn()
    expect(displayFields({ actor }, warn)).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`leaving out actor ${JSON.stringify(actor)}`))
  })

  it.each([
    RUN_URL,
    `${RUN_URL}/attempts/1`,
    'https://github.com/a/b/actions/runs/1',
    'https://github.com/o/.github/actions/runs/7',
    'https://github.com/a--b/x.y_z-1/actions/runs/12345678901234567890/attempts/12345678901234567890'
  ])('accepts the run URL %j', (runUrl) => {
    expect(displayFields({ run_url: runUrl })).toEqual({ run_url: runUrl })
  })

  it.each([
    'http://github.com/o/r/actions/runs/1',
    'https://github.com/o/r/actions/runs/1/',
    'https://github.com/o/r/actions/runs/1?check_suite_focus=true',
    'https://github.com/o/r/actions/runs/1#summary',
    'https://github.com:443/o/r/actions/runs/1',
    'https://user@github.com/o/r/actions/runs/1',
    'https://www.github.com/o/r/actions/runs/1',
    'https://github.example.test/o/r/actions/runs/1',
    'github.com/o/r/actions/runs/1',
    'https://github.com/-o/r/actions/runs/1',
    'https://github.com/o[bot]/r/actions/runs/1',
    'https://github.com/o/../actions/runs/1',
    'https://github.com/o/./actions/runs/1',
    'https://github.com/o/r/actions/runs/abc',
    'https://github.com/o/r/actions/runs/123456789012345678901',
    'https://github.com/o/r/actions/runs/1/attempts/',
    'https://github.com/o/r/actions/runs/1/attempts/2/logs',
    'https://github.com/o/r/actions/runs/1/job/2'
  ])('leaves out the run URL %j with a warning', (runUrl) => {
    const warn = vi.fn()
    expect(displayFields({ run_url: runUrl }, warn)).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving out run_url'))
  })

  it.each([DIGEST, 'sha256:' + 'f'.repeat(64)])('accepts the digest %j', (digest) => {
    expect(displayFields({ image_digest: digest })).toEqual({ image_digest: digest })
  })

  it.each([
    'sha256:' + 'A'.repeat(64), 'sha256:' + 'a'.repeat(63), 'sha256:' + 'a'.repeat(65), 'sha512:' + 'a'.repeat(64),
    'a'.repeat(64), 'sha256:' + 'g'.repeat(64), 'registry.example.test/app@sha256:' + 'a'.repeat(64)
  ])('leaves out the digest %j with a warning', (digest) => {
    const warn = vi.fn()
    expect(displayFields({ image_digest: digest }, warn)).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving out image_digest'))
  })

  // Flightdeck's rule is the HTML form's "valid email address", any domain,
  // 254 characters at most. The deploy gate's own check is looser (any
  // characters but spaces, controls and a second @), so a requester that
  // passes the gate can still be left out here.
  it.each([
    'someone@example.org', 'first.last+tag@example.co.uk', "o'neil@example.org", 'a@b', 'x_y-z@sub-1.example.org',
    "!#$%&'*+/=?^_`{|}~-@example.org", 'a/b@example.org',
    `${'x'.repeat(250)}@a.b`, `${'x'.repeat(64)}@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(61)}`
  ])('accepts the requester %j', (requester) => {
    expect(displayFields({ requested_by: requester })).toEqual({ requested_by: requester })
  })

  it.each([
    'someone', '@example.org', 'someone@', 'a@b@example.org', 'some one@example.org', 'zoë@example.org', 'a<b>@example.org',
    'a@-example.org', 'a@example-.org', 'a@example..org', 'a@.example.org', 'a@example.org.', `a@${'x'.repeat(64)}.org`,
    `${'x'.repeat(251)}@a.b`, 'a@exa_mple.org', 'some\none@example.org'
  ])('leaves out the requester %j with a warning', (requester) => {
    const warn = vi.fn()
    expect(displayFields({ requested_by: requester }, warn)).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving out requested_by'))
  })

  it('sends the requester trimmed, beside actor', () => {
    const event = buildEvent({ environment: 'production', actor: 'octo-dev', requestedBy: '  someone@example.org \n' })
    expect(event).toMatchObject({ actor: 'octo-dev', requested_by: 'someone@example.org' })
  })

  it('leaves out blank values quietly: they are no opinion, not a mistake', () => {
    const warn = vi.fn()
    expect(displayFields({ actor: '', requested_by: ' ', run_url: '   ', image_digest: undefined }, warn)).toEqual({})
    expect(buildEvent({ environment: 'production' }, { warn })).toEqual({ environment: 'production', kind: 'deploy' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves out only the bad field and keeps the rest of the event', () => {
    const warn = vi.fn()
    const event = buildEvent({ environment: 'staging', releaseTag: 'candidate-7', actor: 'octo dev', runUrl: RUN_URL, imageDigest: DIGEST }, { warn })
    expect(event).toEqual({ environment: 'staging', kind: 'deploy', release_tag: 'candidate-7', build_number: '7', run_url: RUN_URL, image_digest: DIGEST })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('run: display-only fields', () => {
  const posted = () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'SHOP' }], 1, 1))
      .mockResolvedValueOnce(jsonResponse(201, { id: 901 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const body = (fetchMock) => JSON.parse(fetchMock.mock.calls[1][1].body).release_event
  const validDisplayInputs = () => {
    inputs.project = 'SHOP'
    inputs.actor = 'octo-dev'
    inputs['run-url'] = `${RUN_URL}/attempts/1`
    inputs['image-digest'] = DIGEST
  }

  it('posts actor, run_url and image_digest when they are valid', async () => {
    happyInputs()
    validDisplayInputs()
    const fetchMock = posted()
    await run()
    expect(body(fetchMock)).toMatchObject({ actor: 'octo-dev', run_url: `${RUN_URL}/attempts/1`, image_digest: DIGEST, sha: SHA })
    expect(warningMock).not.toHaveBeenCalled()
    expect(output('status')).toBe('created')
  })

  it.each([
    ['actor', 'actor', 'not a login'],
    ['requested-by', 'requested_by', 'zoë@example.org'],
    ['run-url', 'run_url', 'https://github.com/o/r/actions/runs/1?x=1'],
    ['image-digest', 'image_digest', 'sha256:ABC']
  ])('still posts the event when %s is invalid, without that field and with a warning', async (input, key, value) => {
    happyInputs()
    validDisplayInputs()
    inputs[input] = value
    const fetchMock = posted()
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const sent = body(fetchMock)
    expect(sent).not.toHaveProperty(key)
    for (const other of ['actor', 'run_url', 'image_digest'].filter((k) => k !== key)) expect(sent).toHaveProperty(other)
    if (key !== 'requested_by') expect(sent).not.toHaveProperty('requested_by')
    expect(sent).toMatchObject({ environment: 'production', release_tag: 'release-2026-09-04-10123', rollback_safe: true })
    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining(`leaving out ${key}`))
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(output('status')).toBe('created')
  })

  it('posts requested_by beside actor when it is a valid address', async () => {
    happyInputs()
    validDisplayInputs()
    inputs['requested-by'] = 'someone@example.org'
    const fetchMock = posted()
    await run()
    expect(body(fetchMock)).toMatchObject({ actor: 'octo-dev', requested_by: 'someone@example.org', run_url: `${RUN_URL}/attempts/1`, image_digest: DIGEST })
    expect(warningMock).not.toHaveBeenCalled()
  })

  it('sends no requested_by key when the input is unset', async () => {
    happyInputs()
    validDisplayInputs()
    const fetchMock = posted()
    await run()
    expect(body(fetchMock)).not.toHaveProperty('requested_by')
  })

  it('still posts the event with all three invalid, as the body it sent before these fields existed', async () => {
    happyInputs()
    inputs.project = 'SHOP'
    inputs.actor = '-bad'
    inputs['run-url'] = 'https://example.test/run/1'
    inputs['image-digest'] = 'latest'
    const fetchMock = posted()
    await run()
    expect(body(fetchMock)).toEqual({
      environment: 'production',
      kind: 'deploy',
      release_tag: 'release-2026-09-04-10123',
      build_number: '10123',
      sha: SHA,
      rollback_safe: true,
      rollback_safe_reasons: ['2 additive migration(s)']
    })
    expect(warningMock).toHaveBeenCalledTimes(3)
    expect(output('status')).toBe('created')
  })
})

// ---------------------------------------------------------------------------
// A Flightdeck from before a display-only field refuses it as an unknown key:
// 422 invalid_attribute, "unknown key(s): <sorted names> (settable: ...)".
// Without a retry, a Flightdeck rollback past a field, or one that has not
// shipped a new field yet, would get every release event refused. So that
// refusal, and only that one, is retried once without the fields it names.

const SETTABLE = '(settable: environment, kind, release_tag, build_number, sha, rollback_safe, rollback_safe_reasons, deployed_at, app)'
// What a Flightdeck that has the first three display fields, but not
// requested_by, lists as settable. Its list names actor, run_url and
// image_digest, which must not be read as unknown.
const SETTABLE_WITH_DISPLAY = '(settable: environment, kind, release_tag, build_number, sha, rollback_safe, rollback_safe_reasons, deployed_at, app, actor, run_url, image_digest)'
const unknownKeys = (names) => jsonResponse(422, { error: `unknown key${names.includes(',') ? 's' : ''}: ${names} ${SETTABLE}`, code: 'invalid_attribute' })

describe('run: a Flightdeck that does not know the display-only fields', () => {
  const displayInputs = () => {
    happyInputs()
    inputs.project = 'SHOP'
    inputs.actor = 'octo-dev'
    inputs['run-url'] = `${RUN_URL}/attempts/1`
    inputs['image-digest'] = DIGEST
  }
  const answers = (...responses) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'SHOP' }], 1, 1))
    for (const response of responses) fetchMock.mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const posted = (fetchMock, n) => JSON.parse(fetchMock.mock.calls[n][1].body).release_event
  const BASE_EVENT = {
    environment: 'production',
    kind: 'deploy',
    release_tag: 'release-2026-09-04-10123',
    build_number: '10123',
    sha: SHA,
    rollback_safe: true,
    rollback_safe_reasons: ['2 additive migration(s)']
  }

  it('posts again once without them, names them in a warning, and records the event', async () => {
    displayInputs()
    const fetchMock = answers(unknownKeys('actor, image_digest, run_url'), jsonResponse(201, { id: 902 }))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(posted(fetchMock, 1)).toMatchObject({ actor: 'octo-dev', image_digest: DIGEST })
    expect(posted(fetchMock, 2)).toEqual(BASE_EVENT)
    expect(fetchMock.mock.calls[2][0]).toBe('https://flightdeck.cru.org/api/v1/projects/42/release-events')
    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('Posting the event again without actor, run_url, image_digest.'))
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(output('status')).toBe('created')
    expect(output('event-id')).toBe('902')
  })

  it('retries when only one of them was sent and named', async () => {
    happyInputs()
    inputs.project = 'SHOP'
    inputs['run-url'] = RUN_URL
    const fetchMock = answers(unknownKeys('run_url'), jsonResponse(200, { id: 903 }))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(posted(fetchMock, 2)).toEqual(BASE_EVENT)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('Posting the event again without run_url.'))
    expect(output('status')).toBe('updated')
  })

  // The case this retry exists for today: requested_by ships here before
  // Flightdeck takes it. Only requested_by is dropped, and the event keeps
  // the display fields Flightdeck does take.
  it('drops only requested_by when a Flightdeck that lacks it refuses it, and keeps the other display fields', async () => {
    displayInputs()
    inputs['requested-by'] = 'someone@example.org'
    const refusedRequester = jsonResponse(422, { error: `unknown key: requested_by ${SETTABLE_WITH_DISPLAY}`, code: 'invalid_attribute' })
    const fetchMock = answers(refusedRequester, jsonResponse(201, { id: 904 }))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(posted(fetchMock, 1)).toMatchObject({ requested_by: 'someone@example.org' })
    expect(posted(fetchMock, 2)).toEqual({ ...BASE_EVENT, actor: 'octo-dev', run_url: `${RUN_URL}/attempts/1`, image_digest: DIGEST })
    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('Posting the event again without requested_by.'))
    expect(output('status')).toBe('created')
    expect(output('event-id')).toBe('904')
  })

  it('drops only the fields named when an older Flightdeck lacks several', async () => {
    displayInputs()
    inputs['requested-by'] = 'someone@example.org'
    const fetchMock = answers(unknownKeys('image_digest, requested_by'), jsonResponse(201, { id: 905 }))
    await run()
    expect(posted(fetchMock, 2)).toEqual({ ...BASE_EVENT, actor: 'octo-dev', run_url: `${RUN_URL}/attempts/1` })
    expect(output('status')).toBe('created')
  })

  it('does not retry a second time when the retry is refused too', async () => {
    displayInputs()
    const fetchMock = answers(unknownKeys('actor, image_digest, run_url'), unknownKeys('actor, image_digest, run_url'))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(output('status')).toBe('failed')
    expect(warningMock).toHaveBeenLastCalledWith(expect.stringContaining('Flightdeck release event not recorded (non-blocking)'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a different invalid attribute', jsonResponse(422, { error: 'environment is required', code: 'invalid_attribute' })],
    ['an unknown key that is not a display field', unknownKeys('rollback-safe')],
    ['a bad value in a display field', jsonResponse(422, { error: 'actor must be a GitHub login (1-39 letters, digits or hyphens), got "x y"', code: 'invalid_attribute' })],
    ['an unknown-keys message under another code', jsonResponse(422, { error: `unknown keys: actor, run_url ${SETTABLE}`, code: 'validation_failed' })],
    ['an unknown-keys message on another status', jsonResponse(400, { error: `unknown keys: actor, run_url ${SETTABLE}`, code: 'invalid_attribute' })],
    ['a 422 with no JSON body', { ok: false, status: 422, statusText: 'Unprocessable Content', json: async () => { throw new Error('not json') } }]
  ])('does not retry %s', async (_name, response) => {
    displayInputs()
    const fetchMock = answers(response)
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(output('status')).toBe('failed')
    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('Flightdeck release event not recorded (non-blocking)'))
  })

  it('does not retry an unknown-keys refusal when the event carried no display fields', async () => {
    happyInputs()
    inputs.project = 'SHOP'
    const fetchMock = answers(unknownKeys('actor'))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(output('status')).toBe('failed')
  })
})

describe('refusedDisplayFields', () => {
  const refusal = (status, body) => Object.assign(new Error('x'), { status, body })
  const event = { environment: 'production', actor: 'a', requested_by: 'someone@example.org', run_url: RUN_URL, image_digest: DIGEST }
  const unknown = (list, settable = SETTABLE_WITH_DISPLAY) => refusal(422, { error: `unknown key${list.includes(',') ? 's' : ''}: ${list} ${settable}`, code: 'invalid_attribute' })

  it('drops only the display fields the message names', () => {
    expect(refusedDisplayFields(unknown('requested_by'), event)).toEqual(['requested_by'])
    expect(refusedDisplayFields(unknown('image_digest'), event)).toEqual(['image_digest'])
    expect(refusedDisplayFields(unknown('actor, image_digest, requested_by, run_url'), event)).toEqual(['actor', 'requested_by', 'run_url', 'image_digest'])
  })

  // The settable list names display fields Flightdeck takes. Reading it would
  // drop good fields from the retry.
  it('never reads the settable list as unknown keys', () => {
    const settable = '(settable: actor, requested_by, run_url, image_digest)'
    expect(refusedDisplayFields(unknown('requested_by', '(settable: actor, run_url, image_digest)'), event)).toEqual(['requested_by'])
    expect(refusedDisplayFields(unknown('frobnicate', settable), event)).toEqual([])
  })

  it('drops only fields the event carries', () => {
    const withoutRequester = { ...event }
    delete withoutRequester.requested_by
    expect(refusedDisplayFields(unknown('requested_by, run_url'), withoutRequester)).toEqual(['run_url'])
  })

  it('reads the list loosely: case, spacing, "and", no settable part, no code', () => {
    expect(refusedDisplayFields(refusal(422, { error: 'Unknown Keys:  actor ,run_url' }), event)).toEqual(['actor', 'run_url'])
    expect(refusedDisplayFields(refusal(422, { error: 'unknown keys: actor and run_url' }), event)).toEqual(['actor', 'run_url'])
  })

  // Not Flightdeck's wording today, but a settable list without its "("
  // must still not be read as unknown keys.
  it('stops the list at the word settable even without a "("', () => {
    expect(refusedDisplayFields(refusal(422, { error: 'unknown key: requested_by; settable: actor, run_url, image_digest' }), event)).toEqual(['requested_by'])
    expect(refusedDisplayFields(refusal(422, { error: 'unknown key: requested_by. Settable: actor, run_url' }), event)).toEqual(['requested_by'])
  })

  // When the message cannot say which keys were unknown, the retry leaves
  // out every display field, as it always did, so it cannot fail the same way
  // over one the message left unnamed.
  it('drops every display field the event carries when the list is cut short or names nothing', () => {
    const all = ['actor', 'requested_by', 'run_url', 'image_digest']
    expect(refusedDisplayFields(refusal(422, { error: 'unknown keys: a, b, c, d, run_url and 2 more (settable: x)' }), event)).toEqual(all)
    expect(refusedDisplayFields(refusal(422, { error: 'unknown keys: a, b, c, d, e and 1 more (settable: x)' }), event)).toEqual(all)
    expect(refusedDisplayFields(refusal(422, { error: 'unknown key:  (settable: x)', code: 'invalid_attribute' }), event)).toEqual(all)
    expect(refusedDisplayFields(refusal(422, { error: 'unknown keys:' }), event)).toEqual(all)
  })

  it('matches whole key names only', () => {
    expect(refusedDisplayFields(refusal(422, { error: 'unknown key: actors (settable: x)', code: 'invalid_attribute' }), event)).toEqual([])
    expect(refusedDisplayFields(refusal(422, { error: 'unknown key: old_run_url (settable: x)', code: 'invalid_attribute' }), event)).toEqual([])
  })

  it('ignores anything that is not that refusal', () => {
    expect(refusedDisplayFields(new Error('ECONNRESET'), event)).toEqual([])
    expect(refusedDisplayFields(refusal(422, null), event)).toEqual([])
    expect(refusedDisplayFields(refusal(422, { error: ['unknown keys: actor'] }), event)).toEqual([])
    expect(refusedDisplayFields(refusal(422, { error: 'the settable list mentions unknown keys: actor' }), event)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Workflow wiring. These read the real workflow files and run each release
// event step's inputs through run(), so what a workflow sends cannot change
// without a test failing.

const ACTION = './cru-github-actions/actions/flightdeck-release-event'
const actionYml = loadYaml('actions/flightdeck-release-event/action.yml')
const WORKFLOWS = {
  promote: loadYaml('.github/workflows/promote.yml'),
  rollback: loadYaml('.github/workflows/rollback.yml'),
  'deploy-candidate': loadYaml('.github/workflows/deploy-candidate.yml')
}
const RUN_URL_INPUT = '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}'

const eventSteps = Object.entries(WORKFLOWS).flatMap(([workflow, spec]) => Object.entries(spec.jobs).flatMap(([jobId, job]) =>
  job.steps.filter((step) => step.uses === ACTION).map((step) => ({ id: `${workflow}:${jobId}`, workflow, jobId, job, step }))))
function stepOf (id) {
  const entry = eventSteps.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`${id} has no "${ACTION}" step`)
  return entry
}

// What the runner would fill in. github.actor and github.triggering_actor
// differ, as on a re-run started by someone else.
const PROMOTE_KIND = "steps.release-kind.outputs.kind == 'hotfix' && 'hotfix' || 'deploy'"
const TARGET_SHA = '5ca1ab1e00000000000000000000000000000042'
const RESOLVED_DIGEST = 'sha256:' + 'e'.repeat(64)
const runnerContext = () => ({
  'secrets.flightdeck-token': 'fd_pat_test',
  'inputs.flightdeck-url': 'https://flightdeck.example.test',
  'needs.lookup.outputs.flightdeck-project': 'SHOP',
  'inputs.project-name': 'shop-web',
  'inputs.tag': 'candidate-2026-09-03-10120',
  'steps.release.outputs.release': 'release-2026-09-03-10120',
  'steps.actual-release.outputs.tag': 'release-2026-09-03-10120',
  'steps.resolve.outputs.tags': `candidate-2026-09-03-10120,sha-${TARGET_SHA},release-2026-09-03-10120`,
  'steps.resolve.outputs.digest': RESOLVED_DIGEST,
  'steps.rollback-safety.outputs.verdict': 'safe',
  'steps.rollback-safety.outputs.reasons': '["no migration changes in this release"]',
  'github.actor': 'first-starter',
  'github.triggering_actor': 're-runner',
  'github.server_url': 'https://github.com',
  'github.repository': 'example-org/deploy-wrappers',
  'github.run_id': '9001',
  'github.run_attempt': '2',
  // A run the deploy gate did not start: authorize-actor sets no requester.
  'steps.authz.outputs.requester': '',
  // promote's kind: hotfix only when its release-kind step said so.
  [PROMOTE_KIND]: 'deploy'
})

// Run one workflow step's action with the inputs the workflow gives it, and
// return the event it posted. `overrides` replaces what the runner fills in.
async function postFrom (step, overrides = {}) {
  for (const [name, value] of Object.entries(step.with)) inputs[name] = resolveExpressions(value, { ...runnerContext(), ...overrides })
  // The attempt the context names has passed authorize-actor, as it must
  // have for a production event.
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
  vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '2')
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'SHOP' }], 1, 1))
    .mockResolvedValueOnce(jsonResponse(201, { id: 77 }))
  vi.stubGlobal('fetch', fetchMock)
  await run()
  expect(setFailedMock).not.toHaveBeenCalled()
  expect(warningMock).not.toHaveBeenCalled()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[1][0]).toBe('https://flightdeck.example.test/api/v1/projects/42/release-events')
  return JSON.parse(fetchMock.mock.calls[1][1].body).release_event
}

describe('release event wiring', () => {
  it('posts a release event from every job that deploys, promotes, rolls back or verifies a candidate', () => {
    expect(eventSteps.map((entry) => entry.id)).toEqual([
      'promote:promote-gcp', 'promote:promote-aws',
      'rollback:rollback-gcp', 'rollback:rollback-aws',
      'deploy-candidate:deploy-candidate-gcp', 'deploy-candidate:deploy-candidate-aws', 'deploy-candidate:verify-candidate-aws'
    ])
  })

  it.each(Object.entries(WORKFLOWS))('%s posts to the Flightdeck URL input, which defaults to the action\'s own endpoint', (_name, workflow) => {
    expect(workflow.on.workflow_call.inputs['flightdeck-url'].default).toBe(actionYml.inputs.endpoint.default)
    expect(actionYml.inputs.endpoint.default).toBe(DEFAULT_ENDPOINT)
  })

  describe.each(eventSteps.map((entry) => [entry.id, entry]))('%s', (_id, { workflow, job, step }) => {
    it('passes only inputs the action declares, and every required one', () => {
      const declared = actionYml.inputs
      for (const name of Object.keys(step.with)) expect(declared).toHaveProperty(name)
      for (const [name, spec] of Object.entries(declared)) if (spec.required) expect(step.with).toHaveProperty(name)
    })

    it('names the account that started this attempt, this attempt\'s run, and the resolved digest', () => {
      expect(step.with).toMatchObject({
        actor: '${{ github.triggering_actor }}',
        'run-url': RUN_URL_INPUT,
        'image-digest': '${{ steps.resolve.outputs.digest }}',
        'image-tags': '${{ steps.resolve.outputs.tags }}',
        endpoint: '${{ inputs.flightdeck-url }}'
      })
      const resolveAt = job.steps.findIndex((s) => s.id === 'resolve')
      expect(resolveAt).toBeGreaterThanOrEqual(0)
      expect(resolveAt).toBeLessThan(job.steps.indexOf(step))
    })

    it('posts the re-runner, the attempt\'s run URL, the digest and the commit sha', async () => {
      const event = await postFrom(step)
      expect(event).toMatchObject({
        app: 'shop-web',
        actor: 're-runner',
        run_url: 'https://github.com/example-org/deploy-wrappers/actions/runs/9001/attempts/2',
        image_digest: RESOLVED_DIGEST,
        sha: TARGET_SHA
      })
      expect(event).not.toHaveProperty('requested_by')
      expect(event.environment).toBe(workflow === 'deploy-candidate' ? 'staging' : 'production')
    })

    // Only promote and rollback run authorize-actor, so only their events
    // can name who asked the deploy gate. The requester comes from the check
    // in the same job, which runs before the event step.
    if (workflow === 'deploy-candidate') {
      it('sends no requester: nothing in this job asks the deploy gate', () => {
        expect(step.with).not.toHaveProperty('requested-by')
      })
    } else {
      it('sends the requester from the authorize-actor check earlier in the same job', () => {
        expect(step.with['requested-by']).toBe('${{ steps.authz.outputs.requester }}')
        const check = job.steps.findIndex((s) => s.id === 'authz')
        expect(check).toBeGreaterThanOrEqual(0)
        expect(job.steps[check].uses).toBe('./cru-github-actions/actions/authorize-actor')
        expect(check).toBeLessThan(job.steps.indexOf(step))
      })

      // The person's full email, not masked: Flightdeck needs a sign-in to
      // read. actor still names the account that started the attempt.
      it('names the person who asked the deploy gate, by their full email, and leaves actor alone', async () => {
        const event = await postFrom(step, {
          'steps.authz.outputs.requester': 'someone@example.org',
          'github.actor': 'deploy-gate[bot]',
          'github.triggering_actor': 'deploy-gate[bot]'
        })
        expect(event).toMatchObject({ actor: 'deploy-gate[bot]', requested_by: 'someone@example.org' })
      })
    }

    it('stays telemetry: it can never fail the job', () => {
      expect(step['continue-on-error']).toBe(true)
    })
  })

  // A hotfix is promoted like any candidate; only the event's kind differs.
  // The kind is hotfix only when the release-kind step's output is exactly
  // hotfix. An empty output (the step failed, or a workflow-ref without the
  // action) is deploy, as every promote was before.
  describe.each(['promote:promote-gcp', 'promote:promote-aws'])('%s kind', (id) => {
    it('is hotfix only when the release-kind step says so', async () => {
      const { job, step } = stepOf(id)
      expect(step.with.kind).toBe(`\${{ ${PROMOTE_KIND} }}`)
      const kindStep = job.steps.find((s) => s.id === 'release-kind')
      expect(kindStep).toMatchObject({
        uses: './cru-github-actions/actions/hotfix',
        'continue-on-error': true,
        with: { mode: 'release-kind', 'github-token': '${{ secrets.authz-token }}', repository: '${{ needs.lookup.outputs.repository }}', 'project-name': '${{ inputs.project-name }}', sha: '${{ steps.baseline.outputs.head-sha }}' }
      })
      // Before production changes, since a stale hotfix is refused on what
      // it finds, and so before the event that reads it.
      const names = job.steps.map((s) => s.name)
      expect(job.steps.indexOf(kindStep)).toBeLessThan(names.indexOf('Deploy to production'))
      expect(job.steps.indexOf(kindStep)).toBeLessThan(job.steps.indexOf(step))
      expect((await postFrom(step, { [PROMOTE_KIND]: 'hotfix' })).kind).toBe('hotfix')
      expect((await postFrom(step)).kind).toBe('deploy')
    })
  })

  it.each(['rollback:rollback-gcp', 'rollback:rollback-aws'])('%s sends the sha of the release it rolled back to', async (id) => {
    const { job, step } = stepOf(id)
    // The tags come from the step that resolved the TARGET release by tag.
    const resolve = job.steps.find((s) => s.id === 'resolve')
    expect(resolve.with).toMatchObject({ mode: 'tag', tag: '${{ needs.lookup.outputs.release-tag }}' })
    const event = await postFrom(step)
    expect(event).toMatchObject({ kind: 'rollback', release_tag: 'release-2026-09-03-10120', sha: TARGET_SHA })
    // Still no verdict: a rollback is not classified.
    expect(event).not.toHaveProperty('rollback_safe')
  })

  describe('verify-candidate-aws (stage-less)', () => {
    // Looked up inside each test, so a missing step fails these tests by name.
    const verify = () => {
      const { job, step } = stepOf('deploy-candidate:verify-candidate-aws')
      return { job, step, names: job.steps.map((s) => s.name) }
    }

    it('posts the same event a stage deploy posts', () => {
      const { step } = verify()
      expect(step.with).toEqual(stepOf('deploy-candidate:deploy-candidate-aws').step.with)
      expect(step.with).toMatchObject({ environment: 'staging', kind: 'deploy', 'release-tag': '${{ inputs.tag }}' })
    })

    it('posts only after the candidate is verified, and not on a no-op run', () => {
      const { job, step, names } = verify()
      const at = job.steps.indexOf(step)
      expect(at).toBeGreaterThan(names.indexOf('Verify the candidate image'))
      expect(at).toBeGreaterThan(names.indexOf('Record deployment in ledger'))
      expect(names.indexOf('Verify the candidate image')).toBeGreaterThan(0)
      expect(step.if).toBe("steps.noop.outputs.skip != 'true'")
      // The verify step itself can fail the job, which skips this one.
      const verifyStep = job.steps.find((s) => s.name === 'Verify the candidate image')
      expect(verifyStep['continue-on-error']).toBeUndefined()
      expect(verifyStep.if).toBe("steps.noop.outputs.skip != 'true'")
    })

    it('posts the candidate as a staging deploy with its tag, build number and sha', async () => {
      const event = await postFrom(verify().step)
      expect(event).toEqual({
        app: 'shop-web',
        environment: 'staging',
        kind: 'deploy',
        release_tag: 'candidate-2026-09-03-10120',
        build_number: '10120',
        sha: TARGET_SHA,
        actor: 're-runner',
        run_url: 'https://github.com/example-org/deploy-wrappers/actions/runs/9001/attempts/2',
        image_digest: RESOLVED_DIGEST
      })
    })
  })
})
