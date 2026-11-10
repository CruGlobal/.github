import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as yaml from 'js-yaml'

// The deploy gate, one-time request ids, break-glass, refused accounts and
// allow-push-access. The checks that existed before these inputs are covered,
// unchanged, in v2-authorize-actor.test.js; that they still pass is what shows
// the new inputs, left at their defaults, change nothing.
const { api, octokit, core, inputs, defaults } = vi.hoisted(() => {
  const api = {
    getByUsername: vi.fn(),
    getCollaboratorPermissionLevel: vi.fn(),
    getMembershipForUserInOrg: vi.fn(),
    getByName: vi.fn(),
    listChildInOrg: vi.fn()
  }
  const octokit = {
    rest: {
      users: { getByUsername: api.getByUsername },
      repos: { getCollaboratorPermissionLevel: api.getCollaboratorPermissionLevel },
      teams: { getMembershipForUserInOrg: api.getMembershipForUserInOrg, getByName: api.getByName, listChildInOrg: api.listChildInOrg }
    }
  }
  return {
    api,
    octokit,
    core: {
      notice: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      setFailed: vi.fn(),
      exportVariable: vi.fn(),
      setOutput: vi.fn()
    },
    inputs: {},
    defaults: {}
  }
})

vi.mock('@actions/github', () => ({ getOctokit: () => octokit }))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? defaults[name] ?? '',
  notice: core.notice,
  warning: core.warning,
  info: core.info,
  error: core.error,
  setFailed: core.setFailed,
  exportVariable: core.exportVariable,
  setOutput: core.setOutput,
  ExitCode: { Success: 0, Failure: 1 }
}))

import { authorize, authorizeAttempt, run, HELD_REQUEST_MAX_SECONDS_PAST_EXPIRY } from '../src/authorize-actor.js'
import { RequestIdTaken } from '../src/v2/signed-request.js'
import { AUTHORIZED_ATTEMPT_MARKER } from '../src/v2/attempt-guard.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const action = yaml.load(readFileSync(path.join(root, 'actions/authorize-actor/action.yml'), 'utf8'))
// The runner fills in an input's declared default when a step leaves it out.
for (const [name, spec] of Object.entries(action.inputs)) defaults[name] = String(spec.default ?? '')

const noSleep = async () => {}
const REPO = 'example-org/example-app'
const WORKFLOW_REPO = 'example-org/deploy-workflows'
const RUN_ID = '9000000001'
const GATE = 'deploy-gate[bot]'
const GATE_ID = '12345'
const BOT = 'release-helper[bot]'
const BOT_ID = '41000001'
const USER_IDS = { [GATE]: 12345, [BOT]: 41000001, alice: 2001, bob: 2002, mallory: 2003 }

const NOW = 1800000000
const HOUR = 3600
const gateKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const oldKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const GATE_PEM = gateKeys.publicKey.export({ type: 'spki', format: 'pem' })
const OLD_PEM = oldKeys.publicKey.export({ type: 'spki', format: 'pem' })
const ISSUER = 'https://deploy-gate.example.com'
const AUDIENCE = 'example-org/deploy'

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
// A request signed at NOW - 10, so it expires at NOW + 290 and is refused
// as expired from NOW + 350.
function signRequest (overrides = {}) {
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'requester@example.com',
    app: 'example-app',
    action: 'promote',
    target: 'candidate-12345',
    environment: 'production',
    jti: 'req-0001-abcdef',
    iat: NOW - 10,
    exp: NOW + 290,
    ...overrides
  }
  const data = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'gate-1' })}.${b64(payload)}`
  return `${data}.${sign('sha256', Buffer.from(data), { key: gateKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status })

// GitHub's answers: user ids by login, permissions on the app repo by login,
// team membership states by login (missing means 404), whether the team
// itself can be read, and its child teams.
function github ({ permissions = {}, members = {}, teamFound = true, children = [] } = {}) {
  api.getByUsername.mockImplementation(async ({ username }) => {
    if (!(username in USER_IDS)) throw httpError(404)
    return { data: { id: USER_IDS[username] } }
  })
  api.getCollaboratorPermissionLevel.mockImplementation(async ({ username }) => {
    if (!(username in permissions)) throw httpError(404, `${username} is not a user`)
    return { data: { permission: permissions[username] } }
  })
  api.getMembershipForUserInOrg.mockImplementation(async ({ username }) => {
    if (!(username in members)) throw httpError(404, 'Not Found')
    return { data: { state: members[username], role: 'member' } }
  })
  api.getByName.mockImplementation(async ({ org, team_slug: slug }) => {
    if (!teamFound) throw httpError(404, 'Not Found')
    return { data: { slug, organization: { login: org } } }
  })
  api.listChildInOrg.mockResolvedValue({ data: children })
}

// A one-time request id store that keeps the contract written above the
// claimRequestId call in src/authorize-actor.js, so a run can be walked
// through lookup, a wait for the production lock and a re-run.
function memoryStore (clock = () => NOW) {
  const records = new Map()
  const claim = vi.fn(async ({ claims, expired, run }) => {
    const record = records.get(claims.jti)
    const sameRun = record && record.repository === run.repository && record.id === run.id
    const sameAttempt = sameRun && record.attempt === run.attempt
    if (!expired) {
      if (clock() > claims.exp + 60) throw Object.assign(new Error('the request expired by the store\'s clock'), { name: 'RequestExpired' })
      if (!record) {
        records.set(claims.jti, { ...run, at: clock() })
        return 'claimed'
      }
      if (sameAttempt) return 'held'
      if (sameRun && Number(run.attempt) > Number(record.attempt)) {
        records.set(claims.jti, { ...run, at: clock() })
        return 'held'
      }
      throw new RequestIdTaken()
    }
    if (sameAttempt && clock() - record.at <= 2 * HOUR) return 'held'
    throw new RequestIdTaken()
  })
  return { claim, records }
}

const base = {
  octokit,
  repository: REPO,
  operation: 'promote',
  runAttempt: '1',
  workflowRepository: WORKFLOW_REPO,
  runId: RUN_ID,
  sleep: noSleep,
  now: () => NOW * 1000
}
const gate = {
  gateActorId: GATE_ID,
  gatePublicKeys: GATE_PEM,
  gateIssuer: ISSUER,
  gateAudience: AUDIENCE,
  expectedApp: 'example-app',
  expectedAction: 'promote',
  expectedTarget: 'candidate-12345'
}
const gateRun = { actor: GATE, actorId: GATE_ID, triggeringActor: GATE }
const at = (seconds) => ({ now: () => seconds * 1000 })
const everything = () => JSON.stringify(Object.values(core).map((fn) => fn.mock.calls))

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  for (const fn of Object.values(core)) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
})

