import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock @actions/core the way the sibling action tests do. setSecret matters as
// much as the reporters here: several tests assert WHEN it is called relative
// to the first HTTP request.
const { setSecretMock, warningMock, infoMock } = vi.hoisted(() => ({
  setSecretMock: vi.fn(),
  warningMock: vi.fn(),
  infoMock: vi.fn()
}))

vi.mock('@actions/core', () => ({
  setSecret: setSecretMock,
  warning: warningMock,
  info: infoMock
}))

import {
  BUDGET_MS,
  CONCURRENCY,
  DEFAULT_ENDPOINT,
  MAX_MAP_BYTES,
  MAX_VERSION_LENGTH,
  REQUEST_TIMEOUT_MS,
  SOURCEMAPS_IMAGE_DIR,
  SOURCEMAPS_LABEL,
  TOKEN_HEADER,
  TOKEN_SECRET,
  UPLOAD_PATH,
  minifiedUrl,
  publishSourceMaps,
  sourceMapsEndpoint,
  sourceMapsVersion
} from '../src/v2/sourcemaps.js'

const REPO = 'us-central1-docker.pkg.dev/cru-shared-artifacts/bills/bills'
const APP_URL = 'https://bills.cru.org'
const ENDPOINT = `${DEFAULT_ENDPOINT}${UPLOAD_PATH}`
const TOKEN = 'server-scope-token'
const VERSION = 'release-2026-09-10-10123'
const MAP = '{"version":3,"sources":["src/app.ts"]}'

// A Cloud Run service as the API returns it: app container plus a sidecar that
// must never be mistaken for it.
function service (env, { name = 'bills-web' } = {}) {
  return {
    name: `projects/p/locations/us-central1/services/${name}`,
    template: {
      containers: [
        { image: `${REPO}@sha256:old`, ports: [{ containerPort: 8080 }], env },
        {
          name: 'datadog',
          image: 'gcr.io/datadoghq/agent:latest',
          env: [{ name: 'ROLLBAR_ENDPOINT', value: 'https://wrong.example.org' }]
        }
      ]
    }
  }
}

// Stub an open image handle: labels plus a /cru/sourcemaps listing.
function image (labels, files = []) {
  return {
    labels,
    readFile: vi.fn(),
    readDir: vi.fn(async (prefix, { maxBytes = MAX_MAP_BYTES } = {}) => {
      expect(prefix).toBe(SOURCEMAPS_IMAGE_DIR)
      return files.map(file => ({
        path: `cru/sourcemaps/${file.name}`,
        name: file.name,
        size: file.size ?? Buffer.byteLength(file.body ?? MAP),
        contents: (file.size ?? 0) > maxBytes ? null : Buffer.from(file.body ?? MAP)
      }))
    })
  }
}

function maps (...names) {
  return names.map(name => ({ name }))
}

// Decode one recorded upload into the fields the ingestion API sees.
async function uploadFor (call) {
  const [url, options] = call
  const form = options.body
  const part = form.get('source_map')
  return {
    url,
    method: options.method,
    token: options.headers[TOKEN_HEADER],
    version: form.get('version'),
    minified_url: form.get('minified_url'),
    filename: part.name,
    contents: await part.text()
  }
}

function uploads () {
  return Promise.all(fetch.mock.calls.map(uploadFor))
}

// { err: 1, message } with a status, the shape the API returns for a rejection.
function rejection (status, message) {
  return {
    ok: false,
    status,
    statusText: 'Unprocessable Entity',
    json: async () => ({ err: 1, message })
  }
}

const accepted = { ok: true, status: 200, json: async () => ({ err: 0 }) }

// Every test drives publishSourceMaps with tiny timings, so the retry and
// budget paths run in real time without slowing the suite.
const FAST = { attempts: 3, retryDelayMs: 0, requestTimeoutMs: 50 }

function publish (overrides = {}) {
  return publishSourceMaps({ appUrl: APP_URL, token: TOKEN, endpoint: ENDPOINT, ...FAST, ...overrides })
}

