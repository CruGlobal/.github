import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'

// The deploy gate's claim route as authorize-actor's one-time request id
// store (src/v2/gate-claim.js): what it sends, how it reads each answer, its
// time limits, and the gate-claim-url and gate-claim-audience inputs. fetch
// and the runner's OIDC token are mocked; nothing reaches a network.
const { core, inputs } = vi.hoisted(() => ({
  core: {
    getIDToken: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    exportVariable: vi.fn(),
    setOutput: vi.fn()
  },
  inputs: {}
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? (name === 'allow-push-access' ? 'true' : ''),
  getIDToken: core.getIDToken,
  notice: core.notice,
  warning: core.warning,
  info: core.info,
  error: core.error,
  setFailed: core.setFailed,
  exportVariable: core.exportVariable,
  setOutput: core.setOutput,
  ExitCode: { Success: 0, Failure: 1 }
}))

const api = vi.hoisted(() => ({ getByUsername: vi.fn(), getCollaboratorPermissionLevel: vi.fn() }))
vi.mock('@actions/github', () => ({
  getOctokit: () => ({ rest: { users: { getByUsername: api.getByUsername }, repos: { getCollaboratorPermissionLevel: api.getCollaboratorPermissionLevel } } })
}))

import { gateClaim, RequestExpired, CLAIM_ATTEMPTS } from '../src/v2/gate-claim.js'
import { RequestIdTaken } from '../src/v2/signed-request.js'
import { authorize, run } from '../src/authorize-actor.js'

const URL = 'https://gate.example.com/gate/claim'
const AUDIENCE = 'https://gate.example.com'
const OIDC_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.example-oidc-payload.example-signature'
const claims = {
  sub: 'requester@example.com',
  jti: 'req-0001-abcdef',
  app: 'example-app',
  action: 'promote',
  target: 'candidate-12345',
  environment: 'production',
  iat: 1800000000,
  exp: 1800000300
}
const run1 = { repository: 'example-org/example-deploy', id: '9000000001', attempt: '1' }

// An answer from the gate, as fetch resolves it.
const answer = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refusal = (status, code) => answer(status, { code, message: `refused: ${code}` })

// A fetch that never answers, and rejects only when its signal aborts.
const hanging = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason))
}))

