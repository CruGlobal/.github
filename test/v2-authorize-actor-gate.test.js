import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as yaml from 'js-yaml'

// The deploy gate, break-glass, refused accounts and allow-push-access. The
// checks that existed before these inputs are covered, unchanged, in
// v2-authorize-actor.test.js; that they still pass is what shows the new
// inputs, left at their defaults, change nothing.
const { getByUsername, getCollaboratorPermissionLevel, getMembershipForUserInOrg, core, inputs } = vi.hoisted(() => ({
  getByUsername: vi.fn(),
  getCollaboratorPermissionLevel: vi.fn(),
  getMembershipForUserInOrg: vi.fn(),
  core: {
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

vi.mock('@actions/github', () => ({
  getOctokit: () => ({
    rest: { users: { getByUsername }, repos: { getCollaboratorPermissionLevel }, teams: { getMembershipForUserInOrg } }
  })
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  notice: core.notice,
  warning: core.warning,
  info: core.info,
  error: core.error,
  setFailed: core.setFailed,
  exportVariable: core.exportVariable,
  setOutput: core.setOutput,
  ExitCode: { Success: 0, Failure: 1 }
}))

import { authorize, run } from '../src/authorize-actor.js'
import { AUTHORIZED_ATTEMPT_MARKER } from '../src/v2/attempt-guard.js'

const octokit = { rest: { users: { getByUsername }, repos: { getCollaboratorPermissionLevel }, teams: { getMembershipForUserInOrg } } }
const noSleep = async () => {}
const REPO = 'example-org/example-app'
const GATE = 'deploy-gate[bot]'
const GATE_ID = '12345'
const BOT = 'release-helper[bot]'
const BOT_ID = '41000001'
const USER_IDS = { [GATE]: 12345, [BOT]: 41000001, alice: 2001, bob: 2002, mallory: 2003 }

const NOW = 1800000000
const gateKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const GATE_PEM = gateKeys.publicKey.export({ type: 'spki', format: 'pem' })
const ISSUER = 'https://deploy-gate.example.com'
const AUDIENCE = 'example-org/deploy'

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
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
// and team membership states by login (missing means 404).
function github ({ permissions = {}, members = {} } = {}) {
  getByUsername.mockImplementation(async ({ username }) => {
    if (!(username in USER_IDS)) throw httpError(404)
    return { data: { id: USER_IDS[username] } }
  })
  getCollaboratorPermissionLevel.mockImplementation(async ({ username }) => {
    if (!(username in permissions)) throw httpError(404, `${username} is not a user`)
    return { data: { permission: permissions[username] } }
  })
  getMembershipForUserInOrg.mockImplementation(async ({ username }) => {
    if (!(username in members)) throw httpError(404, 'Not Found')
    return { data: { state: members[username], role: 'member' } }
  })
}

const base = { octokit, repository: REPO, operation: 'promote', runAttempt: '1', sleep: noSleep, now: () => NOW * 1000 }
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

beforeEach(() => {
  getByUsername.mockReset()
  getCollaboratorPermissionLevel.mockReset()
  getMembershipForUserInOrg.mockReset()
  for (const fn of Object.values(core)) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
})

afterEach(() => { process.exitCode = undefined })

describe('authorize: the deploy gate', () => {
  it('lets the gate account through with a valid signed request, and logs who asked and the request id', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest() })).resolves.toBe('gate')
    expect(getByUsername).toHaveBeenCalledWith({ username: GATE, request: { signal: expect.any(AbortSignal) } })
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
    expect(getMembershipForUserInOrg).not.toHaveBeenCalled()
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('with a signed request from requester@example.com to promote example-app at candidate-12345 (request id req-0001-abcdef, key gate-1)'))
  })

  it('refuses a gate-started run with no signed request, and does not fall through', async () => {
    github({ permissions: { [GATE]: 'admin' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: '' }))
      .rejects.toThrow(`${GATE}, the deploy gate's account, started this run attempt (attempt 1), so it needs a valid signed request, and no signed request was given; refusing to promote ${REPO}`)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
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
    ['an expired request', { iat: NOW - 500, exp: NOW - 200 }, 'expired 200 seconds ago'],
    ['a request for another target', { target: 'candidate-99999' }, "for target 'candidate-99999', but this run is for target 'candidate-12345'"],
    ['a request for another app', { app: 'other-app' }, "for app 'other-app'"],
    ['a request for another action', { action: 'rollback' }, "for action 'rollback'"]
  ])('refuses %s, even when the gate account has push access', async (_label, claims, message) => {
    github({ permissions: { [GATE]: 'admin' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(claims) })).rejects.toThrow(message)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('refuses when the run does not say what it is for', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, expectedTarget: '', signedRequest: signRequest() }))
      .rejects.toThrow('no expected-target was given, so the signed request cannot be matched to this run')
  })

  it('needs the signed request even when the gate account is also on the automation allowlist', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, trustedActorIds: GATE_ID, signedRequest: '' }))
      .rejects.toThrow('no signed request was given')
  })

  it('lets the gate account through on a re-run it started itself', async () => {
    github()
    await expect(authorize({ ...base, ...gate, ...gateRun, runAttempt: '2', signedRequest: signRequest() })).resolves.toBe('gate')
  })

  it('refuses when the gate account\'s user id cannot be looked up', async () => {
    getByUsername.mockRejectedValue(httpError(500))
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest() }))
      .rejects.toThrow(/could not look up the user id of deploy-gate\[bot\].*cannot be matched to the deploy gate's account; refusing to promote/)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('does not treat a login that now belongs to another user id as the gate', async () => {
    getByUsername.mockResolvedValue({ data: { id: 99999 } })
    getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'none' } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest() }))
      .rejects.toThrow(`${GATE} is not authorized to promote ${REPO} (permission: none)`)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("now belongs to user id 99999, not the deploy gate's user id 12345"))
  })

  it('falls through to break-glass when a person re-runs a gate run', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...gate, actor: GATE, actorId: GATE_ID, triggeringActor: 'alice', runAttempt: '2', signedRequest: signRequest(), breakGlassTeam: 'ops-team' }))
      .resolves.toBe('break-glass')
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining(`this run was first started by the deploy gate's account ${GATE}, but this run attempt (attempt 2) was started by alice, so no signed request is used`))
    expect(getByUsername).not.toHaveBeenCalled()
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
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  describe('one-time id hook', () => {
    it('is given the verified claims', async () => {
      github()
      const claimRequestId = vi.fn(async () => {})
      await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId })).resolves.toBe('gate')
      expect(claimRequestId).toHaveBeenCalledWith(expect.objectContaining({ jti: 'req-0001-abcdef', sub: 'requester@example.com', exp: NOW + 290 }))
    })

    it('refuses when it throws', async () => {
      github()
      const claimRequestId = vi.fn(async () => { throw new Error('already used by another run') })
      await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), claimRequestId }))
        .rejects.toThrow('its request id req-0001-abcdef could not be claimed for this run (already used by another run)')
    })
  })
})

