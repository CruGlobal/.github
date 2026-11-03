import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as esbuild from 'esbuild'
import * as yaml from 'js-yaml'

// Mock @actions/core the way the sibling action tests do: `inputs` backs
// getInput, and every reporter is a spy so the tests can assert the telemetry
// policy (warnings, never setFailed) and WHEN the token is masked.
const { inputs, setOutputMock, setSecretMock, setFailedMock, warningMock, infoMock } = vi.hoisted(() => ({
  inputs: {},
  setOutputMock: vi.fn(),
  setSecretMock: vi.fn(),
  setFailedMock: vi.fn(),
  warningMock: vi.fn(),
  infoMock: vi.fn()
}))

vi.mock('@actions/core', () => ({
  getInput: name => inputs[name] ?? '',
  setOutput: setOutputMock,
  setSecret: setSecretMock,
  setFailed: setFailedMock,
  warning: warningMock,
  info: infoMock
}))

import {
  MAX_READ_BYTES,
  TAIL_BYTES,
  deleteMapsInput,
  mapPath,
  normalizeBaseUrl,
  publishDirectory,
  run,
  sourceMappingUrl,
  stripSourcesContent,
  uploadEndpoint
} from '../src/flightdeck-sourcemaps.js'
import { CONCURRENCY, DEFAULT_ENDPOINT, MAX_MAP_BYTES, TOKEN_HEADER, UPLOAD_PATH } from '../src/sourcemap-upload.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE_URL = 'https://example-app.example.org/'
const ENDPOINT = 'https://flightdeck.example.org'
const UPLOAD_URL = `${ENDPOINT}${UPLOAD_PATH}`
const TOKEN = 'server-scope-token'
const VERSION = '0123456789abcdef0123456789abcdef01234567'

// Every test that drives the upload uses tiny timings, so the retry and budget
// paths run in real time without slowing the suite.
const FAST = { attempts: 3, retryDelayMs: 0, requestTimeoutMs: 50 }

// A chunk as a bundler writes it: minified code, then the comment naming its map.
function chunk (mapReference, code = 'console.log("example")') {
  return mapReference === null ? `${code}\n` : `${code}\n//# sourceMappingURL=${mapReference}\n`
}

// A source map as a bundler writes it, sourcesContent included.
function sourceMap (sources, extra = {}) {
  return JSON.stringify({
    version: 3,
    file: 'out.js',
    sources,
    sourcesContent: sources.map(source => `// the source of ${source}\n`),
    names: [],
    mappings: 'AAAA',
    ...extra
  })
}

// What stripSourcesContent should send for sourceMap(sources).
function stripped (sources, extra = {}) {
  return JSON.stringify({ version: 3, file: 'out.js', sources, names: [], mappings: 'AAAA', ...extra })
}

function jsonResponse (status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body }
}

// Flightdeck's answers to a well-formed upload: stored, or already held.
const stored = () => jsonResponse(200, { err: 0, result: { id: 1, unchanged: false } })
const unchanged = () => jsonResponse(200, { err: 0, result: { id: 1, unchanged: true } })
const rejection = (status, message) => jsonResponse(status, { err: 1, message })

// Decode one recorded upload into the fields the ingestion API sees.
async function uploadFor ([url, options]) {
  const part = options.body.get('source_map')
  return {
    url,
    token: options.headers[TOKEN_HEADER],
    version: options.body.get('version'),
    minified_url: options.body.get('minified_url'),
    filename: part.name,
    contents: await part.text()
  }
}

function uploads () {
  return Promise.all(fetch.mock.calls.map(uploadFor))
}

// A throwaway build directory: { 'js/app.js': '...', 'js/app.js.map': '...' }.
let dirs = []
function build (files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flightdeck-sourcemaps-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  return dir
}

function publish (directory, overrides = {}) {
  return publishDirectory({ directory, baseUrl: BASE_URL, version: VERSION, token: TOKEN, endpoint: ENDPOINT, ...FAST, ...overrides })
}

function warned (text) {
  return warningMock.mock.calls.some(([message]) => message.includes(text))
}

function logged (text) {
  return infoMock.mock.calls.some(([message]) => message.includes(text))
}

function output (name) {
  return setOutputMock.mock.calls.filter(([key]) => key === name).pop()?.[1]
}