afterEach(() => { process.exitCode = undefined })

describe('authorize: the deploy gate', () => {
  it('lets the gate account through with a valid signed request, and logs who asked, the request id and the key', async () => {
    github()
    const store = memoryStore()
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: store.claim })).resolves.toBe('gate')
    expect(api.getByUsername).toHaveBeenCalledWith({ username: GATE, request: { signal: expect.any(AbortSignal) } })
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
    expect(api.getMembershipForUserInOrg).not.toHaveBeenCalled()
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('with a signed request from requester@example.com to promote example-app at candidate-12345 (request id req-0001-abcdef, claimed for this run attempt; verified with key 1 of 1, kid gate-1)'))
  })

  it('names the configured key that verified by its place, not by the request\'s kid', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, gatePublicKeys: OLD_PEM + GATE_PEM, signedRequest: signRequest(), claimRequestId: memoryStore().claim }))
      .resolves.toBe('gate')
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('verified with key 2 of 2, kid gate-1)'))
  })

  it('refuses a gate-started run with no signed request, and does not fall through', async () => {
    github({ permissions: { [GATE]: 'admin' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: '', claimRequestId: memoryStore().claim }))
      .rejects.toThrow(`${GATE}, the deploy gate's account, started this run attempt (attempt 1), so it needs a valid signed request, and no signed request was given; refusing to promote ${REPO}`)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('refuses a gate-started run when no public keys are configured', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, gatePublicKeys: '', signedRequest: signRequest() }))
      .rejects.toThrow('so it needs a valid signed request, and no gate public key was given, so the signed request cannot be checked')
  })

  it('refuses a gate-started run whose public keys cannot be read', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, gatePublicKeys: 'not a key', signedRequest: signRequest() }))
      .rejects.toThrow('gate-public-keys holds something other than PEM public keys')
  })

  it.each([
    ['a request for another target', { target: 'candidate-99999' }, "for target 'candidate-99999', but this run is for target 'candidate-12345'"],
    ['a request for another app', { app: 'other-app' }, "for app 'other-app'"],
    ['a request for another action', { action: 'rollback' }, "for action 'rollback'"],
    ['an expired request for another target', { target: 'candidate-99999', iat: NOW - 500, exp: NOW - 200 }, "for target 'candidate-99999'"],
    ['a sub that hides a right-to-left override', { sub: 'requester‮@example.com' }, 'sub claim is not an email address']
  ])('refuses %s, even when the gate account has push access', async (_label, claims, message) => {
    github({ permissions: { [GATE]: 'admin' } })
    const store = memoryStore()
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(claims), claimRequestId: store.claim })).rejects.toThrow(message)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
    expect(store.claim).not.toHaveBeenCalled()
  })

  it('refuses when the run does not say what it is for', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, expectedTarget: '', signedRequest: signRequest() }))
      .rejects.toThrow('no expected-target was given, so the signed request cannot be matched to this run')
  })

  it.each([
    ['the gate\'s own run', gateRun],
    ['a person\'s run', { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }]
  ])('refuses the setup when the gate account is also on the automation allowlist, on %s', async (_label, who) => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...gate, ...who, trustedActorIds: `7, ${GATE_ID}`, signedRequest: signRequest(), claimRequestId: memoryStore().claim }))
      .rejects.toThrow(`gate-actor-id ${GATE_ID} is also in trusted-automation-actor-ids. The deploy gate's account may pass only with a signed request, never as plain automation, so take it off the allowlist; refusing to promote ${REPO}`)
    expect(api.getByUsername).not.toHaveBeenCalled()
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('lets the gate account through when it is on refused-actor-ids too, since only the gate comes before that list', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, refusedActorIds: GATE_ID, signedRequest: signRequest(), claimRequestId: memoryStore().claim }))
      .resolves.toBe('gate')
  })

  it('refuses when the gate account\'s user id cannot be looked up', async () => {
    api.getByUsername.mockRejectedValue(httpError(500))
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: memoryStore().claim }))
      .rejects.toThrow(/could not look up the user id of deploy-gate\[bot\].*cannot be matched to the deploy gate's account; refusing to promote/)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('does not treat a login that now belongs to another user id as the gate', async () => {
    api.getByUsername.mockResolvedValue({ data: { id: 99999 } })
    api.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'none' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: memoryStore().claim }))
      .rejects.toThrow(`${GATE} is not authorized to promote ${REPO} (permission: none)`)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("now belongs to user id 99999, not the deploy gate's user id 12345"))
  })

  it('falls through to break-glass when a person re-runs a gate run', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...gate, actor: GATE, actorId: GATE_ID, triggeringActor: 'alice', runAttempt: '2', signedRequest: signRequest(), breakGlassTeam: 'example-org/ops-team' }))
      .resolves.toBe('break-glass')
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining(`this run was first started by the deploy gate's account ${GATE}, but this run attempt (attempt 2) was started by alice, so no signed request is used`))
    expect(api.getByUsername).not.toHaveBeenCalled()
  })

  it('falls through to push access when a person re-runs a gate run, and refuses one without it', async () => {
    github({ permissions: { mallory: 'read' } })
    await expect(authorize({ ...base, ...gate, actor: GATE, actorId: GATE_ID, triggeringActor: 'mallory', runAttempt: '2', signedRequest: signRequest() }))
      .rejects.toThrow(`mallory is not authorized to promote ${REPO} (permission: read). Requires admin, write, or maintain. The account checked is mallory, the one that started this run attempt (attempt 2); the run was first started by ${GATE}. Tried: the deploy gate (this attempt was not started by its account); push access on ${REPO} (permission: read).`)
  })

  it('ignores a signed request on a run a person started', async () => {
    github({ permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...gate, actor: 'alice', actorId: '2001', triggeringActor: 'alice', signedRequest: signRequest() }))
      .resolves.toBe('push-access')
    expect(core.notice).toHaveBeenCalledWith('a signed request was given, but this run attempt (attempt 1) was not started by the deploy gate\'s account, so it is not used')
  })

  it('ignores a signed request when no gate-actor-id is set', async () => {
    github({ permissions: { [GATE]: 'none' } })
    await expect(authorize({ ...base, ...gateRun, signedRequest: signRequest() }))
      .rejects.toThrow(`${GATE} is not authorized to promote`)
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('(no gate-actor-id is set), so it is not used'))
  })

  it('refuses a gate-actor-id that is not a number', async () => {
    github({ permissions: { alice: 'write' } })
    await expect(authorize({ ...base, gateActorId: GATE, actor: 'alice', actorId: '2001', triggeringActor: 'alice' }))
      .rejects.toThrow(`gate-actor-id must be one numeric GitHub user id, not '${GATE}'; refusing to promote ${REPO}`)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })
})

