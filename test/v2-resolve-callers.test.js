import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'

// The workflows that read what a Cloud Run environment is running, driven end
// to end at the level a unit test can reach: the real resolve-image run()
// against a mocked Cloud Run, then the real shell of the step that consumes
// its outputs. The point is the contract between them: when there is no
// single serving image, resolve-image fails, deploy-candidate's no-op guard
// then does not skip, and promote stops at the resolve step.

const { inputs, setOutputMock, setFailedMock, requestMock } = vi.hoisted(() => ({
  inputs: {},
  setOutputMock: vi.fn(),
  setFailedMock: vi.fn(),
  requestMock: vi.fn()
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  },
  getBooleanInput: name => (inputs[name] ?? 'false') === 'true',
  setOutput: setOutputMock,
  setFailed: setFailedMock,
  info: vi.fn(),
  warning: vi.fn()
}))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))
vi.mock('../src/gcp.js', () => ({
  DEFAULT_REGION: 'us-central1',
  cloudrunListServices: vi.fn(),
  cloudrunListJobs: vi.fn(),
  cloudrunGetRevision: vi.fn()
}))
vi.mock('../src/v2/resolve-ecs.js', () => ({ resolveEcs: vi.fn() }))
vi.mock('../src/v2/resolve-lambda.js', () => ({ resolveLambda: vi.fn() }))

import * as gcp from '../src/gcp.js'
import { run } from '../src/resolve-image.js'
import { imageIndex, serveRegistry } from './support/registry-fixture.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = path.join(root, '.github/workflows')
const load = file => yaml.load(readFileSync(path.join(WORKFLOWS, file), 'utf8'))
const RESOLVE = './cru-github-actions/actions/resolve-image'

const REPO = 'us-central1-docker.pkg.dev/cru-shared-artifacts/example-app/example-app'
const OLD = `${REPO}@sha256:aaa`
const NEW = `${REPO}@sha256:bbb`
// INDEX is a multi-platform candidate. A revision deployed from it reports
// CHILD, its linux/amd64 image, which carries none of the candidate's tags.
const INDEX = `${REPO}@sha256:index14`
const CHILD = `${REPO}@sha256:child14`
const IMAGES = [
  { uri: OLD, tags: ['candidate-10012', 'sha-abc123'] },
  { uri: NEW, tags: ['candidate-10013', 'sha-def456'] },
  { uri: INDEX, tags: ['candidate-2026-09-28-10014', 'sha-0a1b2c'] },
  { uri: CHILD }
]
const INDEXES = { 'sha256:index14': imageIndex('sha256:child14') }
const PROJECT = 'example-app-stage-1234'
const SERVICES = `projects/${PROJECT}/locations/us-central1/services`
const LATEST = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'

// One service: the template names `template`, and all traffic goes to one
// revision running `serving` (or to no ready revision at all when serving is
// null). `split` is a list of [image, percent], one revision each, all of them
// real revisions, so a resolver that took the biggest share would find one.
function environment (list) {
  const revisions = {}
  const add = (name, id, image) => {
    revisions[`${SERVICES}/${name}/revisions/${id}`] = { containers: [{ image, ports: [{}] }] }
  }
  const services = list.map(({ name, template, serving, split }) => {
    const ready = serving ? `${name}-00001-aaa` : ''
    if (serving) add(name, ready, serving)
    const shares = (split ?? []).map(([image, percent], i) => {
      const id = `${name}-0000${i + 1}-split`
      add(name, id, image)
      return { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: id, percent }
    })
    return {
      name: `${SERVICES}/${name}`,
      template: { containers: [{ image: template, ports: [{ containerPort: 8080 }] }] },
      traffic: [{ type: LATEST, percent: 100 }],
      trafficStatuses: split ? shares : ready ? [{ type: LATEST, revision: ready, percent: 100 }] : [],
      latestReadyRevision: split ? `${SERVICES}/${name}/revisions/${name}-00001-split` : ready ? `${SERVICES}/${name}/revisions/${ready}` : ''
    }
  })
  gcp.cloudrunListServices.mockResolvedValue(services)
  gcp.cloudrunGetRevision.mockImplementation(async name => revisions[name])
}

// Stand-in for the runner's expression evaluation, for the few expressions
// these steps use. Missing step outputs are '' exactly as on a runner.
function evaluate (value, context) {
  return String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    const step = expr.match(/^steps\.([\w-]+)\.outputs\.([\w-]+)$/)
    if (step) return context.steps[step[1]]?.[step[2]] ?? ''
    if (expr in context.values) return context.values[expr]
    throw new Error(`test does not know how to evaluate ${expr}`)
  })
}

