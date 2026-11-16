import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mocked octokit + @actions/core. `inputs` is the per-test getInput backing map;
// getInput enforces `required` the same way @actions/core does so we can assert
// the missing-input failure paths.
const { createWorkflowDispatch, core, inputs } = vi.hoisted(() => ({
  createWorkflowDispatch: vi.fn(),
  core: {
    notice: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setSecret: vi.fn()
  },
  inputs: {}
}))
const noticeMock = core.notice
const setFailedMock = core.setFailed

vi.mock('@actions/github', () => ({
  getOctokit: () => ({ rest: { actions: { createWorkflowDispatch } } })
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') {
      throw new Error(`Input required and not supplied: ${name}`)
    }
    return value
  },
  notice: core.notice,
  setFailed: core.setFailed,
  info: core.info,
  warning: core.warning,
  setSecret: core.setSecret
}))

import { parseInputsJson, parseRepo, run } from '../src/dispatch.js'
import { parseGateUrl, GATE_ATTEMPTS } from '../src/v2/gate-dispatch.js'

beforeEach(() => {
  createWorkflowDispatch.mockReset()
  for (const fn of Object.values(core)) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
})

describe('parseInputsJson', () => {
  it('treats empty / blank input as no inputs', () => {
    expect(parseInputsJson('')).toEqual({})
    expect(parseInputsJson('   ')).toEqual({})
    expect(parseInputsJson(undefined)).toEqual({})
  })

  it('parses a JSON object payload', () => {
    expect(parseInputsJson('{"project-name":"example-app","release":"release-10012"}')).toEqual({
      'project-name': 'example-app',
      release: 'release-10012'
    })
  })

  it('throws on malformed JSON', () => {
    expect(() => parseInputsJson('{not json}')).toThrow(/not valid JSON/)
  })

  it('throws when the payload is not an object', () => {
    expect(() => parseInputsJson('[1,2,3]')).toThrow(/must be a JSON object/)
    expect(() => parseInputsJson('"example-app"')).toThrow(/must be a JSON object/)
    expect(() => parseInputsJson('null')).toThrow(/must be a JSON object/)
  })
})

describe('parseRepo', () => {
  it('splits an owner/name slug', () => {
    expect(parseRepo('CruGlobal/cru-deploy')).toEqual({ owner: 'CruGlobal', repo: 'cru-deploy' })
  })

  it.each(['', 'cru-deploy', 'a/b/c', '/cru-deploy', 'CruGlobal/'])(
    'rejects malformed slug %j',
    (slug) => {
      expect(() => parseRepo(slug)).toThrow(/owner\/name/)
    }
  )
})

describe('run', () => {
  it('dispatches with defaults and a parsed inputs payload', async () => {
    inputs['github-token'] = 'tok'
    inputs.workflow = 'promote.yml'
    inputs['inputs-json'] = '{"project-name":"example-app"}'

    await run()

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'CruGlobal',
      repo: 'cru-deploy',
      workflow_id: 'promote.yml',
      ref: 'main',
      inputs: { 'project-name': 'example-app' }
    })
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('promote.yml'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('honors an explicit repo and ref', async () => {
    inputs['github-token'] = 'tok'
    inputs.repo = 'CruGlobal/example-app'
    inputs.workflow = 'rollback.yml'
    inputs.ref = 'pipeline-v2'

    await run()

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'CruGlobal',
      repo: 'example-app',
      workflow_id: 'rollback.yml',
      ref: 'pipeline-v2',
      inputs: {}
    })
  })

  it('fails (never throws) on invalid inputs-json', async () => {
    inputs['github-token'] = 'tok'
    inputs.workflow = 'promote.yml'
    inputs['inputs-json'] = '{bad}'

    await run()

    expect(createWorkflowDispatch).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/))
  })

  it('fails when a required input is missing', async () => {
    inputs.workflow = 'promote.yml'

    await run()

    expect(createWorkflowDispatch).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/github-token/))
  })
})

