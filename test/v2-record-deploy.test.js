import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

// record-deploy: the run check (verify-deploy-run), the mark it leaves for the
// release event action, the previous-release read, and the workflow's own
// steps. @actions/core is mocked so exportVariable lands in `exported`, the
// way the runner hands it to later steps, and @actions/github hands out one
// fake client whose calls each test sets up. Nothing reaches GitHub,
// Flightdeck or AWS.
const { core, inputs, exported, octokit } = vi.hoisted(() => ({
  core: {
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn()
  },
  inputs: {},
  exported: {},
  octokit: {
    rest: {
      actions: { getWorkflowRun: vi.fn() },
      repos: { get: vi.fn(), compareCommitsWithBasehead: vi.fn() }
    }
  }
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  },
  ...core,
  exportVariable: (name, value) => { exported[name] = String(value) }
}))
vi.mock('@actions/github', () => ({ getOctokit: () => octokit }))

import { run as verify, verifyDeployRun, parseRequest, Refusal, DEPLOY_EVENTS, MAX_RUN_AGE_MS } from '../src/verify-deploy-run.js'
import { run as postReleaseEvent, previousReleaseEvent } from '../src/flightdeck-release-event.js'
import {
  AUTHORIZED_ATTEMPT_MARKER, VERIFIED_DEPLOY_RUN_MARKER, deployRunVerifiedFor, markDeployRunVerified
} from '../src/v2/attempt-guard.js'
import { loadYaml, findStep, runShellStep, removeFakes, resolveExpressions } from './support/workflow-steps.js'

const REPO = 'CruGlobal/example-app'
const SHA = 'c0ffee00000000000000000000000000000000aa'
const OTHER_SHA = 'deadbeef00000000000000000000000000000001'
const RUN_ID = '4242'
const PROJECT = 'EXAMPLE'
const APP = 'example-app'
const WORKFLOW = '.github/workflows/deploy.yml'
const NOW = Date.parse('2026-09-04T13:00:00Z')
const noSleep = () => Promise.resolve()

// The run GitHub returns: a push to main of SHA, still running, in the app's
// own repository, re-run 30 minutes ago by someone other than who first
// started it.
function workflowRun (overrides = {}) {
  return {
    id: 4242,
    run_number: 57,
    run_attempt: 2,
    event: 'push',
    status: 'in_progress',
    conclusion: null,
    path: WORKFLOW,
    head_sha: SHA,
    head_branch: 'main',
    created_at: '2026-09-04T11:50:00Z',
    run_started_at: '2026-09-04T12:30:00Z',
    updated_at: '2026-09-04T12:34:56Z',
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    actor: { login: 'first-starter' },
    triggering_actor: { login: 'octo-dev' },
    ...overrides
  }
}
const answer = (data) => ({ data })
const httpError = (status) => Object.assign(new Error(`status ${status}`), { status })

function theRunIs (run) {
  octokit.rest.actions.getWorkflowRun.mockResolvedValue(answer(run))
}
function compareSays (status, behindBy = 0) {
  octokit.rest.repos.get.mockResolvedValue(answer({ default_branch: 'main' }))
  octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue(answer({ status, behind_by: behindBy, ahead_by: 3 }))
}

const check = (overrides = {}) => verifyDeployRun({
  octokit, repository: REPO, runId: RUN_ID, sha: SHA, environment: 'production', project: PROJECT, app: APP, deployWorkflow: WORKFLOW, now: NOW, sleep: noSleep, ...overrides
})

const output = (name) => core.setOutput.mock.calls.filter(([key]) => key === name).pop()?.[1]
const mark = (deploy, attempt = '1') => JSON.stringify([attempt, deploy.project, deploy.app, deploy.environment, deploy.sha])
const DEPLOY = { project: PROJECT, app: APP, environment: 'production', sha: SHA }

beforeEach(() => {
  for (const fn of [...Object.values(core), octokit.rest.actions.getWorkflowRun, octokit.rest.repos.get, octokit.rest.repos.compareCommitsWithBasehead]) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
  for (const key of Object.keys(exported)) delete exported[key]
  theRunIs(workflowRun())
  compareSays('ahead')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
  vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '')
  vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, '')
  vi.unstubAllGlobals()
})

afterEach(() => vi.unstubAllEnvs())
afterAll(removeFakes)

