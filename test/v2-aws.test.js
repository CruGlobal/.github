import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the ECR SDK so ecrResolveDigest / ecrTagsForDigest / ecrRetagDigest hit a
// canned client. The mock also satisfies v1 src/aws.js's import of the same
// module (ECRClient, BatchGetImageCommand), which loads transitively via
// src/ecs-config.js.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: class { send (command) { return sendMock(command) } },
  DescribeImagesCommand: class { constructor (input) { this.kind = 'DescribeImages'; this.input = input } },
  BatchGetImageCommand: class { constructor (input) { this.kind = 'BatchGetImage'; this.input = input } },
  PutImageCommand: class { constructor (input) { this.kind = 'PutImage'; this.input = input } },
  ImageAlreadyExistsException: class extends Error {
    constructor (message) { super(message); this.name = 'ImageAlreadyExistsException' }
  }
}))

import { ImageAlreadyExistsException } from '@aws-sdk/client-ecr'
import {
  composeTaskDefinition,
  ecrImageRef,
  ecrRepo,
  ecrResolveDigest,
  ecrRetagDigest,
  ecrTagsForDigest,
  ecsServiceRegExp,
  isEcsAppContainer
} from '../src/v2/aws.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'

beforeEach(() => {
  sendMock.mockReset()
})

describe('ECR naming (keyed on project name)', () => {
  it('repo is the project name', () => {
    expect(ecrRepo('hoax')).toBe('hoax')
  })

  it('builds a digest-pinned reference in the shared cruds registry', () => {
    expect(ecrImageRef('hoax', 'sha256:abc')).toBe(`${REGISTRY}/hoax@sha256:abc`)
  })
})

describe('ecrResolveDigest', () => {
  it('resolves a tag to a digest and reports the tags on it', async () => {
    sendMock.mockResolvedValue({
      imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-10012', 'sha-abc123'] }]
    })

    const result = await ecrResolveDigest('hoax', 'candidate-10012')

    expect(result).toEqual({ digest: 'sha256:aaa', tags: ['candidate-10012', 'sha-abc123'] })
    const command = sendMock.mock.calls[0][0]
    expect(command.kind).toBe('DescribeImages')
    expect(command.input).toEqual({ repositoryName: 'hoax', imageIds: [{ imageTag: 'candidate-10012' }] })
  })

  it('throws when the tag is absent', async () => {
    sendMock.mockResolvedValue({ imageDetails: [] })
    await expect(ecrResolveDigest('hoax', 'candidate-99999')).rejects.toThrow(/not found/)
  })
})

describe('ecrTagsForDigest', () => {
  it('returns the tags currently on a digest', async () => {
    sendMock.mockResolvedValue({ imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['release-3'] }] })
    expect(await ecrTagsForDigest('hoax', 'sha256:aaa')).toEqual(['release-3'])
  })

  it('returns [] when the digest is unknown (call rejects)', async () => {
    sendMock.mockRejectedValue(new Error('ImageNotFoundException'))
    expect(await ecrTagsForDigest('hoax', 'sha256:missing')).toEqual([])
  })
})

describe('ecrRetagDigest (manifest re-tag)', () => {
  it('re-puts the digest manifest under the new tag', async () => {
    sendMock.mockImplementation(command => {
      if (command.kind === 'BatchGetImage') {
        return Promise.resolve({
          images: [{ imageManifest: '{"schemaVersion":2}', imageManifestMediaType: 'application/vnd.docker.distribution.manifest.v2+json' }]
        })
      }
      return Promise.resolve({})
    })

    const result = await ecrRetagDigest('hoax', 'sha256:aaa', 'release-10038')

    const batch = sendMock.mock.calls.find(c => c[0].kind === 'BatchGetImage')[0]
    expect(batch.input.repositoryName).toBe('hoax')
    expect(batch.input.imageIds).toEqual([{ imageDigest: 'sha256:aaa' }])

    const put = sendMock.mock.calls.find(c => c[0].kind === 'PutImage')[0]
    expect(put.input).toEqual({
      repositoryName: 'hoax',
      imageManifest: '{"schemaVersion":2}',
      imageManifestMediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      imageTag: 'release-10038'
    })

    expect(result).toEqual({
      repository: 'hoax',
      digest: 'sha256:aaa',
      tag: 'release-10038',
      image: `${REGISTRY}/hoax@sha256:aaa`
    })
  })

  it('throws when the digest is not present', async () => {
    sendMock.mockResolvedValue({ images: [] })
    await expect(ecrRetagDigest('hoax', 'sha256:missing', 'release-1')).rejects.toThrow(/not found/)
  })

  it('tolerates a tag that already points at the digest (idempotent)', async () => {
    sendMock.mockImplementation(command => {
      if (command.kind === 'BatchGetImage') {
        return Promise.resolve({ images: [{ imageManifest: '{}', imageManifestMediaType: 'm' }] })
      }
      return Promise.reject(new ImageAlreadyExistsException('exists'))
    })
    await expect(ecrRetagDigest('hoax', 'sha256:aaa', 'release-1')).resolves.toMatchObject({ tag: 'release-1' })
  })
})