beforeEach(() => {
  setSecretMock.mockReset()
  warningMock.mockReset()
  infoMock.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => accepted))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sourceMapsVersion', () => {
  it('returns null for an image with no source-map label', () => {
    // The overwhelmingly common case: it must cost nothing.
    expect(sourceMapsVersion({})).toBeNull()
    expect(sourceMapsVersion(undefined)).toBeNull()
    expect(sourceMapsVersion({ 'org.cru.iap-signin': 'signin' })).toBeNull()
  })

  it('returns the declared code version', () => {
    expect(sourceMapsVersion({ [SOURCEMAPS_LABEL]: VERSION })).toBe(VERSION)
    expect(sourceMapsVersion({ [SOURCEMAPS_LABEL]: '10123' })).toBe('10123')
    expect(sourceMapsVersion({ [SOURCEMAPS_LABEL]: 'a'.repeat(40) })).toBe('a'.repeat(40))
  })

  it('accepts a full git sha, which is what the 40-character ceiling is for', () => {
    const sha = '0'.repeat(39) + 'f'
    expect(sourceMapsVersion({ [SOURCEMAPS_LABEL]: sha })).toBe(sha)
  })

  it('trims surrounding whitespace a Dockerfile quoting accident leaves behind', () => {
    expect(sourceMapsVersion({ [SOURCEMAPS_LABEL]: `  ${VERSION}  ` })).toBe(VERSION)
  })

  it('throws on an empty label', () => {
    expect(() => sourceMapsVersion({ [SOURCEMAPS_LABEL]: '' })).toThrow(/not a usable code version/)
    expect(() => sourceMapsVersion({ [SOURCEMAPS_LABEL]: '   ' })).toThrow(/not a usable code version/)
  })

  it('throws past the length ceiling', () => {
    expect(sourceMapsVersion({ [SOURCEMAPS_LABEL]: 'a'.repeat(MAX_VERSION_LENGTH) })).toHaveLength(40)
    expect(() => sourceMapsVersion({ [SOURCEMAPS_LABEL]: 'a'.repeat(MAX_VERSION_LENGTH + 1) }))
      .toThrow(/not a usable code version/)
  })

  it('throws on interior whitespace and control characters', () => {
    for (const bad of ['release 10123', 'release\t10123', 'release\n10123', 'release\u000010123', 'release\u007f10123']) {
      expect(() => sourceMapsVersion({ [SOURCEMAPS_LABEL]: bad })).toThrow(/not a usable code version/)
    }
  })
})

describe('minifiedUrl', () => {
  it('resolves a staged path against the app URL, dropping .map', () => {
    expect(minifiedUrl(APP_URL, 'main.js.map')).toBe('https://bills.cru.org/main.js')
  })

  it('mirrors a nested path exactly', () => {
    expect(minifiedUrl(APP_URL, '_next/static/chunks/abc123.js.map'))
      .toBe('https://bills.cru.org/_next/static/chunks/abc123.js')
  })

  // Review of #489. Each of these composed to somewhere that is not this app,
  // and the map would then have uploaded cleanly and matched no frame ever —
  // the silent class of failure this step exists to avoid.
  it.each([
    ['a scheme-like first segment', 'http:cdn.example.com/x.js.map'],
    ['a javascript: URL', 'javascript:alert(1).js.map'],
    ['a percent-encoded parent segment', '%2e%2e/b.js.map'],
    ['a percent-encoded parent below a directory', '_next/%2e%2e/%2e%2e/b.js.map'],
    ['a malformed escape', '%zz/b.js.map']
  ])('refuses %s', (unused, staged) => {
    expect(() => minifiedUrl(APP_URL, staged)).toThrow()
  })

  it('never composes a URL outside the app, whatever the path', () => {
    const base = 'https://bills.cru.org/app/'
    for (const staged of ['a.js.map', 'a/b/c.js.map', 'a/b%20c.js.map']) {
      expect(minifiedUrl(base, staged).startsWith(base)).toBe(true)
    }
  })

  it('treats an app URL with and without a trailing slash the same', () => {
    expect(minifiedUrl('https://bills.cru.org/', 'a/b.js.map')).toBe('https://bills.cru.org/a/b.js')
    expect(minifiedUrl('https://bills.cru.org', 'a/b.js.map')).toBe('https://bills.cru.org/a/b.js')
  })

  it('keeps a path in the app URL instead of replacing its last segment', () => {
    // Without the appended slash, URL() reads "app" as a file and drops it.
    expect(minifiedUrl('https://cru.org/app', '_next/a.js.map')).toBe('https://cru.org/app/_next/a.js')
    expect(minifiedUrl('https://cru.org/app/', '_next/a.js.map')).toBe('https://cru.org/app/_next/a.js')
  })

  it('strips .map exactly once', () => {
    expect(minifiedUrl(APP_URL, 'a.js.map.map')).toBe('https://bills.cru.org/a.js.map')
    expect(minifiedUrl(APP_URL, 'a.map.js.map')).toBe('https://bills.cru.org/a.map.js')
  })

  it('carries a non-js extension through untouched', () => {
    expect(minifiedUrl(APP_URL, 'styles/app.css.map')).toBe('https://bills.cru.org/styles/app.css')
  })

  it('rejects a path that is not a map', () => {
    expect(() => minifiedUrl(APP_URL, 'main.js')).toThrow(/not a source map/)
    expect(() => minifiedUrl(APP_URL, 'README')).toThrow(/not a source map/)
  })

  it('rejects traversal, absolute and empty segments', () => {
    for (const bad of ['../secrets.js.map', 'a/../../b.js.map', '/etc/passwd.js.map', 'a//b.js.map', 'a/./b.js.map']) {
      expect(() => minifiedUrl(APP_URL, bad)).toThrow(/not a usable source-map path/)
    }
  })

  it('rejects a backslash, which is a path separator on the machine that built it', () => {
    expect(() => minifiedUrl(APP_URL, 'a\\b.js.map')).toThrow(/not a usable source-map path/)
  })

  it('rejects a bare ".map"', () => {
    expect(() => minifiedUrl(APP_URL, '.map')).toThrow(/not a usable source-map path/)
  })
})