describe('authorize: break-glass', () => {
  const person = { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }

  it('lets an active member of the team through, without reading push access', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'ops-team' })).resolves.toBe('break-glass')
    expect(getMembershipForUserInOrg).toHaveBeenCalledWith({ org: 'example-org', team_slug: 'ops-team', username: 'alice', request: { signal: expect.any(AbortSignal) } })
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('does not count a pending member, and names what it tried', async () => {
    github({ members: { alice: 'pending' }, permissions: { alice: 'read' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'ops-team' }))
      .rejects.toThrow(`Tried: the break-glass team example-org/ops-team (membership state: pending); push access on ${REPO} (permission: read).`)
  })

  it('still lets a pending member with push access through on push access', async () => {
    github({ members: { alice: 'pending' }, permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'ops-team' })).resolves.toBe('push-access')
  })

  it('treats a 404 as not a member, and says a wrong slug looks the same', async () => {
    github({ permissions: { alice: 'triage' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'ops-team' }))
      .rejects.toThrow('the break-glass team example-org/ops-team (GitHub answered 404: not a member, or the team does not exist or this token cannot see it)')
  })

  it.each([
    ['a 403', () => getMembershipForUserInOrg.mockRejectedValue(httpError(403)), 1],
    ['a server error that does not clear', () => getMembershipForUserInOrg.mockRejectedValue(httpError(502)), 3]
  ])('refuses on %s instead of falling through', async (_label, arrange, calls) => {
    github({ permissions: { alice: 'admin' } })
    arrange()
    await expect(authorize({ ...base, ...person, breakGlassTeam: 'ops-team' }))
      .rejects.toThrow(/could not read the membership of alice in the break-glass team example-org\/ops-team .*refusing to promote/)
    expect(getMembershipForUserInOrg).toHaveBeenCalledTimes(calls)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it.each(['example-org/ops-team', 'ops team', '-ops'])('refuses a break-glass-team of %j', async (slug) => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...person, breakGlassTeam: slug }))
      .rejects.toThrow(/break-glass-team must be a team slug in the app repo's org/)
    expect(getMembershipForUserInOrg).not.toHaveBeenCalled()
  })

  it('is checked after the automation allowlist', async () => {
    github({ members: { [BOT]: 'active' } })
    await expect(authorize({ ...base, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, trustedActorIds: BOT_ID, breakGlassTeam: 'ops-team' }))
      .resolves.toBe('automation')
    expect(getMembershipForUserInOrg).not.toHaveBeenCalled()
  })
})

