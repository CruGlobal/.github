import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The three type routers (deploy, resolve-image, tag-image) send `static` to
// its own code, and refuse any type they do not know, loudly and before
// anything is touched.
const { inputs, core, deployers, resolvers, ecrRetagDigest, addTag, openImage } = vi.hoisted(() => ({
  inputs: {},
  core: { info: vi.fn(), warning: vi.fn(), notice: vi.fn(), setOutput: vi.fn(), setFailed: vi.fn() },
  deployers: { deployCloudRun: vi.fn(), deployEcs: vi.fn(), deployLambda: vi.fn(), deployStatic: vi.fn() },
  resolvers: { resolveCloudRun: vi.fn(), resolveEcs: vi.fn(), resolveLambda: vi.fn(), resolveStatic: vi.fn() },
  ecrRetagDigest: vi.fn(),
  addTag: vi.fn(),
  openImage: vi.fn()
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  },
  getBooleanInput: name => (inputs[name] ?? 'false') === 'true',
  ...core
}))
vi.mock('../src/v2/deploy-cloudrun.js', () => ({ deployCloudRun: deployers.deployCloudRun }))
vi.mock('../src/v2/deploy-ecs.js', () => ({ deployEcs: deployers.deployEcs }))
vi.mock('../src/v2/deploy-lambda.js', () => ({ deployLambda: deployers.deployLambda }))
vi.mock('../src/v2/deploy-static.js', () => ({ deployStatic: deployers.deployStatic }))
vi.mock('../src/v2/resolve-cloudrun.js', () => ({ resolveCloudRun: resolvers.resolveCloudRun }))
vi.mock('../src/v2/resolve-ecs.js', () => ({ resolveEcs: resolvers.resolveEcs }))
vi.mock('../src/v2/resolve-lambda.js', () => ({ resolveLambda: resolvers.resolveLambda }))
vi.mock('../src/v2/resolve-static.js', () => ({ resolveStatic: resolvers.resolveStatic }))
vi.mock('../src/v2/aws.js', () => ({ ecrRetagDigest, ecrImageRef: (name, digest) => `000000000000.dkr.ecr.us-east-1.amazonaws.com/${name}@${digest}` }))
vi.mock('../src/v2/gcp.js', async importOriginal => ({ ...(await importOriginal()), addTag, sharedRegistryRepo: name => name }))
vi.mock('../src/v2/oci.js', () => ({ openImage }))

import { DEPLOY_TYPES, run as deploy } from '../src/deploy.js'
import { run as resolve } from '../src/resolve-image.js'
import { run as tag } from '../src/tag-image.js'
import { AUTHORIZED_ATTEMPT_MARKER } from '../src/v2/attempt-guard.js'

const DIGEST = 'sha256:' + 'd'.repeat(64)
const IMAGE = `000000000000.dkr.ecr.us-east-1.amazonaws.com/example-app@${DIGEST}`
const UNKNOWN = ['fargate', 'serverless', 'Static', 'amplify']

const outputs = () => Object.fromEntries(core.setOutput.mock.calls)
const nothingRan = () => [...Object.values(deployers), ...Object.values(resolvers), ecrRetagDigest, addTag, openImage]
  .every(fn => fn.mock.calls.length === 0)

