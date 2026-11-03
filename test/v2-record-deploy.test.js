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

import { run as verify, verifyDeployRun, parseRequest, Refusal, DEPLOY_EVENTS } from '../src/verify-deploy-run.js'
import { run as postReleaseEvent, previousReleaseEvent } from '../src/flightdeck-release-event.js'
import {
  AUTHORIZED_ATTEMPT_MARKER, VERIFIED_DEPLOY_RUN_MARKER, deployRunVerifiedFor, markDeployRunVerified
} from '../src/v2/attempt-guard.js'
import { loadYaml, findStep, runShellStep, removeFakes, resolveExpressions } from './support/workflow-steps.js'

const REPO = 'CruGlobal/example-app'
const SHA = 'c0ffee00000000000000000000000000000000aa'
const OTHER_SHA = 'deadbeef00000000000000000000000000000001'
const RUN_ID = '4242'
const noSleep = () => Promise.resolve()

// The run GitHub returns: a push to main of SHA, still running, in the app's
// own repository, re-run by someone other than who first started it.
function workflowRun (overrides = {}) {
  return {
    id: 4242,
    run_attempt: 2,
    event: 'push',
    status: 'in_progress',
    conclusion: null,
    head_sha: SHA,
    head_branch: 'main',
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
  octokit, repository: REPO, runId: RUN_ID, sha: SHA, environment: 'production', sleep: noSleep, ...overrides
})

const output = (name) => core.setOutput.mock.calls.filter(([key]) => key === name).pop()?.[1]

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
  it('passes a push run of the sha, on the default branch, for production', async () => {
    const result = await check()
    expect(result).toMatchObject({
      repository: REPO,
      sha: SHA,
      environment: 'production',
      actor: 'octo-dev',
      runUrl: `https://github.com/${REPO}/actions/runs/4242/attempts/2`,
      deployedAt: '',
      event: 'push',
      defaultBranch: 'main'
    })
    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ owner: 'CruGlobal', repo: 'example-app', run_id: RUN_ID }))
    expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({ basehead: `${SHA}...main` }))
  })

  it('passes a manual dispatch, and a commit the default branch is identical to', async () => {
    theRunIs(workflowRun({ event: 'workflow_dispatch' }))
    compareSays('identical')
    await expect(check()).resolves.toMatchObject({ event: 'workflow_dispatch' })
  })

  it('takes when the run finished as the deploy time, and leaves it empty while it runs', async () => {
    theRunIs(workflowRun({ status: 'completed', conclusion: 'success' }))
    expect((await check()).deployedAt).toBe('2026-09-04T12:34:56Z')
  })

  it('does not ask about the default branch for staging, so a branch deploy passes', async () => {
    theRunIs(workflowRun({ head_branch: 'feature/x' }))
    await expect(check({ environment: 'staging' })).resolves.toMatchObject({ environment: 'staging', defaultBranch: '' })
    expect(octokit.rest.repos.get).not.toHaveBeenCalled()
    expect(octokit.rest.repos.compareCommitsWithBasehead).not.toHaveBeenCalled()
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

  it('accepts only push and workflow_dispatch', () => {
    expect([...DEPLOY_EVENTS]).toEqual(['push', 'workflow_dispatch'])
  })
})

