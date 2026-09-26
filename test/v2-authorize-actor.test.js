import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'

// Mocked octokit + @actions/core. `inputs` backs getInput; the octokit calls
// are per-test mocks so each case says exactly what GitHub answers.
const { getByUsername, getCollaboratorPermissionLevel, core, inputs, tokens } = vi.hoisted(() => ({
  getByUsername: vi.fn(),
  getCollaboratorPermissionLevel: vi.fn(),
  core: {
    notice: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    setFailed: vi.fn()
  },
  inputs: {},
  tokens: []
}))

vi.mock('@actions/github', () => ({
  getOctokit: (token) => {
    tokens.push(token)
    return { rest: { users: { getByUsername }, repos: { getCollaboratorPermissionLevel } } }
  }
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  notice: core.notice,
  warning: core.warning,
  info: core.info,
  setFailed: core.setFailed
}))

import { authorize, parseActorIds, parseRepo, run, ALLOWED_PERMISSIONS } from '../src/authorize-actor.js'

const noSleep = async () => {}
const BOT = 'release-helper[bot]'
const BOT_ID = '41000001'

const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status })
const permission = (value) => ({ data: { permission: value } })
const user = (id) => ({ data: { id } })

// Permissions by login, as GitHub would answer for the app repo.
function grant (map) {
  getCollaboratorPermissionLevel.mockImplementation(async ({ username }) => {
    if (!(username in map)) throw httpError(404, `${username} is not a user`)
    return permission(map[username])
  })
}

function env ({ actor, actorId = '1001', triggeringActor = actor, runAttempt = '1' }) {
  return {
    GITHUB_ACTOR: actor,
    GITHUB_ACTOR_ID: actorId,
    GITHUB_TRIGGERING_ACTOR: triggeringActor,
    GITHUB_RUN_ATTEMPT: runAttempt
  }
}

const failure = () => core.setFailed.mock.calls[0]?.[0]

beforeEach(() => {
  getByUsername.mockReset()
  getCollaboratorPermissionLevel.mockReset()
  for (const fn of Object.values(core)) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
  tokens.length = 0
})

describe('parseActorIds', () => {
  it('keeps whole numeric entries and trims whitespace', () => {
    expect(parseActorIds(' 12 ,34\n 56 \r\n,,')).toEqual({ ids: ['12', '34', '56'], ignored: [] })
  })

  it('returns junk entries separately so they never match', () => {
    expect(parseActorIds('12, bot[bot], 1e3, -5, 7 8')).toEqual({ ids: ['12'], ignored: ['bot[bot]', '1e3', '-5', '7 8'] })
  })

  it('treats empty, blank or missing input as no ids', () => {
    for (const raw of ['', '   ', '\n', undefined, null]) {
      expect(parseActorIds(raw)).toEqual({ ids: [], ignored: [] })
    }
  })
})

describe('parseRepo', () => {
  it('splits an owner/name slug', () => {
    expect(parseRepo('CruGlobal/some-app')).toEqual({ owner: 'CruGlobal', repo: 'some-app' })
  })

  it.each(['', 'some-app', 'a/b/c', '/some-app', 'CruGlobal/', undefined])('refuses %j', (slug) => {
    expect(() => parseRepo(slug)).toThrow(/owner\/name/)
  })
})