beforeEach(() => {
  for (const key of Object.keys(inputs)) delete inputs[key]
  setOutputMock.mockReset()
  setSecretMock.mockReset()
  setFailedMock.mockReset()
  warningMock.mockReset()
  infoMock.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => stored()))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('sourceMappingUrl', () => {
  it('reads the comment on the last line', () => {
    expect(sourceMappingUrl(chunk('a1b2.js.map'))).toBe('a1b2.js.map')
    expect(sourceMappingUrl('code()\n//# sourceMappingURL=a.js.map')).toBe('a.js.map')
  })

  it('accepts the older //@ spelling and no space after the #', () => {
    expect(sourceMappingUrl('code()\n//@ sourceMappingURL=a.js.map\n')).toBe('a.js.map')
    expect(sourceMappingUrl('code()\n//#sourceMappingURL=a.js.map\n')).toBe('a.js.map')
  })

  it('steps over blank lines, CRLF endings and other trailing line comments', () => {
    expect(sourceMappingUrl('code()\r\n//# sourceMappingURL=a.js.map\r\n//# debugId=1234\r\n\r\n')).toBe('a.js.map')
  })

  it('ignores the same text earlier in the file, which names nothing', () => {
    // A bundled library that writes these comments itself carries the text in
    // a string; only the trailing comment belongs to this chunk.
    const text = 'const tpl = `\n//# sourceMappingURL=not-this.js.map\n`\nmore()\n'
    expect(sourceMappingUrl(text)).toBeNull()
    expect(sourceMappingUrl(`${text}//# sourceMappingURL=this.js.map\n`)).toBe('this.js.map')
  })

  it('returns null for a chunk with no comment', () => {
    expect(sourceMappingUrl('code()\n')).toBeNull()
    expect(sourceMappingUrl('')).toBeNull()
  })

  it('returns an inline data: URL as it is, for the caller to recognize', () => {
    expect(sourceMappingUrl(chunk('data:application/json;base64,e30='))).toBe('data:application/json;base64,e30=')
  })

  // Only the end of a chunk is read, so its first line may be cut.
  it('reads a cut first line that is nothing but base64 as the end of an inline map', () => {
    expect(sourceMappingUrl('QUFBQUFBQUFB/+QUFB==\n', { partial: true })).toBe('data:')
  })

  it('reads a cut first line of code as no comment', () => {
    expect(sourceMappingUrl('ole.log("x");var a=1\n', { partial: true })).toBeNull()
  })

  it('still finds a whole comment line after a cut first line', () => {
    expect(sourceMappingUrl('QUFB\n//# sourceMappingURL=a.js.map\n', { partial: true })).toBe('a.js.map')
  })
})

describe('mapPath', () => {
  const chunkUrl = `${BASE_URL}static/js/a1b2.js`

  it('resolves a sibling name, a ../ path, a root-relative path and a full URL the way a browser does', () => {
    expect(mapPath('c3d4.js.map', chunkUrl, BASE_URL)).toEqual({ path: 'static/js/c3d4.js.map' })
    expect(mapPath('../maps/c3d4.js.map', chunkUrl, BASE_URL)).toEqual({ path: 'static/maps/c3d4.js.map' })
    expect(mapPath('/maps/c3d4.js.map', chunkUrl, BASE_URL)).toEqual({ path: 'maps/c3d4.js.map' })
    expect(mapPath(`${BASE_URL}maps/c3d4.js.map`, chunkUrl, BASE_URL)).toEqual({ path: 'maps/c3d4.js.map' })
  })

  it('drops a query and a fragment', () => {
    expect(mapPath('c3d4.js.map?v=2#x', chunkUrl, BASE_URL)).toEqual({ path: 'static/js/c3d4.js.map' })
  })

  it('decodes an escaped name', () => {
    expect(mapPath('c3%20d4.js.map', chunkUrl, BASE_URL)).toEqual({ path: 'static/js/c3 d4.js.map' })
  })

  it('refuses a map outside the directory', () => {
    expect(mapPath('../../../elsewhere.js.map', chunkUrl, `${BASE_URL}static/`).problem).toMatch(/outside/)
    expect(mapPath('https://cdn.example.net/c3d4.js.map', chunkUrl, BASE_URL).problem).toMatch(/outside/)
  })

  it('refuses a reference that does not name a file', () => {
    expect(mapPath('a%2Fb.js.map', chunkUrl, BASE_URL).problem).toMatch(/does not name a file/)
    expect(mapPath('%zz.js.map', chunkUrl, BASE_URL).problem).toMatch(/does not name a file/)
    expect(mapPath('/', chunkUrl, BASE_URL).problem).toMatch(/does not name a file/)
  })
})