// The deploy gate (gate-url). fetch is mocked, and answers for both the
// runner's OIDC token service and the gate, by URL; nothing reaches a network.
const GATE_URL = 'https://gate.example.com/gate'
const ROUTE = 'https://gate.example.com/gate/pipeline'
const TOKEN_URL = 'https://token.example.com/idtoken?api-version=2.0'
const REQUEST_TOKEN = 'example-request-token'
const RUN_URL = 'https://github.com/example-org/example-deploy/actions/runs/9000000001'
// Short waits and time limits, so the retries take milliseconds.
const FAST = { delaysMs: [0, 0], tryTimeoutMs: 50, tokenTryTimeoutMs: 50 }
const PAGE = 'https://github.com/CruGlobal/cru-deploy/actions/workflows/deploy-candidate.yml'

const answer = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refusal = (status, code, message = `refused: ${code}`, headers = {}) => answer(status, { code, message }, headers)
const started = (workflow = 'deploy-candidate.yml') => answer(202, {
  project: 'example-app',
  workflow,
  target: 'candidate-2026-11-16-10001',
  runUrl: RUN_URL,
  runId: 9000000001,
  message: `started ${workflow} for example-app`
})
// A fetch that never answers, and rejects only when its signal aborts.
const hanging = (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason))
})
// An answer whose status and headers arrive but whose body then stops
// partway, or breaks off with the error fetch gives for a dropped connection.
const stalled = (status) => new Response(new ReadableStream({
  start (controller) { controller.enqueue(new TextEncoder().encode('{"workflow":')) }
}), { status, headers: { 'content-type': 'application/json' } })
const brokenOff = (status) => new Response(new ReadableStream({
  start (controller) {
    controller.enqueue(new TextEncoder().encode('{"workflow":'))
    controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }))
  }
}), { status, headers: { 'content-type': 'application/json' } })
const mayHaveStarted = (what) => `${what}. deploy-candidate.yml may have started, so this step does not try again or fall back to github-token: check the deploy repo's runs of it before starting it again (${PAGE})`

// Each token the runner hands out is new: oidc-token-1, oidc-token-2, ...
let tokenService, gate, minted
const route = vi.fn((url, init) => String(url).startsWith(TOKEN_URL) ? tokenService(url, init) : gate(url, init))
const gateCalls = () => route.mock.calls.filter(([url]) => !String(url).startsWith(TOKEN_URL))
const bearer = ([, init]) => init.headers.authorization
// Everything the action logged, except what it asked to mask.
const logged = () => JSON.stringify([core.notice, core.setFailed, core.info, core.warning].map((fn) => fn.mock.calls))

function deployCandidate (extra = {}) {
  Object.assign(inputs, {
    'gate-url': GATE_URL,
    workflow: 'deploy-candidate.yml',
    'inputs-json': '{"project-name":"example-app","tag":"candidate-2026-11-16-10001"}',
    ...extra
  })
}