describe('authorize: push access', () => {
  const base = { repository: 'CruGlobal/some-app', operation: 'promote', sleep: noSleep }
  const octokit = { rest: { users: { getByUsername }, repos: { getCollaboratorPermissionLevel } } }

  it.each(ALLOWED_PERMISSIONS)('lets a first attempt by an account with %s through', async (level) => {
    grant({ alice: level })
    await expect(authorize({ ...base, octokit, actor: 'alice', actorId: '1001', triggeringActor: 'alice', runAttempt: '1' }))
      .resolves.toBe('push-access')
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledWith({ owner: 'CruGlobal', repo: 'some-app', username: 'alice' })
    expect(getByUsername).not.toHaveBeenCalled()
  })

  it.each(['read', 'triage', 'none'])('refuses an account with %s', async (level) => {
    grant({ alice: level })
    await expect(authorize({ ...base, octokit, actor: 'alice', actorId: '1001', triggeringActor: 'alice', runAttempt: '1' }))
      .rejects.toThrow(`alice is not authorized to promote CruGlobal/some-app (permission: ${level})`)
  })

  it('checks the account that pressed re-run, not the one that started the run', async () => {
    // alice could promote; mallory, who pressed re-run, cannot.
    grant({ alice: 'admin', mallory: 'read' })
    const refusal = authorize({ ...base, octokit, actor: 'alice', actorId: '1001', triggeringActor: 'mallory', runAttempt: '2' })
    await expect(refusal).rejects.toThrow(
      'mallory is not authorized to promote CruGlobal/some-app (permission: read). Requires admin, write, or maintain. ' +
      'The account checked is mallory, the one that started this run attempt (attempt 2); the run was first started by alice.'
    )
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1)
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledWith(expect.objectContaining({ username: 'mallory' }))
  })

  it('lets a re-run by another account with push access through, and names both accounts', async () => {
    grant({ alice: 'read', bob: 'write' })
    await expect(authorize({ ...base, octokit, actor: 'alice', actorId: '1001', triggeringActor: 'bob', runAttempt: '3' }))
      .resolves.toBe('push-access')
    expect(core.notice).toHaveBeenCalledWith(
      "bob has 'write' on CruGlobal/some-app. bob is the account that started this run attempt (attempt 3); the run was first started by alice."
    )
  })

  it('refuses when the runner gives no triggering account', async () => {
    grant({ alice: 'admin' })
    await expect(authorize({ ...base, octokit, actor: 'alice', actorId: '1001', triggeringActor: '', runAttempt: '1' }))
      .rejects.toThrow(/GITHUB_TRIGGERING_ACTOR is empty.*refusing to promote/)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('refuses a repository that is not owner/name before calling GitHub', async () => {
    await expect(authorize({ ...base, octokit, repository: '', actor: 'alice', actorId: '1001', triggeringActor: 'alice' }))
      .rejects.toThrow(/owner\/name/)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })
})

describe('authorize: fails closed on a bad permission answer', () => {
  const base = { repository: 'CruGlobal/some-app', operation: 'roll back', actor: 'alice', actorId: '1001', triggeringActor: 'alice', runAttempt: '1' }
  const octokit = { rest: { users: { getByUsername }, repos: { getCollaboratorPermissionLevel } } }

  it.each([401, 403, 404, 422])('refuses on HTTP %i without retrying', async (status) => {
    getCollaboratorPermissionLevel.mockRejectedValue(httpError(status))
    const sleep = vi.fn(noSleep)
    await expect(authorize({ ...base, octokit, sleep }))
      .rejects.toThrow(`could not read the permission of alice on CruGlobal/some-app (HTTP ${status}: HTTP ${status}), so alice, the account that started this run attempt (attempt 1), cannot be checked; refusing to roll back CruGlobal/some-app`)
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('refuses when a server error does not clear after three tries', async () => {
    getCollaboratorPermissionLevel.mockRejectedValue(httpError(502))
    await expect(authorize({ ...base, octokit, sleep: noSleep })).rejects.toThrow(/refusing to roll back CruGlobal\/some-app/)
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledTimes(3)
  })

  it('refuses when the request never gets an answer', async () => {
    getCollaboratorPermissionLevel.mockRejectedValue(new Error('socket hang up'))
    await expect(authorize({ ...base, octokit, sleep: noSleep })).rejects.toThrow(/socket hang up.*refusing to roll back/)
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledTimes(3)
  })

  it('goes ahead when a server error clears on a retry', async () => {
    getCollaboratorPermissionLevel.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(permission('admin'))
    await expect(authorize({ ...base, octokit, sleep: noSleep })).resolves.toBe('push-access')
  })

  it.each([
    ['no data', {}],
    ['no permission field', { data: {} }],
    ['an empty permission', { data: { permission: '' } }],
    ['a non-string permission', { data: { permission: { admin: true } } }]
  ])('refuses a response with %s', async (_label, response) => {
    getCollaboratorPermissionLevel.mockResolvedValue(response)
    await expect(authorize({ ...base, octokit, sleep: noSleep })).rejects.toThrow(/did not return a permission, so alice, the account that started this run attempt \(attempt 1\), cannot be checked; refusing to roll back/)
  })
})

describe('authorize: automation allowlist', () => {
  const base = { repository: 'CruGlobal/some-app', operation: 'roll back', sleep: noSleep }
  const octokit = { rest: { users: { getByUsername }, repos: { getCollaboratorPermissionLevel } } }

  it('lets an allowlisted bot through when it started the run and this attempt', async () => {
    getByUsername.mockResolvedValue(user(Number(BOT_ID)))
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, runAttempt: '1', trustedActorIds: BOT_ID }))
      .resolves.toBe('automation')
    expect(getByUsername).toHaveBeenCalledWith({ username: BOT })
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('also lets it through on a re-run the bot started itself', async () => {
    getByUsername.mockResolvedValue(user(Number(BOT_ID)))
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, runAttempt: '2', trustedActorIds: `99, ${BOT_ID}` }))
      .resolves.toBe('automation')
  })

  it('checks the human who re-runs a bot-started rollback, and refuses one without push access', async () => {
    grant({ mallory: 'read' })
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: BOT_ID, triggeringActor: 'mallory', runAttempt: '2', trustedActorIds: BOT_ID }))
      .rejects.toThrow(/mallory is not authorized to roll back CruGlobal\/some-app \(permission: read\).*the one that started this run attempt \(attempt 2\); the run was first started by release-helper\[bot\]/)
    expect(getByUsername).not.toHaveBeenCalled()
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining("so mallory's own access on CruGlobal/some-app is checked"))
  })

  it('lets a human with push access re-run a bot-started rollback', async () => {
    grant({ bob: 'maintain' })
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: BOT_ID, triggeringActor: 'bob', runAttempt: '2', trustedActorIds: BOT_ID }))
      .resolves.toBe('push-access')
  })

  it('does not match a login that now belongs to a different user id', async () => {
    // The login that started the run was renamed away and then taken by
    // someone else, who pressed re-run. Same login, different account.
    getByUsername.mockResolvedValue(user(50000002))
    grant({ 'ops-robot': 'none' })
    await expect(authorize({ ...base, octokit, actor: 'ops-robot', actorId: '50000001', triggeringActor: 'ops-robot', runAttempt: '2', trustedActorIds: '50000001' }))
      .rejects.toThrow(/ops-robot is not authorized to roll back/)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('now belongs to user id 50000002, not the allowlisted user id 50000001'))
  })

  it.each([
    ['an HTTP error', () => getByUsername.mockRejectedValue(httpError(404))],
    ['a server error that does not clear', () => getByUsername.mockRejectedValue(httpError(500))],
    ['a response with no id', () => getByUsername.mockResolvedValue({ data: {} })]
  ])('refuses the bot when its user id lookup gives %s', async (_label, arrange) => {
    arrange()
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, runAttempt: '1', trustedActorIds: BOT_ID }))
      .rejects.toThrow(/cannot be matched to the automation allowlist; refusing to roll back/)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  it('compares ids as whole strings, so 12 never matches 123', async () => {
    grant({})
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: '123', triggeringActor: BOT, runAttempt: '1', trustedActorIds: '12, 1234' }))
      .rejects.toThrow(/could not read the permission of release-helper\[bot\]/)
    expect(getByUsername).not.toHaveBeenCalled()
  })

  it('warns about and ignores entries that are not numbers', async () => {
    grant({})
    await expect(authorize({ ...base, octokit, actor: BOT, actorId: BOT_ID, triggeringActor: BOT, runAttempt: '1', trustedActorIds: BOT }))
      .rejects.toThrow(/could not read the permission/)
    expect(core.warning).toHaveBeenCalledWith(`ignoring trusted-automation-actor-ids entry '${BOT}' (not a numeric user id)`)
  })

  it('ignores the allowlist when no list is given, as promote does', async () => {
    grant({})
    await expect(authorize({ ...base, octokit, operation: 'promote', actor: BOT, actorId: BOT_ID, triggeringActor: BOT, runAttempt: '1' }))
      .rejects.toThrow(/could not read the permission of release-helper\[bot\].*refusing to promote/)
    expect(getByUsername).not.toHaveBeenCalled()
  })
})