describe('stripSourcesContent', () => {
  const INPUT = '{"version":3,"file":"app.js","sources":["src/app.ts","src/util.ts"],' +
    '"sourcesContent":["export const a = 1\\n","export const b = 2\\n"],"names":["a","b"],"mappings":"AAAA,MAAM"}'

  // Flightdeck compares uploaded bytes to decide "unchanged". A strip whose
  // output drifted for the same map would turn every re-run into a replace and
  // reset the map's applied count. This pins the exact bytes.
  it('gives exactly these bytes for this map', () => {
    expect(stripSourcesContent(Buffer.from(INPUT)).toString('utf8')).toBe(
      '{"version":3,"file":"app.js","sources":["src/app.ts","src/util.ts"],"names":["a","b"],"mappings":"AAAA,MAAM"}'
    )
  })

  it('gives the same bytes for the same input every time, and for a copy of it', () => {
    const first = stripSourcesContent(Buffer.from(INPUT))
    for (let index = 0; index < 5; index++) {
      expect(stripSourcesContent(Buffer.from(INPUT)).equals(first)).toBe(true)
    }
    expect(stripSourcesContent(Buffer.from(String(INPUT))).equals(first)).toBe(true)
  })

  it('sends a map with nothing to strip as the very bytes it was built as', () => {
    const pretty = Buffer.from('{\n  "version": 3,\n  "sources": ["a.ts"],\n  "names": [],\n  "mappings": "AAAA"\n}\n')
    expect(stripSourcesContent(pretty).equals(pretty)).toBe(true)
  })

  it('strips each section of an index map', () => {
    const indexMap = '{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":' +
      '{"version":3,"sources":["a.ts"],"sourcesContent":["x"],"names":[],"mappings":"AAAA"}}]}'
    expect(stripSourcesContent(Buffer.from(indexMap)).toString('utf8')).toBe(
      '{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":' +
      '{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}}]}'
    )
  })

  it('throws on bytes that are not a JSON object', () => {
    expect(() => stripSourcesContent(Buffer.from('not json'))).toThrow()
    expect(() => stripSourcesContent(Buffer.from('[1,2]'))).toThrow(/not a JSON object/)
    expect(() => stripSourcesContent(Buffer.from(''))).toThrow()
  })

  it('throws on a JSON object that is not a version 3 source map', () => {
    expect(() => stripSourcesContent(Buffer.from('{"name":"example-app","version":"1.0.0"}'))).toThrow(/not a version 3 source map/)
    expect(() => stripSourcesContent(Buffer.from('{"version":3}'))).toThrow(/not a version 3 source map/)
    expect(stripSourcesContent(Buffer.from('{"version":"3","mappings":""}')).toString()).toBe('{"version":"3","mappings":""}')
  })

  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  const PLAIN = Buffer.from('{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}')

  // Flightdeck parses the bytes as plain JSON, so neither prefix may be sent.
  it('drops a byte order mark, and otherwise sends the map\'s own bytes', () => {
    expect(stripSourcesContent(Buffer.concat([BOM, PLAIN])).equals(PLAIN)).toBe(true)
  })

  it('drops the source map spec\'s )]}\' first line, and otherwise sends the map\'s own bytes', () => {
    expect(stripSourcesContent(Buffer.concat([Buffer.from(")]}'\n"), PLAIN])).equals(PLAIN)).toBe(true)
    expect(stripSourcesContent(Buffer.concat([BOM, Buffer.from(")]}'\r\n"), PLAIN])).equals(PLAIN)).toBe(true)
  })

  it('strips sourcesContent from a map that has a prefix too, to the same pinned bytes', () => {
    expect(stripSourcesContent(Buffer.concat([BOM, Buffer.from(")]}'\n"), Buffer.from(INPUT)])).toString('utf8')).toBe(
      '{"version":3,"file":"app.js","sources":["src/app.ts","src/util.ts"],"names":["a","b"],"mappings":"AAAA,MAAM"}'
    )
  })

  it('uploads identical bytes from two builds of the same code', async () => {
    const files = { 'a1b2.js': chunk('c3d4.js.map'), 'c3d4.js.map': sourceMap(['src/a.ts']) }
    await publish(build(files))
    fetch.mockImplementation(async () => unchanged())
    const second = await publish(build(files))

    const [one, two] = await uploads()
    expect(two.contents).toBe(one.contents)
    expect(one.contents).toBe(stripped(['src/a.ts']))
    expect(second).toEqual({ uploaded: 0, unchanged: 1, failed: 0 })
  })
})

