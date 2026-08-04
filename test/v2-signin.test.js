import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock google-auth-library so the GCS upload hits a canned client, and src/v2/oci.js
// so no registry reads happen (openImage itself is covered by v2-oci.test.js).
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))
vi.mock('../src/v2/oci.js', () => ({ openImage: vi.fn() }))

import { openImage } from '../src/v2/oci.js'
import {
  SIGNIN_LABEL,
  publishSigninPage,
  signinBucket,
  signinObjectKey,
  signinSourcePath
} from '../src/v2/signin.js'

const REPO = 'us-central1-docker.pkg.dev/cru-shared-artifacts/bills/bills'
const IMAGE = `${REPO}@sha256:new`
const BUCKET = 'bills-stage-1234-iap-signin'
const PAGE = '<!DOCTYPE html><title>Sign in</title>'

// A Cloud Run service as the API returns it: app container plus a Datadog sidecar.
function service (env, { name = 'bills-web' } = {}) {
  return {
    name: `projects/p/locations/us-central1/services/${name}`,
    template: {
      containers: [
        { image: `${REPO}@sha256:old`, ports: [{ containerPort: 8080 }], env },
        { name: 'datadog', image: 'gcr.io/datadoghq/agent:latest', env: [{ name: 'IAP_SIGNIN_BUCKET', value: 'wrong-bucket' }] }
      ]
    }
  }
}

// Stub an image with the given labels and file contents.
function image ({ labels = {}, files = {} } = {}) {
  openImage.mockResolvedValue({
    labels,
    readFile: async path => (path in files ? Buffer.from(files[path]) : null)
  })
}

// Decode the multipart/related upload the GCS JSON API received.
function upload () {
  const [options] = requestMock.mock.calls.at(-1)
  const boundary = options.headers['Content-Type'].match(/boundary=(.+)$/)[1]
  const parts = options.body.toString().split(`--${boundary}`)
  return {
    url: options.url,
    params: options.params,
    boundary,
    metadata: JSON.parse(parts[1].split('\r\n\r\n')[1].trimEnd()),
    contents: parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')
  }
}

beforeEach(() => {
  requestMock.mockReset()
  requestMock.mockResolvedValue({ data: {} })
  openImage.mockReset()
})

describe('signinObjectKey', () => {
  it('returns null for an image with no sign-in label — most apps have none', () => {
    expect(signinObjectKey({})).toBeNull()
    expect(signinObjectKey(undefined)).toBeNull()
    expect(signinObjectKey({ 'org.opencontainers.image.source': 'x' })).toBeNull()
  })

  it('returns the declared key', () => {
    expect(signinObjectKey({ [SIGNIN_LABEL]: 'signin' })).toBe('signin')
    expect(signinObjectKey({ [SIGNIN_LABEL]: 'sign_in' })).toBe('sign_in')
  })

  it('accepts a multi-segment key, matching a nested friendly_signin.path', () => {
    expect(signinObjectKey({ [SIGNIN_LABEL]: 'auth/sign_in' })).toBe('auth/sign_in')
  })

  it('trims incidental whitespace from the label value', () => {
    expect(signinObjectKey({ [SIGNIN_LABEL]: '  signin\n' })).toBe('signin')
  })

  it.each([
    ['an empty value', ''],
    ['whitespace only', '   '],
    ['an absolute path', '/signin'],
    ['a parent-directory escape', '../../etc/passwd'],
    ['a ".." segment', 'auth/../../signin'],
    ['a "." segment', './signin'],
    ['an empty segment', 'auth//signin'],
    ['a backslash', 'auth\\signin']
  ])('throws on %s', (_label, value) => {
    expect(() => signinObjectKey({ [SIGNIN_LABEL]: value })).toThrow(/not a usable object key/)
  })
})

describe('signinSourcePath', () => {
  it('places the page under the conventional directory', () => {
    expect(signinSourcePath('signin')).toBe('/cru/iap-signin/signin')
    expect(signinSourcePath('auth/sign_in')).toBe('/cru/iap-signin/auth/sign_in')
  })
})