describe('the deploy gate', () => {
  beforeEach(() => {
    route.mockClear()
    minted = 0
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', TOKEN_URL)
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', REQUEST_TOKEN)
    tokenService = vi.fn(async () => answer(200, { count: 1, value: `oidc-token-${++minted}` }))
    gate = vi.fn(async () => started())
    vi.stubGlobal('fetch', route)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe('parseGateUrl', () => {
    it('is off when empty', () => {
      expect(parseGateUrl('')).toBeNull()
      expect(parseGateUrl('  ')).toBeNull()
      expect(parseGateUrl(undefined)).toBeNull()
    })

    it.each([
      [GATE_URL],
      [`${GATE_URL}/`],
      [` ${GATE_URL} `],
      ['HTTPS://Gate.Example.com/gate']
    ])('turns %j into the pipeline route, which is also the audience', (value) => {
      expect(parseGateUrl(value)).toEqual({ route: ROUTE, audience: ROUTE })
    })

    it('adds the route to a bare host', () => {
      expect(parseGateUrl('https://gate.example.com')).toEqual({ route: 'https://gate.example.com/pipeline', audience: 'https://gate.example.com/pipeline' })
    })

    it.each([
      'http://gate.example.com/gate',
      'gate.example.com/gate',
      'https://gate.example.com/gate?x=1',
      'https://gate.example.com/gate#x',
      'not a url'
    ])('refuses %j', (value) => {
      expect(() => parseGateUrl(value)).toThrow(/gate-url must be an https URL/)
    })

    it('refuses a URL with a password without printing it', () => {
      expect(() => parseGateUrl('https://user:example-password@gate.example.com/gate')).toThrow(/no user name or password/)
      expect(() => parseGateUrl('https://user:example-password@gate.example.com/gate')).not.toThrow(/example-password/)
    })
  })

  describe('without gate-url', () => {
    it('dispatches with the token exactly as before, and never asks for an OIDC token', async () => {
      inputs['github-token'] = 'tok'
      inputs.workflow = 'deploy-candidate.yml'
      inputs['inputs-json'] = '{"project-name":"example-app","tag":"candidate-2026-11-16-10001"}'

      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(createWorkflowDispatch).toHaveBeenCalledWith({
        owner: 'CruGlobal',
        repo: 'cru-deploy',
        workflow_id: 'deploy-candidate.yml',
        ref: 'main',
        inputs: { 'project-name': 'example-app', tag: 'candidate-2026-11-16-10001' }
      })
      expect(core.notice).toHaveBeenCalledWith('Dispatched deploy-candidate.yml on CruGlobal/cru-deploy@main. See https://github.com/CruGlobal/cru-deploy/actions/workflows/deploy-candidate.yml.')
      expect(core.warning).not.toHaveBeenCalled()
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('still requires github-token with the same error', async () => {
      inputs.workflow = 'deploy-candidate.yml'
      await run(FAST)
      expect(setFailedMock).toHaveBeenCalledWith('Input required and not supplied: github-token')
      expect(route).not.toHaveBeenCalled()
    })
  })

  describe('a request the gate takes', () => {
    it('asks the runner for a token for the route, the way the toolkit does, and masks it', async () => {
      deployCandidate()
      await run(FAST)

      expect(tokenService).toHaveBeenCalledTimes(1)
      const [url, request] = tokenService.mock.calls[0]
      expect(url).toBe(`${TOKEN_URL}&audience=${encodeURIComponent(ROUTE)}`)
      expect(request).toMatchObject({
        method: 'GET',
        headers: { authorization: `Bearer ${REQUEST_TOKEN}`, accept: 'application/json' },
        redirect: 'manual',
        signal: expect.any(AbortSignal)
      })
      expect(core.setSecret).toHaveBeenCalledWith('oidc-token-1')
    })

    it('posts the workflow and its inputs to the route with the token, and nothing else', async () => {
      deployCandidate()
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(1)
      const [url, request] = gate.mock.calls[0]
      expect(url).toBe(ROUTE)
      expect(request).toMatchObject({
        method: 'POST',
        headers: { authorization: 'Bearer oidc-token-1', 'content-type': 'application/json', accept: 'application/json' },
        redirect: 'manual',
        signal: expect.any(AbortSignal)
      })
      expect(JSON.parse(request.body)).toEqual({
        workflow: 'deploy-candidate.yml',
        inputs: { 'project-name': 'example-app', tag: 'candidate-2026-11-16-10001' }
      })
    })

    it('prints the run link from the gate\'s answer, and never uses the token', async () => {
      deployCandidate({ 'github-token': 'tok' })
      await run(FAST)

      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(core.notice).toHaveBeenCalledWith(`Dispatched deploy-candidate.yml through the deploy gate. See ${RUN_URL}.`)
      expect(core.info).toHaveBeenCalledWith('the deploy gate says: started deploy-candidate.yml for example-app')
      expect(core.warning).not.toHaveBeenCalled()
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('needs no github-token', async () => {
      deployCandidate()
      await run(FAST)
      expect(setFailedMock).not.toHaveBeenCalled()
      expect(core.notice).toHaveBeenCalledWith(expect.stringContaining(RUN_URL))
    })

    it('sends notify-build-failure.yml the same way', async () => {
      const runUrl = 'https://github.com/example-org/example-app/actions/runs/9000000002'
      Object.assign(inputs, {
        'gate-url': GATE_URL,
        workflow: 'notify-build-failure.yml',
        'inputs-json': JSON.stringify({ 'project-name': 'example-app', 'run-url': runUrl })
      })
      gate.mockResolvedValue(started('notify-build-failure.yml'))
      await run(FAST)

      expect(JSON.parse(gate.mock.calls[0][1].body)).toEqual({
        workflow: 'notify-build-failure.yml',
        inputs: { 'project-name': 'example-app', 'run-url': runUrl }
      })
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it.each([
      ['no run link', answer(202, { workflow: 'deploy-candidate.yml', message: 'started' })],
      ['a run link that is not https', answer(202, { workflow: 'deploy-candidate.yml', runUrl: 'javascript:alert(1)' })]
    ])('takes a 202 naming the workflow with %s as started, with the workflow page as the link', async (_label, response) => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockResolvedValue(response)
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(1)
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(core.notice).toHaveBeenCalledWith(`Dispatched deploy-candidate.yml through the deploy gate. See ${PAGE}.`)
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('never logs a token', async () => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockResolvedValueOnce(answer(503, {})).mockResolvedValueOnce(answer(503, {}))
      await run(FAST)
      expect(minted).toBe(3)
      for (let n = 1; n <= minted; n++) expect(logged()).not.toContain(`oidc-token-${n}`)
      expect(logged()).not.toContain(REQUEST_TOKEN)
    })
  })

  // Something said yes, so the workflow may have started. Sending the
  // request again, through the gate or with the token, could start it twice.
  describe('a 2xx that is not the gate\'s answer to a start', () => {
    it.each([
      ['a web page on 200, as from a gate-url that points at another site', () => new Response('<!doctype html><title>Welcome</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
        'gate-url answered HTTP 200, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['the gate\'s JSON on 200', () => answer(200, { workflow: 'deploy-candidate.yml', runUrl: RUN_URL }),
        'gate-url answered HTTP 200, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['201', () => answer(201, { workflow: 'deploy-candidate.yml' }),
        'gate-url answered HTTP 201, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['204', () => new Response(null, { status: 204 }),
        'gate-url answered HTTP 204, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['a 202 naming another workflow', () => started('notify-build-failure.yml'),
        'gate-url answered HTTP 202 naming notify-build-failure.yml, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['a 202 naming no workflow', () => answer(202, { runUrl: RUN_URL, message: 'started' }),
        'gate-url answered HTTP 202, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['a 202 whose body is not JSON', () => answer(202, 'accepted'),
        'gate-url answered HTTP 202, not the deploy gate\'s HTTP 202 naming deploy-candidate.yml, so gate-url may not point at the deploy gate'],
      ['a 202 whose body stalls', () => stalled(202),
        'the deploy gate answered HTTP 202, but the rest of its answer did not arrive within 0.05 seconds'],
      ['a 200 whose body stalls', () => stalled(200),
        'the deploy gate answered HTTP 200, but the rest of its answer did not arrive within 0.05 seconds'],
      ['a 202 whose body breaks off', () => brokenOff(202),
        'the deploy gate answered HTTP 202, but the rest of its answer broke off (UND_ERR_SOCKET)']
    ])('fails on %s after one try, and never tries again or falls back', async (_label, respond, what) => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockImplementation(respond)
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(1)
      expect(tokenService).toHaveBeenCalledTimes(1)
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(core.notice).not.toHaveBeenCalled()
      expect(core.warning).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith(mayHaveStarted(what))
    })
  })

  describe('retries', () => {
    it('asks for a fresh token for every try, since the gate takes each one once', async () => {
      deployCandidate()
      gate
        .mockResolvedValueOnce(answer(503, {}))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(started())
      await run(FAST)

      expect(tokenService).toHaveBeenCalledTimes(3)
      expect(gateCalls().map(bearer)).toEqual(['Bearer oidc-token-1', 'Bearer oidc-token-2', 'Bearer oidc-token-3'])
      expect(core.notice).toHaveBeenCalledWith(`Dispatched deploy-candidate.yml through the deploy gate. See ${RUN_URL}.`)
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('says why it tries again', async () => {
      deployCandidate()
      gate.mockResolvedValueOnce(refusal(503, 'not_configured')).mockResolvedValueOnce(started())
      await run(FAST)
      expect(core.info).toHaveBeenCalledWith('the deploy gate did not take the request (the deploy gate answered HTTP 503 not_configured); trying again in 0 seconds (2/3)')
    })

    it.each([408, 429])('tries again on HTTP %i with a fresh token', async (status) => {
      deployCandidate()
      gate.mockResolvedValueOnce(refusal(status, 'slow_down')).mockResolvedValueOnce(started())
      await run(FAST)

      expect(gateCalls().map(bearer)).toEqual(['Bearer oidc-token-1', 'Bearer oidc-token-2'])
      expect(core.info).toHaveBeenCalledWith(`the deploy gate did not take the request (the deploy gate answered HTTP ${status} slow_down); trying again in 0 seconds (2/3)`)
      expect(core.notice).toHaveBeenCalledWith(`Dispatched deploy-candidate.yml through the deploy gate. See ${RUN_URL}.`)
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('decides on the status when a 5xx body stalls, and tries again', async () => {
      deployCandidate()
      gate.mockImplementationOnce(() => stalled(503)).mockResolvedValueOnce(started())
      await run(FAST)

      expect(gateCalls().map(bearer)).toEqual(['Bearer oidc-token-1', 'Bearer oidc-token-2'])
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    describe('Retry-After', () => {
      // The waits, recorded, and taken at once. The planned waits are the
      // real ones, 2 and 5 seconds, so the tries wait 7 seconds in all.
      let waits
      const options = () => ({ ...FAST, delaysMs: [2000, 5000], sleep: async (ms) => { waits.push(ms) } })
      beforeEach(() => { waits = [] })

      it('waits the planned times when the gate does not ask', async () => {
        deployCandidate()
        gate.mockResolvedValueOnce(refusal(429, 'slow_down')).mockResolvedValueOnce(answer(503, {})).mockResolvedValueOnce(started())
        await run(options())
        expect(waits).toEqual([2000, 5000])
        expect(setFailedMock).not.toHaveBeenCalled()
      })

      it('waits as long as the gate asks, out of the later waits', async () => {
        deployCandidate()
        gate
          .mockResolvedValueOnce(refusal(429, 'slow_down', 'too many', { 'retry-after': '3' }))
          .mockResolvedValueOnce(answer(503, {}))
          .mockResolvedValueOnce(started())
        await run(options())

        expect(waits).toEqual([3000, 4000])
        expect(gateCalls().map(bearer)).toEqual(['Bearer oidc-token-1', 'Bearer oidc-token-2', 'Bearer oidc-token-3'])
        expect(setFailedMock).not.toHaveBeenCalled()
      })

      it('takes an HTTP date', async () => {
        deployCandidate()
        gate
          .mockResolvedValueOnce(refusal(503, 'not_configured', 'not yet', { 'retry-after': new Date(Date.now() + 6000).toUTCString() }))
          .mockResolvedValueOnce(started())
        await run(options())

        expect(waits).toHaveLength(1)
        expect(waits[0]).toBeGreaterThan(3000)
        expect(waits[0]).toBeLessThanOrEqual(6000)
        expect(setFailedMock).not.toHaveBeenCalled()
      })

      it('ends the tries and falls back when the gate asks for longer than the tries have left', async () => {
        deployCandidate({ 'github-token': 'tok' })
        gate.mockResolvedValue(refusal(503, 'not_configured', 'not yet', { 'retry-after': '60' }))
        await run(options())

        expect(waits).toEqual([])
        expect(gate).toHaveBeenCalledTimes(1)
        expect(core.warning).toHaveBeenCalledWith('the deploy gate did not take the request to start deploy-candidate.yml after 1 try (last: the deploy gate answered HTTP 503 not_configured, and asked for a wait of 60 seconds, longer than the tries have left); dispatching deploy-candidate.yml on CruGlobal/cru-deploy@main with github-token instead')
        expect(createWorkflowDispatch).toHaveBeenCalledTimes(1)
      })

      it('ignores a Retry-After it cannot read', async () => {
        deployCandidate()
        gate.mockResolvedValueOnce(refusal(429, 'slow_down', 'too many', { 'retry-after': 'soon' })).mockResolvedValueOnce(started())
        await run(options())
        expect(waits).toEqual([2000])
      })
    })

    it('tries again when the token service fails, and still sends each token once', async () => {
      deployCandidate()
      tokenService
        .mockResolvedValueOnce(answer(500, {}))
        .mockImplementation(async () => answer(200, { value: `oidc-token-${++minted}` }))
      await run(FAST)

      expect(tokenService).toHaveBeenCalledTimes(2)
      expect(gateCalls().map(bearer)).toEqual(['Bearer oidc-token-1'])
      expect(setFailedMock).not.toHaveBeenCalled()
    })
  })

  describe('a refusal', () => {
    it.each([
      [400, 'bad_request'],
      [401, 'token_replayed'],
      [403, 'repository_mismatch'],
      [403, 'workflow_not_allowed'],
      [404, ''],
      [404, 'not_configured'],
      [400, 'not_configured'],
      [409, 'conflict'],
      [302, '']
    ])('fails on HTTP %i %s with the gate\'s code and message, after one try, and never falls back', async (status, code) => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockResolvedValue(code ? refusal(status, code) : answer(status, ''))
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(1)
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith(
        `the deploy gate refused to start deploy-candidate.yml: HTTP ${status}${code ? ` ${code}: refused: ${code}` : ''}`
      )
    })

    it('decides on the status when a 4xx body stalls, and refuses after one try', async () => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockImplementation(() => stalled(403))
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(1)
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith('the deploy gate refused to start deploy-candidate.yml: HTTP 403')
    })

    it('shows the gate\'s message on one line', async () => {
      deployCandidate()
      gate.mockResolvedValue(refusal(403, 'repository_mismatch', 'this repository\n::notice::may not start it'))
      await run(FAST)
      expect(setFailedMock).toHaveBeenCalledWith('the deploy gate refused to start deploy-candidate.yml: HTTP 403 repository_mismatch: this repository ::notice::may not start it')
    })

    it('shows only a code that is a plain word', async () => {
      deployCandidate()
      gate.mockResolvedValue(answer(403, { code: 'Bad Code', message: 'no' }))
      await run(FAST)
      expect(setFailedMock).toHaveBeenCalledWith('the deploy gate refused to start deploy-candidate.yml: HTTP 403: no')
    })
  })

  describe('a gate that cannot take the request', () => {
    const cases = [
      ['answers 5xx', () => answer(502, 'Bad Gateway'), 'the deploy gate answered HTTP 502'],
      ['answers 503 with a code', () => refusal(503, 'internal_error'), 'the deploy gate answered HTTP 503 internal_error'],
      ['says not_configured on a 503', () => refusal(503, 'not_configured'), 'the deploy gate answered HTTP 503 not_configured'],
      ['answers 429', () => refusal(429, 'slow_down'), 'the deploy gate answered HTTP 429 slow_down'],
      ['answers 408', () => answer(408, ''), 'the deploy gate answered HTTP 408'],
      ['cannot be reached', () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'the deploy gate gave no answer (ENOTFOUND)'],
      ['does not answer in time', hanging, 'the deploy gate gave no answer within 0.05 seconds']
    ]

    it.each(cases)('falls back to github-token with a warning when it %s every try', async (_label, respond, reason) => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockImplementation(respond)
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(GATE_ATTEMPTS)
      expect(tokenService).toHaveBeenCalledTimes(GATE_ATTEMPTS)
      expect(core.warning).toHaveBeenCalledWith(
        `the deploy gate did not take the request to start deploy-candidate.yml after ${GATE_ATTEMPTS} tries (last: ${reason}); dispatching deploy-candidate.yml on CruGlobal/cru-deploy@main with github-token instead`
      )
      expect(createWorkflowDispatch).toHaveBeenCalledWith({
        owner: 'CruGlobal',
        repo: 'cru-deploy',
        workflow_id: 'deploy-candidate.yml',
        ref: 'main',
        inputs: { 'project-name': 'example-app', tag: 'candidate-2026-11-16-10001' }
      })
      expect(core.notice).toHaveBeenCalledWith(expect.stringMatching(/^Dispatched deploy-candidate\.yml on CruGlobal\/cru-deploy@main\./))
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it.each(cases)('fails, saying there is no token, when it %s every try and there is no github-token', async (_label, respond, reason) => {
      deployCandidate()
      gate.mockImplementation(respond)
      await run(FAST)

      expect(gate).toHaveBeenCalledTimes(GATE_ATTEMPTS)
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith(
        `the deploy gate did not take the request to start deploy-candidate.yml after ${GATE_ATTEMPTS} tries (last: ${reason}), and no github-token was given to use instead`
      )
    })

    it('falls back when the token service never hands out a token', async () => {
      deployCandidate({ 'github-token': 'tok' })
      tokenService.mockImplementation(async () => answer(500, {}))
      await run(FAST)

      expect(gate).not.toHaveBeenCalled()
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('the runner\'s OIDC token service answered HTTP 500 with no token'))
      expect(createWorkflowDispatch).toHaveBeenCalledTimes(1)
    })

    it('surfaces an error from the fallback dispatch', async () => {
      deployCandidate({ 'github-token': 'tok' })
      gate.mockImplementation(async () => answer(503, {}))
      createWorkflowDispatch.mockRejectedValue(new Error('Resource not accessible by integration'))
      await run(FAST)
      expect(setFailedMock).toHaveBeenCalledWith('Resource not accessible by integration')
    })
  })

  describe('a job with no OIDC token', () => {
    beforeEach(() => {
      vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '')
      vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')
    })

    it('warns and uses github-token', async () => {
      deployCandidate({ 'github-token': 'tok' })
      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(core.warning).toHaveBeenCalledWith('gate-url is set, but this job cannot get a GitHub OIDC token for the deploy gate (it needs permissions: id-token: write); dispatching deploy-candidate.yml on CruGlobal/cru-deploy@main with github-token instead')
      expect(createWorkflowDispatch).toHaveBeenCalledTimes(1)
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('fails clearly with no github-token', async () => {
      deployCandidate()
      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith('gate-url is set, but this job cannot get a GitHub OIDC token for the deploy gate (it needs permissions: id-token: write), and no github-token was given to use instead')
    })
  })

  describe('what the gate does not start', () => {
    it.each(['promote.yml', 'rollback.yml', 'record-deploy.yml', 'Deploy-Candidate.yml'])('sends %s with github-token, as before', async (workflow) => {
      deployCandidate({ 'github-token': 'tok', workflow })
      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ owner: 'CruGlobal', repo: 'cru-deploy', workflow_id: workflow, ref: 'main' }))
      expect(core.warning).not.toHaveBeenCalled()
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('fails clearly for another workflow with no github-token', async () => {
      deployCandidate({ workflow: 'promote.yml' })
      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith('gate-url is set, but the deploy gate starts only deploy-candidate.yml and notify-build-failure.yml, and no github-token was given to use instead')
    })

    it.each([
      [{ repo: 'example-org/example-deploy' }, 'example-org', 'example-deploy', 'main'],
      [{ ref: 'example-branch' }, 'CruGlobal', 'cru-deploy', 'example-branch']
    ])('sends deploy-candidate.yml with %j on github-token, with a warning, since the gate takes no repo or ref', async (extra, owner, repo, ref) => {
      deployCandidate({ 'github-token': 'tok', ...extra })
      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(core.warning).toHaveBeenCalledWith(`gate-url is set, but the deploy gate starts deploy-candidate.yml on CruGlobal/cru-deploy@main only; dispatching deploy-candidate.yml on ${owner}/${repo}@${ref} with github-token instead`)
      expect(createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ owner, repo, ref }))
    })

    it('takes the deploy repo in any case', async () => {
      deployCandidate({ repo: 'cruglobal/CRU-DEPLOY' })
      await run(FAST)
      expect(gate).toHaveBeenCalledTimes(1)
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it('fails on a gate-url that is not https, before sending anything', async () => {
      deployCandidate({ 'github-token': 'tok', 'gate-url': 'http://gate.example.com/gate' })
      await run(FAST)

      expect(route).not.toHaveBeenCalled()
      expect(createWorkflowDispatch).not.toHaveBeenCalled()
      expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/^gate-url must be an https URL/))
    })
  })
})