describe('pairing a chunk with its map', () => {
  it('uploads a map whose name differs from its chunk\'s under the CHUNK\'s URL', async () => {
    // As Turbopack builds it: the chunk and its map are hashed separately. A
    // decoy named after the chunk sits beside it; using it would upload the
    // wrong map, and the right map under a URL no frame ever carries.
    const dir = build({
      '_next/static/chunks/f3k9a1.js': chunk('q7m2x8.js.map'),
      '_next/static/chunks/q7m2x8.js.map': sourceMap(['src/real.ts']),
      '_next/static/chunks/f3k9a1.js.map': sourceMap(['src/decoy.ts'])
    })

    const result = await publish(dir)

    expect(await uploads()).toEqual([{
      url: UPLOAD_URL,
      token: TOKEN,
      version: VERSION,
      minified_url: `${BASE_URL}_next/static/chunks/f3k9a1.js`,
      filename: 'q7m2x8.js.map',
      contents: stripped(['src/real.ts'])
    }])
    expect(result).toEqual({ uploaded: 1, unchanged: 0, failed: 0 })
    expect(logged('map file(s) are named by no chunk and were not uploaded: _next/static/chunks/f3k9a1.js.map')).toBe(true)
  })

  it('keeps each chunk\'s nested path and a base URL\'s own path', async () => {
    const dir = build({
      'app.js': chunk('app.js.map'),
      'app.js.map': sourceMap(['src/app.ts']),
      'js/pages/home/x1.js': chunk('y2.js.map'),
      'js/pages/home/y2.js.map': sourceMap(['src/home.ts']),
      'js/vendor/v1.mjs': chunk('../../maps/v1.mjs.map'),
      'maps/v1.mjs.map': sourceMap(['node_modules/lib/index.js'])
    })

    const result = await publish(dir, { baseUrl: 'https://cdn.example.org/assets' })

    expect((await uploads()).map(upload => [upload.minified_url, upload.contents])).toEqual([
      ['https://cdn.example.org/assets/app.js', stripped(['src/app.ts'])],
      ['https://cdn.example.org/assets/js/pages/home/x1.js', stripped(['src/home.ts'])],
      ['https://cdn.example.org/assets/js/vendor/v1.mjs', stripped(['node_modules/lib/index.js'])]
    ])
    expect(result).toEqual({ uploaded: 3, unchanged: 0, failed: 0 })
  })

  it('skips an inline data: map and says so', async () => {
    const dir = build({
      'inline.js': chunk('data:application/json;base64,eyJ2ZXJzaW9uIjozfQ=='),
      'other.js': chunk('other.js.map'),
      'other.js.map': sourceMap(['src/other.ts'])
    })

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([`${BASE_URL}other.js`])
    expect(logged('skipping inline.js: its source map is inline (a data: URL)')).toBe(true)
    expect(warned('1 chunk(s) carry an inline data: source map, which is not uploaded: inline.js')).toBe(true)
    expect(result).toEqual({ uploaded: 1, unchanged: 0, failed: 0 })
  })

  it('counts a map the chunk names but the build does not hold as failed', async () => {
    const dir = build({
      'gone.js': chunk('gone-map.js.map'),
      'polyfills.js': chunk(null),
      'ok.js': chunk('ok.js.map'),
      'ok.js.map': sourceMap(['src/ok.ts'])
    })

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([`${BASE_URL}ok.js`])
    expect(warned(`skipping gone.js: its sourceMappingURL names gone-map.js.map, which is not in ${dir}`)).toBe(true)
    // A chunk with no comment has no map to miss, which is normal.
    expect(logged('1 chunk(s) carry no sourceMappingURL comment, so there is no map to upload for them: polyfills.js')).toBe(true)
    expect(result).toEqual({ uploaded: 1, unchanged: 0, failed: 1 })
  })

  it('counts a map outside the directory, or one that is not JSON, as failed', async () => {
    const dir = build({
      'out.js': chunk('../outside.js.map'),
      'broken.js': chunk('broken.js.map'),
      'broken.js.map': '{"version":3,'
    })

    // Served below /assets/, so ../ from a top-level chunk leaves the directory.
    const result = await publish(dir, { baseUrl: 'https://cdn.example.org/assets/' })

    expect(fetch).not.toHaveBeenCalled()
    expect(warned(
      'skipping out.js: its sourceMappingURL "../outside.js.map" resolves to https://cdn.example.org/outside.js.map, ' +
      'outside https://cdn.example.org/assets/'
    )).toBe(true)
    expect(warned('skipping broken.js: broken.js.map is not a usable source map')).toBe(true)
    expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 2 })
  })

  it('counts a map too big to upload, even without sourcesContent, as failed', async () => {
    const dir = build({ 'big.js': chunk('big.js.map'), 'big.js.map': stripped(['src/big.ts'], { mappings: 'A'.repeat(4096) }) })

    const result = await publish(dir, { maxMapBytes: 1024 })

    expect(fetch).not.toHaveBeenCalled()
    expect(warned('over the 1024-byte upload limit')).toBe(true)
    expect(result.failed).toBe(1)
    expect(MAX_READ_BYTES).toBe(8 * MAX_MAP_BYTES)
  })

  it('uploads a map two chunks share once per chunk URL', async () => {
    const dir = build({ 'a.js': chunk('shared.js.map'), 'b.js': chunk('shared.js.map'), 'shared.js.map': sourceMap(['src/s.ts']) })

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([`${BASE_URL}a.js`, `${BASE_URL}b.js`])
    expect(result.uploaded).toBe(2)
  })

  it('escapes a name the way a browser requests it', async () => {
    const dir = build({ 'a b%.js': chunk('a%20b%25.js.map'), 'a b%.js.map': sourceMap(['src/a.ts']) })

    await publish(dir)

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([`${BASE_URL}a%20b%25.js`])
  })

  it('warns when the build holds maps but no chunk names one, as a hidden source map setting does', async () => {
    const dir = build({ 'a.js': chunk(null), 'a.js.map': sourceMap(['src/a.ts']) })

    const result = await publish(dir)

    expect(fetch).not.toHaveBeenCalled()
    expect(warned('holds 1 script .map file(s), but no chunk names one')).toBe(true)
    expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 0 })
  })
})

describe('the upload', () => {
  it('posts to the origin of the endpoint it is given', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })

    await publish(dir, { endpoint: 'https://flightdeck.example.org/api/1/item/' })

    expect(fetch.mock.calls[0][0]).toBe(UPLOAD_URL)
    expect(uploadEndpoint('')).toBe(`${DEFAULT_ENDPOINT}${UPLOAD_PATH}`)
  })

  it('counts a map Flightdeck already holds as unchanged, not uploaded', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']), 'b.js': chunk('b.js.map'), 'b.js.map': sourceMap(['src/b.ts']) })
    fetch.mockImplementation(async (url, options) =>
      options.body.get('minified_url').endsWith('/a.js') ? unchanged() : stored()
    )

    expect(await publish(dir)).toEqual({ uploaded: 1, unchanged: 1, failed: 0 })
  })

  it('counts a landed map as uploaded when the answer cannot be read', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad body') } })

    expect(await publish(dir)).toEqual({ uploaded: 1, unchanged: 0, failed: 0 })
  })

  it('says applied_count staying at 0 is the only sign a well-formed upload matched nothing', async () => {
    await publish(build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) }))

    expect(logged('applied_count staying at 0 is the only sign a well-formed upload matched nothing')).toBe(true)
    expect(logged('source maps: 1 uploaded, 0 unchanged, 0 failed')).toBe(true)
  })
})

