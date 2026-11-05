import { describe, it, expect, beforeEach, vi } from 'vitest'

// resolveStatic, through the real src/v2/aws.js calls with the ECR, S3 and
// DynamoDB SDKs canned. Tag mode is the ECR path ECS and Lambda use, the
// bare-number release lookup included. Environment mode reads which release
// the bucket serves from index.html's metadata.
const { ecrSend, s3Send, dynamoSend, command } = vi.hoisted(() => ({
  ecrSend: vi.fn(),
  s3Send: vi.fn(),
  dynamoSend: vi.fn(),
  command: op => class {
    constructor (input) {
      this.op = op
      this.input = input
    }
  }
}))
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: class { send (cmd) { return ecrSend(cmd) } },
  DescribeImagesCommand: command('DescribeImages'),
  BatchGetImageCommand: command('BatchGetImage'),
  PutImageCommand: command('PutImage'),
  GetDownloadUrlForLayerCommand: command('GetDownloadUrlForLayer'),
  ImageAlreadyExistsException: class extends Error {},
  ImageNotFoundException: class extends Error {},
  RepositoryNotFoundException: class extends Error {}
}))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send (cmd) { return s3Send(cmd) } },
  PutObjectCommand: command('PutObject'),
  HeadObjectCommand: command('HeadObject')
}))
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { send (cmd) { return dynamoSend(cmd) } },
  GetItemCommand: command('GetItem'),
  UpdateItemCommand: command('UpdateItem')
}))
vi.mock('@actions/core', () => ({ info: vi.fn(), warning: vi.fn() }))

import { resolveStatic } from '../src/v2/resolve-static.js'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../src/ecs-config.js'

const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)
const DIGEST = 'sha256:' + 'c'.repeat(64)
const BUCKET = 'example-site-stage'
const TAGS = ['candidate-2026-11-04-10150', 'sha-ccc3333']
const ROW = { Item: { Bucket: { S: BUCKET }, DistributionId: { S: 'E000EXAMPLE000' }, Type: { S: 'static' } } }

const awsError = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

beforeEach(() => {
  ecrSend.mockReset()
  s3Send.mockReset()
  dynamoSend.mockReset()
  dynamoSend.mockResolvedValue(ROW)
  ecrSend.mockImplementation(async cmd => {
    if (cmd.op === 'DescribeImages' && cmd.input.imageIds?.[0]?.imageDigest === DIGEST) {
      return { imageDetails: [{ imageDigest: DIGEST, imageTags: TAGS }] }
    }
    throw new Error(`unexpected ${cmd.op} ${JSON.stringify(cmd.input)}`)
  })
})

describe('resolveStatic mode=tag', () => {
  it('resolves a candidate tag in the app\'s ECR repository', async () => {
    ecrSend.mockResolvedValue({ imageDetails: [{ imageDigest: DIGEST, imageTags: TAGS }] })
    expect(await resolveStatic({ mode: 'tag', projectName: 'example-app', tag: 'candidate-2026-11-04-10150' })).toEqual({
      image: `${REGISTRY}/example-app@${DIGEST}`, digest: DIGEST, tags: TAGS
    })
    expect(ecrSend.mock.calls[0][0].input).toEqual({ repositoryName: 'example-app', imageIds: [{ imageTag: 'candidate-2026-11-04-10150' }] })
    expect(dynamoSend).not.toHaveBeenCalled()
    expect(s3Send).not.toHaveBeenCalled()
  })

  it('finds a dated release from a bare release number, as for ECS', async () => {
    ecrSend.mockImplementation(async cmd => {
      const id = cmd.input.imageIds?.[0]
      if (id?.imageTag === 'release-10150') return { imageDetails: [] }
      if (id?.imageTag === 'release-2026-11-04-10150') return { imageDetails: [{ imageDigest: DIGEST, imageTags: ['release-2026-11-04-10150'] }] }
      if (!id) return { imageDetails: [{ imageDigest: DIGEST, imageTags: ['release-2026-11-04-10150'] }] }
      throw new Error('unexpected')
    })
    const resolved = await resolveStatic({ mode: 'tag', projectName: 'example-app', tag: 'release-10150' })
    expect(resolved.digest).toBe(DIGEST)
  })
})

describe('resolveStatic mode=environment', () => {
  it('reads the digest index.html names, then that digest\'s tags', async () => {
    s3Send.mockResolvedValue({ Metadata: { 'cru-digest': DIGEST, 'cru-revision': 'candidate-2026-11-04-10150', 'cru-sha': 'ccc3333' } })
    expect(await resolveStatic({ mode: 'environment', projectName: 'example-app', environment: 'release-candidate' })).toEqual({
      image: `${REGISTRY}/example-app@${DIGEST}`, digest: DIGEST, tags: TAGS
    })
    expect(dynamoSend.mock.calls[0][0].input.Key).toEqual({ Project: { S: 'example-app' }, Environment: { S: 'staging' } })
    expect(s3Send.mock.calls[0][0]).toMatchObject({ op: 'HeadObject', input: { Bucket: BUCKET, Key: 'index.html' } })
  })

  it('reports no tags rather than failing when ECR cannot say', async () => {
    s3Send.mockResolvedValue({ Metadata: { 'cru-digest': DIGEST } })
    ecrSend.mockRejectedValue(new Error('throttled'))
    expect((await resolveStatic({ mode: 'environment', projectName: 'example-app', environment: 'production' })).tags).toEqual([])
  })

  it('fails as "nothing is live yet" when the bucket has no index.html, as a never-deployed ECS app does', async () => {
    s3Send.mockRejectedValue(awsError('NotFound', 404))
    await expect(resolveStatic({ mode: 'environment', projectName: 'example-app', environment: 'release-candidate' })).rejects.toThrow(
      `Nothing is live in release-candidate for example-app yet: s3://${BUCKET}/index.html does not exist. Nothing was resolved, ` +
      'so a deploy to this environment goes ahead and a promote from it stops here.'
    )
  })

  it.each([
    ['no metadata', {}],
    ['a cru-digest that is not a digest', { 'cru-digest': 'latest' }]
  ])('fails the same way when index.html has %s', async (_label, metadata) => {
    s3Send.mockResolvedValue({ Metadata: metadata })
    await expect(resolveStatic({ mode: 'environment', projectName: 'example-app', environment: 'release-candidate' })).rejects.toThrow(
      /index\.html names no release \(it has no cru-digest metadata\), so pipeline v2 has not deployed example-app to release-candidate yet\. Nothing was resolved/
    )
  })

  it('names the bucket and the grant it needs when S3 refuses', async () => {
    s3Send.mockRejectedValue(awsError('Forbidden', 403))
    await expect(resolveStatic({ mode: 'environment', projectName: 'example-app', environment: 'production' })).rejects.toThrow(
      /S3 refused s3:GetObject \(HeadObject\) on s3:\/\/example-site-stage\/index\.html \(access denied\)\. The policy of bucket example-site-stage must grant the GitHubDeployStatic role/
    )
  })

  it('refuses a row with no Bucket before reading S3', async () => {
    dynamoSend.mockResolvedValue({ Item: { DistributionId: { S: 'E000EXAMPLE000' } } })
    await expect(resolveStatic({ mode: 'environment', projectName: 'example-app', environment: 'production' })).rejects.toThrow(/has no Bucket/)
    expect(s3Send).not.toHaveBeenCalled()
  })
})

it('refuses an unknown mode', async () => {
  await expect(resolveStatic({ mode: 'running', projectName: 'example-app' })).rejects.toThrow(/Unknown resolve mode "running"/)
})
