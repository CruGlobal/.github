import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for the Lambda list/get reads, and the ECR SDK for the
// tag/digest lookups. src/v2/aws.js, src/v2/env.js and src/ecs-config.js run for
// real (ecrRegistry is pure; the ECR helpers hit the mocked SDK).
vi.mock('../src/aws.js', () => ({
  lambdaListFunctionNames: vi.fn(),
  lambdaGetFunction: vi.fn(),
  lambdaGetAlias: vi.fn()
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
import { DEFAULT_ACCOUNT, ecrRegistry } from '../src/ecs-config.js'
import { resolveLambda } from '../src/v2/resolve-lambda.js'

const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)

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
  aws.lambdaGetAlias.mockReset()
  aws.lambdaGetAlias.mockRejectedValue(Object.assign(new Error('Alias not found'), { name: 'ResourceNotFoundException' }))
  sendMock.mockReset()
})

describe('resolveLambda mode=tag', () => {
  it('resolves an ECR tag to a digest reference + its tags', async () => {
    sendMock.mockResolvedValue({
      imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-10012', 'sha-abc'] }]
    })

    const result = await resolveLambda({ mode: 'tag', projectName: 'example-app', tag: 'candidate-10012' })

    expect(result).toEqual({
      image: `${REGISTRY}/example-app@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc']
    })
    expect(aws.lambdaListFunctionNames).not.toHaveBeenCalled()
  })
})

describe('resolveLambda mode=environment', () => {
  it('returns the deployed digest ref + its tags, skipping non-image and scratch functions', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-stage-a', 'example-app-stage-b', 'example-app-stage-c'])
    aws.lambdaGetFunction.mockImplementation(name => {
      switch (name) {
        case 'example-app-stage-a': return Promise.resolve(zipFn())
        case 'example-app-stage-b': return Promise.resolve(imageFn(`${REGISTRY}/scratch@sha256:zzz`))
        case 'example-app-stage-c': return Promise.resolve(imageFn(`${REGISTRY}/example-app@sha256:aaa`))
      }
    })
    sendMock.mockImplementation(command => {
      // ecrTagsForDigest: DescribeImages by digest.
      expect(command.input.imageIds).toEqual([{ imageDigest: 'sha256:aaa' }])
      return Promise.resolve({ imageDetails: [{ imageTags: ['candidate-10013', 'release-4'] }] })
    })

    const result = await resolveLambda({
      mode: 'environment',
      projectName: 'example-app',
      environment: 'release-candidate'
    })

    expect(result).toEqual({
      image: `${REGISTRY}/example-app@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10013', 'release-4']
    })
    // release-candidate -> nickname stage
    expect(aws.lambdaListFunctionNames).toHaveBeenCalledWith('example-app', 'stage')
    // Stopped at the first match (fn-c); the scratch fn before it did not match.
    expect(aws.lambdaGetFunction).toHaveBeenCalledTimes(3)
  })

  it('returns empty tags when the digest is not describable (tags lookup swallowed)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-x'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/example-app@sha256:bbb`))
    sendMock.mockRejectedValue(new Error('not found'))

    const result = await resolveLambda({ mode: 'environment', projectName: 'example-app', environment: 'production' })

    expect(result).toEqual({ image: `${REGISTRY}/example-app@sha256:bbb`, digest: 'sha256:bbb', tags: [] })
  })

  it('throws when no functions match the project + nickname', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue([])
    await expect(
      resolveLambda({ mode: 'environment', projectName: 'example-app', environment: 'production' })
    ).rejects.toThrow(/No Lambda functions matching/)
  })

  it('throws when every function is still on the scratch placeholder (never deployed)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-a', 'example-app-prod-b'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/scratch@sha256:zzz`))
    await expect(
      resolveLambda({ mode: 'environment', projectName: 'example-app', environment: 'production' })
    ).rejects.toThrow(/Could not find a deployed app image/)
  })
})

describe('resolveLambda mode=environment, for a function with a live alias', () => {
  const LATEST = `${REGISTRY}/example-app@sha256:latest`
  const LIVE = `${REGISTRY}/example-app@sha256:live`
  beforeEach(() => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-a'])
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => imageFn(qualifier === '7' ? LIVE : LATEST))
    sendMock.mockResolvedValue({ imageDetails: [{ imageTags: [] }] })
  })
  const resolve = () => resolveLambda({ mode: 'environment', projectName: 'example-app', environment: 'production' })

  it('returns the image of the version the alias points at, which is what its triggers call', async () => {
    aws.lambdaGetAlias.mockResolvedValue({ FunctionVersion: '7', RevisionId: 'r' })

    expect((await resolve()).image).toBe(LIVE)
    expect(aws.lambdaGetAlias).toHaveBeenCalledWith('example-app-prod-a', 'live')
    expect(aws.lambdaGetFunction).toHaveBeenCalledWith('example-app-prod-a', '7')
  })

  it('returns $LATEST\'s image when the alias points at $LATEST', async () => {
    aws.lambdaGetAlias.mockResolvedValue({ FunctionVersion: '$LATEST', RevisionId: 'r' })
    expect((await resolve()).image).toBe(LATEST)
  })

  it('returns $LATEST\'s image when the role cannot read aliases yet', async () => {
    aws.lambdaGetAlias.mockRejectedValue(Object.assign(new Error('not authorized'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 }
    }))
    expect((await resolve()).image).toBe(LATEST)
  })

  it('reads no alias on a function that is not the app\'s, so it cannot fail the resolve', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-other', 'example-app-prod-a'])
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) =>
      name === 'example-app-prod-other' ? imageFn(`${REGISTRY}/scratch@sha256:zzz`) : imageFn(qualifier === '7' ? LIVE : LATEST))
    aws.lambdaGetAlias.mockImplementation(async name => name === 'example-app-prod-other'
      ? { FunctionVersion: '2', RoutingConfig: { AdditionalVersionWeights: { 1: 0.5 } } }
      : { FunctionVersion: '7', RevisionId: 'r' })

    expect((await resolve()).image).toBe(LIVE)
    expect(aws.lambdaGetAlias).not.toHaveBeenCalledWith('example-app-prod-other', 'live')
  })

  it('throws when the alias splits traffic between versions', async () => {
    aws.lambdaGetAlias.mockResolvedValue({
      FunctionVersion: '7',
      RevisionId: 'r',
      RoutingConfig: { AdditionalVersionWeights: { 6: 0.5 } }
    })
    await expect(resolve()).rejects.toThrow(/splits traffic between version 7 and version 6/)
  })
})

describe('resolveLambda invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveLambda({ mode: 'nope', projectName: 'example-app' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