describe('retries', () => {
  const oneMap = () => build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })

  it('retries a 5xx and counts the map uploaded when a retry lands', async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse(503, null))
      .mockResolvedValue(stored())

    const result = await publish(oneMap())

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ uploaded: 1, unchanged: 0, failed: 0 })
  })

  it('gives up after three attempts and counts the map failed', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'))

    const result = await publish(oneMap())

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 1 })
    expect(warned('source map a.js.map (for a.js) not uploaded: fetch failed')).toBe(true)
  })

  it('does not retry a 422, and reports what Flightdeck said', async () => {
    fetch.mockResolvedValue(rejection(422, 'source_map could not be parsed: unexpected token'))

    const result = await publish(oneMap())

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.failed).toBe(1)
    expect(warned('HTTP 422: source_map could not be parsed: unexpected token')).toBe(true)
  })
})

describe('a redirect', () => {
  // Followed, fetch would send the token header on to the new host, plain http
  // included, and a 301, 302 or 303 would turn the POST into a GET whose 200
  // counts as a map that landed.
  for (const status of [301, 302, 303, 307, 308]) {
    it(`is not followed on a ${status}, not retried, and counts the map failed`, async () => {
      fetch.mockResolvedValue({
        ok: false,
        status,
        statusText: 'Redirect',
        headers: new Headers({ location: 'http://elsewhere.example.net/api/1/sourcemap' }),
        json: async () => null
      })

      const result = await publish(build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) }))

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0][1].redirect).toBe('manual')
      expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 1 })
      expect(warned(
        `source map a.js.map (for a.js) not uploaded: HTTP ${status}: redirected to ` +
        'http://elsewhere.example.net/api/1/sourcemap; not followed with the token'
      )).toBe(true)
    })
  }

  it('is not followed when fetch hands back an opaque redirect', async () => {
    fetch.mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect', headers: new Headers(), json: async () => null })

    const result = await publish(build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) }))

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.failed).toBe(1)
    expect(warned('HTTP 0: redirected; not followed with the token')).toBe(true)
  })
})

describe('a rejected token', () => {
  for (const status of [401, 403]) {
    it(`stops the rest of the uploads on a ${status}, and still deletes the maps`, async () => {
      const files = {}
      for (let index = 0; index < 12; index++) {
        files[`chunk-${index}.js`] = chunk(`map-${index}.js.map`)
        files[`map-${index}.js.map`] = sourceMap([`src/${index}.ts`])
      }
      const dir = build(files)
      fetch.mockResolvedValue(rejection(status, 'invalid access token'))

      const result = await publish(dir)

      // At most the uploads already in flight when the first answer came back.
      expect(fetch.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY)
      expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 12 })
      expect(warned('the ingestion token was rejected')).toBe(true)
      expect(existsSync(path.join(dir, 'map-0.js.map'))).toBe(false)
    })
  }
})

describe('keeping maps off the site', () => {
  const site = () => build({
    'index.html': '<script src="/app.js"></script>',
    'app.js': chunk('9f8e.js.map'),
    '9f8e.js.map': sourceMap(['src/app.ts']),
    'css/site.css.map': '{"version":3,"sources":[],"names":[],"mappings":""}',
    'orphan.js.map': sourceMap(['src/orphan.ts'])
  })

  it('deletes every .map file by default, uploaded or not, and keeps everything else', async () => {
    const dir = site()

    await publish(dir)

    for (const map of ['9f8e.js.map', 'css/site.css.map', 'orphan.js.map']) expect(existsSync(path.join(dir, map))).toBe(false)
    for (const kept of ['index.html', 'app.js']) expect(existsSync(path.join(dir, kept))).toBe(true)
    expect(logged(`deleted 3 map file(s) from ${dir}, so a sync of it does not publish them`)).toBe(true)
  })

  it('leaves the maps in place with delete-maps off, and says a sync publishes them', async () => {
    const dir = site()

    await publish(dir, { deleteMaps: false })

    for (const map of ['9f8e.js.map', 'css/site.css.map', 'orphan.js.map']) expect(existsSync(path.join(dir, map))).toBe(true)
    expect(logged('left 3 map file(s)')).toBe(true)
    expect(logged('publishes them')).toBe(true)
  })

  it('still deletes the maps when the upload is skipped', async () => {
    const dir = site()

    await publish(dir, { token: '' })

    expect(fetch).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, '9f8e.js.map'))).toBe(false)
  })

  it('deletes compressed copies and maps in any case, and keeps other compressed files', async () => {
    // A compression plugin writes app.js.map.gz beside app.js.map by default.
    const dir = build({
      'app.js': chunk('app.js.map'),
      'app.js.map': sourceMap(['src/app.ts']),
      'app.js.map.gz': 'gzip bytes',
      'app.js.map.br': 'brotli bytes',
      'app.js.map.zst': 'zstd bytes',
      'b.js.MAP': sourceMap(['src/b.ts']),
      'c.js.Map.GZ': 'gzip bytes',
      'app.js.gz': 'gzip bytes',
      'app.js.mapping': 'not a map'
    })

    await publish(dir)

    for (const gone of ['app.js.map', 'app.js.map.gz', 'app.js.map.br', 'app.js.map.zst', 'b.js.MAP', 'c.js.Map.GZ']) {
      expect(existsSync(path.join(dir, gone)), gone).toBe(false)
    }
    for (const kept of ['app.js', 'app.js.gz', 'app.js.mapping']) expect(existsSync(path.join(dir, kept)), kept).toBe(true)
  })

  it('deletes a file a chunk names that reads as a map, whatever it is called', async () => {
    const dir = build({ 'app.js': chunk('app.js.json'), 'app.js.json': sourceMap(['src/app.ts']) })

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.filename)).toEqual(['app.js.json'])
    expect(result.uploaded).toBe(1)
    expect(existsSync(path.join(dir, 'app.js.json'))).toBe(false)
  })

  it.each([
    ['no token', { token: '' }],
    ['an unusable base URL', { baseUrl: 'example-app' }],
    ['an unusable endpoint', { endpoint: 'http://flightdeck.example.org' }]
  ])('deletes such a file when the upload is skipped for %s', async (unused, overrides) => {
    const dir = build({ 'app.js': chunk('app.js.json'), 'app.js.json': sourceMap(['src/app.ts']) })

    await publish(dir, overrides)

    expect(fetch).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, 'app.js.json'))).toBe(false)
  })

  it('keeps a file a chunk names that is not a map, and keeps such a file with delete-maps off', async () => {
    const dir = build({
      'app.js': chunk('index.html'),
      'index.html': '<!doctype html>',
      'other.js': chunk('other.js.json'),
      'other.js.json': sourceMap(['src/other.ts'])
    })

    const result = await publish(dir, { deleteMaps: false })

    expect(result).toEqual({ uploaded: 1, unchanged: 0, failed: 1 })
    expect(warned('skipping app.js: index.html is not a usable source map: it is not valid JSON')).toBe(true)
    for (const kept of ['index.html', 'other.js.json']) expect(existsSync(path.join(dir, kept)), kept).toBe(true)
  })
})

