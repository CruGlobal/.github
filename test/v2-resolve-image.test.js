import { describe, it, expect, beforeEach, vi } from 'vitest'

// resolve-image entrypoint: exercises run() with a mocked core and mocked
// resolvers. The point under test is the missing-ok contract — an absent tag is
// an outcome (found=false) for callers that opt in, and a failure otherwise.
const { inputs, setOutputMock, setFailedMock, infoMock, resolveCloudRunMock } = vi.hoisted(() => ({
  inputs: {},
  setOutputMock: vi.fn(),
  setFailedMock: vi.fn(),
  infoMock: vi.fn(),
  resolveCloudRunMock: vi.fn()
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
  info: infoMock
}))
vi.mock('../src/v2/resolve-cloudrun.js', () => ({ resolveCloudRun: resolveCloudRunMock }))
vi.mock('../src/v2/resolve-ecs.js', () => ({ resolveEcs: vi.fn() }))
vi.mock('../src/v2/resolve-lambda.js', () => ({ resolveLambda: vi.fn() }))

import { run } from '../src/resolve-image.js'
import { TagNotFoundError } from '../src/v2/errors.js'

const outputs = () => Object.fromEntries(setOutputMock.mock.calls)

beforeEach(() => {
  for (const key of Object.keys(inputs)) delete inputs[key]
  Object.assign(inputs, { type: 'cloudrun', 'project-name': 'hoax', mode: 'tag', tag: 'sha-abc' })
  setOutputMock.mockReset()
  setFailedMock.mockReset()
  infoMock.mockReset()
  resolveCloudRunMock.mockReset()
})

describe('resolve-image run()', () => {
  it('reports found=true and the image outputs when the tag resolves', async () => {
    resolveCloudRunMock.mockResolvedValue({ image: 'reg/hoax@sha256:aaa', digest: 'sha256:aaa', tags: ['sha-abc', 'candidate-1'] })

    await run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(outputs()).toEqual({ found: 'true', image: 'reg/hoax@sha256:aaa', digest: 'sha256:aaa', tags: 'sha-abc,candidate-1' })
  })

  it('fails on a missing tag by default', async () => {
    resolveCloudRunMock.mockRejectedValue(new TagNotFoundError('sha-abc', 'cru-shared-artifacts/hoax'))

    await run()

    expect(setFailedMock).toHaveBeenCalledWith('Tag "sha-abc" not found in cru-shared-artifacts/hoax')
    expect(outputs()).toEqual({})
  })

  it('reports found=false without failing when missing-ok is set and the tag is absent', async () => {
    inputs['missing-ok'] = 'true'
    resolveCloudRunMock.mockRejectedValue(new TagNotFoundError('sha-abc', 'cru-shared-artifacts/hoax'))

    await run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(outputs()).toEqual({ found: 'false', image: '', digest: '', tags: '' })
    expect(infoMock).toHaveBeenCalledWith(expect.stringMatching(/not found .* found=false/))
  })

  it('still fails on any other error when missing-ok is set', async () => {
    inputs['missing-ok'] = 'true'
    resolveCloudRunMock.mockRejectedValue(new Error('registry unavailable'))

    await run()

    expect(setFailedMock).toHaveBeenCalledWith('registry unavailable')
    expect(outputs()).toEqual({})
  })
})
