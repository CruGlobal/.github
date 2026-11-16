import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes, resolveExpressions } from './support/workflow-steps.js'

// build-candidate's failure notice and the deploy gate: the deploy-gate-url
// input, the job's permissions, the check before the dispatch, and what the
// dispatch step hands the dispatch action. The action's own rules are tested
// in dispatch.test.js. Here its run() gets the inputs the workflow gives it,
// with fetch (the runner's OIDC token service and the gate) and octokit
// mocked.

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

vi.mock('@actions/github', () => ({
  getOctokit: () => ({ rest: { actions: { createWorkflowDispatch } } })
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  },
  ...core
}))

import { run } from '../src/dispatch.js'

afterAll(removeFakes)

const workflow = loadYaml('.github/workflows/build-candidate.yml')
const job = workflow.jobs['notify-failure']
const CHECK = 'Check for a way to reach cru-deploy'
const ANNOUNCE = 'Announce the failure via cru-deploy'
const BUILD_JOBS = ['build-cloudrun', 'build-ecs', 'build-lambda']

const GATE_URL = 'https://gate.example.com/gate'
const TOKEN_URL = 'https://token.example.com/idtoken?api-version=2.0'
const RUN_URL = 'https://github.com/example-org/example-app/actions/runs/9000000002'

describe('the deploy-gate-url input', () => {
  it('is optional and empty by default, so callers that do not set it announce with the token as before', () => {
    expect(workflow.on.workflow_call.inputs['deploy-gate-url']).toMatchObject({ type: 'string', required: false, default: '' })
  })
})

describe('the notify-failure job', () => {
  it('can get an OIDC token for the gate', () => {
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
  })

  // A job in a reusable workflow cannot get more than the calling job
  // grants, and GitHub refuses to start the run when one asks for more. The
  // build jobs already ask for everything this job does, so no caller that
  // runs today is stopped by it.
  it.each(BUILD_JOBS)('asks for nothing %s does not already ask for', (buildJob) => {
    expect(workflow.jobs[buildJob].permissions).toMatchObject(job.permissions)
  })

  it('passes the input to the dispatch action as gate-url, keeps the token as the fallback, and never fails the run', () => {
    const { step } = findStep(workflow, 'notify-failure', ANNOUNCE)
    expect(step['continue-on-error']).toBe(true)
    expect(step.with).toMatchObject({
      'gate-url': '${{ inputs.deploy-gate-url }}',
      'github-token': '${{ secrets.CRU_DEPLOY_GITHUB_TOKEN }}',
      workflow: 'notify-build-failure.yml'
    })
    const dispatch = loadYaml('actions/dispatch/action.yml')
    for (const name of Object.keys(step.with)) expect(dispatch.inputs).toHaveProperty(name)
  })
})

describe('the check before the dispatch', () => {
  const check = (token, gateUrl) => runShellStep(findStep(workflow, 'notify-failure', CHECK), {
    context: { 'secrets.CRU_DEPLOY_GITHUB_TOKEN': token, 'inputs.deploy-gate-url': gateUrl }
  })

  it.each([
    ['the token only', 'example-token', ''],
    ['the gate only', '', GATE_URL],
    ['both', 'example-token', GATE_URL]
  ])('goes ahead with %s', async (_label, token, gateUrl) => {
    const result = await check(token, gateUrl)
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toEqual({ present: 'true' })
    expect(result.stdout).not.toContain('::warning')
  })

  it('warns and skips the notice with neither', async () => {
    const result = await check('', '')
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toEqual({})
    expect(result.stdout).toContain("::warning title=Build failure not announced::CRU_DEPLOY_GITHUB_TOKEN is unset (the caller does not pass 'secrets: inherit') and no deploy-gate-url is set; skipping the Slack notification.")
  })

  it('gates the checkout and the dispatch on it', () => {
    for (const name of ['Checkout Cru Actions & Workflows', ANNOUNCE]) {
      expect(findStep(workflow, 'notify-failure', name).step.if).toBe("steps.token.outputs.present == 'true'")
    }
  })
})

describe('what the dispatch step sends', () => {
  let tokenService, gate
  const route = vi.fn((url, init) => String(url).startsWith(TOKEN_URL) ? tokenService(url, init) : gate(url, init))

  beforeEach(() => {
    createWorkflowDispatch.mockReset()
    for (const fn of Object.values(core)) fn.mockReset()
    for (const key of Object.keys(inputs)) delete inputs[key]
    route.mockClear()
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', TOKEN_URL)
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'example-request-token')
    tokenService = vi.fn(async () => new Response(JSON.stringify({ value: 'oidc-token' }), { status: 200 }))
    gate = vi.fn(async () => new Response(JSON.stringify({ runUrl: 'https://github.com/example-org/example-deploy/actions/runs/1', message: 'started' }), { status: 202 }))
    vi.stubGlobal('fetch', route)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  // The step's `with`, filled in the way the runner fills it.
  function announce ({ token, gateUrl }) {
    const { step } = findStep(workflow, 'notify-failure', ANNOUNCE)
    const context = {
      'inputs.deploy-gate-url': gateUrl,
      'secrets.CRU_DEPLOY_GITHUB_TOKEN': token,
      'needs.setup.outputs.project-name': 'example-app',
      'github.server_url': 'https://github.com',
      'github.repository': 'example-org/example-app',
      'github.run_id': '9000000002'
    }
    for (const [name, value] of Object.entries(step.with)) inputs[name] = resolveExpressions(value, context)
    return run({ delaysMs: [0, 0], tryTimeoutMs: 50, tokenTryTimeoutMs: 50 })
  }

  it('sends the gate the project and this run\'s own page, with no token', async () => {
    await announce({ token: '', gateUrl: GATE_URL })

    expect(gate).toHaveBeenCalledTimes(1)
    const [url, request] = gate.mock.calls[0]
    expect(url).toBe(`${GATE_URL}/pipeline`)
    expect(JSON.parse(request.body)).toEqual({
      workflow: 'notify-build-failure.yml',
      inputs: { 'project-name': 'example-app', 'run-url': RUN_URL }
    })
    expect(createWorkflowDispatch).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('dispatches with the token, as before, when the input is empty', async () => {
    await announce({ token: 'example-token', gateUrl: '' })

    expect(route).not.toHaveBeenCalled()
    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'CruGlobal',
      repo: 'cru-deploy',
      workflow_id: 'notify-build-failure.yml',
      ref: 'main',
      inputs: { 'project-name': 'example-app', 'run-url': RUN_URL }
    })
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('falls back to the token when the gate cannot take it', async () => {
    gate.mockImplementation(async () => new Response('', { status: 503 }))
    await announce({ token: 'example-token', gateUrl: GATE_URL })

    expect(gate).toHaveBeenCalledTimes(3)
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('with github-token instead'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
