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
  },
  ImageNotFoundException: class extends Error {
    constructor (message) { super(message); this.name = 'ImageNotFoundException' }
  },
  RepositoryNotFoundException: class extends Error {
    constructor (message) { super(message); this.name = 'RepositoryNotFoundException' }
  }
}))

import { ImageAlreadyExistsException, ImageNotFoundException, RepositoryNotFoundException } from '@aws-sdk/client-ecr'
import {
  composeTaskDefinition,
  ecrDigestExists,
  ecrImageRef,
  ecrRepo,
  ecrResolveDigest,
  ecrRetagDigest,
  ecrTagsForDigest,
  ecsServiceRegExp,
  isEcsAppContainer
} from '../src/v2/aws.js'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../src/ecs-config.js'

const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)

beforeEach(() => {
  sendMock.mockReset()
})

describe('ECR naming (keyed on project name)', () => {
  it('repo is the project name', () => {
    expect(ecrRepo('example-app')).toBe('example-app')
  })

  it('builds a digest-pinned reference in the shared cruds registry', () => {
    expect(ecrImageRef('example-app', 'sha256:abc')).toBe(`${REGISTRY}/example-app@sha256:abc`)
  })
})

describe('ecrResolveDigest', () => {
  it('resolves a tag to a digest and reports the tags on it', async () => {
    sendMock.mockResolvedValue({
      imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-10012', 'sha-abc123'] }]
    })

    const result = await ecrResolveDigest('example-app', 'candidate-10012')

    expect(result).toEqual({ digest: 'sha256:aaa', tags: ['candidate-10012', 'sha-abc123'] })
    const command = sendMock.mock.calls[0][0]
    expect(command.kind).toBe('DescribeImages')
    expect(command.input).toEqual({ repositoryName: 'example-app', imageIds: [{ imageTag: 'candidate-10012' }] })
  })

  it('throws when the tag is absent', async () => {
    sendMock.mockResolvedValue({ imageDetails: [] })
    await expect(ecrResolveDigest('example-app', 'candidate-99999')).rejects.toThrow(/not found/)
  })
})

describe('ecrResolveDigest D10 bare-number fallback', () => {
  // First call (exact tag) rejects; scan pages return the repo's tags; final
  // call resolves the discovered dated tag.
  it('finds a dated release from a bare build number', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('ImageNotFoundException'))
      .mockResolvedValueOnce({
        imageDetails: [
          { imageDigest: 'sha256:aaa', imageTags: ['candidate-2026-07-23-10056', 'release-2026-07-23-10056'] }
        ],
        nextToken: 'page2'
      })
      .mockResolvedValueOnce({
        imageDetails: [{ imageDigest: 'sha256:bbb', imageTags: ['candidate-2026-07-23-10057'] }]
      })
      .mockResolvedValueOnce({
        imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-2026-07-23-10056', 'release-2026-07-23-10056'] }]
      })

    const result = await ecrResolveDigest('example-app', 'release-10056')

    expect(result.digest).toBe('sha256:aaa')
    expect(result.tags).toContain('release-2026-07-23-10056')
    // the scan pages carried maxResults, the final resolve used the dated tag
    expect(sendMock.mock.calls[1][0].input.maxResults).toBe(1000)
    expect(sendMock.mock.calls[3][0].input.imageIds).toEqual([{ imageTag: 'release-2026-07-23-10056' }])
  })

  it('rethrows the original error when nothing matches the bare number', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('ImageNotFoundException'))
      .mockResolvedValueOnce({ imageDetails: [{ imageDigest: 'sha256:bbb', imageTags: ['release-2026-07-23-10057'] }] })

    await expect(ecrResolveDigest('example-app', 'release-10056'))
      .rejects.toThrow(/ImageNotFoundException/)
  })

  it('does not fall back for non-release tags', async () => {
    sendMock.mockRejectedValueOnce(new Error('ImageNotFoundException'))

    await expect(ecrResolveDigest('example-app', 'candidate-10056'))
      .rejects.toThrow(/ImageNotFoundException/)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('never guesses between ambiguous dated matches', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('ImageNotFoundException'))
      .mockResolvedValueOnce({
        imageDetails: [
          { imageDigest: 'sha256:aaa', imageTags: ['release-2026-07-23-10056'] },
          { imageDigest: 'sha256:bbb', imageTags: ['release-2026-07-24-10056'] }
        ]
      })

    await expect(ecrResolveDigest('example-app', 'release-10056'))
      .rejects.toThrow(/ImageNotFoundException/)
  })
})

describe('ecrTagsForDigest', () => {
  it('returns the tags currently on a digest', async () => {
    sendMock.mockResolvedValue({ imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['release-3'] }] })
    expect(await ecrTagsForDigest('example-app', 'sha256:aaa')).toEqual(['release-3'])
  })

  it('returns [] when the digest is unknown (call rejects)', async () => {
    sendMock.mockRejectedValue(new Error('ImageNotFoundException'))
    expect(await ecrTagsForDigest('example-app', 'sha256:missing')).toEqual([])
  })
})