describe('run', () => {
  it('reads the accounts from the runner environment and the token from inputs', async () => {
    Object.assign(inputs, { 'github-token': 'tok', repository: 'CruGlobal/some-app', operation: 'promote' })
    grant({ alice: 'admin', mallory: 'read' })
    await run({ env: env({ actor: 'alice', triggeringActor: 'mallory', runAttempt: '2' }), sleep: noSleep })
    expect(tokens).toEqual(['tok'])
    expect(failure()).toMatch(/^mallory is not authorized to promote CruGlobal\/some-app/)
  })

  it('passes a first attempt by an authorized account', async () => {
    Object.assign(inputs, { 'github-token': 'tok', repository: 'CruGlobal/some-app', operation: 'promote' })
    grant({ alice: 'write' })
    await run({ env: env({ actor: 'alice' }), sleep: noSleep })
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('refuses when no token is given', async () => {
    Object.assign(inputs, { repository: 'CruGlobal/some-app', operation: 'roll back' })
    await run({ env: env({ actor: 'alice' }), sleep: noSleep })
    expect(failure()).toMatch(/no github-token was given.*refusing to roll back/)
    expect(tokens).toEqual([])
  })

  it('refuses, and never throws, on an unexpected error', async () => {
    Object.assign(inputs, { 'github-token': 'tok', repository: 'CruGlobal/some-app', operation: 'promote' })
    getCollaboratorPermissionLevel.mockImplementation(() => { throw new TypeError('boom') })
    await expect(run({ env: env({ actor: 'alice' }), sleep: noSleep })).resolves.toBeUndefined()
    expect(failure()).toMatch(/boom.*refusing/)
  })
})

// ---------------------------------------------------------------------------
// Workflow wiring. These read the real workflow files, so a job that can
// change production cannot lose its check without a test failing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (file) => yaml.load(readFileSync(path.join(root, file), 'utf8'))
const ACTION = './cru-github-actions/actions/authorize-actor'
const actionYml = load('actions/authorize-actor/action.yml')

const workflows = {
  promote: { file: '.github/workflows/promote.yml', operation: 'promote', allowlist: false },
  rollback: { file: '.github/workflows/rollback.yml', operation: 'roll back', allowlist: true }
}

const isCheckout = (step) =>
  step.uses === 'actions/checkout@v7' &&
  step.with?.repository === 'CruGlobal/.github' &&
  step.with?.ref === '${{ inputs.workflow-ref }}' &&
  step.with?.path === 'cru-github-actions'

// Stand-in for the runner: resolve the few expressions an authz step uses.
function resolve (value, context) {
  return String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    if (!(expr in context)) throw new Error(`test does not know how to resolve ${expr}`)
    return context[expr]
  })
}