// Run one resolve-image step with the inputs the workflow gives it.
async function runResolve (step, context) {
  for (const key of Object.keys(inputs)) delete inputs[key]
  for (const [name, value] of Object.entries(step.with)) inputs[name] = evaluate(value, context)
  setOutputMock.mockReset()
  setFailedMock.mockReset()
  await run()
  return {
    outputs: Object.fromEntries(setOutputMock.mock.calls),
    failure: setFailedMock.mock.calls[0]?.[0]
  }
}

// Run one `run:` step the way the runner does (bash -eo pipefail), with its
// env block evaluated, and return its exit status and GITHUB_OUTPUT values.
const scratch = mkdtempSync(path.join(tmpdir(), 'resolve-callers-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
function runScript (step, context) {
  const output = path.join(scratch, `output-${Math.random().toString(36).slice(2)}`)
  writeFileSync(output, '')
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, evaluate(v, context)]))
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', evaluate(step.run, context)], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8'
  })
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2))
  )
  return { status: result.status, stdout: result.stdout, outputs }
}

// Walk a job's steps up to (and including) `untilId`, running resolve-image
// steps for real and failing the job where the runner would.
async function runJob (job, context, untilId) {
  for (const step of job.steps) {
    if (step.uses === RESOLVE) {
      const { outputs, failure } = await runResolve(step, context)
      context.steps[step.id] = outputs
      if (failure && !step['continue-on-error']) return { failedAt: step.id, failure }
    } else if (step.run && step.id) {
      const { status, outputs, stdout } = runScript(step, context)
      context.steps[step.id] = outputs
      if (status !== 0 && !step['continue-on-error']) return { failedAt: step.id, stdout }
    }
    if (step.id === untilId) return { context }
  }
  throw new Error(`no step ${untilId}`)
}

const workflows = Object.fromEntries(
  readdirSync(WORKFLOWS).filter(file => file.endsWith('.yml')).map(file => [file, load(file)])
)
const deployJob = workflows['deploy-candidate.yml'].jobs['deploy-candidate-gcp']
const promoteJob = workflows['promote.yml'].jobs['promote-gcp']

beforeEach(() => {
  requestMock.mockReset()
  serveRegistry(requestMock, { images: IMAGES, indexes: INDEXES })
  gcp.cloudrunListServices.mockReset()
  gcp.cloudrunListJobs.mockReset()
  gcp.cloudrunListJobs.mockResolvedValue([])
  gcp.cloudrunGetRevision.mockReset()
})

describe('callers of resolve-image mode=environment', () => {
  // Every step that reads a running environment, in every workflow.
  const callers = Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
      (job.steps ?? [])
        .filter(step => step.uses === RESOLVE && String(step.with?.mode).includes('environment'))
        .map(step => ({ file, jobId, job, step }))
    )
  )

  it('reads Cloud Run only in the two steps these tests drive', () => {
    const cloudrun = callers.filter(({ step }) => step.with.type === 'cloudrun')
    expect(cloudrun.map(({ file, jobId, step }) => `${file} ${jobId} ${step.id}`)).toEqual([
      'deploy-candidate.yml deploy-candidate-gcp current',
      'promote.yml promote-gcp resolve'
    ])
  })

  it('reads ECS or Lambda everywhere else, in jobs that only run for AWS apps', () => {
    const others = callers.filter(({ step }) => step.with.type !== 'cloudrun')
    expect(others.length).toBeGreaterThan(0)
    for (const { job, step } of others) {
      expect(step.with.type).toBe('${{ needs.lookup.outputs.type }}')
      expect(job.if).toMatch(/^needs\.lookup\.outputs\.provider == 'aws'/)
    }
  })

  it('lets deploy-candidate carry on past a failed read, and makes promote stop on one', () => {
    const current = deployJob.steps.find(step => step.id === 'current')
    expect(current['continue-on-error']).toBe(true)
    expect(deployJob.steps.find(step => step.id === 'noop').env.HAVE).toBe('${{ steps.current.outputs.digest }}')

    const resolve = promoteJob.steps.find(step => step.id === 'resolve')
    expect(resolve['continue-on-error']).toBeUndefined()
    expect(resolve.if).toBeUndefined()
  })

  // The ECS resolver throws the same way when no single image serves (see
  // test/v2-resolve-ecs.test.js), so the AWS jobs must treat a failed read the
  // same way too.
  it('does the same in the AWS jobs', () => {
    const awsDeploy = workflows['deploy-candidate.yml'].jobs['deploy-candidate-aws']
    const current = awsDeploy.steps.find(step => step.id === 'current')
    expect(current['continue-on-error']).toBe(true)
    expect(awsDeploy.steps.find(step => step.id === 'noop').env.HAVE).toBe('${{ steps.current.outputs.digest }}')

    const resolve = workflows['promote.yml'].jobs['promote-aws'].steps.find(step => step.id === 'resolve')
    expect(resolve.with.mode).toContain('environment')
    expect(resolve['continue-on-error']).toBeUndefined()
    expect(resolve.if).toBeUndefined()
  })
})

