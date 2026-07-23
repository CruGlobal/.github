import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for the Lambda list/get reads, and the ECR SDK for the
// tag/digest lookups. src/v2/aws.js, src/v2/env.js and src/ecs-config.js run for
// real (ecrRegistry is pure; the ECR helpers hit the mocked SDK).
vi.mock('../src/aws.js', () => ({
  lambdaListFunctionNames: vi.fn(),
  lambdaGetFunction: vi.fn()
}))

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: class { send (command) { return sendMock(command) } },
  DescribeImagesCommand: class { constructor (input) { this.kind = 'DescribeImages'; this.input = input } },
  BatchGetImageCommand: class { constructor (input) { this.kind = 'BatchGetImage'; this.input = input } },
  PutImageCommand: class { constructor (input) { this.kind = 'PutImage'; this.input = input } },
  ImageAlreadyExistsException: class extends Error {}
}))

import * as aws from '../src/aws.js'
import { resolveLambda } from '../src/v2/resolve-lambda.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'

// GetFunction response shape: { Configuration: {...}, Code: {...} }.
function imageFn (resolvedImageUri) {
  return { Configuration: { PackageType: 'Image' }, Code: { ResolvedImageUri: resolvedImageUri } }
}
function zipFn () {
  return { Configuration: { PackageType: 'Zip' }, Code: {} }
}

beforeEach(() => {
  aws.lambdaListFunctionNames.mockReset()
  aws.lambdaGetFunction.mockReset()
  sendMock.mockReset()
})

describe('resolveLambda mode=tag', () => {
  it('resolves an ECR tag to a digest reference + its tags', async () => {
    sendMock.mockResolvedValue({
      imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-10012', 'sha-abc'] }]
    })

    const result = await resolveLambda({ mode: 'tag', projectName: 'hoax', tag: 'candidate-10012' })

    expect(result).toEqual({
      image: `${REGISTRY}/hoax@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc']
    })
    expect(aws.lambdaListFunctionNames).not.toHaveBeenCalled()
  })
})

describe('resolveLambda mode=environment', () => {
  it('returns the deployed digest ref + its tags, skipping non-image and scratch functions', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['hoax-stage-a', 'hoax-stage-b', 'hoax-stage-c'])
    aws.lambdaGetFunction.mockImplementation(name => {
      switch (name) {
        case 'hoax-stage-a': return Promise.resolve(zipFn())
        case 'hoax-stage-b': return Promise.resolve(imageFn(`${REGISTRY}/scratch@sha256:zzz`))
        case 'hoax-stage-c': return Promise.resolve(imageFn(`${REGISTRY}/hoax@sha256:aaa`))
      }
    })
    sendMock.mockImplementation(command => {
      // ecrTagsForDigest: DescribeImages by digest.
      expect(command.input.imageIds).toEqual([{ imageDigest: 'sha256:aaa' }])
      return Promise.resolve({ imageDetails: [{ imageTags: ['candidate-10013', 'release-4'] }] })
    })

    const result = await resolveLambda({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'release-candidate'
    })

    expect(result).toEqual({
      image: `${REGISTRY}/hoax@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10013', 'release-4']
    })
    // release-candidate -> nickname stage
    expect(aws.lambdaListFunctionNames).toHaveBeenCalledWith('hoax', 'stage')
    // Stopped at the first match (fn-c); the scratch fn before it did not match.
    expect(aws.lambdaGetFunction).toHaveBeenCalledTimes(3)
  })

  it('returns empty tags when the digest is not describable (tags lookup swallowed)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['hoax-prod-x'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/hoax@sha256:bbb`))
    sendMock.mockRejectedValue(new Error('not found'))

    const result = await resolveLambda({ mode: 'environment', projectName: 'hoax', environment: 'production' })

    expect(result).toEqual({ image: `${REGISTRY}/hoax@sha256:bbb`, digest: 'sha256:bbb', tags: [] })
  })

  it('throws when no functions match the project + nickname', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue([])
    await expect(
      resolveLambda({ mode: 'environment', projectName: 'hoax', environment: 'production' })
    ).rejects.toThrow(/No Lambda functions matching/)
  })

  it('throws when every function is still on the scratch placeholder (never deployed)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['hoax-prod-a', 'hoax-prod-b'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/scratch@sha256:zzz`))
    await expect(
      resolveLambda({ mode: 'environment', projectName: 'hoax', environment: 'production' })
    ).rejects.toThrow(/Could not find a deployed app image/)
  })
})

describe('resolveLambda invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveLambda({ mode: 'nope', projectName: 'hoax' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
