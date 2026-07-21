import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the provider tagging fns + @actions/core. `inputs` is the per-test
// getInput backing map, enforcing `required` the way @actions/core does.
const { addTag, ecrRetagDigest, setOutputMock, setFailedMock, infoMock, inputs } = vi.hoisted(() => ({
  addTag: vi.fn(),
  ecrRetagDigest: vi.fn(),
  setOutputMock: vi.fn(),
  setFailedMock: vi.fn(),
  infoMock: vi.fn(),
  inputs: {}
}))

vi.mock('../src/v2/gcp.js', () => ({ addTag, sharedRegistryRepo: name => name }))
vi.mock('../src/v2/aws.js', () => ({ ecrRetagDigest }))
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

import { assertDigest, run } from '../src/tag-image.js'

const DIGEST = 'sha256:' + 'a'.repeat(64)

beforeEach(() => {
  addTag.mockReset()
  ecrRetagDigest.mockReset()
  setOutputMock.mockReset()
  setFailedMock.mockReset()
  infoMock.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
})

describe('assertDigest', () => {
  it('accepts a bare sha256 digest', () => {
    expect(() => assertDigest(DIGEST)).not.toThrow()
  })

  it.each(['sha256:abc', 'abc', `${DIGEST}:tag`, 'sha512:' + 'a'.repeat(64)])('rejects %j', (d) => {
    expect(() => assertDigest(d)).toThrow(/sha256/)
  })
})

describe('run cloudrun', () => {
  it('tags via Artifact Registry (repo == package == project)', async () => {
    inputs.type = 'cloudrun'
    inputs['project-name'] = 'hoax'
    inputs.digest = DIGEST
    inputs.tag = 'release-10038'
    addTag.mockResolvedValue({ tag: 'release-10038', version: 'v', image: 'gcp-ref@sha256' })

    await run()

    expect(addTag).toHaveBeenCalledWith('cru-shared-artifacts', 'hoax', 'hoax', DIGEST, 'release-10038')
    expect(ecrRetagDigest).not.toHaveBeenCalled()
    expect(setOutputMock).toHaveBeenCalledWith('image', 'gcp-ref@sha256')
    expect(setOutputMock).toHaveBeenCalledWith('tag', 'release-10038')
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('honors a registry-project override', async () => {
    inputs.type = 'cloudrun'
    inputs['project-name'] = 'hoax'
    inputs.digest = DIGEST
    inputs.tag = 'release-1'
    inputs['registry-project'] = 'cru-other-registry'
    addTag.mockResolvedValue({ image: 'x', tag: 'release-1' })

    await run()

    expect(addTag).toHaveBeenCalledWith('cru-other-registry', 'hoax', 'hoax', DIGEST, 'release-1')
  })
})

describe('run ecs / lambda', () => {
  it.each(['ecs', 'lambda'])('re-tags the ECR manifest for %s', async (type) => {
    inputs.type = type
    inputs['project-name'] = 'hoax'
    inputs.digest = DIGEST
    inputs.tag = 'release-10038'
    ecrRetagDigest.mockResolvedValue({ image: 'ecr-ref@sha256', tag: 'release-10038' })

    await run()

    expect(ecrRetagDigest).toHaveBeenCalledWith('hoax', DIGEST, 'release-10038')
    expect(addTag).not.toHaveBeenCalled()
    expect(setOutputMock).toHaveBeenCalledWith('image', 'ecr-ref@sha256')
  })
})

describe('run failures (never throw)', () => {
  it('fails on an unknown type', async () => {
    inputs.type = 'fargate'
    inputs['project-name'] = 'hoax'
    inputs.digest = DIGEST
    inputs.tag = 'release-1'
    await run()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/Unknown type/))
  })

  it('fails on a malformed digest before dispatching', async () => {
    inputs.type = 'ecs'
    inputs['project-name'] = 'hoax'
    inputs.digest = 'not-a-digest'
    inputs.tag = 'release-1'
    await run()
    expect(ecrRetagDigest).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/sha256/))
  })

  it('fails when a required input is missing', async () => {
    inputs.type = 'ecs'
    inputs['project-name'] = 'hoax'
    await run()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/digest/))
  })
})