let fetchMock
beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockReset()
  for (const fn of Object.values(api)) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
  hanging.mockClear()
  core.getIDToken.mockResolvedValue(OIDC_TOKEN)
  fetchMock = vi.fn(async () => answer(200, { result: 'claimed' }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

const claim = (options = {}) => gateClaim({ url: URL, audience: AUDIENCE, tryTimeoutMs: 50, ...options })
const everything = () => JSON.stringify(Object.values(core).map((fn) => fn.mock.calls))

describe('gateClaim: what it sends', () => {
  it('asks the runner for a token for the audience and posts the verified claims, with no run in the body', async () => {
    await expect(claim()({ claims, expired: false, run: run1, signal: new AbortController().signal })).resolves.toBe('claimed')
    expect(core.getIDToken).toHaveBeenCalledWith(AUDIENCE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe(URL)
    expect(request).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${OIDC_TOKEN}`, 'content-type': 'application/json', accept: 'application/json' },
      redirect: 'error',
      signal: expect.any(AbortSignal)
    })
    expect(JSON.parse(request.body)).toEqual({
      requestId: 'req-0001-abcdef',
      app: 'example-app',
      action: 'promote',
      target: 'candidate-12345',
      environment: 'production',
      expired: false
    })
  })

  it('tells the gate when the runner\'s clock says the request expired', async () => {
    fetchMock.mockResolvedValue(answer(200, { result: 'held' }))
    await expect(claim()({ claims, expired: true, run: run1 })).resolves.toBe('held')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ expired: true })
  })

  it('returns any result the gate gives, for authorize-actor to judge', async () => {
    fetchMock.mockResolvedValue(answer(200, { result: 'bound' }))
    await expect(claim()({ claims, expired: false, run: run1 })).resolves.toBe('bound')
  })
})

describe('gateClaim: the gate\'s refusals', () => {
  it('throws the real RequestIdTaken for request_id_taken', async () => {
    fetchMock.mockResolvedValue(refusal(409, 'request_id_taken'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error).toBeInstanceOf(RequestIdTaken)
  })

  it('throws an error named RequestExpired for request_expired', async () => {
    fetchMock.mockResolvedValue(refusal(409, 'request_expired'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error).toBeInstanceOf(RequestExpired)
    expect(error.name).toBe('RequestExpired')
  })

  it.each([
    [403, 'workflow_not_allowed'],
    [401, 'token_wrong_audience'],
    [409, 'request_not_found'],
    [409, 'request_mismatch'],
    [400, 'bad_request'],
    [404, 'not_found']
  ])('throws GateClaimRefused for HTTP %i %s, naming both in a warning, without trying again', async (status, code) => {
    fetchMock.mockResolvedValue(refusal(status, code))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimRefused')
    expect(error).not.toBeInstanceOf(RequestIdTaken)
    expect(core.warning).toHaveBeenCalledWith(`the deploy gate refused the claim: HTTP ${status}, ${code}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not take a refusal\'s code for RequestIdTaken from a 2xx', async () => {
    fetchMock.mockResolvedValue(answer(200, { code: 'request_id_taken' }))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimUnreadable')
  })

  it.each([
    ['not JSON', 'claimed'],
    ['no result', { status: 'claimed' }],
    ['a result that is not a string', { result: true }]
  ])('throws GateClaimUnreadable for a 200 with %s', async (_label, body) => {
    fetchMock.mockResolvedValue(answer(200, body))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimUnreadable')
  })

  it('shows only a code that is a plain word, and nothing else the gate sent', async () => {
    fetchMock.mockResolvedValue(answer(403, { code: 'bad\ncode', message: 'not-a-real-secret' }))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimRefused')
    expect(core.warning).toHaveBeenCalledWith('the deploy gate refused the claim: HTTP 403')
    expect(everything()).not.toContain('not-a-real-secret')
  })
})

describe('gateClaim: trying again', () => {
  it('tries a 5xx once more, and passes on the second answer', async () => {
    fetchMock.mockResolvedValueOnce(refusal(502, 'request_id_failed')).mockResolvedValueOnce(answer(200, { result: 'held' }))
    await expect(claim()({ claims, expired: false, run: run1 })).resolves.toBe('held')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(core.info).toHaveBeenCalledWith(`the deploy gate's claim route answered HTTP 502 (request_id_failed); trying again (2/${CLAIM_ATTEMPTS})`)
  })

  it('gives up after a second 5xx', async () => {
    fetchMock.mockResolvedValue(answer(503, 'Service Unavailable'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimRefused')
    expect(fetchMock).toHaveBeenCalledTimes(CLAIM_ATTEMPTS)
  })

  it('tries a request that got no answer once more', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(answer(200, { result: 'claimed' }))
    await expect(claim()({ claims, expired: false, run: run1 })).resolves.toBe('claimed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws GateClaimUnreachable when neither try gets an answer', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: getaddrinfo ENOTFOUND gate.example.com'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimUnreachable')
    expect(error.message).not.toContain('ENOTFOUND')
  })

  it('gives each try its own time limit, and aborts the request when it runs out', async () => {
    vi.stubGlobal('fetch', hanging)
    const started = Date.now()
    const error = await claim({ tryTimeoutMs: 30 })({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('GateClaimUnreachable')
    expect(hanging).toHaveBeenCalledTimes(CLAIM_ATTEMPTS)
    for (const [, request] of hanging.mock.calls) expect(request.signal.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(core.info).toHaveBeenCalledWith(`the deploy gate's claim route did not answer (no answer within 0.03 seconds); trying again (2/${CLAIM_ATTEMPTS})`)
  })
})

describe('gateClaim: the abort signal', () => {
  it('stops at once, with the signal\'s reason, when the signal aborts during the request', async () => {
    vi.stubGlobal('fetch', hanging)
    const controller = new AbortController()
    const reason = new Error('time is up')
    const pending = claim({ tryTimeoutMs: 60000 })({ claims, expired: false, run: run1, signal: controller.signal })
    await vi.waitFor(() => expect(hanging).toHaveBeenCalled())
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(hanging).toHaveBeenCalledTimes(1)
    expect(hanging.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('stops waiting for the runner\'s token when the signal aborts', async () => {
    core.getIDToken.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const reason = new Error('time is up')
    const pending = claim()({ claims, expired: false, run: run1, signal: controller.signal })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends nothing when the signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('time is up'))
    await expect(claim()({ claims, expired: false, run: run1, signal: controller.signal })).rejects.toThrow('time is up')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('gateClaim: the runner\'s OIDC token', () => {
  it('throws IdTokenUnavailable, and says the job needs id-token: write, when the runner has no token to give', async () => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '')
    core.getIDToken.mockRejectedValue(new Error('Error message: Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('IdTokenUnavailable')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('the job needs permissions: id-token: write'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws IdTokenUnavailable when the token request fails', async () => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://token.example.com/idtoken?api-version=2.0')
    core.getIDToken.mockRejectedValue(new Error('Failed to get ID Token'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('IdTokenUnavailable')
    expect(core.warning).toHaveBeenCalledWith('the runner did not hand out a GitHub OIDC token for the deploy gate\'s claim')
  })

  it.each([[''], [undefined]])('throws IdTokenUnavailable for a token of %j', async (token) => {
    core.getIDToken.mockResolvedValue(token)
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(error.name).toBe('IdTokenUnavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never puts the token in a log line or an error', async () => {
    fetchMock.mockResolvedValue(refusal(401, 'token_bad_signature'))
    const error = await claim()({ claims, expired: false, run: run1 }).catch((e) => e)
    expect(`${error.name} ${error.message} ${everything()}`).not.toContain(OIDC_TOKEN)
  })
})

// The hook as authorize-actor uses it, from its inputs.
const NOW = 1800000000
const GATE = 'deploy-gate[bot]'
const GATE_ID = '12345'
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
function signRequest (now = NOW) {
  const payload = {
    iss: 'https://deploy-gate.example.com',
    aud: 'example-org/deploy',
    sub: 'requester@example.com',
    app: 'example-app',
    action: 'promote',
    target: 'candidate-12345',
    environment: 'production',
    jti: 'req-0001-abcdef',
    iat: now - 10,
    exp: now + 290
  }
  const data = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}`
  return `${data}.${sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
const gate = {
  octokit: { rest: { users: { getByUsername: api.getByUsername }, repos: { getCollaboratorPermissionLevel: api.getCollaboratorPermissionLevel } } },
  repository: 'example-org/example-app',
  operation: 'promote',
  actor: GATE,
  actorId: GATE_ID,
  triggeringActor: GATE,
  runAttempt: '1',
  workflowRepository: run1.repository,
  runId: run1.id,
  gateActorId: GATE_ID,
  gatePublicKeys: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  gateIssuer: 'https://deploy-gate.example.com',
  gateAudience: 'example-org/deploy',
  expectedApp: 'example-app',
  expectedAction: 'promote',
  expectedTarget: 'candidate-12345',
  sleep: async () => {},
  now: () => NOW * 1000
}
const why = `${GATE}, the deploy gate's account, started this run attempt (attempt 1), so it needs a valid signed request, and`

describe('authorize with gate-claim-url', () => {
  beforeEach(() => {
    api.getByUsername.mockResolvedValue({ data: { id: Number(GATE_ID) } })
  })

  it('claims through the gate and lets the gate account through', async () => {
    await expect(authorize({ ...gate, signedRequest: signRequest(), gateClaimUrl: URL, gateClaimAudience: AUDIENCE })).resolves.toBe('gate')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('(request id req-0001-abcdef, claimed for this run attempt; verified with key 1 of 1)'))
  })

  it('refuses the request when the gate says another run holds it', async () => {
    fetchMock.mockResolvedValue(refusal(409, 'request_id_taken'))
    await expect(authorize({ ...gate, signedRequest: signRequest(), gateClaimUrl: URL, gateClaimAudience: AUDIENCE }))
      .rejects.toThrow(`${why} its request id req-0001-abcdef was already claimed by another run; refusing to promote example-org/example-app`)
  })

  it('refuses an expired request the gate says this attempt does not hold', async () => {
    fetchMock.mockResolvedValue(refusal(409, 'request_id_taken'))
    await expect(authorize({ ...gate, now: () => (NOW + 400) * 1000, signedRequest: signRequest(), gateClaimUrl: URL, gateClaimAudience: AUDIENCE }))
      .rejects.toThrow('which is allowed only for the run attempt that claimed its request id req-0001-abcdef while it was fresh, and the one-time request id store says this run attempt (attempt 1) is not that attempt')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ expired: true })
  })

  it.each([
    [refusal(409, 'request_expired'), 'RequestExpired'],
    [refusal(403, 'workflow_not_allowed'), 'GateClaimRefused'],
    [answer(200, 'not json'), 'GateClaimUnreadable']
  ])('refuses, naming the error, for each other answer', async (response, name) => {
    fetchMock.mockResolvedValue(response)
    await expect(authorize({ ...gate, signedRequest: signRequest(), gateClaimUrl: URL, gateClaimAudience: AUDIENCE }))
      .rejects.toThrow(`${why} the one-time request id store could not be reached or answered (${name}); refusing to promote example-org/example-app`)
  })

  it('holds the whole claim to authorize-actor\'s time limit, and aborts the request', async () => {
    vi.stubGlobal('fetch', hanging)
    await expect(authorize({ ...gate, signedRequest: signRequest(), gateClaimUrl: URL, gateClaimAudience: AUDIENCE, timeoutMs: 50 }))
      .rejects.toThrow(`${why} the one-time request id store could not be reached or answered (no answer within 0.05 seconds)`)
    expect(hanging.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('refuses every signed request with no gate-claim-url, and asks nothing', async () => {
    await expect(authorize({ ...gate, signedRequest: signRequest(), gateClaimAudience: AUDIENCE }))
      .rejects.toThrow(`${why} the one-time request id store is not set up (no gate-claim-url is set), so signed requests cannot be used; refusing to promote`)
    expect(core.getIDToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks nothing of the gate on a run a person started', async () => {
    api.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'write' } })
    await expect(authorize({ ...gate, actor: 'alice', actorId: '2001', triggeringActor: 'alice', signedRequest: signRequest(), gateClaimUrl: URL, gateClaimAudience: AUDIENCE }))
      .resolves.toBe('push-access')
    expect(core.getIDToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'http://gate.example.com/gate/claim',
    'gate.example.com/gate/claim',
    'https://user:secret@gate.example.com/gate/claim',
    'https://gate.example.com/gate/claim#x',
    'https://',
    'not a url'
  ])('refuses every run, a person with push access too, for a gate-claim-url of %j', async (value) => {
    api.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'admin' } })
    await expect(authorize({ ...gate, actor: 'alice', actorId: '2001', triggeringActor: 'alice', gateClaimUrl: value, gateClaimAudience: AUDIENCE }))
      .rejects.toThrow(/^gate-claim-url must be an https URL, like https:\/\/gate\.example\.com\/gate\/claim, not '.*'; refusing to promote example-org\/example-app$/)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'gate-claim-audience must be set when gate-claim-url is'],
    ['two words', "gate-claim-audience must be one value of printable characters with no spaces, not 'two words'"],
    ['x'.repeat(257), 'gate-claim-audience must be one value of printable characters with no spaces']
  ])('refuses every run for a gate-claim-audience of %j with a gate-claim-url', async (value, message) => {
    api.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'admin' } })
    await expect(authorize({ ...gate, actor: 'alice', actorId: '2001', triggeringActor: 'alice', gateClaimUrl: URL, gateClaimAudience: value }))
      .rejects.toThrow(message)
  })

  it('ignores a gate-claim-audience with no gate-claim-url', async () => {
    api.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'write' } })
    await expect(authorize({ ...gate, actor: 'alice', actorId: '2001', triggeringActor: 'alice', gateClaimAudience: 'two words' })).resolves.toBe('push-access')
  })
})

describe('run with gate-claim-url', () => {
  const env = {
    GITHUB_ACTOR: GATE,
    GITHUB_ACTOR_ID: GATE_ID,
    GITHUB_TRIGGERING_ACTOR: GATE,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: run1.repository,
    GITHUB_RUN_ID: run1.id
  }
  const gateInputs = () => ({
    'github-token': 'tok',
    repository: 'example-org/example-app',
    operation: 'promote',
    'gate-actor-id': GATE_ID,
    'signed-request': signRequest(Math.floor(Date.now() / 1000)),
    'gate-public-keys': gate.gatePublicKeys,
    'gate-issuer': gate.gateIssuer,
    'gate-audience': gate.gateAudience,
    'expected-app': 'example-app',
    'expected-action': 'promote',
    'expected-target': 'candidate-12345',
    'gate-claim-url': URL,
    'gate-claim-audience': AUDIENCE
  })

  beforeEach(() => {
    api.getByUsername.mockResolvedValue({ data: { id: Number(GATE_ID) } })
  })

  it('reads the claim inputs, claims through the gate and passes the gate account', async () => {
    Object.assign(inputs, gateInputs())
    await run({ env, sleep: async () => {} })
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.getIDToken).toHaveBeenCalledWith(AUDIENCE)
    expect(fetchMock.mock.calls[0][0]).toBe(URL)
    expect(core.setOutput).toHaveBeenCalledWith('passed-as', 'gate')
  })

  it('refuses the gate account, as before, when gate-claim-url is left out', async () => {
    Object.assign(inputs, gateInputs(), { 'gate-claim-url': '' })
    await run({ env, sleep: async () => {} })
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('the one-time request id store is not set up (no gate-claim-url is set)'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalled()
  })
})