describe('signinBucket', () => {
  it('reads IAP_SIGNIN_BUCKET off the app container', () => {
    const services = [service([{ name: 'FOO', value: 'bar' }, { name: 'IAP_SIGNIN_BUCKET', value: BUCKET }])]
    expect(signinBucket(services, REPO)).toBe(BUCKET)
  })

  it('ignores the value on a sidecar container', () => {
    expect(signinBucket([service([{ name: 'FOO', value: 'bar' }])], REPO)).toBeNull()
  })

  it('returns null when the app has no sign-in page configured', () => {
    expect(signinBucket([service([])], REPO)).toBeNull()
    expect(signinBucket([], REPO)).toBeNull()
  })

  it('ignores a secret-valued entry with no plain value', () => {
    const env = [{ name: 'IAP_SIGNIN_BUCKET', valueSource: { secretKeyRef: { secret: 's' } } }]
    expect(signinBucket([service(env)], REPO)).toBeNull()
  })

  it('scans every service, so a multi-service app still resolves', () => {
    const services = [
      service([], { name: 'bills-worker' }),
      service([{ name: 'IAP_SIGNIN_BUCKET', value: BUCKET }], { name: 'bills-web' })
    ]
    expect(signinBucket(services, REPO)).toBe(BUCKET)
  })

  it('tolerates a service with no template containers', () => {
    expect(signinBucket([{ name: 'projects/p/services/x', template: {} }], REPO)).toBeNull()
  })
})

describe('publishSigninPage', () => {
  it('requires a bucket', async () => {
    await expect(publishSigninPage({ image: IMAGE })).rejects.toThrow(/bucket is required/)
  })

  it('reports no-label without uploading when the image ships no page', async () => {
    image({ labels: {} })
    expect(await publishSigninPage({ image: IMAGE, bucket: BUCKET })).toEqual({
      published: false,
      reason: 'no-label'
    })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('fails when the label promises a page the image does not carry', async () => {
    image({ labels: { [SIGNIN_LABEL]: 'signin' }, files: {} })
    await expect(publishSigninPage({ image: IMAGE, bucket: BUCKET })).rejects.toThrow(
      /has no file at \/cru\/iap-signin\/signin/
    )
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('uploads the extracted page to the bucket', async () => {
    image({ labels: { [SIGNIN_LABEL]: 'signin' }, files: { '/cru/iap-signin/signin': PAGE } })

    const result = await publishSigninPage({ image: IMAGE, bucket: BUCKET })
    expect(result).toEqual({ published: true, bucket: BUCKET, objectKey: 'signin', bytes: PAGE.length })

    const sent = upload()
    expect(sent.url).toBe(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`)
    expect(sent.params).toEqual({ uploadType: 'multipart' })
    expect(sent.contents).toBe(PAGE)
  })

  it('sets the content type and cache control the LB serving contract needs', async () => {
    image({ labels: { [SIGNIN_LABEL]: 'signin' }, files: { '/cru/iap-signin/signin': PAGE } })
    await publishSigninPage({ image: IMAGE, bucket: BUCKET })

    // text/html: without it the extensionless object downloads instead of
    // rendering. max-age=300: the documented upload-to-edge lag.
    expect(upload().metadata).toEqual({
      name: 'signin',
      contentType: 'text/html',
      cacheControl: 'public, max-age=300'
    })
  })

  it('names the object by the label, not by the source path', async () => {
    image({
      labels: { [SIGNIN_LABEL]: 'auth/sign_in' },
      files: { '/cru/iap-signin/auth/sign_in': PAGE }
    })
    await publishSigninPage({ image: IMAGE, bucket: BUCKET })
    expect(upload().metadata.name).toBe('auth/sign_in')
  })

  it('uses a boundary that cannot appear in the body it delimits', async () => {
    // Derived from a hash of the payload, so a page that happens to contain
    // MIME-ish text still round-trips.
    const adversarial = `${PAGE}\r\n--cru-0000\r\n`
    image({ labels: { [SIGNIN_LABEL]: 'signin' }, files: { '/cru/iap-signin/signin': adversarial } })
    await publishSigninPage({ image: IMAGE, bucket: BUCKET })

    const sent = upload()
    expect(sent.contents).toBe(adversarial)
    expect(adversarial.includes(sent.boundary)).toBe(false)
  })

  it('preserves exact bytes for a page with multibyte characters', async () => {
    const unicode = '<!DOCTYPE html><title>Sign in · Bills</title>'
    image({ labels: { [SIGNIN_LABEL]: 'signin' }, files: { '/cru/iap-signin/signin': unicode } })

    const result = await publishSigninPage({ image: IMAGE, bucket: BUCKET })
    expect(result.bytes).toBe(Buffer.byteLength(unicode))
    expect(upload().contents).toBe(unicode)
  })

  it('propagates an upload rejection to the caller', async () => {
    image({ labels: { [SIGNIN_LABEL]: 'signin' }, files: { '/cru/iap-signin/signin': PAGE } })
    requestMock.mockRejectedValue(new Error('403 does not have storage.objects.create access'))
    await expect(publishSigninPage({ image: IMAGE, bucket: BUCKET })).rejects.toThrow(/storage.objects.create/)
  })
})