describe('sourceMapsEndpoint', () => {
  it('defaults when no service names an endpoint', () => {
    expect(sourceMapsEndpoint([service([{ name: 'FOO', value: 'bar' }])], REPO)).toBe(ENDPOINT)
  })

  it('defaults when there are no services at all', () => {
    expect(sourceMapsEndpoint([], REPO)).toBe(ENDPOINT)
  })

  it('keeps only the origin of the app container ROLLBAR_ENDPOINT', () => {
    // The var holds the OCCURRENCE ingestion path, which is not this one.
    const services = [service([{ name: 'ROLLBAR_ENDPOINT', value: 'https://errors.example.org/api/1/item' }])]
    expect(sourceMapsEndpoint(services, REPO)).toBe(`https://errors.example.org${UPLOAD_PATH}`)
  })

  it('keeps a non-default port', () => {
    const services = [service([{ name: 'ROLLBAR_ENDPOINT', value: 'https://errors.example.org:8443/api/1/item' }])]
    expect(sourceMapsEndpoint(services, REPO)).toBe(`https://errors.example.org:8443${UPLOAD_PATH}`)
  })

  it('ignores a sidecar that happens to set the same var', () => {
    expect(sourceMapsEndpoint([service([])], REPO)).toBe(ENDPOINT)
  })

  it('falls back to the default when the value is not a URL', () => {
    const services = [service([{ name: 'ROLLBAR_ENDPOINT', value: 'not a url' }])]
    expect(sourceMapsEndpoint(services, REPO)).toBe(ENDPOINT)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('not a URL'))
  })
})

describe('publishSourceMaps gates', () => {
  it('makes NO request at all when the image carries no label', async () => {
    const oci = image({})

    const result = await publish({ oci })

    expect(fetch).not.toHaveBeenCalled()
    expect(oci.readDir).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'no-label', uploaded: 0, failed: 0 })
  })

  it('warns and skips on a malformed label rather than failing', async () => {
    const result = await publish({ oci: image({ [SOURCEMAPS_LABEL]: 'not a version' }, maps('a.js.map')) })

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'invalid-label' })
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('not a usable code version'))
  })

  it('skips silently without a token', async () => {
    const result = await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map')), token: '' })

    expect(fetch).not.toHaveBeenCalled()
    expect(setSecretMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'no-token' })
  })

  it('warns and skips when there is no app URL to resolve maps against', async () => {
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map'))

    const result = await publish({ oci, appUrl: '' })

    expect(oci.readDir).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'no-app-url' })
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('no app URL'))
  })

  it('warns and skips when the label promises maps the image does not carry', async () => {
    const result = await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, []) })

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'no-files' })
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('must COPY the built maps'))
  })

  it('masks the token before anything can log it', async () => {
    const order = []
    setSecretMock.mockImplementation(() => order.push('setSecret'))
    fetch.mockImplementation(async () => { order.push('fetch'); return accepted })

    await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map')) })

    expect(setSecretMock).toHaveBeenCalledWith(TOKEN)
    expect(order[0]).toBe('setSecret')
  })
})