beforeEach(() => {
  for (const fn of [...Object.values(core), ...Object.values(deployers), ...Object.values(resolvers), ecrRetagDigest, addTag, openImage]) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
  vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('deploy router', () => {
  const base = { 'project-name': 'example-app', environment: 'release-candidate', image: IMAGE, 'app-url': 'https://example-site.example.org' }

  it('sends static to the static deploy, with the revision and the rollout setting', async () => {
    Object.assign(inputs, base, { type: 'static', revision: 'candidate-2026-11-04-10150', 'stop-rollout-on-failure': 'false' })
    deployers.deployStatic.mockResolvedValue({ deployedImage: IMAGE, services: ['example-site-stage'], sourcemaps: { status: 'skipped', uploaded: 0, failed: 0 } })
    await deploy()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(deployers.deployStatic).toHaveBeenCalledWith({
      projectName: 'example-app',
      environment: 'release-candidate',
      image: IMAGE,
      runtimeProject: '',
      appUrl: 'https://example-site.example.org',
      revision: 'candidate-2026-11-04-10150',
      stopRolloutOnFailure: false
    })
    expect(outputs()).toMatchObject({ 'deployed-image': IMAGE, services: 'example-site-stage', 'sourcemaps-status': 'skipped' })
  })

  it('passes an empty revision when an older workflow sets none', async () => {
    Object.assign(inputs, base, { type: 'static' })
    deployers.deployStatic.mockResolvedValue({ deployedImage: IMAGE, services: [] })
    await deploy()
    expect(deployers.deployStatic.mock.calls[0][0]).toMatchObject({ revision: '', stopRolloutOnFailure: true })
  })

  it('still sends the other types where they went', async () => {
    for (const [type, fn] of [['ecs', 'deployEcs'], ['lambda', 'deployLambda']]) {
      deployers[fn].mockResolvedValue({ deployedImage: IMAGE, services: [] })
      Object.assign(inputs, base, { type })
      await deploy()
      expect(deployers[fn]).toHaveBeenCalledTimes(1)
    }
    expect(deployers.deployStatic).not.toHaveBeenCalled()
  })

  it.each(UNKNOWN)('refuses type %j, naming every type it knows, and deploys nothing', async (type) => {
    Object.assign(inputs, base, { type })
    await deploy()
    expect(core.setFailed).toHaveBeenCalledWith(`Unknown type "${type}". Expected one of: ecs, lambda, cloudrun, static.`)
    expect(nothingRan()).toBe(true)
  })

  it('knows exactly four types', () => {
    expect([...DEPLOY_TYPES].sort()).toEqual(['cloudrun', 'ecs', 'lambda', 'static'])
  })
})

describe('resolve-image router', () => {
  it.each([
    ['tag', { mode: 'tag', tag: 'candidate-2026-11-04-10150' }],
    ['environment', { mode: 'environment', environment: 'release-candidate' }]
  ])('sends static to the static resolver in %s mode', async (_label, mode) => {
    Object.assign(inputs, { type: 'static', 'project-name': 'example-app', ...mode })
    resolvers.resolveStatic.mockResolvedValue({ image: IMAGE, digest: DIGEST, tags: ['candidate-2026-11-04-10150', 'sha-ddd4444'] })
    await resolve()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(resolvers.resolveStatic).toHaveBeenCalledWith(expect.objectContaining({ projectName: 'example-app', ...mode }))
    expect(outputs()).toEqual({ found: 'true', image: IMAGE, digest: DIGEST, tags: 'candidate-2026-11-04-10150,sha-ddd4444' })
  })

  it('reports nothing when the static resolver finds nothing live', async () => {
    Object.assign(inputs, { type: 'static', 'project-name': 'example-app', mode: 'environment', environment: 'release-candidate' })
    resolvers.resolveStatic.mockRejectedValue(new Error('Nothing is live in release-candidate for example-app yet'))
    await resolve()
    expect(core.setFailed).toHaveBeenCalledWith('Nothing is live in release-candidate for example-app yet')
    expect(outputs()).toEqual({})
  })

  it.each(UNKNOWN)('refuses type %j and resolves nothing', async (type) => {
    Object.assign(inputs, { type, 'project-name': 'example-app', mode: 'tag', tag: 'candidate-1' })
    await resolve()
    expect(core.setFailed).toHaveBeenCalledWith(`Unknown type "${type}". Expected one of: ecs, lambda, cloudrun, static.`)
    expect(nothingRan()).toBe(true)
  })
})

describe('tag-image router', () => {
  it('re-tags a static site\'s digest in ECR, with no companions to look for', async () => {
    Object.assign(inputs, { type: 'static', 'project-name': 'example-app', digest: DIGEST, tag: 'release-2026-11-04-10150' })
    ecrRetagDigest.mockResolvedValue({ image: IMAGE })
    await tag()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(ecrRetagDigest).toHaveBeenCalledWith('example-app', DIGEST, 'release-2026-11-04-10150')
    expect(openImage).not.toHaveBeenCalled()
    expect(addTag).not.toHaveBeenCalled()
  })

  it('refuses a release tag for a static site without the authorize-actor check, like any type', async () => {
    vi.stubEnv(AUTHORIZED_ATTEMPT_MARKER, '')
    Object.assign(inputs, { type: 'static', 'project-name': 'example-app', digest: DIGEST, tag: 'release-2026-11-04-10150' })
    await tag()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/^refusing to add the release tag release-2026-11-04-10150/))
    expect(ecrRetagDigest).not.toHaveBeenCalled()
  })

  it.each(UNKNOWN)('refuses type %j and tags nothing', async (type) => {
    Object.assign(inputs, { type, 'project-name': 'example-app', digest: DIGEST, tag: 'release-1' })
    await tag()
    expect(core.setFailed).toHaveBeenCalledWith(`Unknown type "${type}". Expected one of: ecs, lambda, cloudrun, static.`)
    expect(nothingRan()).toBe(true)
  })
})