describe('verifyDeployRun: passes', () => {
  it('passes a running push of the sha, from the pinned workflow, on the default branch, for production', async () => {
    const result = await check()
    expect(result).toMatchObject({
      repository: REPO,
      sha: SHA,
      environment: 'production',
      project: PROJECT,
      app: APP,
      actor: 'octo-dev',
      runUrl: `https://github.com/${REPO}/actions/runs/4242/attempts/2`,
      deployedAt: '',
      event: 'push',
      workflowPath: WORKFLOW,
      pinned: true,
      releaseTag: 'deploy-2026-09-04-57',
      buildNumber: '57',
      defaultBranch: 'main'
    })
    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ owner: 'CruGlobal', repo: 'example-app', run_id: RUN_ID }))
    expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({ basehead: `${SHA}...main` }))
  })

  it.each(DEPLOY_EVENTS)('passes a %s run', async (event) => {
    theRunIs(workflowRun({ event }))
    await expect(check()).resolves.toMatchObject({ event })
  })

  it('accepts push, manual dispatch, schedule and release, and nothing else', () => {
    expect([...DEPLOY_EVENTS]).toEqual(['push', 'workflow_dispatch', 'schedule', 'release'])
  })

  it('passes a commit the default branch is identical to', async () => {
    compareSays('identical')
    await expect(check()).resolves.toMatchObject({ sha: SHA })
  })

  it('passes a run that finished successfully, and takes when it finished as the deploy time', async () => {
    theRunIs(workflowRun({ status: 'completed', conclusion: 'success' }))
    expect((await check()).deployedAt).toBe('2026-09-04T12:34:56Z')
  })

  it('passes a run whose latest attempt started just inside the window', async () => {
    theRunIs(workflowRun({ run_started_at: new Date(NOW - MAX_RUN_AGE_MS + 1000).toISOString() }))
    await expect(check()).resolves.toMatchObject({ sha: SHA })
    expect(MAX_RUN_AGE_MS).toBe(6 * 60 * 60 * 1000)
  })

  it('does not ask about the default branch for staging, so a branch deploy passes', async () => {
    theRunIs(workflowRun({ head_branch: 'feature/x' }))
    await expect(check({ environment: 'staging' })).resolves.toMatchObject({ environment: 'staging', defaultBranch: '' })
    expect(octokit.rest.repos.get).not.toHaveBeenCalled()
    expect(octokit.rest.repos.compareCommitsWithBasehead).not.toHaveBeenCalled()
  })

  it('accepts a run of any workflow when none is pinned, and says so', async () => {
    theRunIs(workflowRun({ path: '.github/workflows/lint.yml' }))
    await expect(check({ deployWorkflow: '' })).resolves.toMatchObject({ pinned: false, workflowPath: '.github/workflows/lint.yml' })
  })

  it('reads the workflow file without a ref GitHub adds to the path', async () => {
    theRunIs(workflowRun({ path: `${WORKFLOW}@refs/heads/main` }))
    await expect(check()).resolves.toMatchObject({ workflowPath: WORKFLOW })
  })

  it('dates the tag by when the run was created, in UTC, and keeps it on a re-run', async () => {
    theRunIs(workflowRun({ created_at: '2026-09-03T23:59:59-04:00', run_attempt: 3, run_started_at: '2026-09-04T12:59:00Z' }))
    expect(await check()).toMatchObject({ releaseTag: 'deploy-2026-09-04-57', buildNumber: '57' })
  })

  it('reads names without regard to case, and the sha in either case', async () => {
    theRunIs(workflowRun({ repository: { full_name: 'cruglobal/Example-App' }, head_repository: { full_name: 'CRUGLOBAL/example-app' } }))
    const result = await check({ sha: SHA.toUpperCase(), environment: ' Production ' })
    expect(result).toMatchObject({ sha: SHA, environment: 'production' })
    expect(result.runUrl).toBe('https://github.com/cruglobal/Example-App/actions/runs/4242/attempts/2')
  })

  it('falls back to the first starter, and to the run page without an attempt', async () => {
    theRunIs(workflowRun({ triggering_actor: null, run_attempt: undefined }))
    expect(await check()).toMatchObject({ actor: 'first-starter', runUrl: `https://github.com/${REPO}/actions/runs/4242` })
  })
})

