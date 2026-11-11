import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { loadYaml, findStep, runShellStep, removeFakes, resolveExpressions } from './support/workflow-steps.js'

// How the deploy gate is wired into promote.yml, rollback.yml and hotfix.yml:
// the inputs each takes, what every authorize-actor step is given, the
// promote's candidate pin, hotfix's check before its lock, and how a run the
// gate started names the person who asked. The check itself is tested in
// v2-authorize-actor-gate.test.js. Here the real steps run: the action's
// run() with the inputs the workflow gives it, and the shell steps under
// bash (see support/workflow-steps.js).

const { api, octokit, core, inputs, defaults } = vi.hoisted(() => {
  const api = {
    getByUsername: vi.fn(),
    getCollaboratorPermissionLevel: vi.fn(),
    getTeamMembership: vi.fn(),
    getTeamByName: vi.fn(),
    listChildTeams: vi.fn()
  }
  const octokit = {
    rest: {
      users: { getByUsername: api.getByUsername },
      repos: { getCollaboratorPermissionLevel: api.getCollaboratorPermissionLevel },
      teams: {
        getMembershipForUserInOrg: api.getTeamMembership,
        getByName: api.getTeamByName,
        listChildInOrg: api.listChildTeams
      }
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

import { run } from '../src/authorize-actor.js'
import { RequestIdTaken } from '../src/v2/signed-request.js'

afterAll(removeFakes)

const ACTION = './cru-github-actions/actions/authorize-actor'
const action = loadYaml('actions/authorize-actor/action.yml')
// The runner fills in an input's declared default when a step leaves it out.
for (const [name, spec] of Object.entries(action.inputs)) defaults[name] = String(spec.default ?? '')

const FILES = {
  promote: '.github/workflows/promote.yml',
  rollback: '.github/workflows/rollback.yml',
  hotfix: '.github/workflows/hotfix.yml'
}
const workflows = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, loadYaml(file)]))

// What each workflow's checks compare a signed request to. The action is a
// fixed word, and the target is the input the gate fills in for it.
const EXPECTED = {
  promote: { action: 'promote', target: 'inputs.expected-candidate' },
  rollback: { action: 'rollback', target: 'inputs.release' },
  hotfix: { action: 'hotfix', target: 'inputs.commit' }
}
const NEW_INPUTS = ['gate-actor-id', 'gate-public-keys', 'gate-issuer', 'gate-audience', 'signed-request']
// Every gate input a check step reads, the claim inputs from before included.
const GATE_WITH = ['gate-claim-url', 'gate-claim-audience', ...NEW_INPUTS]
// The break-glass settings each workflow passes to every check.
const BREAK_GLASS_WITH = ['break-glass-team', 'allow-push-access']

const checksIn = (workflow) => Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
  job.steps.filter((step) => step.uses === ACTION).map((step) => ({ jobId, job, step })))

