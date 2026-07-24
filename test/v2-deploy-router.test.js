import { describe, it, expect, beforeEach, vi } from 'vitest'

// Router-level test for src/deploy.js: it reads the optional `version` input and
// threads it — with the other args — to the type-selected deploy impl. The three
// impls + @actions/core are mocked; the pure env/gcp helpers are stubbed so the
// router runs in isolation (no GCP/AWS SDK load). deploy.js exports `run` and is
// import-safe under VITEST (the auto-run guard), matching tag-image.js.
const { deployCloudRun, deployEcs, deployLambda, setOutputMock, setFailedMock, infoMock, inputs } = vi.hoisted(() => ({
  deployCloudRun: vi.fn(),
  deployEcs: vi.fn(),
  deployLambda: vi.fn(),
  setOutputMock: vi.fn(),
  setFailedMock: vi.fn(),
  infoMock: vi.fn(),
  inputs: {}
}))

vi.mock('../src/v2/deploy-cloudrun.js', () => ({ deployCloudRun }))
vi.mock('../src/v2/deploy-ecs.js', () => ({ deployEcs }))
vi.mock('../src/v2/deploy-lambda.js', () => ({ deployLambda }))
vi.mock('../src/v2/gcp.js', () => ({ assertDigestRef: vi.fn() }))
vi.mock('../src/v2/env.js', () => ({ environmentNickname: () => 'stage' }))
vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  },
  setOutput: setOutputMock,
  setFailed: setFailedMock,
  info: infoMock
}))

import { run } from '../src/deploy.js'

const IMAGE = 'us-central1-docker.pkg.dev/cru-shared-artifacts/hoax/hoax@sha256:' + 'a'.repeat(64)

beforeEach(() => {
  deployCloudRun.mockReset().mockResolvedValue({ deployedImage: IMAGE, services: ['hoax-web'] })
  deployEcs.mockReset().mockResolvedValue({ deployedImage: IMAGE, services: ['hoax-prod-web'] })
  deployLambda.mockReset().mockResolvedValue({ deployedImage: IMAGE, services: ['hoax-prod-app'] })
  setOutputMock.mockReset()
  setFailedMock.mockReset()
  infoMock.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
})

describe('deploy router version passthrough', () => {
  const impls = { cloudrun: () => deployCloudRun, ecs: () => deployEcs, lambda: () => deployLambda }

  it.each(['cloudrun', 'ecs', 'lambda'])('threads version to the %s impl', async (type) => {
    inputs.type = type
    inputs['project-name'] = 'hoax'
    inputs.environment = 'release-candidate'
    inputs.image = IMAGE
    inputs['runtime-project'] = 'hoax-stage-123'
    inputs.version = 'candidate-2026-07-23-10057'

    await run()

    expect(impls[type]()).toHaveBeenCalledWith(expect.objectContaining({
      projectName: 'hoax',
      environment: 'release-candidate',
      image: IMAGE,
      runtimeProject: 'hoax-stage-123',
      version: 'candidate-2026-07-23-10057'
    }))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('passes an empty version through when the input is omitted (version is optional)', async () => {
    inputs.type = 'cloudrun'
    inputs['project-name'] = 'hoax'
    inputs.environment = 'production'
    inputs.image = IMAGE

    await run()

    expect(deployCloudRun).toHaveBeenCalledWith(expect.objectContaining({ version: '' }))
    expect(setFailedMock).not.toHaveBeenCalled()
  })
})