describe('verifyDeployRun: refuses', () => {
  it.each(['pull_request', 'pull_request_target', 'pull_request_review'])('a %s run', async (event) => {
    theRunIs(workflowRun({ event }))
    await expect(check()).rejects.toThrow(/was started by a pull request; only a push, a manual dispatch/)
    await expect(check({ environment: 'staging' })).rejects.toThrow(Refusal)
  })

  it.each(['workflow_run', 'repository_dispatch', 'merge_group', undefined])('a run started by %s', async (event) => {
    theRunIs(workflowRun({ event }))
    await expect(check()).rejects.toThrow(/only a push, a manual dispatch \(workflow_dispatch\), a schedule or a release can record a deploy/)
  })

  it('a release run of a production commit that is not on the default branch', async () => {
    theRunIs(workflowRun({ event: 'release', head_branch: 'v1.2.3' }))
    compareSays('diverged', 1)
    await expect(check()).rejects.toThrow(/is not on CruGlobal\/example-app's default branch main/)
  })

  it('a run whose head commit is not the sha', async () => {
    theRunIs(workflowRun({ head_sha: OTHER_SHA }))
    await expect(check()).rejects.toThrow(`run 4242 of ${REPO} ran commit ${OTHER_SHA}, not ${SHA}`)
    await expect(check({ environment: 'staging' })).rejects.toThrow(Refusal)
  })

  it.each([
    ['queued', null, /is queued/],
    ['waiting', null, /is waiting/],
    ['completed', 'failure', /finished with conclusion failure/],
    ['completed', 'cancelled', /finished with conclusion cancelled/],
    ['completed', 'skipped', /finished with conclusion skipped/],
    ['completed', null, /finished with conclusion none/],
    [undefined, null, /is in an unknown state/]
  ])('a run that is %s with conclusion %s', async (status, conclusion, why) => {
    theRunIs(workflowRun({ status, conclusion }))
    await expect(check()).rejects.toThrow(why)
    await expect(check()).rejects.toThrow(/only a run that is still going, or one that finished successfully, can record a deploy/)
  })

  it('a run whose latest attempt started more than six hours ago, so an old run cannot be replayed', async () => {
    theRunIs(workflowRun({ run_started_at: new Date(NOW - MAX_RUN_AGE_MS - 1000).toISOString() }))
    await expect(check()).rejects.toThrow(/more than 6 hours ago; only a recent run can record a deploy/)
    theRunIs(workflowRun({ run_started_at: '2025-01-01T00:00:00Z', status: 'completed', conclusion: 'success' }))
    await expect(check()).rejects.toThrow(/started its latest attempt at 2025-01-01T00:00:00Z/)
  })

  it('a run that does not say when it started', async () => {
    theRunIs(workflowRun({ run_started_at: undefined }))
    await expect(check()).rejects.toThrow(/did not say when run 4242 of CruGlobal\/example-app started/)
  })

  it('a run of another workflow than the pinned one', async () => {
    theRunIs(workflowRun({ path: '.github/workflows/lint.yml' }))
    await expect(check()).rejects.toThrow(`run 4242 of ${REPO} is a run of .github/workflows/lint.yml, not of ${WORKFLOW}, the deploy workflow app-info names`)
    theRunIs(workflowRun({ path: undefined }))
    await expect(check()).rejects.toThrow(/is a run of an unknown workflow/)
  })

  it('a run with no creation time or run number, since the deploy would have no tag', async () => {
    theRunIs(workflowRun({ run_number: undefined }))
    await expect(check()).rejects.toThrow(/did not give the creation time and run number/)
    theRunIs(workflowRun({ created_at: 'not a time' }))
    await expect(check()).rejects.toThrow(/did not give the creation time and run number/)
  })

  it.each([['diverged', 2], ['behind', 1], ['ahead', 1], [undefined, undefined]])('a production sha the default branch compares as %s', async (status, behindBy) => {
    compareSays(status, behindBy)
    await expect(check()).rejects.toThrow(/is not on CruGlobal\/example-app's default branch main/)
  })

  it('a production sha GitHub does not know', async () => {
    octokit.rest.repos.compareCommitsWithBasehead.mockRejectedValue(httpError(404))
    await expect(check()).rejects.toThrow(/could not check that .* is on CruGlobal\/example-app's default branch main \(HTTP 404/)
  })

  it('a repository with no default branch', async () => {
    octokit.rest.repos.get.mockResolvedValue(answer({}))
    await expect(check()).rejects.toThrow(/did not say what the default branch/)
  })

  it('a run that does not exist, or that the token cannot see', async () => {
    octokit.rest.actions.getWorkflowRun.mockRejectedValue(httpError(404))
    await expect(check()).rejects.toThrow(`there is no run 4242 in ${REPO}, or the token cannot read it`)
  })

  it('a run in another repository', async () => {
    theRunIs(workflowRun({ repository: { full_name: 'CruGlobal/other-app' } }))
    await expect(check()).rejects.toThrow(`run 4242 belongs to CruGlobal/other-app, not to ${REPO}`)
  })

  it('a run of code from a fork', async () => {
    theRunIs(workflowRun({ head_repository: { full_name: 'someone/example-app' } }))
    await expect(check()).rejects.toThrow(`run 4242 ran code from someone/example-app, not from ${REPO} itself`)
  })

  it('an answer with no run in it', async () => {
    octokit.rest.actions.getWorkflowRun.mockResolvedValue(answer(null))
    await expect(check()).rejects.toThrow(/returned no run/)
  })

  it('a 4xx without retrying it, and retries a 5xx before giving up', async () => {
    octokit.rest.actions.getWorkflowRun.mockRejectedValue(httpError(403))
    await expect(check()).rejects.toThrow(/could not read run 4242 of CruGlobal\/example-app \(HTTP 403/)
    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(1)

    octokit.rest.actions.getWorkflowRun.mockReset()
    octokit.rest.actions.getWorkflowRun.mockRejectedValue(httpError(502))
    await expect(check()).rejects.toThrow(/HTTP 502/)
    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(3)
  })

  it('passes once a 5xx clears', async () => {
    octokit.rest.actions.getWorkflowRun.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(answer(workflowRun()))
    await expect(check()).resolves.toMatchObject({ sha: SHA })
  })
})

describe('parseRequest', () => {
  const good = { repository: REPO, runId: RUN_ID, sha: SHA, environment: 'staging', project: PROJECT, app: APP, deployWorkflow: '' }

  it.each([
    ['environment', 'prod'], ['environment', 'lab'], ['environment', 'release-candidate'], ['environment', ''],
    ['sha', SHA.slice(0, 7)], ['sha', 'g'.repeat(40)], ['sha', `${SHA}\n`.repeat(2)], ['sha', ''],
    ['runId', 'abc'], ['runId', '0'], ['runId', '12 34'], ['runId', ''],
    ['repository', 'example-app'], ['repository', 'a/b/c'], ['repository', 'CruGlobal/'], ['repository', 'Cru Global/example-app'],
    ['project', ''], ['project', 'example'], ['project', 'TOOLONGPROJ'], ['project', 'EX\nAMPLE'],
    ['app', ''], ['app', 'example app'], ['app', '-example'], ['app', 'a'.repeat(101)],
    ['deployWorkflow', 'deploy.yml'], ['deployWorkflow', '.github/workflows/../x.yml'], ['deployWorkflow', '.github/workflows/deploy.json'], ['deployWorkflow', '.github/workflows/a/b.yml']
  ])('refuses %s %j before any call', (key, value) => {
    expect(() => parseRequest({ ...good, [key]: value })).toThrow(Refusal)
  })

  it('trims what it compares, and lowercases the sha and environment', () => {
    expect(parseRequest({ repository: ` ${REPO} `, runId: ' 4242 ', sha: ` ${SHA.toUpperCase()} `, environment: 'STAGING', project: ` ${PROJECT} `, app: ` ${APP} `, deployWorkflow: ` ${WORKFLOW} ` }))
      .toEqual({ owner: 'CruGlobal', repo: 'example-app', repository: REPO, runId: '4242', sha: SHA, environment: 'staging', project: PROJECT, app: APP, deployWorkflow: WORKFLOW })
  })
})

describe('verify-deploy-run action', () => {
  function actionInputs (overrides = {}) {
    Object.assign(inputs, {
      'github-token': 'gh-test', repository: REPO, 'run-id': RUN_ID, sha: SHA, environment: 'production', project: PROJECT, app: APP, 'deploy-workflow': WORKFLOW, ...overrides
    })
  }

  it('on a pass, outputs what record-deploy posts and marks the job for this attempt and deploy', async () => {
    actionInputs()
    theRunIs(workflowRun({ status: 'completed', conclusion: 'success' }))
    await verify({ sleep: noSleep, now: NOW })
    expect(output('verified')).toBe('true')
    expect(output('sha')).toBe(SHA)
    expect(output('environment')).toBe('production')
    expect(output('project')).toBe(PROJECT)
    expect(output('app')).toBe(APP)
    expect(output('actor')).toBe('octo-dev')
    expect(output('run-url')).toBe(`https://github.com/${REPO}/actions/runs/4242/attempts/2`)
    expect(output('deployed-at')).toBe('2026-09-04T12:34:56Z')
    expect(output('release-tag')).toBe('deploy-2026-09-04-57')
    expect(output('build-number')).toBe('57')
    expect(exported).toEqual({ [VERIFIED_DEPLOY_RUN_MARKER]: mark(DEPLOY) })
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('passes an unpinned app with a warning that its deploy workflow is not pinned', async () => {
    actionInputs({ 'deploy-workflow': '' })
    await verify({ sleep: noSleep, now: NOW })
    expect(output('verified')).toBe('true')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('app-info names no DeployWorkflow for example-app'), { title: 'Deploy workflow not pinned' })
  })

  it.each([
    ['a pull request run', () => theRunIs(workflowRun({ event: 'pull_request' })), /pull request/],
    ['a wrong sha', () => theRunIs(workflowRun({ head_sha: OTHER_SHA })), /not c0ffee/],
    ['a production sha off the default branch', () => compareSays('diverged', 2), /not on CruGlobal\/example-app's default branch/],
    ['a missing run', () => octokit.rest.actions.getWorkflowRun.mockRejectedValue(httpError(404)), /there is no run 4242/],
    ['a failed run', () => theRunIs(workflowRun({ status: 'completed', conclusion: 'failure' })), /finished with conclusion failure/],
    ['an old run', () => theRunIs(workflowRun({ run_started_at: '2026-09-03T01:00:00Z' })), /more than 6 hours ago/],
    ['a run of another workflow', () => theRunIs(workflowRun({ path: '.github/workflows/lint.yml' })), /not of \.github\/workflows\/deploy\.yml/]
  ])('on %s, warns, sets no mark and never fails the step', async (_label, arrange, why) => {
    actionInputs()
    arrange()
    await verify({ sleep: noSleep, now: NOW })
    expect(output('verified')).toBe('false')
    expect(output('reason')).toMatch(why)
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(why), { title: 'Deploy not recorded' })
    expect(exported).toEqual({})
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('refuses with no token, before any call', async () => {
    actionInputs({ 'github-token': '' })
    await verify({ sleep: noSleep, now: NOW })
    expect(output('verified')).toBe('false')
    expect(octokit.rest.actions.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('refuses when the runner gives no attempt number, since nothing can be marked', async () => {
    actionInputs()
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '')
    await verify({ sleep: noSleep, now: NOW })
    expect(output('verified')).toBe('false')
    expect(exported).toEqual({})
  })
})

describe('the verified-deploy-run mark', () => {
  it('counts only for its own attempt, project, app, environment and sha, compared exactly', () => {
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '3')
    markDeployRunVerified(DEPLOY)
    const env = { GITHUB_RUN_ATTEMPT: '3', [VERIFIED_DEPLOY_RUN_MARKER]: exported[VERIFIED_DEPLOY_RUN_MARKER] }
    expect(deployRunVerifiedFor(DEPLOY, env)).toBe(true)
    for (const other of [
      { project: 'OTHER' }, { app: 'other-app' }, { environment: 'staging' }, { sha: OTHER_SHA },
      { environment: 'Production' }, { sha: SHA.toUpperCase() }, { sha: ` ${SHA}` }, { sha: '' }, { app: undefined }
    ]) {
      expect(deployRunVerifiedFor({ ...DEPLOY, ...other }, env), JSON.stringify(other)).toBe(false)
    }
    expect(deployRunVerifiedFor(DEPLOY, { ...env, GITHUB_RUN_ATTEMPT: '4' })).toBe(false)
    expect(deployRunVerifiedFor(DEPLOY, { GITHUB_RUN_ATTEMPT: '3' })).toBe(false)
  })

  it('cannot be set without every part, so a separator cannot be borrowed between them', () => {
    expect(() => markDeployRunVerified({ ...DEPLOY, app: '' })).toThrow(/needs a project, an app, an environment and a sha/)
    expect(() => markDeployRunVerified({ ...DEPLOY, project: ' EXAMPLE' })).toThrow(/needs a project/)
    expect(mark(DEPLOY)).not.toBe(mark({ ...DEPLOY, project: 'EXAMPLE","example-app', app: 'production' }))
  })

  it('is not the authorized-attempt mark', () => {
    expect(VERIFIED_DEPLOY_RUN_MARKER).toBe('CRU_V2_VERIFIED_DEPLOY_RUN')
    expect(VERIFIED_DEPLOY_RUN_MARKER).not.toBe(AUTHORIZED_ATTEMPT_MARKER)
  })
})

// ---------------------------------------------------------------------------
// flightdeck-release-event with the mark, and the previous-release read.

function jsonResponse (status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body }
}
const projectsPage = (results) => jsonResponse(200, { results, meta: { page: 1, total_pages: 1 } })

function eventInputs (overrides = {}) {
  Object.assign(inputs, {
    token: 'fd_pat_test',
    project: PROJECT,
    app: APP,
    environment: 'production',
    kind: 'deploy',
    'release-tag': 'deploy-2026-09-04-57',
    'build-number': '57',
    sha: SHA,
    ...overrides
  })
}

describe('a production deploy event from a verified run', () => {
  const answers = () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: PROJECT }, { id: 43, identifier: 'OTHER' }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: 901 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts with the mark for this attempt and deploy, and no authorize-actor mark', async () => {
    eventInputs()
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, mark(DEPLOY))
    const fetchMock = answers()
    await postReleaseEvent()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).release_event).toMatchObject({ app: APP, environment: 'production', kind: 'deploy', sha: SHA })
  })

  it.each([
    ['another project', { project: 'OTHER' }],
    ['another app', { app: 'other-app' }],
    ['no app', { app: '' }],
    ['another sha', { sha: OTHER_SHA }],
    ['the sha in capitals', { sha: SHA.toUpperCase() }],
    ['the environment in capitals', { environment: 'Production' }],
    ['a rollback', { kind: 'rollback' }],
    ['a hotfix', { kind: 'hotfix' }],
    ['a sha taken from image tags instead of given', { sha: '', 'image-tags': `sha-${SHA}` }]
  ])('refuses %s, as before, and fails the step', async (_label, overrides) => {
    eventInputs(overrides)
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, mark(DEPLOY))
    const fetchMock = answers()
    await postReleaseEvent()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/^refusing to post a release event for .*: no authorize-actor check passed/))
  })

  it('refuses a mark from another attempt', async () => {
    eventInputs()
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, mark(DEPLOY, '2'))
    const fetchMock = answers()
    await postReleaseEvent()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still posts with the authorize-actor mark and no verified run, as promote does', async () => {
    eventInputs({ kind: 'rollback' })
    vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '1')
    const fetchMock = answers()
    await postReleaseEvent()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('previous-environment', () => {
  const PREVIOUS = [
    { id: 9, environment: 'production', release_tag: 'deploy-2026-09-05-60', sha: 'f'.repeat(40), deployed_at: '2026-09-05T09:00:00Z' },
    { id: 8, environment: 'production', release_tag: 'deploy-2026-09-04-57', sha: SHA, deployed_at: '2026-09-04T12:34:56Z' },
    { id: 7, environment: 'production', release_tag: 'deploy-2026-09-03-56', sha: null, deployed_at: '2026-09-03T10:00:00Z' },
    { id: 6, environment: 'production', release_tag: 'deploy-2026-09-02-55', sha: OTHER_SHA, deployed_at: '2026-09-02T10:00:00Z' }
  ]

  it('reads production before posting and outputs the release before this one', async () => {
    eventInputs({ 'previous-environment': 'production', 'deployed-at': '2026-09-04T12:34:56Z' })
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, mark(DEPLOY))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: PROJECT }]))
      .mockResolvedValueOnce(jsonResponse(200, { results: PREVIOUS, meta: {} }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 902 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()
    expect(fetchMock.mock.calls[1][0]).toBe('https://flightdeck.cru.org/api/v1/projects/42/release-events?environment=production&per_page=20')
    expect(fetchMock.mock.calls[1][1].method).toBe('GET')
    expect(fetchMock.mock.calls[2][1].method).toBe('POST')
    // Not the later release, not this same tag restated, not one with no sha.
    expect(output('previous-sha')).toBe(OTHER_SHA)
    expect(output('previous-release-tag')).toBe('deploy-2026-09-02-55')
    expect(output('status')).toBe('created')
  })

  it('warns and still posts when the read fails', async () => {
    eventInputs({ 'previous-environment': 'production' })
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, mark(DEPLOY))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: PROJECT }]))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'down' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 903 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not read the previous production release event'))
    expect(output('previous-sha')).toBe('')
    expect(output('status')).toBe('created')
  })

  it('reads nothing when unset, so the existing callers make the same two calls', async () => {
    eventInputs()
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, mark(DEPLOY))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: PROJECT }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: 904 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(core.setOutput.mock.calls.map(([key]) => key)).not.toContain('previous-sha')
  })

  it('previousReleaseEvent takes the newest earlier release that has a sha', () => {
    const event = { environment: 'production', release_tag: 'deploy-2026-09-04-57' }
    expect(previousReleaseEvent(PREVIOUS, event).id).toBe(9)
    expect(previousReleaseEvent(PREVIOUS, { ...event, deployed_at: '2026-09-04T12:34:56Z' }).id).toBe(6)
    expect(previousReleaseEvent(PREVIOUS, { ...event, deployed_at: 'not a time' }).id).toBe(9)
    expect(previousReleaseEvent(PREVIOUS, { ...event, deployed_at: '2026-09-01T00:00:00Z' })).toBeNull()
    expect(previousReleaseEvent([], event)).toBeNull()
    expect(previousReleaseEvent(undefined, event)).toBeNull()
    // A staging deploy reads production, where its own tag is not.
    expect(previousReleaseEvent(PREVIOUS, { environment: 'staging', release_tag: 'deploy-2026-09-04-57' }).id).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// The workflow's own steps, run under bash with fake aws, gh and curl
// (support/workflow-steps.js).

const workflow = loadYaml('.github/workflows/record-deploy.yml')

describe('record-deploy lookup', () => {
  const { job, step } = findStep(workflow, 'lookup', 'Look up app info')
  const row = (extra = {}) => ({
    Item: { Project: { S: APP }, Environment: { S: 'production' }, Provider: { S: 'aws' }, Type: { S: 'static' }, FlightdeckProject: { S: PROJECT }, ...extra }
  })
  const lookup = (aws, { environment = 'production', project = APP, credentials = 'success' } = {}) =>
    runShellStep({ job, step }, { context: { 'inputs.project-name': project, 'inputs.environment': environment, 'steps.aws.outcome': credentials }, aws })

  it('records nothing for a missing row, says why, and passes', async () => {
    const result = await lookup({})
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("::warning title=Deploy not recorded::no CruApplicationInfo row for project 'example-app' environment 'production'")
    expect(result.outputs).toEqual({})
  })

  it('records nothing for a row with no FlightdeckProject', async () => {
    const result = await lookup(row({ FlightdeckProject: undefined }))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("::warning title=Deploy not recorded::example-app's CruApplicationInfo row for 'production' has no FlightdeckProject")
    expect(result.outputs).toEqual({})
  })

  it('records nothing for a pipeline v2 app, whose own workflows record its deploys', async () => {
    const result = await lookup(row({ PipelineVersion: { S: '2' }, Type: { S: 'ecs' } }))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('::warning title=Deploy not recorded::example-app is on pipeline v2')
    expect(result.outputs).toEqual({})
  })

  it('records nothing, and passes, when the role that reads app-info could not be assumed', async () => {
    const result = await lookup(row(), { credentials: 'failure' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('::warning title=Deploy not recorded::could not assume the role that reads CruApplicationInfo')
    expect(result.outputs).toEqual({})
  })

  it.each(['prod', 'release-candidate', 'Production', 'staging\nproduction', ''])('records nothing for environment %j', async (environment) => {
    const result = await lookup(row(), { environment })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^::warning title=Deploy not recorded::environment '.*' is not staging or production$/m)
    expect(result.outputs).toEqual({})
  })

  it.each([
    ['a FlightdeckProject that is not an identifier', { FlightdeckProject: { S: 'EXAMPLE\nrecord=true' } }, 'is not a Flightdeck project identifier'],
    ['a DeployWorkflow that is not a workflow path', { DeployWorkflow: { S: '.github/workflows/deploy.yml\nx=y' } }, 'is not a path under .github/workflows/'],
    ['a SlackChannel with a line break', { SlackChannel: { S: 'C0TEST\nflightdeck-project=OTHER' } }, 'holds a line break'],
    ['an AppUrl with a line break', { AppUrl: { S: 'https://example.test\nrepository=someone/else' } }, 'holds a line break'],
    ['a Repository with a line break', { Repository: { S: 'CruGlobal/example-app\nx=y' } }, 'holds a line break']
  ])('records nothing for %s, so no value can add an output of its own', async (_label, extra, why) => {
    const result = await lookup(row(extra))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(why)
    expect(result.outputs).toEqual({})
  })

  it('records nothing for a project name app-info cannot hold', async () => {
    const result = await lookup(row(), { project: 'example app' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('is not one app-info can hold')
  })

  it('hands the record job what it needs, with the repository named after the project by default', async () => {
    const result = await lookup(row({ SlackChannel: { S: 'C0TESTCHANNEL' }, AppUrl: { S: 'https://example-app.example.test' }, DeployWorkflow: { S: WORKFLOW } }))
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toEqual({
      record: 'true',
      'flightdeck-project': PROJECT,
      'slack-channel': 'C0TESTCHANNEL',
      'app-url': 'https://example-app.example.test',
      repository: REPO,
      'deploy-workflow': WORKFLOW
    })
  })

  it('uses the row\'s Repository when it has one, and no DeployWorkflow when it has none', async () => {
    const result = await lookup(row({ Repository: { S: 'CruGlobal/example-app-web' } }), { environment: 'staging' })
    expect(result.outputs).toMatchObject({ repository: 'CruGlobal/example-app-web', 'deploy-workflow': '' })
  })
})

describe('record-deploy Slack notice', () => {
  const { job, step } = findStep(workflow, 'record', 'Notify Slack')
  const context = (overrides = {}) => ({
    'inputs.project-name': APP,
    'inputs.flightdeck-url': 'https://flightdeck.cru.org',
    'vars.FLIGHTDECK_WORKSPACE': 'acme',
    'needs.lookup.outputs.flightdeck-project': PROJECT,
    'needs.lookup.outputs.slack-channel': 'C0TESTCHANNEL',
    'needs.lookup.outputs.app-url': '',
    'needs.lookup.outputs.repository': REPO,
    'secrets.slack-bot-token': 'xoxb-test',
    'secrets.github-token': 'gh-test',
    'steps.verify.outputs.environment': 'production',
    'steps.verify.outputs.release-tag': 'deploy-2026-09-04-57',
    'steps.verify.outputs.sha': SHA,
    'steps.verify.outputs.actor': 'octo-dev',
    'steps.verify.outputs.run-url': `https://github.com/${REPO}/actions/runs/4242/attempts/2`,
    'steps.release-event.outputs.previous-sha': OTHER_SHA,
    ...overrides
  })
  const notify = (options) => runShellStep({ job, step }, { ...options, context: context(options.context) })

  it('compares production\'s previous release with this commit, and links the changes when it is ahead', async () => {
    const result = await notify({ ghCompare: { status: 'ahead' } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.comparePath).toBe(`repos/${REPO}/compare/${OTHER_SHA}...${SHA}`)
    expect(result.slack.text).toBe([
      `:white_check_mark: *${APP} deployed \`deploy-2026-09-04-57\` to production* by octo-dev`,
      `Deployed by the app's own workflow: <https://github.com/${REPO}/actions/runs/4242/attempts/2|run>`,
      `<https://flightdeck.cru.org/acme/projects/${PROJECT}/changelog?from=${OTHER_SHA}&to=${SHA}&app=${APP}|what's in this release>`
    ].join('\n'))
  })

  it('links the changes when the commits have diverged', async () => {
    const result = await notify({ ghCompare: { status: 'diverged' } })
    expect(result.slack.text).toMatch(/\|what's in this release>$/)
  })

  it('says it goes back to an earlier commit, with no link, when this commit is behind', async () => {
    const result = await notify({ ghCompare: { status: 'behind' } })
    expect(result.slack.text).not.toContain('what\'s in this release')
    expect(result.slack.text).toMatch(/\nThis goes back to an earlier commit than production's previous release\.$/)
  })

  it.each([
    ['the comparison fails', { ghCompareFails: true }],
    ['GitHub gives no status', { ghCompare: {} }],
    ['the commits are identical', { ghCompare: { status: 'identical' } }]
  ])('leaves the line out when %s', async (_label, options) => {
    const result = await notify(options)
    expect(result.status).toBe(0)
    expect(result.slack.text).not.toMatch(/what's in this release|goes back/)
  })

  it('does not compare when there is no previous release, or it is this commit', async () => {
    for (const previous of ['', SHA]) {
      const result = await notify({ context: { 'steps.release-event.outputs.previous-sha': previous }, ghCompare: { status: 'ahead' } })
      expect(result.comparePath).toBeNull()
      expect(result.slack.text).not.toMatch(/what's in this release|goes back/)
    }
  })

  it('names stage, with its link, for a staging deploy', async () => {
    const result = await notify({ context: { 'steps.verify.outputs.environment': 'staging', 'needs.lookup.outputs.app-url': 'https://stage.example.test' }, ghCompare: { status: 'diverged' } })
    expect(result.slack.text).toMatch(/^:package: \*example-app deployed `deploy-2026-09-04-57` to <https:\/\/stage\.example\.test\|stage>\* by octo-dev\n/)
  })
})

describe('record-deploy wiring', () => {
  const job = workflow.jobs.record
  const steps = Object.fromEntries(job.steps.map((s) => [s.name, s]))
  const at = (name) => job.steps.indexOf(steps[name])
  const eventStep = steps['Record release event in Flightdeck']
  const releaseEventAction = loadYaml('actions/flightdeck-release-event/action.yml')
  const verifyAction = loadYaml('actions/verify-deploy-run/action.yml')

  it('takes the inputs the app dispatches, and keeps the Flightdeck URL default', () => {
    const declared = workflow.on.workflow_call.inputs
    for (const name of ['project-name', 'environment', 'sha', 'run-id']) expect(declared[name]).toMatchObject({ type: 'string', required: true })
    expect(declared['flightdeck-url'].default).toBe(releaseEventAction.inputs.endpoint.default)
    expect(workflow.on.workflow_call.secrets['github-token'].required).toBe(true)
  })

  it('lets every setup step fail without failing the run, and says so', () => {
    const credentials = workflow.jobs.lookup.steps.find((s) => s.name === 'Configure AWS credentials for app-info')
    expect(credentials).toMatchObject({ id: 'aws', 'continue-on-error': true })
    expect(workflow.jobs.lookup.steps.find((s) => s.id === 'app-info').env.CREDENTIALS).toBe('${{ steps.aws.outcome }}')
    expect(steps['Checkout Cru Actions & Workflows']).toMatchObject({ id: 'checkout', 'continue-on-error': true })
    expect(steps['Say why nothing was recorded'].if).toBe("steps.checkout.outcome != 'success'")
    // Nothing in the record job needs a cloud credential any more.
    expect(job.steps.some((s) => String(s.uses ?? '').startsWith('aws-actions/'))).toBe(false)
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  it('runs only for an app the lookup found, and checks the run before anything else', () => {
    expect(job.if).toBe("needs.lookup.outputs.record == 'true'")
    expect(job.needs).toBe('lookup')
    expect(steps['Verify the run that asked']).toMatchObject({ id: 'verify', uses: './cru-github-actions/actions/verify-deploy-run', if: "steps.checkout.outcome == 'success'" })
    expect(steps['Verify the run that asked']['continue-on-error']).toBeUndefined()
    for (const name of ['Record release event in Flightdeck', 'Notify Slack']) {
      expect(steps[name].if, name).toBe("steps.verify.outputs.verified == 'true'")
      expect(steps[name]['continue-on-error'], name).toBe(true)
      expect(at(name), name).toBeGreaterThan(at('Verify the run that asked'))
    }
    expect(at('Notify Slack')).toBeGreaterThan(at('Record release event in Flightdeck'))
  })

  it('checks the run in the app repository from app-info, for the deploy asked and the pinned workflow', () => {
    expect(steps['Verify the run that asked'].with).toEqual({
      'github-token': '${{ secrets.github-token }}',
      repository: '${{ needs.lookup.outputs.repository }}',
      'run-id': '${{ inputs.run-id }}',
      sha: '${{ inputs.sha }}',
      environment: '${{ inputs.environment }}',
      project: '${{ needs.lookup.outputs.flightdeck-project }}',
      app: '${{ inputs.project-name }}',
      'deploy-workflow': '${{ needs.lookup.outputs.deploy-workflow }}'
    })
    for (const name of Object.keys(steps['Verify the run that asked'].with)) expect(verifyAction.inputs).toHaveProperty(name)
  })

  it('posts the values the mark names, and passes only inputs the release event action declares', () => {
    expect(eventStep.with).toMatchObject({
      project: '${{ steps.verify.outputs.project }}',
      app: '${{ steps.verify.outputs.app }}',
      environment: '${{ steps.verify.outputs.environment }}',
      sha: '${{ steps.verify.outputs.sha }}',
      'release-tag': '${{ steps.verify.outputs.release-tag }}',
      'build-number': '${{ steps.verify.outputs.build-number }}',
      kind: 'deploy'
    })
    for (const name of Object.keys(eventStep.with)) expect(releaseEventAction.inputs).toHaveProperty(name)
    for (const [name, spec] of Object.entries(releaseEventAction.inputs)) if (spec.required) expect(eventStep.with).toHaveProperty(name)
    expect(eventStep.with).not.toHaveProperty('rollback-safety')
    expect(eventStep.with).not.toHaveProperty('rollback-safety-reasons')
  })

  // End to end: the run check passes for the app's run, leaves its mark, and
  // the release event step posts the deploy through the production check with
  // what the workflow hands it.
  it('posts the app\'s deploy as a production deploy event once the run is verified', async () => {
    Object.assign(inputs, { 'github-token': 'gh-test', repository: REPO, 'run-id': RUN_ID, sha: SHA, environment: 'production', project: PROJECT, app: APP, 'deploy-workflow': WORKFLOW })
    theRunIs(workflowRun({ status: 'completed', conclusion: 'success' }))
    await verify({ sleep: noSleep, now: NOW })
    expect(output('verified')).toBe('true')
    const verified = Object.fromEntries(['sha', 'environment', 'project', 'app', 'actor', 'run-url', 'deployed-at', 'release-tag', 'build-number']
      .map((key) => [`steps.verify.outputs.${key}`, output(key)]))
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, exported[VERIFIED_DEPLOY_RUN_MARKER])

    for (const key of Object.keys(inputs)) delete inputs[key]
    const context = {
      ...verified,
      'secrets.flightdeck-token': 'fd_pat_test',
      'inputs.flightdeck-url': 'https://flightdeck.example.test'
    }
    for (const [name, value] of Object.entries(eventStep.with)) inputs[name] = resolveExpressions(value, context)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: PROJECT }]))
      .mockResolvedValueOnce(jsonResponse(200, { results: [], meta: {} }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 905 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).release_event).toEqual({
      app: APP,
      environment: 'production',
      kind: 'deploy',
      release_tag: 'deploy-2026-09-04-57',
      build_number: '57',
      sha: SHA,
      deployed_at: '2026-09-04T12:34:56Z',
      actor: 'octo-dev',
      run_url: `https://github.com/${REPO}/actions/runs/4242/attempts/2`
    })
    expect(output('previous-sha')).toBe('')
  })
})