describe('ecrDigestExists', () => {
  it('is true when the repository has the digest', async () => {
    sendMock.mockResolvedValue({ imageDetails: [{ imageDigest: 'sha256:aaa' }] })

    expect(await ecrDigestExists('example-app/worker', 'sha256:aaa')).toBe(true)
    expect(sendMock.mock.calls[0][0].input).toEqual({ repositoryName: 'example-app/worker', imageIds: [{ imageDigest: 'sha256:aaa' }] })
  })

  it.each([
    ['the image', new ImageNotFoundException('not found')],
    ['the repository', new RepositoryNotFoundException('no repository')]
  ])('is false when %s is missing', async (_, error) => {
    sendMock.mockRejectedValue(error)
    expect(await ecrDigestExists('example-app/worker', 'sha256:missing')).toBe(false)
  })

  it('throws any other error, which says nothing about the image', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('not allowed'), { name: 'AccessDeniedException' }))
    await expect(ecrDigestExists('example-app/worker', 'sha256:aaa')).rejects.toThrow('not allowed')
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

    const result = await ecrRetagDigest('example-app', 'sha256:aaa', 'release-10038')

    const batch = sendMock.mock.calls.find(c => c[0].kind === 'BatchGetImage')[0]
    expect(batch.input.repositoryName).toBe('example-app')
    expect(batch.input.imageIds).toEqual([{ imageDigest: 'sha256:aaa' }])

    const put = sendMock.mock.calls.find(c => c[0].kind === 'PutImage')[0]
    expect(put.input).toEqual({
      repositoryName: 'example-app',
      imageManifest: '{"schemaVersion":2}',
      imageManifestMediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      imageTag: 'release-10038'
    })

    expect(result).toEqual({
      repository: 'example-app',
      digest: 'sha256:aaa',
      tag: 'release-10038',
      image: `${REGISTRY}/example-app@sha256:aaa`
    })
  })

  it('throws when the digest is not present', async () => {
    sendMock.mockResolvedValue({ images: [] })
    await expect(ecrRetagDigest('example-app', 'sha256:missing', 'release-1')).rejects.toThrow(/not found/)
  })

  it('tolerates a tag that already points at the digest (idempotent)', async () => {
    sendMock.mockImplementation(command => {
      if (command.kind === 'BatchGetImage') {
        return Promise.resolve({ images: [{ imageManifest: '{}', imageManifestMediaType: 'm' }] })
      }
      return Promise.reject(new ImageAlreadyExistsException('exists'))
    })
    await expect(ecrRetagDigest('example-app', 'sha256:aaa', 'release-1')).resolves.toMatchObject({ tag: 'release-1' })
  })
})

describe('ecsServiceRegExp', () => {
  it('matches the legacy long name and the nickname, not a substring', () => {
    const re = ecsServiceRegExp('example-app', 'staging', 'stage')
    expect(re.test('arn:aws:ecs:us-east-1:1:service/stage/example-app-staging-web')).toBe(true)
    expect(re.test('arn:aws:ecs:us-east-1:1:service/stage/example-app-stage-worker')).toBe(true)
    expect(re.test('arn:aws:ecs:us-east-1:1:service/stage/example-application-stage-web')).toBe(false)
  })
})

describe('isEcsAppContainer', () => {
  it('treats the scratch placeholder as the app container', () => {
    expect(isEcsAppContainer({ image: 'scratch' }, 'example-app')).toBe(true)
  })

  it('matches by ECR repo name, for both digest and tag refs', () => {
    expect(isEcsAppContainer({ image: `${REGISTRY}/example-app@sha256:aaa` }, 'example-app')).toBe(true)
    expect(isEcsAppContainer({ image: `${REGISTRY}/example-app:staging-101` }, 'example-app')).toBe(true)
  })

  it('does not match sidecars (nginx, fluentbit) or a different repo', () => {
    expect(isEcsAppContainer({ name: 'nginx', image: 'public.ecr.aws/nginx/nginx:latest' }, 'example-app')).toBe(false)
    expect(isEcsAppContainer({ name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' }, 'example-app')).toBe(false)
    expect(isEcsAppContainer({ image: `${REGISTRY}/example-app-web@sha256:aaa` }, 'example-app')).toBe(false)
    expect(isEcsAppContainer({ name: 'x' }, 'example-app')).toBe(false)
  })
})

describe('composeTaskDefinition', () => {
  const base = {
    family: 'example-app-stage-web',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/example-app-stage-web:7',
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
  const secrets = [{ name: 'DATABASE_URL', valueFrom: '/ecs/example-app/stage/DATABASE_URL' }]
  const image = `${REGISTRY}/example-app@sha256:new`

  it('strips read-only fields, swaps only the app container, preserves sidecars', () => {
    const composed = composeTaskDefinition(base, { projectName: 'example-app', image, secrets, tags: [] })

    for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']) {
      expect(composed).not.toHaveProperty(key)
    }
    expect(composed.family).toBe('example-app-stage-web')
    expect(composed.cpu).toBe('256')

    expect(composed.containerDefinitions[0]).toEqual({ name: 'app', image, secrets })
    // sidecar passes through untouched
    expect(composed.containerDefinitions[1]).toEqual({ name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' })
  })

  it('does not mutate the source task definition', () => {
    composeTaskDefinition(base, { projectName: 'example-app', image, secrets, tags: [] })
    expect(base.containerDefinitions[0].image).toBe('scratch')
  })

  it('only sets tags when non-empty (AWS rejects an empty tags array)', () => {
    expect(composeTaskDefinition(base, { projectName: 'example-app', image, secrets, tags: [] })).not.toHaveProperty('tags')
    const withTags = composeTaskDefinition(base, {
      projectName: 'example-app', image, secrets, tags: [{ key: 'team', value: 'devops' }]
    })
    expect(withTags.tags).toEqual([{ key: 'team', value: 'devops' }])
  })
})