describe('reading the directory with care', () => {
  const unix = process.platform !== 'win32'
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it.skipIf(!unix || asRoot)('deletes the maps it can reach when one folder cannot be read, and says some were NOT deleted', async () => {
    const dir = build({
      'a.js': chunk('a.js.map'),
      'a.js.map': sourceMap(['src/a.ts']),
      'locked/b.js.map': sourceMap(['src/b.ts']),
      'open/c.js.map': sourceMap(['src/c.ts'])
    })
    chmodSync(path.join(dir, 'locked'), 0o000)
    try {
      const result = await publish(dir)

      expect(result.uploaded).toBe(1)
      for (const gone of ['a.js.map', 'open/c.js.map']) expect(existsSync(path.join(dir, gone)), gone).toBe(false)
      expect(warned(`could not read the folder locked in ${dir} (EACCES), so nothing in it was uploaded or deleted`)).toBe(true)
      expect(warned(`Not every map was deleted from ${dir}: 1 folder(s) could not be read (locked)`)).toBe(true)
      expect(warned('a sync of the directory will publish it')).toBe(true)
    } finally {
      chmodSync(path.join(dir, 'locked'), 0o755)
    }
    expect(existsSync(path.join(dir, 'locked/b.js.map'))).toBe(true)
  })

  it.skipIf(!unix)('does not follow a folder that is a symbolic link, and warns that a sync would publish what is under it', async () => {
    const outside = build({ 'x.js': chunk('x.js.map'), 'x.js.map': sourceMap(['src/x.ts']) })
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })
    symlinkSync(outside, path.join(dir, 'linked'))

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([`${BASE_URL}a.js`])
    expect(result.uploaded).toBe(1)
    expect(existsSync(path.join(outside, 'x.js.map'))).toBe(true)
    expect(warned('1 folder(s) in')).toBe(true)
    expect(warned('are symbolic links, which were not followed: linked')).toBe(true)
    expect(warned('aws s3 sync follows links by default and will publish any map under them')).toBe(true)
    expect(warned('1 folder(s) are symbolic links that were not followed (linked)')).toBe(true)
  })

  it.skipIf(!unix)('refuses to read a map that links outside the directory, and never logs what is in it', async () => {
    const outside = build({ 'private.txt': 'SECRET-VALUE-0000 not a map' })
    const dir = build({ 'a.js': chunk('a.js.map') })
    symlinkSync(path.join(outside, 'private.txt'), path.join(dir, 'a.js.map'))

    const result = await publish(dir)

    expect(fetch).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
    expect(warned('skipping a.js: a.js.map is a link to a file outside the directory, so it was not read')).toBe(true)
    // The link is removed from the directory; what it pointed at is untouched.
    expect(existsSync(path.join(dir, 'a.js.map'))).toBe(false)
    expect(readFileSync(path.join(outside, 'private.txt'), 'utf8')).toBe('SECRET-VALUE-0000 not a map')
  })

  it.skipIf(!unix)('reads a map that links to another file inside the directory', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'maps/real.map': sourceMap(['src/a.ts']) })
    symlinkSync(path.join(dir, 'maps/real.map'), path.join(dir, 'a.js.map'))

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.contents)).toEqual([stripped(['src/a.ts'])])
    expect(result.uploaded).toBe(1)
  })

  it('never repeats a broken map\'s contents in a log line', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': 'SECRET-VALUE-0000 is not json' })

    const result = await publish(dir)

    expect(result.failed).toBe(1)
    expect(warned('skipping a.js: a.js.map is not a usable source map: it is not valid JSON')).toBe(true)
    const lines = [...warningMock.mock.calls, ...infoMock.mock.calls].map(([text]) => text)
    expect(lines.some(text => text.includes('SECRET'))).toBe(false)
  })

  it('warns when the directory holds node_modules or .git, as it is probably set too high', async () => {
    const dir = build({
      'a.js': chunk('a.js.map'),
      'a.js.map': sourceMap(['src/a.ts']),
      'node_modules/lib/index.js': chunk(null),
      '.git/HEAD': 'ref: refs/heads/main\n'
    })

    await publish(dir)

    expect(warned(`${dir} holds node_modules, so it is probably set too high`)).toBe(true)
    expect(warned(`${dir} holds .git, so it is probably set too high`)).toBe(true)
  })

  it.skipIf(!unix)('skips a FIFO rather than blocking on it', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })
    const made = spawnSync('mkfifo', [path.join(dir, 'pipe.js')])
    if (made.status !== 0) return

    const result = await publish(dir)

    expect(result.uploaded).toBe(1)
    expect(warned('that are not regular files: pipe.js')).toBe(true)
  })

  it(`reads only the last ${TAIL_BYTES} bytes of a chunk`, async () => {
    // Read whole, this chunk's only comment is found past the blank lines; read
    // from the end, it is never reached.
    const dir = build({
      'far.js': `//# sourceMappingURL=far.js.map\n${'\n'.repeat(TAIL_BYTES + 100)}`,
      'far.js.map': sourceMap(['src/far.ts']),
      'big.js': chunk('big.js.map', `var x="${'a'.repeat(TAIL_BYTES * 4)}"`),
      'big.js.map': sourceMap(['src/big.ts'])
    })

    const result = await publish(dir)

    expect((await uploads()).map(upload => upload.minified_url)).toEqual([`${BASE_URL}big.js`])
    expect(result.uploaded).toBe(1)
    expect(logged('carry no sourceMappingURL comment, so there is no map to upload for them: far.js')).toBe(true)
  })

  it('still recognizes an inline map far longer than what is read', async () => {
    const dir = build({ 'inline.js': chunk(`data:application/json;base64,${'eyJ2'.repeat(TAIL_BYTES)}`) })

    await publish(dir)

    expect(fetch).not.toHaveBeenCalled()
    expect(warned('1 chunk(s) carry an inline data: source map, which is not uploaded: inline.js')).toBe(true)
  })
})