// Run one workflow step's authz action, with the inputs the workflow gives it.
async function runStep (step, context, runnerEnv) {
  for (const key of Object.keys(inputs)) delete inputs[key]
  for (const [name, value] of Object.entries(step.with)) inputs[name] = resolve(value, context)
  await run({ env: runnerEnv, sleep: noSleep })
}

describe.each(Object.entries(workflows))('%s workflow wiring', (_name, { file, operation, allowlist }) => {
  const workflow = load(file)
  const jobs = Object.entries(workflow.jobs)
  const productionJobs = jobs.filter(([id]) => id !== 'lookup')

  it('has a lookup job and at least one production job', () => {
    expect(workflow.jobs.lookup).toBeDefined()
    expect(productionJobs.length).toBeGreaterThanOrEqual(2)
  })

  it('checks the attempt in lookup with the shared action', () => {
    const steps = workflow.jobs.lookup.steps
    const index = steps.findIndex((step) => step.name === 'Authorize actor')
    expect(index).toBeGreaterThan(0)
    const step = steps[index]
    expect(step.uses).toBe(ACTION)
    expect(step.run).toBeUndefined()
    expect(steps.slice(0, index).some(isCheckout)).toBe(true)
    expect(step.with['github-token']).toBe('${{ secrets.authz-token }}')
    expect(step.with.operation).toBe(operation)
    expect(workflow.jobs.lookup.permissions).toMatchObject({ contents: 'read' })
  })

  it.each(productionJobs.map(([id]) => id))('%s runs the check first, inside the production lock', (id) => {
    const job = workflow.jobs[id]
    expect(job.needs).toBe('lookup')
    expect(job.concurrency?.group).toBe('production-${{ inputs.project-name }}')
    expect(job.permissions).toMatchObject({ contents: 'read' })

    // Nothing but the checkout of this repo comes before the check.
    const [checkout, check] = job.steps
    expect(isCheckout(checkout)).toBe(true)
    expect(checkout.with.token).toBeUndefined()
    expect(check.uses).toBe(ACTION)
    expect(check.if).toBeUndefined()
    expect(check['continue-on-error']).toBeUndefined()
    expect(check.with['github-token']).toBe('${{ secrets.authz-token }}')
    expect(check.with.repository).toBe('${{ needs.lookup.outputs.repository }}')
    expect(check.with.operation).toBe(operation)
    if (allowlist) {
      expect(check.with['trusted-automation-actor-ids']).toBe('${{ inputs.trusted-automation-actor-ids }}')
    } else {
      expect(check.with['trusted-automation-actor-ids']).toBeUndefined()
    }
  })

  it('passes only inputs the action declares, and every required one', () => {
    const declared = actionYml.inputs
    const required = Object.entries(declared).filter(([, spec]) => spec.required).map(([name]) => name)
    const steps = jobs.flatMap(([, job]) => job.steps).filter((step) => step.uses === ACTION)
    expect(steps).toHaveLength(productionJobs.length + 1)
    for (const step of steps) {
      for (const name of Object.keys(step.with)) expect(declared).toHaveProperty(name)
      for (const name of required) expect(step.with).toHaveProperty(name)
    }
  })

  // "Re-run failed jobs": only the production job runs. lookup is not run
  // again; its earlier outputs are reused. The job's own check must refuse.
  it.each(productionJobs.map(([id]) => id))('%s refuses a failed-jobs re-run by an account without push access', async (id) => {
    const check = workflow.jobs[id].steps[1]
    grant({ alice: 'admin', mallory: 'read' })
    await runStep(check, {
      'secrets.authz-token': 'tok',
      'needs.lookup.outputs.repository': 'CruGlobal/some-app',
      'inputs.trusted-automation-actor-ids': ''
    }, env({ actor: 'alice', triggeringActor: 'mallory', runAttempt: '2' }))
    expect(failure()).toMatch(new RegExp(`^mallory is not authorized to ${operation} CruGlobal/some-app`))
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledWith(expect.objectContaining({ username: 'mallory' }))
  })

  it.each(productionJobs.map(([id]) => id))('%s lets a failed-jobs re-run by an account with push access through', async (id) => {
    const check = workflow.jobs[id].steps[1]
    grant({ alice: 'read', bob: 'write' })
    await runStep(check, {
      'secrets.authz-token': 'tok',
      'needs.lookup.outputs.repository': 'CruGlobal/some-app',
      'inputs.trusted-automation-actor-ids': ''
    }, env({ actor: 'alice', triggeringActor: 'bob', runAttempt: '2' }))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  if (allowlist) {
    it.each(productionJobs.map(([id]) => id))('%s lets the allowlisted bot through, and refuses a human re-running its run', async (id) => {
      const check = workflow.jobs[id].steps[1]
      const context = {
        'secrets.authz-token': 'tok',
        'needs.lookup.outputs.repository': 'CruGlobal/some-app',
        'inputs.trusted-automation-actor-ids': BOT_ID
      }
      getByUsername.mockResolvedValue(user(Number(BOT_ID)))
      grant({ mallory: 'read' })

      await runStep(check, context, env({ actor: BOT, actorId: BOT_ID, triggeringActor: BOT, runAttempt: '1' }))
      expect(core.setFailed).not.toHaveBeenCalled()

      await runStep(check, context, env({ actor: BOT, actorId: BOT_ID, triggeringActor: 'mallory', runAttempt: '2' }))
      expect(failure()).toMatch(/^mallory is not authorized to roll back CruGlobal\/some-app/)
    })
  }
})

describe('authorize-actor action', () => {
  it('runs the bundle the build produces', () => {
    expect(actionYml.runs).toEqual({ using: 'node24', main: '../../dist/authorize-actor.js' })
    const config = readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8')
    expect(config).toContain("'./src/authorize-actor.js': 'authorize-actor'")
  })
})