// Made-up accounts, keys and hosts.
const PROJECT = 'example-app'
const APP_REPO = `CruGlobal/${PROJECT}`
const WORKFLOW_REPO = 'example-org/deploy-workflows'
const GATE = 'deploy-gate[bot]'
const GATE_ID = '50000001'
const REQUESTER = 'requester@example.com'
const ISSUER = 'https://gate.example.com/gate'
const AUDIENCE = 'example-org/deploy-workflows'
const CLAIM_URL = 'https://gate.example.com/gate/claim'
const CANDIDATE = 'candidate-2026-11-10-10200'
const RELEASE = 'release-2026-11-09-10190'
const COMMIT = 'c0ffee0000000000000000000000000000000002'
const TARGETS = { promote: CANDIDATE, rollback: RELEASE, hotfix: COMMIT }
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PEM = keys.publicKey.export({ type: 'spki', format: 'pem' })

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
let requestNumber = 0
// A request signed now, by the runner's clock, good for five minutes.
function signRequest (claims) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: REQUESTER,
    app: PROJECT,
    environment: 'production',
    jti: `req-${++requestNumber}`,
    iat: now,
    exp: now + 300,
    ...claims
  }
  const data = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}`
  return `${data}.${sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

// A request id store that keeps the contract above claimRequestId in
// src/authorize-actor.js, with the runner's clock standing in for the gate's.
function memoryStore () {
  const records = new Map()
  const clock = () => Math.floor(Date.now() / 1000)
  const claim = vi.fn(async ({ claims, expired, run }) => {
    const record = records.get(claims.jti)
    const sameAttempt = record && record.repository === run.repository && record.id === run.id && record.attempt === run.attempt
    if (!expired) {
      if (clock() > claims.exp + 60) throw Object.assign(new Error('expired'), { name: 'RequestExpired' })
      if (!record) {
        records.set(claims.jti, { ...run, at: clock() })
        return 'claimed'
      }
      if (sameAttempt) return 'held'
      throw new RequestIdTaken()
    }
    if (sameAttempt && clock() - record.at <= 7200) return 'held'
    throw new RequestIdTaken()
  })
  return { claim, records }
}

const runnerEnv = (actor, actorId, attempt = '1') => ({
  GITHUB_ACTOR: actor,
  GITHUB_ACTOR_ID: actorId,
  GITHUB_TRIGGERING_ACTOR: actor,
  GITHUB_RUN_ATTEMPT: attempt,
  GITHUB_REPOSITORY: WORKFLOW_REPO,
  GITHUB_RUN_ID: '9000000002'
})

// What a caller that sets none of the gate inputs passes: each input's
// default.
function callerContext (workflowName, overrides = {}) {
  const declared = workflows[workflowName].on.workflow_call.inputs
  const context = {}
  for (const [name, spec] of Object.entries(declared)) context[`inputs.${name}`] = String(spec.default ?? '')
  return {
    ...context,
    'inputs.project-name': PROJECT,
    'inputs.expected-candidate': '',
    'inputs.release': RELEASE,
    'inputs.commit': COMMIT,
    'inputs.expected-release': RELEASE,
    'secrets.authz-token': 'tok',
    'steps.app-info.outputs.repository': APP_REPO,
    'steps.app-info-prod.outputs.repository': APP_REPO,
    'needs.lookup.outputs.repository': APP_REPO,
    ...overrides
  }
}

// What the wrapper passes once it reads the gate's settings.
function gateContext (workflowName, overrides = {}) {
  return callerContext(workflowName, {
    'inputs.gate-actor-id': GATE_ID,
    'inputs.gate-public-keys': PEM,
    'inputs.gate-issuer': ISSUER,
    'inputs.gate-audience': AUDIENCE,
    'inputs.gate-claim-url': CLAIM_URL,
    'inputs.gate-claim-audience': 'https://gate.example.com/gate',
    ...(workflowName === 'promote' ? { 'inputs.expected-candidate': CANDIDATE } : {}),
    ...overrides
  })
}

// Run one check step's action with the inputs the workflow gives it.
async function runCheck (step, context, env, store) {
  for (const key of Object.keys(inputs)) delete inputs[key]
  for (const [name, value] of Object.entries(step.with)) inputs[name] = resolveExpressions(value, context)
  await run({ env, sleep: async () => {}, claimRequestId: store?.claim })
}

const outputs = () => Object.fromEntries(core.setOutput.mock.calls)
const refusal = () => [...core.setFailed.mock.calls, ...core.error.mock.calls].map(([message]) => message).join('\n')

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  for (const fn of Object.values(core)) fn.mockReset()
  api.getByUsername.mockImplementation(async ({ username }) => {
    if (username === GATE) return { data: { id: Number(GATE_ID) } }
    throw Object.assign(new Error('Not Found'), { status: 404 })
  })
  api.getCollaboratorPermissionLevel.mockImplementation(async ({ username }) => ({ data: { permission: username === 'alice' ? 'write' : 'read' } }))
})

afterEach(() => {
  process.exitCode = undefined
  vi.useRealTimers()
})