describe('verifyDeployRun: refuses', () => {
  it.each(['pull_request', 'pull_request_target', 'pull_request_review'])('a %s run', async (event) => {
    theRunIs(workflowRun({ event }))
    await expect(check()).rejects.toThrow(/was started by a pull request; only a push or a manual dispatch/)
    await expect(check({ environment: 'staging' })).rejects.toThrow(Refusal)
  })

  it.each(['schedule', 'workflow_run', 'release', 'repository_dispatch', undefined])('a run started by %s', async (event) => {
    theRunIs(workflowRun({ event }))
    await expect(check()).rejects.toThrow(/only a push or a manual dispatch \(workflow_dispatch\) can record a deploy/)
  })

  it('a run whose head commit is not the sha', async () => {
    theRunIs(workflowRun({ head_sha: OTHER_SHA }))
    await expect(check()).rejects.toThrow(`run 4242 of ${REPO} ran commit ${OTHER_SHA}, not ${SHA}`)
    await expect(check({ environment: 'staging' })).rejects.toThrow(Refusal)
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
  const good = { repository: REPO, runId: RUN_ID, sha: SHA, environment: 'staging' }

  it.each([
    ['environment', 'prod'], ['environment', 'lab'], ['environment', 'release-candidate'], ['environment', ''],
    ['sha', SHA.slice(0, 7)], ['sha', 'g'.repeat(40)], ['sha', `${SHA}\n`.repeat(2)], ['sha', ''],
    ['runId', 'abc'], ['runId', '0'], ['runId', '12 34'], ['runId', ''],
    ['repository', 'example-app'], ['repository', 'a/b/c'], ['repository', 'CruGlobal/'], ['repository', 'Cru Global/example-app']
  ])('refuses %s %j before any call', (key, value) => {
    expect(() => parseRequest({ ...good, [key]: value })).toThrow(Refusal)
  })

  it('trims and lowercases what it compares', () => {
    expect(parseRequest({ repository: ` ${REPO} `, runId: ' 4242 ', sha: ` ${SHA.toUpperCase()} `, environment: 'STAGING' }))
      .toEqual({ owner: 'CruGlobal', repo: 'example-app', repository: REPO, runId: '4242', sha: SHA, environment: 'staging' })
  })
})

describe('verify-deploy-run action', () => {
  function actionInputs (overrides = {}) {
    Object.assign(inputs, { 'github-token': 'gh-test', repository: REPO, 'run-id': RUN_ID, sha: SHA, environment: 'production', ...overrides })
  }

  it('on a pass, outputs what record-deploy posts and marks the job for this attempt, environment and sha', async () => {
    actionInputs()
    theRunIs(workflowRun({ status: 'completed' }))
    await verify({ sleep: noSleep })
    expect(output('verified')).toBe('true')
    expect(output('sha')).toBe(SHA)
    expect(output('environment')).toBe('production')
    expect(output('actor')).toBe('octo-dev')
    expect(output('run-url')).toBe(`https://github.com/${REPO}/actions/runs/4242/attempts/2`)
    expect(output('deployed-at')).toBe('2026-09-04T12:34:56Z')
    expect(exported).toEqual({ [VERIFIED_DEPLOY_RUN_MARKER]: `1:production:${SHA}` })
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it.each([
    ['a pull request run', () => theRunIs(workflowRun({ event: 'pull_request' })), /pull request/],
    ['a wrong sha', () => theRunIs(workflowRun({ head_sha: OTHER_SHA })), /not c0ffee/],
    ['a production sha off the default branch', () => compareSays('diverged', 2), /not on CruGlobal\/example-app's default branch/],
    ['a missing run', () => octokit.rest.actions.getWorkflowRun.mockRejectedValue(httpError(404)), /there is no run 4242/]
  ])('on %s, warns, sets no mark and never fails the step', async (_label, arrange, why) => {
    actionInputs()
    arrange()
    await verify({ sleep: noSleep })
    expect(output('verified')).toBe('false')
    expect(output('reason')).toMatch(why)
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(why), { title: 'Deploy not recorded' })
    expect(exported).toEqual({})
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('refuses with no token, before any call', async () => {
    actionInputs({ 'github-token': '' })
    await verify({ sleep: noSleep })
    expect(output('verified')).toBe('false')
    expect(octokit.rest.actions.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('refuses when the runner gives no attempt number, since nothing can be marked', async () => {
    actionInputs()
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '')
    await verify({ sleep: noSleep })
    expect(output('verified')).toBe('false')
    expect(exported).toEqual({})
  })
})

describe('the verified-deploy-run mark', () => {
  it('counts only for its own attempt, environment and sha', () => {
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '3')
    markDeployRunVerified({ environment: 'production', sha: SHA })
    const env = { GITHUB_RUN_ATTEMPT: '3', [VERIFIED_DEPLOY_RUN_MARKER]: exported[VERIFIED_DEPLOY_RUN_MARKER] }
    expect(deployRunVerifiedFor({ environment: 'production', sha: SHA }, env)).toBe(true)
    expect(deployRunVerifiedFor({ environment: ' Production ', sha: SHA.toUpperCase() }, env)).toBe(true)
    expect(deployRunVerifiedFor({ environment: 'production', sha: OTHER_SHA }, env)).toBe(false)
    expect(deployRunVerifiedFor({ environment: 'staging', sha: SHA }, env)).toBe(false)
    expect(deployRunVerifiedFor({ environment: 'production', sha: '' }, env)).toBe(false)
    expect(deployRunVerifiedFor({ environment: 'production', sha: SHA }, { ...env, GITHUB_RUN_ATTEMPT: '4' })).toBe(false)
    expect(deployRunVerifiedFor({ environment: 'production', sha: SHA }, { GITHUB_RUN_ATTEMPT: '3' })).toBe(false)
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
    project: 'EXAMPLE',
    app: 'example-app',
    environment: 'production',
    kind: 'deploy',
    'release-tag': 'deploy-2026-09-04-10123',
    'build-number': '10123',
    sha: SHA,
    ...overrides
  })
}

describe('a production deploy event from a verified run', () => {
  const answers = () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: 901 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts with the mark for this attempt, environment and sha, and no authorize-actor mark', async () => {
    eventInputs()
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, `1:production:${SHA}`)
    const fetchMock = answers()
    await postReleaseEvent()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).release_event).toMatchObject({ environment: 'production', kind: 'deploy', sha: SHA })
  })

  it.each([
    ['another sha', `1:production:${OTHER_SHA}`, {}],
    ['another environment', `1:staging:${SHA}`, {}],
    ['another attempt', `2:production:${SHA}`, {}],
    ['a rollback', `1:production:${SHA}`, { kind: 'rollback' }],
    ['a hotfix', `1:production:${SHA}`, { kind: 'hotfix' }],
    ['a sha taken from image tags instead of given', `1:production:${SHA}`, { sha: '', 'image-tags': `sha-${SHA}` }]
  ])('refuses %s, as before, and fails the step', async (_label, marker, overrides) => {
    eventInputs(overrides)
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, marker)
    const fetchMock = answers()
    await postReleaseEvent()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/^refusing to post a release event for production: no authorize-actor check passed/))
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
    { id: 9, environment: 'production', release_tag: 'deploy-2026-09-05-10130', sha: 'f'.repeat(40), deployed_at: '2026-09-05T09:00:00Z' },
    { id: 8, environment: 'production', release_tag: 'deploy-2026-09-04-10123', sha: SHA, deployed_at: '2026-09-04T12:34:56Z' },
    { id: 7, environment: 'production', release_tag: 'deploy-2026-09-03-10110', sha: null, deployed_at: '2026-09-03T10:00:00Z' },
    { id: 6, environment: 'production', release_tag: 'deploy-2026-09-02-10100', sha: OTHER_SHA, deployed_at: '2026-09-02T10:00:00Z' }
  ]

  it('reads production before posting and outputs the release before this one', async () => {
    eventInputs({ 'previous-environment': 'production', 'deployed-at': '2026-09-04T12:34:56Z' })
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, `1:production:${SHA}`)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }]))
      .mockResolvedValueOnce(jsonResponse(200, { results: PREVIOUS, meta: {} }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 902 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()
    expect(fetchMock.mock.calls[1][0]).toBe('https://flightdeck.cru.org/api/v1/projects/42/release-events?environment=production&per_page=20')
    expect(fetchMock.mock.calls[1][1].method).toBe('GET')
    expect(fetchMock.mock.calls[2][1].method).toBe('POST')
    // Not the later release, not this same tag restated, not one with no sha.
    expect(output('previous-sha')).toBe(OTHER_SHA)
    expect(output('previous-release-tag')).toBe('deploy-2026-09-02-10100')
    expect(output('status')).toBe('created')
  })

  it('warns and still posts when the read fails', async () => {
    eventInputs({ 'previous-environment': 'production' })
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, `1:production:${SHA}`)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }]))
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
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, `1:production:${SHA}`)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: 904 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(core.setOutput.mock.calls.map(([key]) => key)).not.toContain('previous-sha')
  })

  it('previousReleaseEvent takes the newest earlier release that has a sha', () => {
    const event = { environment: 'production', release_tag: 'deploy-2026-09-04-10123' }
    expect(previousReleaseEvent(PREVIOUS, event).id).toBe(9)
    expect(previousReleaseEvent(PREVIOUS, { ...event, deployed_at: '2026-09-04T12:34:56Z' }).id).toBe(6)
    expect(previousReleaseEvent(PREVIOUS, { ...event, deployed_at: 'not a time' }).id).toBe(9)
    expect(previousReleaseEvent(PREVIOUS, { ...event, deployed_at: '2026-09-01T00:00:00Z' })).toBeNull()
    expect(previousReleaseEvent([], event)).toBeNull()
    expect(previousReleaseEvent(undefined, event)).toBeNull()
    // A staging deploy reads production, where its own tag is not.
    expect(previousReleaseEvent(PREVIOUS, { environment: 'staging', release_tag: 'deploy-2026-09-04-10123' }).id).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// The workflow's own steps, run under bash with fake aws and curl
// (support/workflow-steps.js).

const workflow = loadYaml('.github/workflows/record-deploy.yml')

describe('record-deploy lookup', () => {
  const { job, step } = findStep(workflow, 'lookup', 'Look up app info')
  const row = (extra = {}) => ({
    Item: { Project: { S: 'example-app' }, Environment: { S: 'production' }, Provider: { S: 'aws' }, Type: { S: 'static' }, FlightdeckProject: { S: 'EXAMPLE' }, ...extra }
  })
  const lookup = (aws, { environment = 'production', project = 'example-app' } = {}) =>
    runShellStep({ job, step }, { context: { 'inputs.project-name': project, 'inputs.environment': environment }, aws })

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

  it.each(['prod', 'release-candidate', 'Production', 'staging\nproduction', ''])('records nothing for environment %j', async (environment) => {
    const result = await lookup(row(), { environment })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^::warning title=Deploy not recorded::environment '.*' is not staging or production$/m)
    expect(result.outputs).toEqual({})
  })

  it.each([
    ['a FlightdeckProject that is not an identifier', { FlightdeckProject: { S: 'EXAMPLE\nrecord=true' } }, 'is not a Flightdeck project identifier'],
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
    const result = await lookup(row({ SlackChannel: { S: 'C0TESTCHANNEL' }, AppUrl: { S: 'https://example-app.example.test' } }))
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toEqual({
      record: 'true',
      'flightdeck-project': 'EXAMPLE',
      'slack-channel': 'C0TESTCHANNEL',
      'app-url': 'https://example-app.example.test',
      repository: 'CruGlobal/example-app'
    })
  })

  it('uses the row\'s Repository when it has one', async () => {
    const result = await lookup(row({ Repository: { S: 'CruGlobal/example-app-web' } }), { environment: 'staging' })
    expect(result.outputs.repository).toBe('CruGlobal/example-app-web')
  })
})

describe('record-deploy release name', () => {
  const { job, step } = findStep(workflow, 'record', 'Name the release')
  const name = (buildNumber, deployedAt) => runShellStep({ job, step }, {
    context: { 'inputs.project-name': 'example-app', 'steps.build-number.outputs.build-number': buildNumber, 'steps.verify.outputs.deployed-at': deployedAt }
  })

  it('is deploy-<the day the run finished>-<build number>', async () => {
    const result = await name('10123', '2026-09-04T23:59:59Z')
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toEqual({ tag: 'deploy-2026-09-04-10123', 'build-number': '10123' })
  })

  it('is dated today while the run is still going', async () => {
    const result = await name('10124', '')
    expect(result.outputs.tag).toMatch(/^deploy-\d{4}-\d{2}-\d{2}-10124$/)
    expect(result.outputs.tag).toBe(`deploy-${new Date().toISOString().slice(0, 10)}-10124`)
  })

  it('records nothing without a build number, and says what the role needs', async () => {
    const result = await name('', '')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('::warning title=Deploy not recorded::could not get a build number for example-app')
    expect(result.stdout).toContain('dynamodb:UpdateItem')
    expect(result.outputs).toEqual({})
  })
})

describe('record-deploy wiring', () => {
  const job = workflow.jobs.record
  const steps = Object.fromEntries(job.steps.map((s) => [s.name, s]))
  const at = (name) => job.steps.indexOf(steps[name])
  const eventStep = steps['Record release event in Flightdeck']
  const releaseEventAction = loadYaml('actions/flightdeck-release-event/action.yml')

  it('takes the inputs the app dispatches, and keeps the Flightdeck URL default', () => {
    const declared = workflow.on.workflow_call.inputs
    for (const name of ['project-name', 'environment', 'sha', 'run-id']) expect(declared[name]).toMatchObject({ type: 'string', required: true })
    expect(declared['flightdeck-url'].default).toBe(releaseEventAction.inputs.endpoint.default)
    expect(workflow.on.workflow_call.secrets['github-token'].required).toBe(true)
  })

  it('runs only for an app the lookup found, and checks the run before anything else', () => {
    expect(job.if).toBe("needs.lookup.outputs.record == 'true'")
    expect(job.needs).toBe('lookup')
    expect(steps['Verify the run that asked']).toMatchObject({ id: 'verify', uses: './cru-github-actions/actions/verify-deploy-run' })
    expect(steps['Verify the run that asked']['continue-on-error']).toBeUndefined()
    for (const name of ['Configure AWS credentials for the build number', 'Get a build number', 'Name the release']) {
      expect(steps[name].if, name).toBe("steps.verify.outputs.verified == 'true'")
      expect(at(name), name).toBeGreaterThan(at('Verify the run that asked'))
    }
    for (const name of ['Record release event in Flightdeck', 'Notify Slack']) {
      expect(steps[name].if, name).toBe("steps.release.outputs.tag != ''")
      expect(steps[name]['continue-on-error'], name).toBe(true)
      expect(at(name), name).toBeGreaterThan(at('Name the release'))
    }
    expect(at('Notify Slack')).toBeGreaterThan(at('Record release event in Flightdeck'))
  })

  it('checks the run in the app repository from app-info, for the sha and environment asked', () => {
    expect(steps['Verify the run that asked'].with).toEqual({
      'github-token': '${{ secrets.github-token }}',
      repository: '${{ needs.lookup.outputs.repository }}',
      'run-id': '${{ inputs.run-id }}',
      sha: '${{ inputs.sha }}',
      environment: '${{ inputs.environment }}'
    })
  })

  it('passes only inputs the release event action declares, and every required one', () => {
    for (const name of Object.keys(eventStep.with)) expect(releaseEventAction.inputs).toHaveProperty(name)
    for (const [name, spec] of Object.entries(releaseEventAction.inputs)) if (spec.required) expect(eventStep.with).toHaveProperty(name)
    expect(eventStep.with).not.toHaveProperty('rollback-safety')
    expect(eventStep.with).not.toHaveProperty('rollback-safety-reasons')
  })

  // End to end: the run check passes for the app's run, leaves its mark, and
  // the release event step posts the deploy through the production check with
  // what the workflow hands it.
  it('posts the app\'s deploy as a production deploy event once the run is verified', async () => {
    Object.assign(inputs, { 'github-token': 'gh-test', repository: REPO, 'run-id': RUN_ID, sha: SHA, environment: 'production' })
    theRunIs(workflowRun({ status: 'completed' }))
    await verify({ sleep: noSleep })
    expect(output('verified')).toBe('true')
    const verified = Object.fromEntries(['sha', 'environment', 'actor', 'run-url', 'deployed-at'].map((key) => [`steps.verify.outputs.${key}`, output(key)]))
    vi.stubEnv(VERIFIED_DEPLOY_RUN_MARKER, exported[VERIFIED_DEPLOY_RUN_MARKER])

    for (const key of Object.keys(inputs)) delete inputs[key]
    const context = {
      ...verified,
      'secrets.flightdeck-token': 'fd_pat_test',
      'inputs.flightdeck-url': 'https://flightdeck.example.test',
      'needs.lookup.outputs.flightdeck-project': 'EXAMPLE',
      'inputs.project-name': 'example-app',
      'steps.release.outputs.tag': 'deploy-2026-09-04-10123',
      'steps.release.outputs.build-number': '10123'
    }
    for (const [name, value] of Object.entries(eventStep.with)) inputs[name] = resolveExpressions(value, context)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(projectsPage([{ id: 42, identifier: 'EXAMPLE' }]))
      .mockResolvedValueOnce(jsonResponse(200, { results: [], meta: {} }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 905 }))
    vi.stubGlobal('fetch', fetchMock)
    await postReleaseEvent()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).release_event).toEqual({
      app: 'example-app',
      environment: 'production',
      kind: 'deploy',
      release_tag: 'deploy-2026-09-04-10123',
      build_number: '10123',
      sha: SHA,
      deployed_at: '2026-09-04T12:34:56Z',
      actor: 'octo-dev',
      run_url: `https://github.com/${REPO}/actions/runs/4242/attempts/2`
    })
    expect(output('previous-sha')).toBe('')
  })
})