describe('deploy-candidate re-runs (Cloud Run)', () => {
  const context = tag => ({
    steps: {},
    values: {
      'inputs.project-name': 'example-app',
      'inputs.tag': tag,
      'inputs.force': 'false',
      'needs.lookup.outputs.project-id': PROJECT
    }
  })
  const guard = async () => {
    const result = await runJob(deployJob, context('candidate-10013'), 'noop')
    return result.context.steps.noop.skip
  }

  it('is still a no-op when the revision went live after the deploy gave up on it', async () => {
    environment([{ name: 'web', template: NEW, serving: NEW }])
    expect(await guard()).toBe('true')
  })

  it('is a no-op when a multi-platform candidate is serving and its revision reports the child', async () => {
    environment([{ name: 'web', template: INDEX, serving: CHILD }])
    const result = await runJob(deployJob, context('candidate-2026-09-28-10014'), 'noop')
    expect(result.context.steps.noop.skip).toBe('true')
  })

  it('is not a no-op when the new revision failed for good and the old one still serves', async () => {
    environment([{ name: 'web', template: NEW, serving: OLD }])
    expect(await guard()).toBe('false')
  })

  it('is not a no-op when no revision is ready yet', async () => {
    environment([{ name: 'web', template: NEW, serving: null }])
    expect(await guard()).toBe('false')
  })

  it('is not a no-op when the first service landed and the second did not', async () => {
    environment([
      { name: 'web', template: NEW, serving: NEW },
      { name: 'worker', template: OLD, serving: OLD }
    ])
    expect(await guard()).toBe('false')
  })

  it('is not a no-op when traffic is split', async () => {
    environment([{ name: 'web', template: NEW, split: [[NEW, 90], [OLD, 10]] }])
    expect(await guard()).toBe('false')
  })
})

describe('promote (Cloud Run)', () => {
  const context = () => ({
    steps: {},
    values: {
      'inputs.project-name': 'example-app',
      'needs.lookup.outputs.rc-project-id': PROJECT
    }
  })

  it('takes the candidate that is serving in release-candidate, not the one the template names', async () => {
    environment([{ name: 'web', template: NEW, serving: OLD }])

    const { context: done } = await runJob(promoteJob, context(), 'release')

    expect(done.steps.resolve.image).toBe(OLD)
    expect(done.steps.release).toEqual({ candidate: 'candidate-10012', release: 'release-10012' })
  })

  it('takes the release name from the index when a multi-platform candidate is serving', async () => {
    environment([{ name: 'web', template: INDEX, serving: CHILD }])

    const { context: done } = await runJob(promoteJob, context(), 'release')

    expect(done.steps.resolve.image).toBe(INDEX)
    expect(done.steps.release).toEqual({
      candidate: 'candidate-2026-09-28-10014',
      release: 'release-2026-09-28-10014'
    })
  })

  it('stops at the resolve step when the release-candidate services disagree', async () => {
    environment([
      { name: 'web', template: NEW, serving: NEW },
      { name: 'worker', template: NEW, serving: OLD }
    ])

    const result = await runJob(promoteJob, context(), 'release')

    expect(result.failedAt).toBe('resolve')
    expect(result.failure).toMatch(/do not all serve one app image .*web serves .*@sha256:bbb; worker serves .*@sha256:aaa/)
  })

  it('stops at the resolve step when release-candidate traffic is split', async () => {
    environment([{ name: 'web', template: NEW, split: [[NEW, 90], [OLD, 10]] }])

    const result = await runJob(promoteJob, context(), 'release')

    expect(result.failedAt).toBe('resolve')
    expect(result.failure).toMatch(/web splits its traffic between revisions/)
  })
})