describe('publishSourceMaps request shape', () => {
  it('POSTs each map as Rollbar-compatible multipart', async () => {
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, [{ name: '_next/chunks/abc.js.map', body: MAP }])

    const result = await publish({ oci })

    expect(await uploads()).toEqual([{
      url: ENDPOINT,
      method: 'POST',
      token: TOKEN,
      // Spelled `version`, NOT `code_version` (that is the occurrence payload).
      version: VERSION,
      minified_url: 'https://bills.cru.org/_next/chunks/abc.js',
      filename: 'abc.js.map',
      contents: MAP
    }])
    expect(result).toMatchObject({ status: 'uploaded', uploaded: 1, failed: 0, skipped: 0 })
  })

  it('lets fetch derive the multipart Content-Type, boundary included', async () => {
    await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map')) })

    const [, options] = fetch.mock.calls[0]
    expect(options.headers).toEqual({ [TOKEN_HEADER]: TOKEN })
    expect(options.body).toBeInstanceOf(FormData)
  })

  it('sends one request per map', async () => {
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map', 'b/c.js.map', 'd.css.map'))

    const result = await publish({ oci })

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([
      'https://bills.cru.org/a.js',
      'https://bills.cru.org/b/c.js',
      'https://bills.cru.org/d.css'
    ])
    expect(result).toMatchObject({ status: 'uploaded', uploaded: 3 })
  })

  it('bounds each request', async () => {
    await publishSourceMaps({
      oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map')),
      appUrl: APP_URL,
      token: TOKEN,
      endpoint: ENDPOINT
    })

    const [, options] = fetch.mock.calls[0]
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(REQUEST_TIMEOUT_MS).toBe(60 * 1000)
  })
})

describe('publishSourceMaps file selection', () => {
  it('ignores a non-map file under the prefix, with a warning', async () => {
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map', 'README.txt'))

    const result = await publish({ oci })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('not a .map file'))
    expect(result).toMatchObject({ status: 'uploaded', uploaded: 1 })
  })

  it('skips an over-size map with a warning and uploads the rest', async () => {
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, [
      { name: 'huge.js.map', size: MAX_MAP_BYTES + 1 },
      { name: 'small.js.map' }
    ])

    const result = await publish({ oci })

    expect((await uploads()).map(upload => upload.filename)).toEqual(['small.js.map'])
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('over the'))
    expect(result).toMatchObject({ status: 'partial', uploaded: 1, failed: 0, skipped: 1 })
  })

  it('skips an unusable path with a warning and uploads the rest', async () => {
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, maps('../escape.js.map', 'ok.js.map'))

    const result = await publish({ oci })

    expect((await uploads()).map(upload => upload.filename)).toEqual(['ok.js.map'])
    expect(result).toMatchObject({ status: 'partial', uploaded: 1, skipped: 1 })
  })

  it('skips rather than uploads when nothing under the prefix is a map', async () => {
    const result = await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('README.txt')) })

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'no-maps' })
  })
})

describe('publishSourceMaps concurrency', () => {
  it('never exceeds four requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    fetch.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return accepted
    })
    const names = Array.from({ length: 20 }, (unused, index) => `chunk-${index}.js.map`)

    const result = await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps(...names)) })

    expect(CONCURRENCY).toBe(4)
    expect(peak).toBe(4)
    expect(result).toMatchObject({ status: 'uploaded', uploaded: 20 })
  })

  it('does not spin up more workers than there are maps', async () => {
    let peak = 0
    let inFlight = 0
    fetch.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return accepted
    })

    await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map', 'b.js.map')) })

    expect(peak).toBe(2)
  })
})

describe('publishSourceMaps retries', () => {
  const oneMap = () => image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map'))

  it('retries a 5xx three times then counts the map failed', async () => {
    fetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => null })

    const result = await publish({ oci: oneMap() })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ status: 'failed', uploaded: 0, failed: 1 })
  })

  it('retries a 429', async () => {
    fetch.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => null })

    await publish({ oci: oneMap() })

    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retries a network error', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'))

    const result = await publish({ oci: oneMap() })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result.failures).toEqual([{ file: 'cru/sourcemaps/a.js.map', message: 'fetch failed' }])
  })

  it('succeeds on a retry and reports a clean upload', async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', json: async () => null })
      .mockResolvedValue(accepted)

    const result = await publish({ oci: oneMap() })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'uploaded', uploaded: 1, failed: 0 })
  })

  it('does NOT retry a 4xx — the server already answered about this request', async () => {
    fetch.mockResolvedValue(rejection(422, 'invalid source map: Unexpected token } at line 4'))

    const result = await publish({ oci: oneMap() })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: 'failed', failed: 1 })
  })

  it('captures the 422 message per file, which is the whole point of reading the body', async () => {
    fetch.mockImplementation(async (url, options) =>
      options.body.get('minified_url').endsWith('/bad.js')
        ? rejection(422, 'invalid source map: Unexpected token } at line 4')
        : accepted
    )
    const oci = image({ [SOURCEMAPS_LABEL]: VERSION }, maps('good.js.map', 'bad.js.map'))

    const result = await publish({ oci })

    expect(result).toMatchObject({ status: 'partial', uploaded: 1, failed: 1 })
    expect(result.failures).toEqual([{
      file: 'cru/sourcemaps/bad.js.map',
      message: 'HTTP 422: invalid source map: Unexpected token } at line 4'
    }])
    // "HTTP 422" alone would send someone hunting; the message names the fix.
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('Unexpected token } at line 4'))
  })

  it('reports the status when the body carries no message', async () => {
    fetch.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', json: async () => null })

    const result = await publish({ oci: oneMap() })

    expect(result.failures[0].message).toBe('HTTP 400 Bad Request')
  })
})