describe.each(Object.keys(FILES))('%s.yml', (workflowName) => {
  const workflow = workflows[workflowName]
  const declared = workflow.on.workflow_call.inputs
  const checks = checksIn(workflow)
  const { action: expectedAction, target } = EXPECTED[workflowName]

  it('takes the gate inputs, each off unless the caller sets it', () => {
    for (const name of NEW_INPUTS) expect(declared[name], name).toMatchObject({ type: 'string', required: false, default: '' })
  })

  // A caller that could choose the action could send a promote's approval
  // to a rollback. What the run applies is never a separate input either.
  it('takes no input for what a signed request is compared to', () => {
    for (const name of ['expected-action', 'expected-app', 'expected-target']) expect(declared).not.toHaveProperty(name)
  })

  it('gives every check the gate inputs, the project, its own action word and its target', () => {
    expect(checks.length).toBe({ promote: 3, rollback: 3, hotfix: 2 }[workflowName])
    for (const { jobId, step } of checks) {
      for (const name of GATE_WITH) expect(step.with[name], `${jobId}: ${name}`).toBe(`\${{ inputs.${name} }}`)
      expect(step.with['expected-app'], jobId).toBe('${{ inputs.project-name }}')
      expect(step.with['expected-action'], jobId).toBe(expectedAction)
      expect(step.with['expected-target'], jobId).toBe(`\${{ ${target} }}`)
      for (const name of Object.keys(step.with)) expect(action.inputs, `${jobId}: ${name}`).toHaveProperty(name)
    }
  })

  // The break-glass settings, as the action takes them: strings, with the
  // action's own defaults, so a caller that sets neither is checked as before.
  it('takes break-glass-team and allow-push-access, off and on unless the caller sets them', () => {
    expect(declared['break-glass-team']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(declared['allow-push-access']).toMatchObject({ type: 'string', required: false, default: 'true' })
    for (const name of BREAK_GLASS_WITH) expect(declared[name].default, name).toBe(action.inputs[name].default)
  })

  it('gives every check break-glass-team and allow-push-access', () => {
    for (const { jobId, step } of checks) {
      for (const name of BREAK_GLASS_WITH) expect(step.with[name], `${jobId}: ${name}`).toBe(`\${{ inputs.${name} }}`)
    }
  })

  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: lets an active member of break-glass-team through without push access', async (_jobId, index) => {
    const { step } = checks[index]
    api.getTeamMembership.mockResolvedValue({ data: { state: 'active' } })
    api.listChildTeams.mockResolvedValue({ data: [] })
    await runCheck(step, callerContext(workflowName, { 'inputs.break-glass-team': 'example-org/ops-team' }), runnerEnv('mallory', '2003'))
    expect(refusal()).toBe('')
    expect(core.setOutput.mock.calls).toEqual([['passed-as', 'break-glass']])
    expect(api.getTeamMembership).toHaveBeenCalledWith(expect.objectContaining({ org: 'example-org', team_slug: 'ops-team', username: 'mallory' }))
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: refuses an account with push access when allow-push-access is false', async (_jobId, index) => {
    const { step } = checks[index]
    await runCheck(step, callerContext(workflowName, { 'inputs.allow-push-access': 'false' }), runnerEnv('alice', '2001'))
    expect(refusal()).toContain('push access does not count for this run (allow-push-access is false)')
    expect(core.setOutput).not.toHaveBeenCalled()
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  // A caller whose expression for it comes out empty is refused, not let
  // through: the workflow passes the value on as it is.
  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: refuses an allow-push-access that comes out empty', async (_jobId, index) => {
    const { step } = checks[index]
    await runCheck(step, callerContext(workflowName, { 'inputs.allow-push-access': '' }), runnerEnv('alice', '2001'))
    expect(refusal()).toContain('allow-push-access is empty')
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: passes the gate\'s attempt with a signed request, and names the requester', async (_jobId, index) => {
    const { step } = checks[index]
    const store = memoryStore()
    const context = gateContext(workflowName, { 'inputs.signed-request': signRequest({ action: expectedAction, target: TARGETS[workflowName] }) })
    await runCheck(step, context, runnerEnv(GATE, GATE_ID), store)
    expect(refusal()).toBe('')
    expect(outputs()).toEqual({ 'passed-as': 'gate', requester: REQUESTER, 'request-target': TARGETS[workflowName], 'request-id': `req-${requestNumber}` })
    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(api.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: refuses a request signed for another action', async (_jobId, index) => {
    const { step } = checks[index]
    const other = expectedAction === 'promote' ? 'rollback' : 'promote'
    const context = gateContext(workflowName, { 'inputs.signed-request': signRequest({ action: other, target: TARGETS[workflowName] }) })
    await runCheck(step, context, runnerEnv(GATE, GATE_ID), memoryStore())
    expect(refusal()).toContain(`the signed request is for action '${other}', but this run is for action '${expectedAction}'`)
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: refuses a request signed for another target', async (_jobId, index) => {
    const { step } = checks[index]
    const context = gateContext(workflowName, { 'inputs.signed-request': signRequest({ action: expectedAction, target: `${TARGETS[workflowName]}0` }) })
    await runCheck(step, context, runnerEnv(GATE, GATE_ID), memoryStore())
    expect(refusal()).toContain(`but this run is for target '${TARGETS[workflowName]}'`)
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  // The rule for every caller still on today's inputs: nothing changes.
  it.each(checks.map(({ jobId }, index) => [jobId, index]))('%s: checks a caller that sets no gate input exactly as before', async (_jobId, index) => {
    const { step } = checks[index]
    const context = callerContext(workflowName)
    for (const name of GATE_WITH) expect(resolveExpressions(step.with[name], context), name).toBe('')
    expect(resolveExpressions(step.with['break-glass-team'], context)).toBe('')
    expect(resolveExpressions(step.with['allow-push-access'], context)).toBe('true')

    await runCheck(step, context, runnerEnv('alice', '2001'))
    expect(refusal()).toBe('')
    expect(core.setOutput.mock.calls).toEqual([['passed-as', 'push-access']])
    expect(api.getByUsername).not.toHaveBeenCalled()
    expect(api.getTeamMembership).not.toHaveBeenCalled()

    // The gate's account, with no gate-actor-id set, is any other account,
    // and a signed request it carries is not used.
    for (const fn of Object.values(core)) fn.mockReset()
    await runCheck(step, { ...context, 'inputs.signed-request': signRequest({ action: expectedAction, target: TARGETS[workflowName] }) }, runnerEnv(GATE, GATE_ID))
    expect(refusal()).toMatch(new RegExp(`^${GATE.replace(/[[\]]/g, '\\$&')} is not authorized to`))
  })
})

describe('authorize-actor outputs', () => {
  it('declares every output a workflow reads from a check', () => {
    for (const [name, workflow] of Object.entries(workflows)) {
      const read = new Set([...JSON.stringify(workflow).matchAll(/steps\.authz\.outputs\.([a-z-]+)/g)].map((match) => match[1]))
      for (const output of read) expect(action.outputs, `${name}: ${output}`).toHaveProperty(output)
    }
    expect(Object.keys(action.outputs).sort()).toEqual(['passed-as', 'request-id', 'request-target', 'requester'])
  })
})

describe('promote: the gate pins its candidate', () => {
  const workflow = workflows.promote
  const STEP = 'Refuse a gate promote that does not pin its candidate'
  const pin = (passedAs, expectedCandidate, requestTarget) => runShellStep(findStep(workflow, 'lookup', STEP), {
    context: {
      'steps.authz.outputs.passed-as': passedAs,
      'inputs.expected-candidate': expectedCandidate,
      'steps.authz.outputs.request-target': requestTarget
    }
  })

  it('runs in lookup right after the automation check, with no way to skip it', () => {
    const names = workflow.jobs.lookup.steps.map((step) => step.name)
    expect(names.indexOf(STEP)).toBe(names.indexOf('Refuse an automation promote that does not name its candidate') + 1)
    expect(names.indexOf(STEP)).toBeGreaterThan(names.indexOf('Authorize actor'))
    const { step } = findStep(workflow, 'lookup', STEP)
    expect(step.if).toBeUndefined()
    expect(step['continue-on-error']).toBeUndefined()
  })

  it.each(['push-access', 'automation', 'break-glass', ''])('leaves a promote that passed as %j alone', async (passedAs) => {
    const result = await pin(passedAs, '', '')
    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('lets a gate promote through when expected-candidate is the approved candidate', async () => {
    const result = await pin('gate', CANDIDATE, CANDIDATE)
    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).not.toContain('::error')
  })

  it.each([
    ['another candidate', 'candidate-2026-11-10-10201', CANDIDATE],
    ['no expected-candidate', '', CANDIDATE],
    ['the same candidate with a space around it', ` ${CANDIDATE}`, CANDIDATE],
    ['no request-target from an older action bundle', CANDIDATE, '']
  ])('refuses a gate promote with %s', async (_why, expectedCandidate, requestTarget) => {
    const result = await pin('gate', expectedCandidate, requestTarget)
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^::error title=actor_not_allowed::the deploy gate started this promote, so expected-candidate must be exactly the candidate its signed request approved/m)
    expect(result.stdout).toContain('Nothing in production was changed')
  })

  it('keeps the refusal on one line', async () => {
    const result = await pin('gate', `${CANDIDATE}\n::notice::injected`, CANDIDATE)
    expect(result.status).toBe(1)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
  })

  // The pin and the moved-candidate guard together: once expected-candidate
  // is the approved candidate, a newer candidate on release-candidate is
  // refused inside the lock rather than shipped.
  it.each(['promote-gcp', 'promote-aws'])('%s refuses a candidate that moved after the approval', async (jobId) => {
    const result = await runShellStep(findStep(workflow, jobId, 'Refuse a moved candidate'), {
      context: {
        'inputs.project-name': PROJECT,
        'inputs.expected-candidate': CANDIDATE,
        'steps.release.outputs.candidate': 'candidate-2026-11-10-10201',
        'steps.release.outputs.release': 'release-2026-11-10-10201',
        'steps.resolve.outputs.tags': 'candidate-2026-11-10-10201',
        'steps.resolve.outputs.digest': 'sha256:' + 'e'.repeat(64),
        'secrets.datadog-api-key': 'dd-test'
      }
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^::error title=candidate_moved::/m)
  })
})

// A production job waits for the production lock outside lookup, and can
// find the request expired once it gets it. lookup's claim carries it.
describe.each([['promote', 'promote-aws'], ['rollback', 'rollback-gcp']])('%s: a job that waited for the lock', (workflowName, jobId) => {
  const workflow = workflows[workflowName]
  const lookupCheck = () => findStep(workflow, 'lookup', 'Authorize actor').step
  const jobCheck = () => workflow.jobs[jobId].steps[1]

  it('goes ahead with the request lookup claimed, after it expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const store = memoryStore()
    const context = gateContext(workflowName, { 'inputs.signed-request': signRequest({ action: EXPECTED[workflowName].action, target: TARGETS[workflowName] }) })
    await runCheck(lookupCheck(), context, runnerEnv(GATE, GATE_ID), store)
    expect(refusal()).toBe('')
    for (const fn of Object.values(core)) fn.mockReset()
    vi.setSystemTime(new Date('2026-11-10T12:45:00Z'))
    await runCheck(jobCheck(), context, runnerEnv(GATE, GATE_ID), store)
    expect(refusal()).toBe('')
    expect(await store.claim.mock.results[1].value).toBe('held')
    expect(outputs()).toMatchObject({ 'passed-as': 'gate', requester: REQUESTER })
  })

  it('refuses another run that brings the same request', async () => {
    const store = memoryStore()
    const context = gateContext(workflowName, { 'inputs.signed-request': signRequest({ action: EXPECTED[workflowName].action, target: TARGETS[workflowName] }) })
    await runCheck(lookupCheck(), context, runnerEnv(GATE, GATE_ID), store)
    expect(refusal()).toBe('')
    for (const fn of Object.values(core)) fn.mockReset()
    await runCheck(lookupCheck(), context, { ...runnerEnv(GATE, GATE_ID), GITHUB_RUN_ID: '9000000003' }, store)
    expect(refusal()).toContain('was already claimed by another run')
  })
})

describe('hotfix: the check before the lock', () => {
  const workflow = workflows.hotfix
  const { authorize, hotfix } = workflow.jobs

  it('runs a job outside the hotfix lock first, and the hotfix job waits for it', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['authorize', 'hotfix'])
    expect(authorize.concurrency).toBeUndefined()
    expect(authorize.permissions).toEqual({ 'id-token': 'write', contents: 'read' })
    expect(Number.isInteger(authorize['timeout-minutes'])).toBe(true)
    expect(hotfix.needs).toBe('authorize')
    expect(hotfix.concurrency.group).toBe('hotfix-${{ inputs.project-name }}')
    expect(hotfix.if).toBeUndefined()
  })

  it('makes the same app-info lookup and the same check as the hotfix job', () => {
    const names = authorize.steps.map((step) => step.name)
    expect(names).toEqual(['Configure AWS credentials for app-info', 'Look up app info (production)', 'Checkout Cru Actions & Workflows', 'Authorize actor'])
    for (const name of names) {
      const mine = findStep(workflow, 'authorize', name).step
      const theirs = findStep(workflow, 'hotfix', name).step
      expect(mine, name).toEqual(theirs)
    }
    expect(authorize.env).toEqual(hotfix.env)
  })

  // A hotfix that waits behind another for longer than the request's five
  // minutes still goes through, because the authorize job claimed it while
  // it was fresh, and the same attempt's hotfix job then holds it.
  it('lets the hotfix job use a request that expired while it waited for the lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const store = memoryStore()
    const context = gateContext('hotfix', { 'inputs.signed-request': signRequest({ action: 'hotfix', target: COMMIT }) })
    const env = runnerEnv(GATE, GATE_ID)

    await runCheck(findStep(workflow, 'authorize', 'Authorize actor').step, context, env, store)
    expect(refusal()).toBe('')
    expect(await store.claim.mock.results[0].value).toBe('claimed')

    for (const fn of Object.values(core)) fn.mockReset()
    vi.setSystemTime(new Date('2026-11-10T12:20:00Z'))
    await runCheck(findStep(workflow, 'hotfix', 'Authorize actor').step, context, env, store)
    expect(refusal()).toBe('')
    expect(await store.claim.mock.results[1].value).toBe('held')
    expect(outputs()).toMatchObject({ 'passed-as': 'gate', requester: REQUESTER })
  })

  it('would refuse that request without the earlier claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const context = gateContext('hotfix', { 'inputs.signed-request': signRequest({ action: 'hotfix', target: COMMIT }) })
    vi.setSystemTime(new Date('2026-11-10T12:20:00Z'))
    await runCheck(findStep(workflow, 'hotfix', 'Authorize actor').step, context, runnerEnv(GATE, GATE_ID), memoryStore())
    expect(refusal()).toContain('the one-time request id store says this run attempt (attempt 1) is not that attempt')
  })

  // "Re-run failed jobs" reuses the authorize job and runs only the hotfix
  // job, at a new attempt that never claimed the request.
  it('refuses the gate account\'s re-run of the hotfix job once the request has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const store = memoryStore()
    const context = gateContext('hotfix', { 'inputs.signed-request': signRequest({ action: 'hotfix', target: COMMIT }) })
    await runCheck(findStep(workflow, 'authorize', 'Authorize actor').step, context, runnerEnv(GATE, GATE_ID), store)
    for (const fn of Object.values(core)) fn.mockReset()
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
    await runCheck(findStep(workflow, 'hotfix', 'Authorize actor').step, context, runnerEnv(GATE, GATE_ID, '2'), store)
    expect(refusal()).toContain('refusing to cut a hotfix for')
    expect(core.setOutput).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Naming the person. On a run the gate started, the ledger row and the Slack
// notices name the requester by their full email, and the GitHub Release,
// which can be public, by the part before the @. On every other run they read
// exactly as before (the other tests pin that wording).

const SHA = 'c0ffee0000000000000000000000000000000001'
const RUN_URL = 'https://github.com/example-org/deploy-wrappers/actions/runs/9001'

function namingContext (requester) {
  return {
    'inputs.project-name': PROJECT,
    'inputs.flightdeck-url': '',
    'vars.FLIGHTDECK_WORKSPACE': '',
    'secrets.datadog-api-key': 'dd-test',
    'secrets.authz-token': 'tok',
    'secrets.slack-bot-token': 'xoxb-test',
    'github.actor': GATE,
    'github.triggering_actor': GATE,
    'steps.authz.outputs.requester': requester,
    'steps.authz.outputs.request-id': requester ? 'req-0042' : '',
    'steps.authz.outputs.passed-as': requester ? 'gate' : 'push-access',
    'needs.lookup.outputs.repository': APP_REPO,
    'needs.lookup.outputs.slack-channel': 'C0000000000',
    'needs.lookup.outputs.app-url': '',
    'needs.lookup.outputs.flightdeck-project': '',
    'needs.lookup.outputs.type': 'ecs',
    'needs.lookup.outputs.release-tag': RELEASE,
    'steps.resolve.outputs.tags': `candidate-2026-11-10-10200,sha-${SHA}`,
    'steps.resolve.outputs.digest': 'sha256:' + 'd'.repeat(64),
    'steps.release.outputs.release': 'release-2026-11-10-10200',
    "steps.release.outputs.release || ''": 'release-2026-11-10-10200',
    'steps.baseline.outputs.head-sha': SHA,
    'steps.baseline.outputs.prev-sha': '',
    'steps.rollback-safety.outputs.verdict': 'safe',
    'steps.rollback-safety.outputs.reasons': '["no migration changes in this release"]',
    'steps.rollback-safety.outputs.slack': '',
    'steps.rollback-safety.outputs.previous-revision': '',
    'steps.release-kind.outputs.kind': 'deploy',
    'steps.release-kind.outputs.release': '',
    'steps.actual-release.outputs.tag': RELEASE,
    'steps.actual-release.outputs.tag || needs.lookup.outputs.release-tag': RELEASE,
    'job.status': 'failure'
  }
}

const PRODUCTION_JOBS = [
  ['promote', 'promote-gcp'],
  ['promote', 'promote-aws'],
  ['rollback', 'rollback-gcp'],
  ['rollback', 'rollback-aws']
]
const NAMING_STEPS = ['Record deployment in ledger', 'Notify Slack', 'Notify Slack (failure)']

describe.each(PRODUCTION_JOBS)('%s: %s names the requester', (workflowName, jobId) => {
  const workflow = workflows[workflowName]
  const job = workflow.jobs[jobId]
  const step = (name) => findStep(workflow, jobId, name)
  const verb = workflowName === 'promote' ? 'promote' : 'rollback'

  it('reads the requester from the check that runs first in the job, and only through env', () => {
    const check = job.steps[1]
    expect(check.uses).toBe(ACTION)
    expect(check.id).toBe('authz')
    for (const name of NAMING_STEPS) {
      expect(step(name).step.env.REQUESTER, name).toBe('${{ steps.authz.outputs.requester }}')
      expect(step(name).step.run, name).not.toContain('steps.authz')
    }
    expect(step('Record deployment in ledger').step.env.REQUEST_ID).toBe('${{ steps.authz.outputs.request-id }}')
    if (workflowName === 'promote') {
      const release = step('Publish GitHub Release on the app repo').step
      expect(release.env.PASSED_AS).toBe('${{ steps.authz.outputs.passed-as }}')
      expect(release.env.REQUESTER).toBe('${{ steps.authz.outputs.requester }}')
      expect(release.run).not.toContain('steps.authz')
      // The full address never reaches the payload, only the part before
      // the @.
      expect(release.run).toContain('--arg requestername "${REQUESTER%%@*}"')
      expect(release.run.match(/\$REQUESTER\b|\$\{REQUESTER\b/g)).toEqual(['${REQUESTER'])
    }
  })

  // Flightdeck takes only a GitHub login as a release event's actor, so the
  // event names the account that started the attempt, as it always has.
  it('leaves the Flightdeck release event naming the account that started the attempt', () => {
    expect(step('Record release event in Flightdeck').step.with.actor).toBe('${{ github.triggering_actor }}')
  })

  it('writes the requester as both accounts on the ledger row, and the bot otherwise', async () => {
    const gate = await runShellStep(step('Record deployment in ledger'), { context: namingContext(REQUESTER) })
    expect(gate.status, gate.stderr).toBe(0)
    expect(gate.putItem.item.Actor).toEqual({ S: REQUESTER })
    expect(gate.putItem.item.TriggeringActor).toEqual({ S: REQUESTER })
    expect(gate.putItem.item.GateRequestId).toEqual({ S: 'req-0042' })

    const plain = await runShellStep(step('Record deployment in ledger'), { context: namingContext('') })
    expect(plain.putItem.item.Actor).toEqual({ S: GATE })
    expect(plain.putItem.item.TriggeringActor).toEqual({ S: GATE })
    expect(plain.putItem.item).not.toHaveProperty('GateRequestId')
  })

  it('names the requester in the Slack notice', async () => {
    const result = await runShellStep(step('Notify Slack'), { context: namingContext(REQUESTER) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.slack.text).toContain(`* by ${REQUESTER} through the deploy gate`)
    expect(result.slack.text).not.toContain(GATE)
  })

  it('names the requester in the failure notice', async () => {
    const result = await runShellStep(step('Notify Slack (failure)'), { context: namingContext(REQUESTER) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.slack.text).toMatch(new RegExp(`^:x: \\*${PROJECT} ${verb}.* FAILED\\* by ${REQUESTER} through the deploy gate\\n${RUN_URL}$`))
  })

  // Slack reads <...> as a link and & as the start of an entity, so an
  // address holding them is escaped rather than turned into a link.
  it('escapes what Slack would read as markup in the address', async () => {
    const odd = 'a<b>&c@example.com'
    for (const name of ['Notify Slack', 'Notify Slack (failure)']) {
      const result = await runShellStep(step(name), { context: namingContext(odd) })
      expect(result.slack.text, name).toContain('by a&lt;b&gt;&amp;c@example.com through the deploy gate')
    }
  })
})

describe.each(['promote-gcp', 'promote-aws'])('promote: %s GitHub Release', (jobId) => {
  const release = (requester) => runShellStep(findStep(workflows.promote, jobId, 'Publish GitHub Release on the app repo'), { context: namingContext(requester) })

  const firstLine = (result) => result.release.body.split('\n')[0]

  // Many app repos are public, so the Release names the requester by the part
  // of their email before the @, and leaves the full address to Slack and the
  // ledger.
  it('names the requester by the part of their email before the @', async () => {
    const result = await release(REQUESTER)
    expect(result.status, result.stderr).toBe(0)
    expect(result.release.body).toMatch(/^Promoted to production by <code>requester<\/code> through the deploy gate\.\n\n/)
    expect(JSON.stringify(result.release)).not.toContain('example.com')
    expect(JSON.stringify(result.release)).not.toContain('@')
  })

  it('names the account as before when no requester is set', async () => {
    const result = await release('')
    expect(result.release.body).toMatch(new RegExp(`^Promoted to production by @${GATE.replace(/[[\]]/g, '\\$&')}\\.\\n\\n`))
  })

  // A gate pass with no requester (an action bundle from before the output),
  // or one whose part before the @ is empty, names no one, as before.
  it.each(['', '@example.com'])('says only that it went through the deploy gate for a requester of %j', async (requester) => {
    const result = await runShellStep(findStep(workflows.promote, jobId, 'Publish GitHub Release on the app repo'), {
      context: { ...namingContext(requester), 'steps.authz.outputs.passed-as': 'gate' }
    })
    expect(result.status, result.stderr).toBe(0)
    expect(firstLine(result)).toBe('Promoted to production through the deploy gate.')
  })

  // The check refuses a sub that is not one address with one @, so these
  // only show what the step does if one ever got through: the least that
  // could identify the person, and never an @ that GitHub would read as a
  // mention.
  it.each([
    ['no @, shown whole', 'requester', 'requester'],
    ['more than one @, cut at the first', 'requester@example.com@example.org', 'requester'],
    ['a trailing @', 'requester@', 'requester']
  ])('names a requester with %s', async (_why, requester, name) => {
    const result = await release(requester)
    expect(result.status, result.stderr).toBe(0)
    expect(firstLine(result)).toBe(`Promoted to production by <code>${name}</code> through the deploy gate.`)
  })

  // The body is Markdown. Each ASCII punctuation mark is backslash-escaped,
  // which Markdown shows as the mark itself, so no link, HTML or emphasis can
  // come from the name, and a < can never close the <code> around it. The
  // <code> keeps GitHub's own extras (#1 issue links, :smile: emoji, $math$)
  // off it, which the escapes alone do not. Checked against GitHub's Markdown
  // renderer when this was written; these tests pin the text sent.
  it('escapes everything Markdown or HTML would read in the name', async () => {
    const result = await release('a<b>&c*d_e`f[g](h)!i~j|k\\l#m@example.com')
    expect(result.status, result.stderr).toBe(0)
    expect(firstLine(result)).toBe('Promoted to production by <code>a\\<b\\>\\&c\\*d\\_e\\`f\\[g\\]\\(h\\)\\!i\\~j\\|k\\\\l\\#m</code> through the deploy gate.')
  })

  it.each([
    ['an issue reference', '#1', '\\#1'],
    ['a cross-repo issue reference', 'example-org/example-app#1', 'example\\-org\\/example\\-app\\#1'],
    ['an emoji shortcode', ':smile:', '\\:smile\\:'],
    ['math', '$x^2$', '\\$x\\^2\\$'],
    ['a closing tag', 'x</code><b>y', 'x\\<\\/code\\>\\<b\\>y'],
    ['a www. link', 'www.example.com', 'www\\.example\\.com'],
    ['first.last, whose dot GitHub shows as a dot', 'first.last', 'first\\.last']
  ])('keeps %s in the name inside <code>, escaped', async (_why, name, sent) => {
    const result = await release(`${name}@example.com`)
    expect(firstLine(result)).toBe(`Promoted to production by <code>${sent}</code> through the deploy gate.`)
  })

  it('keeps a name that is not ASCII as it is', async () => {
    const result = await release('zoë@example.com')
    expect(firstLine(result)).toBe('Promoted to production by <code>zoë</code> through the deploy gate.')
  })
})