describe('authorizeAttempt', () => {
  it('returns the verified claims with a gate pass, and none with any other', async () => {
    github({ permissions: { alice: 'write' } })
    const store = memoryStore()
    const gatePass = await authorizeAttempt({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: store.claim })
    expect(gatePass).toEqual({
      passedAs: 'gate',
      request: expect.objectContaining({ sub: 'requester@example.com', target: 'candidate-12345', action: 'promote', app: 'example-app', jti: 'req-0001-abcdef' })
    })
    await expect(authorizeAttempt({ ...base, actor: 'alice', actorId: '2001', triggeringActor: 'alice' })).resolves.toEqual({ passedAs: 'push-access', request: null })
  })
})

describe('authorize: one-time request ids', () => {
  const why = `${GATE}, the deploy gate's account, started this run attempt (attempt 1), so it needs a valid signed request, and`

  it('refuses every signed request while no store is set up', async () => {
    github({ permissions: { [GATE]: 'admin' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest() }))
      .rejects.toThrow(`${why} the one-time request id store is not set up (no gate-claim-url is set), so signed requests cannot be used; refusing to promote ${REPO}`)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('gives the store the verified claims, this run and a time limit', async () => {
    github()
    const store = memoryStore()
    await authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: store.claim })
    expect(store.claim).toHaveBeenCalledTimes(1)
    const [request] = store.claim.mock.calls[0]
    expect(request).toEqual({
      claims: expect.objectContaining({ jti: 'req-0001-abcdef', sub: 'requester@example.com', app: 'example-app', target: 'candidate-12345', exp: NOW + 290 }),
      expired: false,
      run: { repository: WORKFLOW_REPO, id: RUN_ID, attempt: '1' },
      signal: expect.any(AbortSignal)
    })
    expect(store.records.get('req-0001-abcdef')).toMatchObject({ repository: WORKFLOW_REPO, id: RUN_ID, attempt: '1' })
  })

  it.each([
    ['no workflow repository', { workflowRepository: '' }, 'the repository this workflow runs in (GITHUB_REPOSITORY) "" is not in owner/name form'],
    ['a workflow repository of ".."', { workflowRepository: 'example-org/..' }, 'is not a name GitHub allows'],
    ['no run id', { runId: undefined }, 'the runner did not give a run id (GITHUB_RUN_ID is "")'],
    ['a run id that is not a number', { runId: '12 3' }, 'GITHUB_RUN_ID is "12 3"'],
    ['a run id of 0', { runId: '0' }, 'GITHUB_RUN_ID is "0"']
  ])('refuses, without asking the store, when the runner gives %s', async (_label, run, message) => {
    github()
    const store = memoryStore()
    await expect(authorize({ ...base, ...gate, ...gateRun, ...run, signedRequest: signRequest(), claimRequestId: store.claim }))
      .rejects.toThrow(message)
    expect(store.claim).not.toHaveBeenCalled()
  })

  it('lets a production job that waited for the lock use the request lookup claimed, once it has expired', async () => {
    github()
    let clock = NOW
    const store = memoryStore(() => clock)
    const request = signRequest()
    // lookup, before any lock.
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })).resolves.toBe('gate')
    // The production job gets the lock six minutes later.
    clock = NOW + 360
    await expect(authorize({ ...base, ...at(clock), ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })).resolves.toBe('gate')
    expect(store.claim.mock.calls.map(([call]) => call.expired)).toEqual([false, true])
    expect(core.notice).toHaveBeenLastCalledWith(expect.stringContaining('(request id req-0001-abcdef, already held by this run attempt, expired 70 seconds ago; verified with key 1 of 1, kid gate-1)'))
  })

  it('lets a later job of the same attempt use the request while it is still fresh', async () => {
    github()
    const store = memoryStore()
    const request = signRequest()
    await authorize({ ...base, ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })
    await expect(authorize({ ...base, ...at(NOW + 120), ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })).resolves.toBe('gate')
    expect(store.claim.mock.calls.map(([call]) => call.expired)).toEqual([false, false])
    expect(core.notice).toHaveBeenLastCalledWith(expect.stringContaining('already held by this run attempt; verified'))
  })

  it('refuses the request in another run', async () => {
    github()
    const store = memoryStore()
    const request = signRequest()
    await authorize({ ...base, ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })
    await expect(authorize({ ...base, ...gate, ...gateRun, runId: '9000000002', signedRequest: request, claimRequestId: store.claim }))
      .rejects.toThrow(`${why} its request id req-0001-abcdef was already claimed by another run; refusing to promote ${REPO}`)
  })

  it('refuses a "Re-run failed jobs" that the gate account starts after the request expired', async () => {
    // The re-run keeps attempt 1's lookup result, so its production job is
    // the first check of attempt 2, with the old request.
    github()
    let clock = NOW
    const store = memoryStore(() => clock)
    const request = signRequest()
    await authorize({ ...base, ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })
    clock = NOW + HOUR
    await expect(authorize({ ...base, ...at(clock), ...gate, ...gateRun, runAttempt: '2', signedRequest: request, claimRequestId: store.claim }))
      .rejects.toThrow(`started this run attempt (attempt 2), so it needs a valid signed request, and the signed request expired ${HOUR - 290} seconds ago, which is allowed only for the run attempt that claimed its request id req-0001-abcdef while it was fresh, and the one-time request id store says this run attempt (attempt 2) is not that attempt; refusing to promote ${REPO}`)
  })

  it('moves the id to a re-run the gate account starts while the request is fresh, and the old attempt loses it', async () => {
    github()
    let clock = NOW
    const store = memoryStore(() => clock)
    const request = signRequest()
    await authorize({ ...base, ...gate, ...gateRun, signedRequest: request, claimRequestId: store.claim })
    clock = NOW + 60
    await expect(authorize({ ...base, ...at(clock), ...gate, ...gateRun, runAttempt: '2', signedRequest: request, claimRequestId: store.claim })).resolves.toBe('gate')
    expect(store.records.get('req-0001-abcdef')).toMatchObject({ attempt: '2' })
    clock = NOW + 400
    await expect(authorize({ ...base, ...at(clock), ...gate, ...gateRun, runAttempt: '2', signedRequest: request, claimRequestId: store.claim })).resolves.toBe('gate')
    await expect(authorize({ ...base, ...at(clock), ...gate, ...gateRun, runAttempt: '1', signedRequest: request, claimRequestId: store.claim }))
      .rejects.toThrow('is not that attempt')
  })

  it('refuses a request the store\'s own clock says has expired, even when the runner\'s clock is behind', async () => {
    github()
    const store = memoryStore(() => NOW + 400)
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: store.claim }))
      .rejects.toThrow(`${why} the one-time request id store says the signed request had expired by its own clock before request id req-0001-abcdef could be claimed for this run attempt (attempt 1), so a new request is needed (RequestExpired); refusing to promote ${REPO}`)
    expect(store.claim).toHaveBeenCalledWith(expect.objectContaining({ expired: false }))
    expect(store.records.size).toBe(0)
  })

  it('refuses an expired request that was never claimed', async () => {
    github()
    const store = memoryStore()
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest({ iat: NOW - 400, exp: NOW - 100 }), claimRequestId: store.claim }))
      .rejects.toThrow('the signed request expired 100 seconds ago, which is allowed only for the run attempt that claimed its request id')
    expect(store.claim).toHaveBeenCalledWith(expect.objectContaining({ expired: true }))
    expect(store.records.size).toBe(0)
  })

  it(`asks the store up to ${HELD_REQUEST_MAX_SECONDS_PAST_EXPIRY} seconds past expiry, and refuses without asking after that`, async () => {
    github()
    const exp = NOW + 290
    const claimRequestId = vi.fn(async () => 'held')
    await expect(authorize({ ...base, ...at(exp + 2 * HOUR), ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId })).resolves.toBe('gate')
    expect(claimRequestId).toHaveBeenCalledTimes(1)
    await expect(authorize({ ...base, ...at(exp + 2 * HOUR + 1), ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId }))
      .rejects.toThrow(`${why} the signed request expired ${2 * HOUR + 1} seconds ago, more than the 2 hours a run attempt may keep using a request it claimed while it was fresh; refusing to promote ${REPO}`)
    expect(claimRequestId).toHaveBeenCalledTimes(1)
  })

  it('refuses an expired request the store answers \'claimed\' for, since an expired request must never be recorded', async () => {
    github()
    await expect(authorize({ ...base, ...at(NOW + 400), ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: async () => 'claimed' }))
      .rejects.toThrow("the signed request expired 110 seconds ago, and the one-time request id store answered 'claimed' for it, which it must never do for an expired request")
  })

  it.each([undefined, null, '', 'yes', 'HELD', true, { status: 'held' }])('refuses a store answer of %j', async (answer) => {
    github({ permissions: { [GATE]: 'admin' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: async () => answer }))
      .rejects.toThrow(`${why} the one-time request id store gave an answer this check does not know (only 'claimed' or 'held' passes a fresh request)`)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('never shows the store\'s error text, which may hold a connection string, only the error\'s name', async () => {
    github()
    const leak = Object.assign(new Error('connect ECONNREFUSED store.example.com:5432 password=not-a-real-secret'), { name: 'ConnectionError' })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: async () => { throw leak } }))
      .rejects.toThrow(`${why} the one-time request id store could not be reached or answered (ConnectionError); refusing to promote ${REPO}`)
    expect(everything()).not.toContain('not-a-real-secret')
  })

  it.each([
    ['a name that is not a plain word', Object.assign(new Error('x'), { name: 'Error: password=not-a-real-secret' })],
    ['no name', Object.assign(Object.create(null), { message: 'password=not-a-real-secret' })],
    ['a thrown string', 'not-a-real-secret']
  ])('refuses with no detail for an error with %s', async (_label, thrown) => {
    github()
    let message
    try {
      await authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: async () => { throw thrown } })
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('the one-time request id store could not be reached or answered; refusing to promote')
    expect(message).not.toContain('not-a-real-secret')
  })

  it('refuses when the store throws before it returns a promise', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId: () => { throw new TypeError('boom') } }))
      .rejects.toThrow('the one-time request id store could not be reached or answered (TypeError)')
  })

  it('stops waiting for a store that never answers, and aborts its signal', async () => {
    github()
    let signal
    const claimRequestId = (request) => {
      signal = request.signal
      return new Promise(() => {})
    }
    const started = Date.now()
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId, timeoutMs: 50 }))
      .rejects.toThrow(`${why} the one-time request id store could not be reached or answered (no answer within 0.05 seconds); refusing to promote ${REPO}`)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(signal.aborted).toBe(true)
  })

  it('refuses the same way when the store gives up on the aborted signal itself', async () => {
    github()
    const claimRequestId = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId, timeoutMs: 50 }))
      .rejects.toThrow('could not be reached or answered (no answer within 0.05 seconds)')
  })
})