describe('authorize: refused accounts', () => {
  const alice = { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }

  it('refuses a listed account that is an active break-glass member', async () => {
    github({ members: { alice: 'active' }, permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2001', breakGlassTeam: 'ops-team' }))
      .rejects.toThrow(`alice (user id 2001) is in refused-actor-ids, so it may not promote ${REPO} by break-glass or push access`)
    expect(getMembershipForUserInOrg).not.toHaveBeenCalled()
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('refuses a listed account that has push access', async () => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '9, 2001\n7' })).rejects.toThrow('is in refused-actor-ids')
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('checks the account that pressed re-run, by its own user id', async () => {
    github({ permissions: { alice: 'admin', mallory: 'admin' } })
    await expect(authorize({ ...base, actor: 'alice', actorId: '2001', triggeringActor: 'mallory', runAttempt: '2', refusedActorIds: '2003' }))
      .rejects.toThrow('mallory (user id 2003) is in refused-actor-ids')
    expect(getByUsername).toHaveBeenCalledWith(expect.objectContaining({ username: 'mallory' }))
  })

  it('lets an account that is not listed through as before', async () => {
    github({ permissions: { alice: 'write' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2003' })).resolves.toBe('push-access')
  })

  it('refuses when the user id cannot be looked up', async () => {
    github({ permissions: { alice: 'admin' } })
    getByUsername.mockRejectedValue(httpError(404))
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2003' }))
      .rejects.toThrow(/could not look up the user id of alice .* cannot be checked against refused-actor-ids; refusing to promote/)
  })

  it('refuses an entry that is not a number, instead of skipping it', async () => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, refusedActorIds: '2003, mallory' }))
      .rejects.toThrow("refused-actor-ids must hold numeric GitHub user ids only; cannot read 'mallory'")
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('looks the user id up once when the gate check already did', async () => {
    // The gate's login was taken by another account, which is also refused.
    getByUsername.mockResolvedValue({ data: { id: 2003 } })
    await expect(authorize({ ...base, ...gate, ...gateRun, signedRequest: signRequest(), refusedActorIds: '2003' }))
      .rejects.toThrow('is in refused-actor-ids')
    expect(getByUsername).toHaveBeenCalledTimes(1)
  })
})

describe('authorize: allow-push-access', () => {
  const alice = { actor: 'alice', actorId: '2001', triggeringActor: 'alice' }

  it.each(['false', 'FALSE', ' false '])('refuses a writer when it is %j, without reading push access', async (value) => {
    github({ permissions: { alice: 'admin' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: value }))
      .rejects.toThrow(`alice is not authorized to promote ${REPO}: push access does not count for this run (allow-push-access is false). The account checked is alice, the one that started this run attempt (attempt 1). Tried: nothing else is configured.`)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('still lets a break-glass member through when it is false', async () => {
    github({ members: { alice: 'active' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: 'false', breakGlassTeam: 'ops-team' })).resolves.toBe('break-glass')
  })

  it('names break-glass in the refusal when it is false', async () => {
    github({ members: { alice: 'pending' } })
    await expect(authorize({ ...base, ...alice, allowPushAccess: 'false', breakGlassTeam: 'ops-team' }))
      .rejects.toThrow('Tried: the break-glass team example-org/ops-team (membership state: pending).')
  })

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
    GITHUB_ACTOR: actor, GITHUB_ACTOR_ID: actorId, GITHUB_TRIGGERING_ACTOR: triggeringActor, GITHUB_RUN_ATTEMPT: '1'
  })

  // run() reads the clock itself, so these requests are signed for now.
  const fresh = () => {
    const seconds = Math.floor(Date.now() / 1000)
    return signRequest({ iat: seconds, exp: seconds + 300 })
  }

  it('reads the gate inputs, passes the gate account and says so', async () => {
    github()
    Object.assign(inputs, {
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
    await run({ env: env(GATE, GATE_ID), sleep: noSleep })
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('passed-as', 'gate')
    expect(core.exportVariable).toHaveBeenCalledWith(AUTHORIZED_ATTEMPT_MARKER, '1')
  })

  it('refuses the gate account with a titled error when the request is missing', async () => {
    github()
    Object.assign(inputs, {
      'github-token': 'tok',
      repository: REPO,
      operation: 'promote',
      'gate-actor-id': GATE_ID,
      'gate-public-keys': GATE_PEM,
      'gate-issuer': ISSUER,
      'gate-audience': AUDIENCE,
      'expected-app': 'example-app',
      'expected-action': 'promote',
      'expected-target': 'candidate-12345',
      'refusal-title': 'actor_not_allowed'
    })
    await run({ env: env(GATE, GATE_ID), sleep: noSleep })
    expect(core.error).toHaveBeenCalledWith(expect.stringContaining('no signed request was given'), { title: 'actor_not_allowed' })
    expect(core.exportVariable).not.toHaveBeenCalled()
  })

  it('reads break-glass-team, refused-actor-ids and allow-push-access', async () => {
    github({ members: { alice: 'active', bob: 'active' }, permissions: { alice: 'admin', bob: 'admin' } })
    Object.assign(inputs, { 'github-token': 'tok', repository: REPO, operation: 'roll back', 'break-glass-team': 'ops-team', 'refused-actor-ids': '2002', 'allow-push-access': 'false' })
    await run({ env: env('alice', '2001'), sleep: noSleep })
    expect(core.setOutput).toHaveBeenCalledWith('passed-as', 'break-glass')

    for (const fn of Object.values(core)) fn.mockReset()
    await run({ env: env('bob', '2002'), sleep: noSleep })
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('bob (user id 2002) is in refused-actor-ids'))
  })
})

describe('authorize-actor action inputs', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const action = yaml.load(readFileSync(path.join(root, 'actions/authorize-actor/action.yml'), 'utf8'))

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
    ['allow-push-access', 'true']
  ])('declares %s as optional with a default of %j', (name, value) => {
    expect(action.inputs[name]).toMatchObject({ required: false, default: value })
  })
})