describe('gates', () => {
  const site = () => build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })

  it('warns and uploads nothing without a token', async () => {
    const result = await publish(site(), { token: '' })

    expect(fetch).not.toHaveBeenCalled()
    expect(setSecretMock).not.toHaveBeenCalled()
    expect(warned('no token was given')).toBe(true)
    expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 0 })
  })

  it('warns and does nothing at all without a directory', async () => {
    expect(await publish('')).toEqual({ uploaded: 0, unchanged: 0, failed: 0 })
    expect(await publish(path.join(tmpdir(), 'flightdeck-sourcemaps-does-not-exist'))).toEqual({ uploaded: 0, unchanged: 0, failed: 0 })

    expect(fetch).not.toHaveBeenCalled()
    expect(warned('no directory was given')).toBe(true)
    expect(warned('is not a directory')).toBe(true)
  })

  it('masks the token before anything else', async () => {
    const order = []
    setSecretMock.mockImplementation(() => order.push('setSecret'))
    warningMock.mockImplementation(() => order.push('warning'))
    infoMock.mockImplementation(() => order.push('info'))
    fetch.mockImplementation(async () => { order.push('fetch'); return stored() })

    await publish(site())

    expect(setSecretMock).toHaveBeenCalledWith(TOKEN)
    expect(order[0]).toBe('setSecret')
    expect(order).toContain('fetch')
  })

  it.each([
    ['an unusable version', { version: 'has a space' }, 'is not a usable code version'],
    ['no version', { version: '' }, 'is not a usable code version'],
    ['a version past 40 characters', { version: 'a'.repeat(41) }, 'is not a usable code version'],
    ['no base URL', { baseUrl: '' }, 'no base-url was given'],
    ['a base URL that is not one', { baseUrl: 'example-app' }, 'is not a URL'],
    ['a base URL with a query', { baseUrl: `${BASE_URL}?v=1` }, 'has a query or fragment'],
    ['an endpoint that is not https', { endpoint: 'http://flightdeck.example.org' }, 'is not https'],
    ['an endpoint that is not a URL', { endpoint: 'flightdeck' }, 'is not a URL'],
    // Resolves to other.example, with "flightdeck.example.org" as a user name.
    ['an endpoint with a user name', { endpoint: 'https://flightdeck.example.org@other.example' }, 'endpoint has a user name or password'],
    ['an endpoint with a password', { endpoint: 'https://user:pa55word@flightdeck.example.org' }, 'endpoint has a user name or password'],
    ['a base URL with a password', { baseUrl: 'https://user:pa55word@example-app.example.org/' }, 'base-url has a user name or password']
  ])('warns and uploads nothing given %s, but still deletes the maps', async (unused, overrides, message) => {
    const dir = site()

    const result = await publish(dir, overrides)

    expect(fetch).not.toHaveBeenCalled()
    expect(warned(message)).toBe(true)
    expect(result).toEqual({ uploaded: 0, unchanged: 0, failed: 0 })
    expect(existsSync(path.join(dir, 'a.js.map'))).toBe(false)
    // A user name or password could be a secret, so it is never repeated.
    expect(warningMock.mock.calls.some(([text]) => text.includes('pa55word') || text.includes('other.example'))).toBe(false)
  })

  it('normalizes a base URL to end in one slash', () => {
    expect(normalizeBaseUrl('https://Example-App.example.org')).toBe(BASE_URL)
    expect(normalizeBaseUrl('https://cdn.example.org/assets')).toBe('https://cdn.example.org/assets/')
    expect(normalizeBaseUrl('https://cdn.example.org/assets/')).toBe('https://cdn.example.org/assets/')
  })
})