describe('authorize: break-glass', () => {
  const person = { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }

  it('lets an active member of a team with no child teams through, without reading push access', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' })).resolves.toBe('break-glass')
    expect(api.getMembershipForUserInOrg).toHaveBeenCalledWith({ org: 'example-org', team_slug: 'ops-team', username: 'alice', request: { signal: expect.any(AbortSignal) } })
    expect(api.listChildInOrg).toHaveBeenCalledWith({ org: 'example-org', team_slug: 'ops-team', per_page: 1, request: { signal: expect.any(AbortSignal) } })
    expect(api.getByName).not.toHaveBeenCalled()
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
    expect(core.notice).toHaveBeenCalledWith(`alice is an active member of the break-glass team example-org/ops-team and started this run attempt (attempt 1), so it may promote ${REPO}`)
  })

  it('reads the team in the org it names, not the app repo\'s owner', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...person, repository: 'other-org/example-app', breakGlassTeam: 'example-org/ops-team' })).resolves.toBe('break-glass')
    expect(api.getMembershipForUserInOrg).toHaveBeenCalledWith(expect.objectContaining({ org: 'example-org', team_slug: 'ops-team' }))
  })

  it('refuses an active member of a team that has child teams, whose members GitHub counts as its own', async () => {
    github({ members: { alice: 'active' }, permissions: { alice: 'admin' }, children: [{ slug: 'contractors' }] })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' }))
      .rejects.toThrow(`alice is an active member of the break-glass team example-org/ops-team, but that team has child teams. GitHub counts the members of a child team as members of the team, so this does not show alice was put on example-org/ops-team itself. Use a break-glass team with no child teams; refusing to promote ${REPO}`)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it.each([
    ['a 403', () => api.listChildInOrg.mockRejectedValue(httpError(403)), 1, 'its child teams could not be listed (HTTP 403: HTTP 403)'],
    ['a server error that does not clear', () => api.listChildInOrg.mockRejectedValue(httpError(502)), 3, 'its child teams could not be listed (HTTP 502: HTTP 502)'],
    ['an answer that is not a list', () => api.listChildInOrg.mockResolvedValue({ data: { total: 0 } }), 1, 'listing its child teams did not return a list']
  ])('refuses an active member when listing child teams gives %s', async (_label, arrange, calls, message) => {
    github({ members: { alice: 'active' }, permissions: { alice: 'admin' } })
    arrange()
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' })).rejects.toThrow(message)
    expect(api.listChildInOrg).toHaveBeenCalledTimes(calls)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('does not count a pending member, and names what it tried', async () => {
    github({ members: { alice: 'pending' }, permissions: { alice: 'read' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' }))
      .rejects.toThrow(`Tried: the break-glass team example-org/ops-team (membership state: pending); push access on ${REPO} (permission: read).`)
    expect(api.listChildInOrg).not.toHaveBeenCalled()
    expect(api.getByName).not.toHaveBeenCalled()
  })

  it('still lets a pending member with push access through on push access', async () => {
    github({ members: { alice: 'pending' }, permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' })).resolves.toBe('push-access')
  })

  it('treats a 404 as not a member, and checks once that the team can be read', async () => {
    github({ permissions: { alice: 'triage' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' }))
      .rejects.toThrow('the break-glass team example-org/ops-team (GitHub answered 404: not a member, or the team does not exist or this token cannot see it)')
    expect(api.getByName).toHaveBeenCalledTimes(1)
    expect(api.getByName).toHaveBeenCalledWith({ org: 'example-org', team_slug: 'ops-team', request: { signal: expect.any(AbortSignal) } })
    expect(core.warning).not.toHaveBeenCalled()
    expect(api.listChildInOrg).not.toHaveBeenCalled()
  })

  it('warns on every run when the team cannot be found or seen, and still checks push access', async () => {
    github({ permissions: { alice: 'write' }, teamFound: false })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-tem' })).resolves.toBe('push-access')
    expect(core.warning).toHaveBeenCalledWith('the break-glass team example-org/ops-tem was not found, or this token cannot see it (HTTP 404: Not Found); the token needs read:org. Until that is fixed, nobody can pass by break-glass')
  })

  it('warns, without retrying, when the team lookup itself fails', async () => {
    github({ permissions: { alice: 'write' } })
    api.getByName.mockRejectedValue(httpError(502))
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' })).resolves.toBe('push-access')
    expect(api.getByName).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith('could not check that the break-glass team example-org/ops-team exists (HTTP 502: HTTP 502)')
  })

  it.each([
    ['a 403', () => api.getMembershipForUserInOrg.mockRejectedValue(httpError(403)), 1],
    ['a server error that does not clear', () => api.getMembershipForUserInOrg.mockRejectedValue(httpError(502)), 3]
  ])('refuses on %s instead of falling through', async (_label, arrange, calls) => {
    github({ permissions: { alice: 'admin' } })
    arrange()
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'example-org/ops-team' }))
      .rejects.toThrow(/could not read the membership of alice in the break-glass team example-org\/ops-team .*refusing to promote/)
    expect(api.getMembershipForUserInOrg).toHaveBeenCalledTimes(calls)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it.each(['Example-Org/OPS', 'example-org/2024', 'example-org/ops.team', 'example-org/ops_team', 'a/b'])('reads a break-glass-team of %j', async (value) => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: value })).resolves.toBe('break-glass')
    const [org, slug] = value.split('/')
    expect(api.getMembershipForUserInOrg).toHaveBeenCalledWith(expect.objectContaining({ org, team_slug: slug }))
  })

  it.each([
    'ops-team',
    'example-org/',
    '/ops-team',
    'example-org/ops-team/x',
    '../ops-team',
    '-org/ops-team',
    'example.org/ops-team',
    'example-org/..',
    'example-org/.hidden',
    'example-org/-ops',
    'example-org/ops team',
    'example-org/ops%2fteam',
    'example-org/ops?x=1',
    'example-org/ops#x',
    'example-org/ops\nteam'
  ])('refuses a break-glass-team of %j', async (value) => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: value }))
      .rejects.toThrow(/break-glass-team must be a team as "org\/team-slug", like "example-org\/ops-team"/)
    expect(api.getMembershipForUserInOrg).not.toHaveBeenCalled()
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('is checked after the automation allowlist', async () => {
    github({ members: { [BOT]: 'active' } })
    await expect(authorize({ ...base, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, trustedActorIds: BOT_ID, breakGlassTeam: 'example-org/ops-team' }))
      .resolves.toBe('automation')
    expect(api.getMembershipForUserInOrg).not.toHaveBeenCalled()
  })
})

describe('authorize: refused accounts', () => {
  const alice = { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }

  it('refuses a listed account that is an active break-glass member', async () => {
    github({ members: { alice: 'active' }, permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2001', breakGlassTeam: 'example-org/ops-team' }))
      .rejects.toThrow(`alice (user id 2001) is in refused-actor-ids, so it may not promote ${REPO} as allowlisted automation, by break-glass or by push access. The account checked is alice, the one that started this run attempt (attempt 1).`)
    expect(api.getMembershipForUserInOrg).not.toHaveBeenCalled()
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('refuses a listed account that is allowlisted automation, before the allowlist is read', async () => {
    github()
    await expect(authorize({ ...base, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, trustedActorIds: BOT_ID, refusedActorIds: BOT_ID }))
      .rejects.toThrow(`${BOT} (user id ${BOT_ID}) is in refused-actor-ids, so it may not promote ${REPO} as allowlisted automation`)
    expect(core.notice).not.toHaveBeenCalled()
  })

  it('lets allowlisted automation that is not listed through, looking its user id up once', async () => {
    github()
    await expect(authorize({ ...base, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, trustedActorIds: BOT_ID, refusedActorIds: '2003' }))
      .resolves.toBe('automation')
    expect(api.getByUsername).toHaveBeenCalledTimes(1)
  })

  it('refuses a listed account that has push access', async () => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '9, 2001\n7' })).rejects.toThrow('is in refused-actor-ids')
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('checks the account that pressed re-run, by its own user id', async () => {
    github({ permissions: { alice: 'admin', mallory: 'admin' } })
    await expect(authorize({ ...base, actor: 'alice', actorId: '2001', triggeringActor: 'mallory', runAttempt: '2', refusedActorIds: '2003' }))
      .rejects.toThrow('mallory (user id 2003) is in refused-actor-ids')
    expect(api.getByUsername).toHaveBeenCalledWith(expect.objectContaining({ username: 'mallory' }))
  })

  it('lets an account that is not listed through as before', async () => {
    github({ permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2003' })).resolves.toBe('push-access')
  })

  it('refuses when the user id cannot be looked up', async () => {
    github({ permissions: { alice: 'admin' } })
    api.getByUsername.mockRejectedValue(httpError(404))
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2003' }))
      .rejects.toThrow(/could not look up the user id of alice .* cannot be checked against refused-actor-ids; refusing to promote/)
  })

  it('refuses an entry that is not a number, instead of skipping it', async () => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2003, mallory' }))
      .rejects.toThrow("refused-actor-ids must hold numeric GitHub user ids only; cannot read 'mallory'")
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('looks the user id up once when the gate check already did', async () => {
    // The gate's login was taken by another account, which is also refused.
    api.getByUsername.mockResolvedValue({ data: { id: 2003 } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), refusedActorIds: '2003' }))
      .rejects.toThrow('is in refused-actor-ids')
    expect(api.getByUsername).toHaveBeenCalledTimes(1)
  })
})

describe('authorize: allow-push-access', () => {
  const alice = { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }

  it.each(['false', 'FALSE', ' false '])('refuses a writer when it is %j, without reading push access', async (value) => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: value }))
      .rejects.toThrow(`alice is not authorized to promote ${REPO}: push access does not count for this run (allow-push-access is false). The account checked is alice, the one that started this run attempt (attempt 1). Tried: nothing else is configured.`)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('still lets a break-glass member through when it is false', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: 'false', breakGlassTeam: 'example-org/ops-team' })).resolves.toBe('break-glass')
  })

  it('names break-glass in the refusal when it is false', async () => {
    github({ members: { alice: 'pending' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: 'false', breakGlassTeam: 'example-org/ops-team' }))
      .rejects.toThrow('Tried: the break-glass team example-org/ops-team (membership state: pending).')
  })

  // run() refuses an empty value (see below); authorize() on its own keeps
  // reading one as the default.
  it.each(['true', 'TRUE', '', undefined])('keeps push access when it is %j', async (value) => {
    github({ permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: value })).resolves.toBe('push-access')
  })

  it.each(['no', '0', 'off'])('refuses a value it cannot read (%j)', async (value) => {
    github({ permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: value }))
      .rejects.toThrow(`allow-push-access must be "true" or "false", not '${value}'; refusing to promote ${REPO}`)
  })
})