describe('publishSourceMaps abort on auth failure', () => {
  for (const status of [401, 403]) {
    it(`stops the remaining uploads on a ${status}`, async () => {
      // Every remaining map carries the same token and would fail identically;
      // proving that 39 more times just burns the budget.
      fetch.mockResolvedValue({ ...rejection(status, 'access token not found'), status })
      const names = Array.from({ length: 12 }, (unused, index) => `chunk-${index}.js.map`)

      const result = await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps(...names)) })

      // At most the four in flight when the first rejection landed.
      expect(fetch.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY)
      expect(result.status).toBe('failed')
      expect(result.uploaded).toBe(0)
      expect(result.failed + result.skipped).toBe(12)
      expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('token was rejected'))
    })
  }

  it('does not retry the rejected request either', async () => {
    fetch.mockResolvedValue({ ...rejection(401, 'access token not found'), status: 401 })

    await publish({ oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map')) })

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('publishSourceMaps time budget', () => {
  it('abandons the remaining maps and warns when the budget runs out', async () => {
    // This path runs on ROLLBACK. An unbounded telemetry step must never stand
    // between an operator and a restored production.
    fetch.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return accepted
    })
    const names = Array.from({ length: 40 }, (unused, index) => `chunk-${index}.js.map`)

    const result = await publish({
      oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps(...names)),
      budgetMs: 30
    })

    expect(fetch.mock.calls.length).toBeLessThan(40)
    expect(result.uploaded).toBeGreaterThan(0)
    expect(result.uploaded + result.skipped + result.failed).toBe(40)
    expect(result.status).toBe('partial')
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('upload budget ran out'))
  })

  // Review of #489: the deadline was only read before a map was dequeued, so a
  // request starting just under it still got every attempt and every backoff —
  // about three more minutes, on all four workers at once.
  it('aborts a request already in flight rather than letting it outlive the budget', async () => {
    let settled = 0
    fetch.mockImplementation((url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { settled++; resolve(accepted) }, 10000)
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    }))

    const started = Date.now()
    const result = await publish({
      oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map')),
      budgetMs: 40,
      requestTimeoutMs: 10000,
      attempts: 3,
      retryDelayMs: 1
    })

    // Without the phase signal this sat for three 10s attempts.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(settled).toBe(0)
    expect(result.status).toBe('failed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports failed, not partial, when the budget expires before anything lands', async () => {
    fetch.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return accepted
    })

    const result = await publish({
      oci: image({ [SOURCEMAPS_LABEL]: VERSION }, maps('a.js.map', 'b.js.map')),
      budgetMs: -1
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'failed', uploaded: 0, skipped: 2 })
  })

  // Review of #489: an app shipping maps that are all unusable uploaded nothing
  // and reported `skipped`, reading identically to an app that ships none.
  it('reports failed when maps were shipped but none were usable', async () => {
    const result = await publish({
      oci: image({ [SOURCEMAPS_LABEL]: VERSION }, [
        { path: '/cru/sourcemaps/huge.js.map', name: 'huge.js.map', size: 99000000, contents: null }
      ])
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'failed', reason: 'no-usable-maps', uploaded: 0, skipped: 1 })
  })

  it('defaults to three minutes', () => {
    expect(BUDGET_MS).toBe(3 * 60 * 1000)
  })
})

describe('module constants', () => {
  it('names the contract the app image is built against', () => {
    expect(SOURCEMAPS_LABEL).toBe('org.cru.sourcemaps')
    expect(SOURCEMAPS_IMAGE_DIR).toBe('/cru/sourcemaps')
    expect(TOKEN_SECRET).toBe('ROLLBAR_ACCESS_TOKEN')
    expect(TOKEN_HEADER).toBe('X-Rollbar-Access-Token')
    expect(UPLOAD_PATH).toBe('/api/1/sourcemap')
  })
})