describe('run', () => {
  function happyInputs (dir) {
    inputs.directory = dir
    inputs['base-url'] = BASE_URL
    inputs.version = VERSION
    inputs.token = TOKEN
    inputs.endpoint = ENDPOINT
  }

  it('reads its inputs and sets the three counts as outputs', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']), 'gone.js': chunk('gone.js.map') })
    happyInputs(dir)

    await run()

    expect(output('uploaded')).toBe('1')
    expect(output('unchanged')).toBe('0')
    expect(output('failed')).toBe('1')
    expect(existsSync(path.join(dir, 'a.js.map'))).toBe(false)
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('keeps the maps when delete-maps is false', async () => {
    const dir = build({ 'a.js': chunk('a.js.map'), 'a.js.map': sourceMap(['src/a.ts']) })
    happyInputs(dir)
    inputs['delete-maps'] = 'false'

    await run()

    expect(existsSync(path.join(dir, 'a.js.map'))).toBe(true)
  })

  it('never fails the job, and sets zero outputs, when there is nothing to work with', async () => {
    await run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(warned('no directory was given')).toBe(true)
    expect([output('uploaded'), output('unchanged'), output('failed')]).toEqual(['0', '0', '0'])
  })

  it('reads anything but "false" in delete-maps as true', () => {
    expect(deleteMapsInput('')).toBe(true)
    expect(deleteMapsInput('true')).toBe(true)
    expect(deleteMapsInput('FALSE')).toBe(false)
    expect(warningMock).not.toHaveBeenCalled()
    expect(deleteMapsInput('no')).toBe(true)
    expect(warned('delete-maps="no" is not true or false')).toBe(true)
  })
})

describe('the action', () => {
  it('is declared with the inputs and outputs it reads and sets', () => {
    const action = yaml.load(readFileSync(path.join(root, 'actions/flightdeck-sourcemaps/action.yml'), 'utf8'))

    expect(action.runs).toEqual({ using: 'node24', main: '../../dist/flightdeck-sourcemaps.js' })
    expect(Object.keys(action.inputs)).toEqual(['directory', 'base-url', 'version', 'token', 'endpoint', 'delete-maps'])
    expect(action.inputs.endpoint.default).toBe(DEFAULT_ENDPOINT)
    expect(action.inputs['delete-maps'].default).toBe('true')
    expect(Object.keys(action.outputs)).toEqual(['uploaded', 'unchanged', 'failed'])
  })

  it('is built from its entry file', () => {
    expect(readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8'))
      .toContain("'./src/entry/flightdeck-sourcemaps.js': 'flightdeck-sourcemaps'")
    expect(readFileSync(path.join(root, 'src/entry/flightdeck-sourcemaps.js'), 'utf8')).toMatch(/^run\(\)$/m)
  })

  describe('bundled', () => {
    let outDir
    beforeAll(async () => {
      outDir = mkdtempSync(path.join(tmpdir(), 'flightdeck-sourcemaps-bundle-'))
      await esbuild.build({
        entryPoints: [path.join(root, 'src/entry/flightdeck-sourcemaps.js')],
        bundle: true,
        platform: 'node',
        target: 'node24',
        outfile: path.join(outDir, 'flightdeck-sourcemaps.js'),
        logLevel: 'silent'
      })
    }, 120000)

    afterAll(() => rmSync(outDir, { recursive: true, force: true }))

    it('exits 0 with a warning and zero outputs when given nothing', () => {
      const outputFile = path.join(outDir, 'github-output')
      writeFileSync(outputFile, '')
      const env = { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, 'INPUT_DELETE-MAPS': 'true' }

      const result = spawnSync(process.execPath, [path.join(outDir, 'flightdeck-sourcemaps.js')], { env, encoding: 'utf8', timeout: 30000 })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('::warning::source maps not uploaded (job unaffected): no directory was given.')
      expect(result.stdout).not.toContain('::error::')
      const written = readFileSync(outputFile, 'utf8')
      for (const name of ['uploaded', 'unchanged', 'failed']) expect(written).toMatch(new RegExp(`^${name}<<[^\\n]+\\n0\\n`, 'm'))
    })
  })
})