describe('run with the new inputs', () => {
  const env = (actor, actorId, triggeringActor = actor) => ({
    GITHUB_ACTOR: actor,
    GITHUB_ACTOR_ID: actorId,
    GITHUB_TRIGGERING_ACTOR: triggeringActor,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: WORKFLOW_REPO,
    GITHUB_RUN_ID: RUN_ID
  })

  // run() reads the clock itself, so these requests are signed for now.
  const fresh = () => {
    const seconds = Math.floor(Date.now() / 1000)
    return signRequest({ iat: seconds, exp: seconds + 300 })
  }
  const gateInputs = () => ({
    'github-token': 'tok',
    repository: REPO,
    operation: 'promote',
    'gate-actor-id': GATE_ID,
    'signed-request': fresh(),
    'gate-public-keys': GATE_PEM,
    'gate-issuer': ISSUER,
    'gate-audience': AUDIENCE,
    'expected-app': 'example-app',
    'expected-action': 'promote',
    'expected-target': 'candidate-12345'
  })

  it('refuses the gate account when no gate-claim-url sets up a request id store', async () => {
    github({ permissions: { [GATE]: 'admin' } })
    Object.assign(inputs, gateInputs())
    await run({ env: env(GATE, GATE_ID), sleep: noSleep })
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('the one-time request id store is not set up (no gate-claim-url is set), so signed requests cannot be used'))
    expect(core.exportVariable).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  it('gives a store this run\'s repository, id and attempt from the runner, and passes the gate account', async () => {
    github()
    Object.assign(inputs, gateInputs())
    const store = memoryStore(() => Math.floor(Date.now() / 1000))
    await run({ env: env(GATE, GATE_ID), sleep: noSleep, claimRequestId: store.claim })
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(store.claim).toHaveBeenCalledWith(expect.objectContaining({ run: { repository: WORKFLOW_REPO, id: RUN_ID, attempt: '1' } }))
    expect(core.setOutput).toHaveBeenCalledWith('passed-as', 'gate')
    expect(core.exportVariable).toHaveBeenCalledWith(AUTHORIZED_ATTEMPT_MARKER, '1')
  })

  // A workflow names the person who asked the gate, and pins what the gate
  // approved, from these. No other pass sets them.
  it('outputs the requester and the approved target on a gate pass, and only then', async () => {
    github({ permissions: { alice: 'write' } })
    Object.assign(inputs, gateInputs())
    const store = memoryStore(() => Math.floor(Date.now() / 1000))
    await run({ env: env(GATE, GATE_ID), sleep: noSleep, claimRequestId: store.claim })
    expect(core.setOutput.mock.calls).toEqual([
      ['passed-as', 'gate'],
      ['requester', 'requester@example.com'],
      ['request-target', 'candidate-12345'],
      ['request-id', 'req-0001-abcdef']
    ])

    for (const fn of Object.values(core)) fn.mockReset()
    await run({ env: env('alice', '2001'), sleep: noSleep, claimRequestId: store.claim })
    expect(core.setOutput.mock.calls).toEqual([['passed-as', 'push-access']])
  })

  it('refuses the gate account with a titled error when the request is missing', async () => {
    github()
    Object.assign(inputs, gateInputs(), { 'signed-request': '', 'refusal-title': 'actor_not_allowed' })
    await run({ env: env(GATE, GATE_ID), sleep: noSleep, claimRequestId: memoryStore().claim })
    expect(core.error).toHaveBeenCalledWith(expect.stringContaining('no signed request was given'), { title: 'actor_not_allowed' })
    expect(core.exportVariable).not.toHaveBeenCalled()
  })

  it('reads break-glass-team, refused-actor-ids and allow-push-access', async () => {
    github({ members: { alice: 'active', bob: 'active' }, permissions: { alice: 'admin', bob: 'admin' } })
    Object.assign(inputs, { 'github-token': 'tok', repository: REPO, operation: 'roll back', 'break-glass-team': 'example-org/ops-team', 'refused-actor-ids': '2002', 'allow-push-access': 'false' })
    await run({ env: env('alice', '2001'), sleep: noSleep })
    expect(core.setOutput).toHaveBeenCalledWith('passed-as', 'break-glass')

    for (const fn of Object.values(core)) fn.mockReset()
    await run({ env: env('bob', '2002'), sleep: noSleep })
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('bob (user id 2002) is in refused-actor-ids'))
  })

  it('keeps push access when a caller leaves allow-push-access out', async () => {
    github({ permissions: { alice: 'write' } })
    Object.assign(inputs, { 'github-token': 'tok', repository: REPO, operation: 'promote' })
    await run({ env: env('alice', '2001'), sleep: noSleep })
    expect(core.setOutput).toHaveBeenCalledWith('passed-as', 'push-access')
  })

  it('refuses an allow-push-access that a caller\'s expression left empty, even for a writer', async () => {
    github({ permissions: { alice: 'admin' } })
    Object.assign(inputs, { 'github-token': 'tok', repository: REPO, operation: 'promote', 'allow-push-access': '' })
    await run({ env: env('alice', '2001'), sleep: noSleep })
    expect(core.setFailed).toHaveBeenCalledWith('allow-push-access is empty, which happens only when the expression a caller gave it comes out empty; it must be "true" or "false"; refusing to promote')
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
    expect(core.exportVariable).not.toHaveBeenCalled()
  })
})

describe('authorize-actor action inputs', () => {
  // A caller on @v2 that sets none of these must be checked exactly as before.
  it.each([
    ['gate-actor-id', ''],
    ['signed-request', ''],
    ['gate-public-keys', ''],
    ['gate-issuer', ''],
    ['gate-audience', ''],
    ['expected-app', ''],
    ['expected-action', ''],
    ['expected-target', ''],
    ['refused-actor-ids', ''],
    ['break-glass-team', ''],
    ['allow-push-access', 'true'],
    ['gate-claim-url', ''],
    ['gate-claim-audience', '']
  ])('declares %s as optional with a default of %j', (name, value) => {
    expect(action.inputs[name]).toMatchObject({ required: false, default: value })
  })
})
