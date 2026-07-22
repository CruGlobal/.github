import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for the ECS service/task-def reads, and the ECR SDK for the
// tag/digest lookups. src/v2/aws.js, src/v2/env.js and src/ecs-config.js run for
// real (ecsCluster is pure; the ECR helpers hit the mocked SDK).
vi.mock('../src/aws.js', () => ({
  ecsListServices: vi.fn(),
  ecsServiceTaskDefinitions: vi.fn()
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
import { resolveEcs } from '../src/v2/resolve-ecs.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'
const ARN = 'arn:aws:ecs:us-east-1:056154071827:service/stage/hoax-staging-web'

beforeEach(() => {
  aws.ecsListServices.mockReset()
  aws.ecsServiceTaskDefinitions.mockReset()
  sendMock.mockReset()
})

describe('resolveEcs mode=tag', () => {
  it('resolves an ECR tag to a digest reference + its tags', async () => {
    sendMock.mockResolvedValue({
      imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-10012', 'sha-abc'] }]
    })

    const result = await resolveEcs({ mode: 'tag', projectName: 'hoax', tag: 'candidate-10012' })

    expect(result).toEqual({
      image: `${REGISTRY}/hoax@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc']
    })
    expect(aws.ecsListServices).not.toHaveBeenCalled()
  })
})

describe('resolveEcs mode=environment', () => {
  it('returns the running digest ref (normalized) and its tags, skipping sidecars', async () => {
    aws.ecsListServices.mockResolvedValue([ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({
      [ARN]: {
        containerDefinitions: [
          { name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' },
          { name: 'app', image: `${REGISTRY}/hoax@sha256:aaa` }
        ]
      }
    })
    sendMock.mockImplementation(command => {
      // ecrTagsForDigest: DescribeImages by digest
      expect(command.input.imageIds).toEqual([{ imageDigest: 'sha256:aaa' }])
      return Promise.resolve({ imageDetails: [{ imageTags: ['candidate-10013', 'release-4'] }] })
    })

    const result = await resolveEcs({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'release-candidate'
    })

    expect(result).toEqual({
      image: `${REGISTRY}/hoax@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10013', 'release-4']
    })
    // release-candidate -> nickname stage -> cluster stage
    expect(aws.ecsListServices).toHaveBeenCalledWith(expect.any(RegExp), 'stage')
  })

  it('resolves the tag when the running image is a tag ref', async () => {
    aws.ecsListServices.mockResolvedValue([ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({
      [ARN]: { containerDefinitions: [{ name: 'app', image: `${REGISTRY}/hoax:staging-101` }] }
    })
    sendMock.mockImplementation(command => {
      expect(command.input.imageIds).toEqual([{ imageTag: 'staging-101' }])
      return Promise.resolve({ imageDetails: [{ imageDigest: 'sha256:bbb', imageTags: ['candidate-10014'] }] })
    })

    const result = await resolveEcs({ mode: 'environment', projectName: 'hoax', environment: 'release-candidate' })

    expect(result).toEqual({
      image: `${REGISTRY}/hoax@sha256:bbb`,
      digest: 'sha256:bbb',
      tags: ['candidate-10014']
    })
  })

  it('throws when no matching services exist', async () => {
    aws.ecsListServices.mockResolvedValue([])
    await expect(
      resolveEcs({ mode: 'environment', projectName: 'hoax', environment: 'production' })
    ).rejects.toThrow(/No ECS services matching/)
  })

  it('throws when only a scratch placeholder is present (never deployed)', async () => {
    aws.ecsListServices.mockResolvedValue([ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({
      [ARN]: { containerDefinitions: [{ name: 'app', image: 'scratch' }] }
    })
    await expect(
      resolveEcs({ mode: 'environment', projectName: 'hoax', environment: 'production' })
    ).rejects.toThrow(/Could not find a running app container/)
  })
})

describe('resolveEcs invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveEcs({ mode: 'nope', projectName: 'hoax' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
