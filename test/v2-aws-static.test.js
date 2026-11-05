import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The S3, CloudFront and app-info calls a static site's deploy makes
// (src/v2/aws.js), against canned SDK clients. What is pinned: what each call
// sends (no ACL, ever), the time limits every client carries, and the messages
// an access-denied answer turns into, which name what to fix.
const { s3Send, s3Configs, cloudfrontSend, cloudfrontConfigs, dynamoSend, command } = vi.hoisted(() => ({
  s3Send: vi.fn(),
  s3Configs: [],
  cloudfrontSend: vi.fn(),
  cloudfrontConfigs: [],
  dynamoSend: vi.fn(),
  command: op => class {
    constructor (input) {
      this.op = op
      this.input = input
    }
  }
}))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor (config) { s3Configs.push(config) }
    send (cmd, options) { return s3Send(cmd, options) }
  },
  PutObjectCommand: command('PutObject'),
  HeadObjectCommand: command('HeadObject')
}))
vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    constructor (config) { cloudfrontConfigs.push(config) }
    send (cmd, options) { return cloudfrontSend(cmd, options) }
  },
  CreateInvalidationCommand: command('CreateInvalidation'),
  GetInvalidationCommand: command('GetInvalidation')
}))
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { send (cmd, options) { return dynamoSend(cmd, options) } },
  GetItemCommand: command('GetItem'),
  UpdateItemCommand: command('UpdateItem')
}))

import {
  STATIC_CONNECTION_TIMEOUT_MS,
  STATIC_REQUEST_TIMEOUT_MS,
  appInfoItem,
  cloudfrontCreateInvalidation,
  cloudfrontInvalidationStatus,
  isAccessDenied,
  s3HeadObject,
  s3PutObject
} from '../src/v2/aws.js'

const BUCKET = 'example-site-stage'
const DISTRIBUTION = 'E000EXAMPLE000'

const awsError = (name, status, message = name) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } })

beforeEach(() => {
  s3Send.mockReset()
  cloudfrontSend.mockReset()
  dynamoSend.mockReset()
})

