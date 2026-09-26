import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The authorized-attempt marker, and the deploy action's use of it. @actions/core
// is mocked so exportVariable lands in `exported`, the way the runner would
// hand it to later steps in the same job.
const { core, inputs, exported, deployCloudRun, deployEcs, deployLambda, getCollaboratorPermissionLevel } = vi.hoisted(() => ({
  core: {
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn()
  },
  inputs: {},
  exported: {},
  deployCloudRun: vi.fn(),
  deployEcs: vi.fn(),
  deployLambda: vi.fn(),
  getCollaboratorPermissionLevel: vi.fn()
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
vi.mock('@actions/github', () => ({
  getOctokit: () => ({ rest: { repos: { getCollaboratorPermissionLevel }, users: { getByUsername: vi.fn() } } })
}))
vi.mock('../src/v2/deploy-cloudrun.js', () => ({ deployCloudRun }))
vi.mock('../src/v2/deploy-ecs.js', () => ({ deployEcs }))
vi.mock('../src/v2/deploy-lambda.js', () => ({ deployLambda }))

import {
  AUTHORIZED_ATTEMPT_MARKER, AttemptNotAuthorized, assertAttemptAuthorized, currentRunAttempt, markAttemptAuthorized
} from '../src/v2/attempt-guard.js'
import { run as deploy, NON_PRODUCTION_ENVIRONMENTS } from '../src/deploy.js'
import { run as authorizeActor } from '../src/authorize-actor.js'

const IMAGE = 'us-docker.pkg.dev/p/app/app@sha256:' + 'a'.repeat(64)
const MARKER = AUTHORIZED_ATTEMPT_MARKER

// The runner's view of the job: the attempt number, and the marker if an
// earlier step exported one.
function jobEnv ({ attempt = '1', marker } = {}) {
  vi.stubEnv('GITHUB_RUN_ATTEMPT', attempt)
  vi.stubEnv(MARKER, marker ?? '')
}

function deployInputs (environment) {
  Object.assign(inputs, { type: 'cloudrun', 'project-name': 'app', environment, image: IMAGE, 'runtime-project': 'app-prod' })
}

const failure = () => core.setFailed.mock.calls[0]?.[0]

beforeEach(() => {
  for (const fn of [...Object.values(core), deployCloudRun, deployEcs, deployLambda, getCollaboratorPermissionLevel]) fn.mockReset()
  deployCloudRun.mockResolvedValue({ deployedImage: IMAGE, services: ['app'] })
  for (const key of Object.keys(inputs)) delete inputs[key]
  for (const key of Object.keys(exported)) delete exported[key]
})

afterEach(() => vi.unstubAllEnvs())

describe('attempt guard', () => {
  it('uses a clear, fixed marker name', () => {
    expect(MARKER).toBe('CRU_V2_AUTHORIZED_ATTEMPT')
  })

  it('reads the run attempt as a whole number above zero', () => {
    expect(currentRunAttempt({ GITHUB_RUN_ATTEMPT: ' 12 ' })).toBe('12')
    for (const value of ['', '0', '01', '-1', '1.0', 'one', undefined]) {
      expect(currentRunAttempt({ GITHUB_RUN_ATTEMPT: value })).toBe('')
    }
  })

  it('marks the current attempt', () => {
    expect(markAttemptAuthorized({ GITHUB_RUN_ATTEMPT: '4' })).toBe('4')
    expect(exported).toEqual({ [MARKER]: '4' })
  })

  it('will not mark an attempt without a run attempt number', () => {
    expect(() => markAttemptAuthorized({ GITHUB_RUN_ATTEMPT: '' })).toThrow(AttemptNotAuthorized)
    expect(exported).toEqual({})
  })

  it('passes when the marker names the current attempt', () => {
    expect(() => assertAttemptAuthorized('deploy to production', { GITHUB_RUN_ATTEMPT: '2', [MARKER]: '2' })).not.toThrow()
  })

  it('refuses with no marker, and says what to do instead', () => {
    expect(() => assertAttemptAuthorized('deploy to production', { GITHUB_RUN_ATTEMPT: '2' })).toThrow(
      'refusing to deploy to production: no authorize-actor check passed earlier in this job for this run attempt (attempt 2). ' +
      'A production change needs the account that started this run attempt to be checked first, in the same job. ' +
      'This happens when a run made before that check existed is re-run with "Re-run failed jobs" or "Re-run job", ' +
      "because those re-runs reuse the run's old workflow file. " +
      'Use "Re-run all jobs", which loads the current workflow file, or start a new run.'
    )
  })

  it('refuses a marker from an earlier attempt', () => {
    expect(() => assertAttemptAuthorized('deploy to production', { GITHUB_RUN_ATTEMPT: '3', [MARKER]: '2' }))
      .toThrow(/passed for attempt 2, not for this attempt \(attempt 3\)/)
  })

  it('refuses when the runner gives no attempt number, even with a marker', () => {
    expect(() => assertAttemptAuthorized('deploy to production', { GITHUB_RUN_ATTEMPT: '', [MARKER]: '1' }))
      .toThrow(/did not give a run attempt number/)
  })
})

describe('deploy action', () => {
  it('treats only release-candidate and preview as non-production', () => {
    expect(NON_PRODUCTION_ENVIRONMENTS).toEqual(['release-candidate', 'preview'])
  })

  // What an old promote or rollback job looks like when it is re-run: it
  // deploys to production and never ran authorize-actor.
  it('refuses a production deploy with no marker, before touching anything', async () => {
    jobEnv({ attempt: '2' })
    deployInputs('production')
    await deploy()
    expect(failure()).toMatch(/^refusing to deploy to production: no authorize-actor check passed earlier in this job/)
    expect(deployCloudRun).not.toHaveBeenCalled()
  })

  it('refuses a production deploy whose marker is from an earlier attempt', async () => {
    jobEnv({ attempt: '3', marker: '1' })
    deployInputs('production')
    await deploy()
    expect(failure()).toMatch(/passed for attempt 1, not for this attempt \(attempt 3\)/)
    expect(deployCloudRun).not.toHaveBeenCalled()
  })

  it('deploys to production when the marker matches this attempt', async () => {
    jobEnv({ attempt: '3', marker: '3' })
    deployInputs('production')
    await deploy()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(deployCloudRun).toHaveBeenCalledWith(expect.objectContaining({ environment: 'production', image: IMAGE }))
  })

  it.each(['release-candidate', 'preview'])('deploys to %s with no marker, as deploy-candidate does', async (environment) => {
    jobEnv({ attempt: '1' })
    deployInputs(environment)
    await deploy()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(deployCloudRun).toHaveBeenCalledWith(expect.objectContaining({ environment }))
  })

  it('still rejects an unknown environment by name', async () => {
    jobEnv({ attempt: '1', marker: '1' })
    deployInputs('prod')
    await deploy()
    expect(failure()).toMatch(/Unknown v2 environment "prod"/)
    expect(deployCloudRun).not.toHaveBeenCalled()
  })
})

describe('a production job, step by step', () => {
  // Run the job's steps in order: the check (if the job has one), then the
  // production deploy. The marker reaches the deploy only through the job
  // environment, the way the runner passes it on.
  async function runJob ({ withCheck, attempt, triggeringActor, permission }) {
    jobEnv({ attempt })
    getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission } })
    if (withCheck) {
      Object.assign(inputs, { 'github-token': 'tok', repository: 'CruGlobal/app', operation: 'promote' })
      await authorizeActor({
        env: { GITHUB_ACTOR: 'alice', GITHUB_ACTOR_ID: '1001', GITHUB_TRIGGERING_ACTOR: triggeringActor, GITHUB_RUN_ATTEMPT: attempt },
        sleep: async () => {}
      })
      if (exported[MARKER] !== undefined) vi.stubEnv(MARKER, exported[MARKER])
      if (core.setFailed.mock.calls.length > 0) return 'refused at the check'
    }
    deployInputs('production')
    await deploy()
    return core.setFailed.mock.calls.length > 0 ? 'refused at deploy' : 'deployed'
  }

  it('deploys when the current job checks an authorized account first', async () => {
    expect(await runJob({ withCheck: true, attempt: '2', triggeringActor: 'bob', permission: 'write' })).toBe('deployed')
  })

  it('stops at the check when the current job checks an unauthorized account', async () => {
    expect(await runJob({ withCheck: true, attempt: '2', triggeringActor: 'mallory', permission: 'read' })).toBe('refused at the check')
    expect(deployCloudRun).not.toHaveBeenCalled()
  })

  it('stops at deploy when an old job with no check is re-run', async () => {
    expect(await runJob({ withCheck: false, attempt: '2' })).toBe('refused at deploy')
    expect(deployCloudRun).not.toHaveBeenCalled()
  })
})