describe('ecsServiceRegExp', () => {
  it('matches the legacy long name and the nickname, not a substring', () => {
    const re = ecsServiceRegExp('hoax', 'staging', 'stage')
    expect(re.test('arn:aws:ecs:us-east-1:1:service/stage/hoax-staging-web')).toBe(true)
    expect(re.test('arn:aws:ecs:us-east-1:1:service/stage/hoax-stage-worker')).toBe(true)
    expect(re.test('arn:aws:ecs:us-east-1:1:service/stage/hoaxious-stage-web')).toBe(false)
  })
})

describe('isEcsAppContainer', () => {
  it('treats the scratch placeholder as the app container', () => {
    expect(isEcsAppContainer({ image: 'scratch' }, 'hoax')).toBe(true)
  })

  it('matches by ECR repo name, for both digest and tag refs', () => {
    expect(isEcsAppContainer({ image: `${REGISTRY}/hoax@sha256:aaa` }, 'hoax')).toBe(true)
    expect(isEcsAppContainer({ image: `${REGISTRY}/hoax:staging-101` }, 'hoax')).toBe(true)
  })

  it('does not match sidecars (nginx, fluentbit) or a different repo', () => {
    expect(isEcsAppContainer({ name: 'nginx', image: 'public.ecr.aws/nginx/nginx:latest' }, 'hoax')).toBe(false)
    expect(isEcsAppContainer({ name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' }, 'hoax')).toBe(false)
    expect(isEcsAppContainer({ image: `${REGISTRY}/hoax-web@sha256:aaa` }, 'hoax')).toBe(false)
    expect(isEcsAppContainer({ name: 'x' }, 'hoax')).toBe(false)
  })
})

describe('composeTaskDefinition', () => {
  const base = {
    family: 'hoax-stage-web',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/hoax-stage-web:7',
    revision: 7,
    status: 'ACTIVE',
    requiresAttributes: [{ name: 'x' }],
    compatibilities: ['FARGATE'],
    registeredAt: '2026-01-01',
    registeredBy: 'terraform',
    cpu: '256',
    memory: '512',
    containerDefinitions: [
      { name: 'app', image: 'scratch', secrets: [] },
      { name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' }
    ]
  }
  const secrets = [{ name: 'DATABASE_URL', valueFrom: '/ecs/hoax/stage/DATABASE_URL' }]
  const image = `${REGISTRY}/hoax@sha256:new`

  it('strips read-only fields, swaps only the app container, preserves sidecars', () => {
    const composed = composeTaskDefinition(base, { projectName: 'hoax', image, secrets, tags: [] })

    for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']) {
      expect(composed).not.toHaveProperty(key)
    }
    expect(composed.family).toBe('hoax-stage-web')
    expect(composed.cpu).toBe('256')

    expect(composed.containerDefinitions[0]).toEqual({ name: 'app', image, secrets })
    // sidecar passes through untouched
    expect(composed.containerDefinitions[1]).toEqual({ name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' })
  })

  it('does not mutate the source task definition', () => {
    composeTaskDefinition(base, { projectName: 'hoax', image, secrets, tags: [] })
    expect(base.containerDefinitions[0].image).toBe('scratch')
  })

  it('only sets tags when non-empty (AWS rejects an empty tags array)', () => {
    expect(composeTaskDefinition(base, { projectName: 'hoax', image, secrets, tags: [] })).not.toHaveProperty('tags')
    const withTags = composeTaskDefinition(base, {
      projectName: 'hoax', image, secrets, tags: [{ key: 'team', value: 'devops' }]
    })
    expect(withTags.tags).toEqual([{ key: 'team', value: 'devops' }])
  })
})