describe('s3PutObject', () => {
  it('sends the body, type, cache header and metadata, and never an ACL', async () => {
    s3Send.mockResolvedValue({})
    await s3PutObject(BUCKET, 'index.html', Buffer.from('<html>'), {
      contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', metadata: { 'cru-digest': 'sha256:abc' }
    })
    const [cmd, options] = s3Send.mock.calls[0]
    expect(cmd.op).toBe('PutObject')
    expect(cmd.input).toEqual({
      Bucket: BUCKET,
      Key: 'index.html',
      Body: Buffer.from('<html>'),
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-cache',
      Metadata: { 'cru-digest': 'sha256:abc' }
    })
    expect(Object.keys(cmd.input).filter(key => /acl|grant/i.test(key))).toEqual([])
    // A whole-call limit, retries included.
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('sends no Metadata when there is none', async () => {
    s3Send.mockResolvedValue({})
    await s3PutObject(BUCKET, 'app.js', Buffer.from('x'), { contentType: 'text/javascript', cacheControl: 'public, max-age=300' })
    expect('Metadata' in s3Send.mock.calls[0][0].input).toBe(false)
  })

  it('turns access denied into a message that names the bucket and the grant it needs', async () => {
    s3Send.mockRejectedValue(awsError('AccessDenied', 403, 'Access Denied'))
    const error = await s3PutObject(BUCKET, 'assets/app.js', Buffer.from('x')).catch(e => e)
    expect(error.message).toBe(
      `S3 refused s3:PutObject on s3://${BUCKET}/assets/app.js (access denied). The policy of bucket ${BUCKET} must ` +
      'grant the GitHubDeployStatic role s3:PutObject, s3:GetObject, s3:ListBucket.'
    )
    expect(error.cause.name).toBe('AccessDenied')
  })

  it('names the object on any other failure', async () => {
    s3Send.mockRejectedValue(awsError('RequestTimeout', 400, 'Your socket connection to the server was not read from'))
    await expect(s3PutObject(BUCKET, 'a.js', Buffer.from('x'))).rejects.toThrow(
      `S3 s3:PutObject on s3://${BUCKET}/a.js failed: Your socket connection to the server was not read from`
    )
  })
})

describe('s3HeadObject', () => {
  it('returns the object\'s metadata', async () => {
    s3Send.mockResolvedValue({ Metadata: { 'cru-digest': 'sha256:abc' } })
    expect(await s3HeadObject(BUCKET, 'index.html')).toEqual({ metadata: { 'cru-digest': 'sha256:abc' } })
    expect(s3Send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: 'index.html' })
  })

  it('returns empty metadata for an object that has none', async () => {
    s3Send.mockResolvedValue({})
    expect(await s3HeadObject(BUCKET, 'index.html')).toEqual({ metadata: {} })
  })

  it.each([
    ['NotFound', awsError('NotFound', 404)],
    ['NoSuchKey', awsError('NoSuchKey', 404)]
  ])('is null for a missing object (%s)', async (_label, error) => {
    s3Send.mockRejectedValue(error)
    expect(await s3HeadObject(BUCKET, 'index.html')).toBeNull()
  })

  it('names the bucket and the grant it needs on a 403, which S3 also sends for a missing object without ListBucket', async () => {
    s3Send.mockRejectedValue(awsError('403', 403, 'UnknownError'))
    await expect(s3HeadObject(BUCKET, 'index.html')).rejects.toThrow(
      `S3 refused s3:GetObject (HeadObject) on s3://${BUCKET}/index.html (access denied). The policy of bucket ${BUCKET} ` +
      'must grant the GitHubDeployStatic role s3:PutObject, s3:GetObject, s3:ListBucket.'
    )
  })
})

describe('CloudFront', () => {
  it('creates an invalidation of the given paths under the given reference', async () => {
    cloudfrontSend.mockResolvedValue({ Invalidation: { Id: 'I000EXAMPLE', Status: 'InProgress' } })
    expect(await cloudfrontCreateInvalidation(DISTRIBUTION, ['/*'], 'cru-pipeline-v2-ref')).toBe('I000EXAMPLE')
    const [cmd, options] = cloudfrontSend.mock.calls[0]
    expect(cmd.op).toBe('CreateInvalidation')
    expect(cmd.input).toEqual({
      DistributionId: DISTRIBUTION,
      InvalidationBatch: { CallerReference: 'cru-pipeline-v2-ref', Paths: { Quantity: 1, Items: ['/*'] } }
    })
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('reads an invalidation\'s status', async () => {
    cloudfrontSend.mockResolvedValue({ Invalidation: { Id: 'I000EXAMPLE', Status: 'Completed' } })
    expect(await cloudfrontInvalidationStatus(DISTRIBUTION, 'I000EXAMPLE')).toBe('Completed')
    expect(cloudfrontSend.mock.calls[0][0].input).toEqual({ DistributionId: DISTRIBUTION, Id: 'I000EXAMPLE' })
  })

  it.each([
    ['CreateInvalidation', () => cloudfrontCreateInvalidation(DISTRIBUTION, ['/*'], 'ref')],
    ['GetInvalidation', () => cloudfrontInvalidationStatus(DISTRIBUTION, 'I000EXAMPLE')]
  ])('turns access denied on %s into a message that names the distribution and the grant', async (action, call) => {
    cloudfrontSend.mockRejectedValue(awsError('AccessDenied', 403, 'User is not authorized'))
    await expect(call()).rejects.toThrow(
      `CloudFront refused cloudfront:${action} on distribution ${DISTRIBUTION} (access denied). The GitHubDeployStatic ` +
      `role's policy must allow cloudfront:CreateInvalidation and cloudfront:GetInvalidation on distribution ${DISTRIBUTION}.`
    )
  })

  it('names the distribution on any other failure', async () => {
    cloudfrontSend.mockRejectedValue(awsError('TooManyInvalidationsInProgress', 400, 'Too many invalidations'))
    await expect(cloudfrontCreateInvalidation(DISTRIBUTION, ['/*'], 'ref')).rejects.toThrow(
      `CloudFront cloudfront:CreateInvalidation on distribution ${DISTRIBUTION} failed: Too many invalidations`
    )
  })
})

describe('client time limits', () => {
  it('gives the S3 and CloudFront clients per-request time limits on top of the retries', async () => {
    s3Send.mockResolvedValue({})
    cloudfrontSend.mockResolvedValue({ Invalidation: { Id: 'I' } })
    await s3PutObject(BUCKET, 'a.js', Buffer.from('x'))
    await cloudfrontCreateInvalidation(DISTRIBUTION, ['/*'], 'ref')
    for (const config of [s3Configs.at(-1), cloudfrontConfigs.at(-1)]) {
      expect(config).toMatchObject({
        region: 'us-east-1',
        maxAttempts: 5,
        requestHandler: { connectionTimeout: STATIC_CONNECTION_TIMEOUT_MS, requestTimeout: STATIC_REQUEST_TIMEOUT_MS }
      })
    }
    expect(s3Configs.at(-1).followRegionRedirects).toBe(true)
  })

  it('shares one client across uploads', async () => {
    s3Send.mockResolvedValue({})
    const before = s3Configs.length
    await s3PutObject(BUCKET, 'a.js', Buffer.from('x'))
    await s3PutObject(BUCKET, 'b.js', Buffer.from('x'))
    expect(s3Configs.length).toBe(before)
  })
})

describe('appInfoItem', () => {
  it('reads the row by project and legacy environment, keeping its string attributes', async () => {
    dynamoSend.mockResolvedValue({ Item: { Project: { S: 'example-app' }, Bucket: { S: BUCKET }, Replicas: { N: '2' } } })
    expect(await appInfoItem('example-app', 'staging')).toEqual({ Project: 'example-app', Bucket: BUCKET })
    expect(dynamoSend.mock.calls[0][0].input).toEqual({
      TableName: 'CruApplicationInfo',
      Key: { Project: { S: 'example-app' }, Environment: { S: 'staging' } }
    })
  })

  it('is null when there is no row', async () => {
    dynamoSend.mockResolvedValue({})
    expect(await appInfoItem('example-app', 'production')).toBeNull()
  })

  it('names the row it could not read', async () => {
    dynamoSend.mockRejectedValue(awsError('AccessDeniedException', 400, 'not authorized to perform: dynamodb:GetItem'))
    await expect(appInfoItem('example-app', 'production')).rejects.toThrow(
      'Could not read the CruApplicationInfo row for example-app (production): not authorized to perform: dynamodb:GetItem'
    )
  })
})

describe('isAccessDenied', () => {
  it.each([
    [awsError('AccessDenied', 403), true],
    [awsError('AccessDeniedException', 400), true],
    [awsError('Forbidden', 403), true],
    [awsError('403', 403), true],
    [awsError('NotFound', 404), false],
    [new Error('socket hang up'), false]
  ])('%s -> %s', (error, denied) => {
    expect(isAccessDenied(error)).toBe(denied)
  })
})

// The bucket policy grants put, get and list only, and the code must never
// need more: no delete, no ACL.
it('the static calls cannot delete an object or set an ACL', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['src/v2/aws.js', 'src/v2/deploy-static.js', 'src/v2/static-site.js', 'src/v2/resolve-static.js']) {
    // Code only: the comments say "no ACL" in plain words.
    const code = readFileSync(path.join(root, file), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
    expect(code, file).not.toMatch(/DeleteObjects?Command|PutObjectAclCommand|\bACL\s*:/)
  }
})
