import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { RETRY_CONFIG, staticClientConfig } from '../src/v2/aws.js'

// The static site's S3 and CloudFront clients against a real local server that
// accepts every request and never answers, the way a stuck connection to AWS
// behaves. Nothing is mocked: this is the installed SDK and HTTP handler with
// the settings the deploy uses (staticClientConfig), only the idle limit is
// shortened so the test takes seconds.
//
// What it pins: each attempt ENDS when its socket has been idle for the limit,
// and the SDK then RETRIES, up to RETRY_CONFIG's attempts. A total-time
// requestTimeout looks like it should do the same, but in this handler it only
// logs a warning unless also told to throw, so a stuck attempt would sit until
// the whole-call limit and never be retried.

let server
let endpoint
let attempts = 0

beforeAll(async () => {
  server = http.createServer(req => {
    attempts++
    req.resume() // read the body, then never answer
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
})

const SOCKET_TIMEOUT_MS = 300
const local = {
  endpoint: () => endpoint,
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret' }
}

describe('a hung connection', () => {
  it('ends an S3 attempt that goes idle, and retries it', async () => {
    attempts = 0
    const s3 = new S3Client({
      ...staticClientConfig({ socketTimeoutMs: SOCKET_TIMEOUT_MS, connectionTimeoutMs: 1000 }),
      endpoint: local.endpoint(),
      forcePathStyle: true,
      credentials: local.credentials
    })
    const started = Date.now()
    const error = await s3.send(
      new PutObjectCommand({ Bucket: 'example-site-stage', Key: 'index.html', Body: Buffer.from('<html>') }),
      // A backstop far above what the retries should take, so the test proves
      // the attempts ended on their own and not on this.
      { abortSignal: AbortSignal.timeout(20 * 1000) }
    ).catch(e => e)
    const took = Date.now() - started

    expect(error.name).toBe('TimeoutError')
    expect(error.message).toMatch(/socket timed out after 300 ms of inactivity/)
    expect(attempts).toBe(RETRY_CONFIG.maxAttempts)
    expect(took).toBeLessThan(15 * 1000)
  }, 30 * 1000)

  it('does the same for a CloudFront call', async () => {
    attempts = 0
    const cloudfront = new CloudFrontClient({
      ...staticClientConfig({ socketTimeoutMs: SOCKET_TIMEOUT_MS, connectionTimeoutMs: 1000 }),
      endpoint: local.endpoint(),
      credentials: local.credentials
    })
    const error = await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: 'E000EXAMPLE000',
      InvalidationBatch: { CallerReference: 'cru-pipeline-v2-test', Paths: { Quantity: 1, Items: ['/*'] } }
    }), { abortSignal: AbortSignal.timeout(20 * 1000) }).catch(e => e)

    expect(error.name).toBe('TimeoutError')
    expect(attempts).toBe(RETRY_CONFIG.maxAttempts)
  }, 30 * 1000)
})
