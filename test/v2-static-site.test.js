import { describe, it, expect, beforeEach, vi } from 'vitest'

// The pieces a static site's deploy and resolve share: where the site lives,
// what index.html says is live, and how each file is uploaded. The two cloud
// calls they make are mocked here; the calls themselves are covered in
// test/v2-aws-static.test.js.
const { appInfoItem, s3HeadObject, warning } = vi.hoisted(() => ({
  appInfoItem: vi.fn(),
  s3HeadObject: vi.fn(),
  warning: vi.fn()
}))
vi.mock('../src/v2/aws.js', () => ({ appInfoItem, s3HeadObject }))
vi.mock('@actions/core', () => ({ info: vi.fn(), warning }))

import {
  DEFAULT_CACHE_CONTROL,
  HASHED_CACHE_CONTROL,
  HTML_CACHE_CONTROL,
  cacheControlFor,
  contentTypeFor,
  isContentHashed,
  planSite,
  readLiveRelease,
  releaseMetadata,
  servesSourceMaps,
  staticSiteTarget
} from '../src/v2/static-site.js'

const DIGEST = 'sha256:' + 'a'.repeat(64)
const IMAGE = `000000000000.dkr.ecr.us-east-1.amazonaws.com/example-app@${DIGEST}`
const ROW = { Project: 'example-app', Environment: 'staging', Type: 'static', PipelineVersion: '2', Bucket: 'example-site-stage', DistributionId: 'E000EXAMPLE000' }

beforeEach(() => {
  appInfoItem.mockReset()
  s3HeadObject.mockReset()
  warning.mockReset()
})

describe('staticSiteTarget', () => {
  it('reads Bucket and DistributionId from the row for the legacy environment name', async () => {
    appInfoItem.mockResolvedValue(ROW)
    expect(await staticSiteTarget('example-app', 'release-candidate')).toEqual({ bucket: 'example-site-stage', distributionId: 'E000EXAMPLE000' })
    expect(appInfoItem).toHaveBeenCalledWith('example-app', 'staging')
    appInfoItem.mockResolvedValue({ ...ROW, Bucket: 'example-site-prod' })
    await staticSiteTarget('example-app', 'production')
    expect(appInfoItem).toHaveBeenLastCalledWith('example-app', 'production')
  })

  it.each([
    ['Bucket', { Bucket: undefined }, /has no Bucket\. A static site is served from/],
    ['DistributionId', { DistributionId: undefined }, /has no DistributionId\. A static site is served from/],
    ['both', { Bucket: '', DistributionId: ' ' }, /has no Bucket and no DistributionId\./]
  ])('refuses a row with no %s', async (_label, change, message) => {
    appInfoItem.mockResolvedValue({ ...ROW, ...change })
    const error = await staticSiteTarget('example-app', 'production').catch(e => e)
    expect(error.message).toMatch(message)
    expect(error.message).toContain("example-app's CruApplicationInfo row for 'production'")
    // Both a deploy and a resolve ask, so the message is neither's: the
    // deploy adds that nothing was changed.
    expect(error.message).not.toMatch(/deploy|Nothing was changed/i)
  })

  it('refuses a missing row, in words that suit a resolve as well as a deploy', async () => {
    appInfoItem.mockResolvedValue(null)
    const error = await staticSiteTarget('example-app', 'production').catch(e => e)
    expect(error.message).toBe(
      "No CruApplicationInfo row for example-app in 'production' (production), so there is no S3 bucket or CloudFront " +
      'distribution on record for the site there.'
    )
  })

  it('quotes a value with a line break, so it cannot start a workflow command', async () => {
    appInfoItem.mockResolvedValue({ ...ROW, Bucket: 'example\n::error::injected' })
    const error = await staticSiteTarget('example-app', 'production').catch(e => e)
    expect(error.message).not.toContain('\n')
    expect(error.message).toContain('"\\"example\\n::error::injected\\""')
  })

  it.each([
    ['a bucket name S3 would refuse', { Bucket: 'Example_Site' }, /names Bucket "Example_Site", which is not an S3 bucket name/],
    ['a bucket ARN', { Bucket: 'arn:aws:s3:::example-site' }, /which is not an S3 bucket name/],
    ['a distribution domain', { DistributionId: 'd111111abcdef8.cloudfront.net' }, /which is not a CloudFront distribution id/]
  ])('refuses %s', async (_label, change, message) => {
    appInfoItem.mockResolvedValue({ ...ROW, ...change })
    await expect(staticSiteTarget('example-app', 'production')).rejects.toThrow(message)
  })

  it('refuses an unknown environment before reading anything', async () => {
    await expect(staticSiteTarget('example-app', 'qa')).rejects.toThrow(/Unknown v2 environment "qa"/)
    expect(appInfoItem).not.toHaveBeenCalled()
  })
})

describe('readLiveRelease', () => {
  it('reads the release index.html names', async () => {
    s3HeadObject.mockResolvedValue({ metadata: { 'cru-digest': DIGEST, 'cru-revision': 'release-2026-11-01-10100', 'cru-sha': 'abc1234' } })
    expect(await readLiveRelease('example-site-prod')).toEqual({ digest: DIGEST, revision: 'release-2026-11-01-10100', sha: 'abc1234' })
    expect(s3HeadObject).toHaveBeenCalledWith('example-site-prod', 'index.html')
  })

  it('is null when there is no index.html (a first deploy)', async () => {
    s3HeadObject.mockResolvedValue(null)
    expect(await readLiveRelease('example-site-prod')).toBeNull()
  })

  it('names no digest when index.html carries no metadata', async () => {
    s3HeadObject.mockResolvedValue({ metadata: {} })
    expect(await readLiveRelease('example-site-prod')).toEqual({ digest: '', revision: '', sha: '' })
  })

  it('ignores a cru-digest that is not a digest, and says so', async () => {
    s3HeadObject.mockResolvedValue({ metadata: { 'cru-digest': 'latest' } })
    expect((await readLiveRelease('example-site-prod')).digest).toBe('')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('is not a sha256 digest'))
  })

  it('passes an access-denied error on, so the caller fails with its message', async () => {
    s3HeadObject.mockRejectedValue(new Error('S3 refused s3:GetObject (HeadObject) on s3://example-site-prod/index.html (access denied).'))
    await expect(readLiveRelease('example-site-prod')).rejects.toThrow(/access denied/)
  })
})

describe('releaseMetadata', () => {
  it('writes the digest, revision and sha', () => {
    expect(releaseMetadata({ digest: DIGEST, revision: 'candidate-2026-11-04-10150', sha: 'abc1234' })).toEqual({
      'cru-digest': DIGEST, 'cru-revision': 'candidate-2026-11-04-10150', 'cru-sha': 'abc1234'
    })
  })

  it('leaves out an empty value, and one that cannot travel as a header', () => {
    expect(releaseMetadata({ digest: DIGEST, revision: '', sha: 'abc\n123' })).toEqual({ 'cru-digest': DIGEST })
    expect(releaseMetadata({ digest: DIGEST, revision: 'rélease' })).toEqual({ 'cru-digest': DIGEST })
  })
})

describe('content type', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['docs/page.HTM', 'text/html; charset=utf-8'],
    ['assets/app-1a2b3c4d.js', 'text/javascript; charset=utf-8'],
    ['assets/app.mjs', 'text/javascript; charset=utf-8'],
    ['assets/app-1a2b3c4d.css', 'text/css; charset=utf-8'],
    ['manifest.json', 'application/json; charset=utf-8'],
    ['site.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['photo.JPG', 'image/jpeg'],
    ['favicon.ico', 'image/x-icon'],
    ['fonts/a.woff2', 'font/woff2'],
    ['robots.txt', 'text/plain; charset=utf-8'],
    ['app.wasm', 'application/wasm'],
    ['LICENSE', 'application/octet-stream'],
    ['.well-known/thing', 'application/octet-stream'],
    ['data.unknownext', 'application/octet-stream'],
    ['captions/en.vtt', 'text/vtt; charset=utf-8'],
    ['video/intro.mov', 'video/quicktime'],
    ['video/intro.m4v', 'video/x-m4v'],
    ['audio/song.flac', 'audio/flac'],
    ['audio/song.aac', 'audio/aac'],
    ['audio/song.opus', 'audio/opus'],
    ['feed.rss', 'application/rss+xml; charset=utf-8'],
    ['feed.atom', 'application/atom+xml; charset=utf-8'],
    ['models/chair.glb', 'model/gltf-binary'],
    ['models/chair.gltf', 'model/gltf+json'],
    ['apple-app-site-association', 'application/json'],
    ['.well-known/apple-app-site-association', 'application/json'],
    ['assets/app.4a6b2c1d.js.map', 'application/json; charset=utf-8'],
    ['loader.js.MAP', 'application/json; charset=utf-8']
  ])('%s is %s', (key, type) => {
    expect(contentTypeFor(key)).toBe(type)
  })
})

describe('content-hashed names', () => {
  it.each([
    'assets/index-4a6b2c1d.js', // Vite 4
    'static/js/main.4a6b2c1d.chunk.js', // webpack, create-react-app
    '_next/static/chunks/pages/index-4a6b2c1d4a6b2c1d.js',
    'assets/4a6b2c1d9e8f.css',
    'img/logo_0f1e2d3c.png',
    'fonts/inter.1a2b3c4d5e6f7a8b9c0d.woff2',
    // A map named after a hashed bundle is hashed too, by the bundle's hash.
    'assets/app.4a6b2c1d.js.map', // webpack's [file].map
    'assets/index-4a6b2c1d.js.map', // Vite 4
    'assets/app.9f8e7d6c.css.map'
  ])('%s is hashed', (key) => {
    expect(isContentHashed(key)).toBe(true)
    expect(cacheControlFor(key)).toBe(HASHED_CACHE_CONTROL)
  })

  it.each([
    ['too short', 'assets/app-4a6b2c1.js'],
    ['a date, all digits', 'reports/summary-20261104.pdf'],
    ['a word spelled in hex letters', 'img/deadbeef-cafe.png'],
    ['no hash at all', 'favicon.ico'],
    ['an unhashed bundle', 'assets/app.js'],
    ['uppercase hex', 'assets/app-4A6B2C1D.js'],
    ['a hash in a directory name only', 'build/4a6b2c1d/app.js'],
    ['a base64 hash', 'assets/index-DiwrgTda.js'],
    ['the map of an unhashed file', 'sw.js.map'],
    ['the map of a base64-hashed bundle', 'assets/index-DiwrgTda.js.map']
  ])('%s (%s) is not hashed', (_label, key) => {
    expect(isContentHashed(key)).toBe(false)
    expect(cacheControlFor(key)).toBe(DEFAULT_CACHE_CONTROL)
  })

  it('never caches HTML, even with a hash in its name', () => {
    expect(cacheControlFor('index.html')).toBe(HTML_CACHE_CONTROL)
    expect(cacheControlFor('pages/about-4a6b2c1d.html')).toBe(HTML_CACHE_CONTROL)
  })
})

describe('planSite', () => {
  const file = (name, contents = 'x', size) => ({ path: `site/${name}`, name, size: size ?? Buffer.byteLength(contents), contents: contents === null ? null : Buffer.from(contents) })
  const plan = (files, { links = [], others = [] } = {}) => planSite({ files, links, others }, { maxBytes: 1024, image: IMAGE })

  it('sorts files into hashed, unhashed, HTML and index.html, and keeps .map files out', () => {
    const site = plan([
      file('index.html', '<html>'),
      file('about/index.html'),
      file('assets/app-4a6b2c1d.js'),
      file('assets/app-4a6b2c1d.js.map'),
      file('robots.txt'),
      file('sw.js'),
      file('stray.MAP')
    ])
    expect(site.index).toMatchObject({ key: 'index.html', contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', immutable: false })
    expect(site.index.contents.toString()).toBe('<html>')
    expect(site.html.map(entry => entry.key)).toEqual(['about/index.html'])
    expect(site.hashed.map(entry => [entry.key, entry.immutable, entry.cacheControl])).toEqual([
      ['assets/app-4a6b2c1d.js', true, HASHED_CACHE_CONTROL]
    ])
    expect(site.unhashed.map(entry => [entry.key, entry.immutable, entry.cacheControl])).toEqual([
      ['robots.txt', false, DEFAULT_CACHE_CONTROL],
      ['sw.js', false, DEFAULT_CACHE_CONTROL]
    ])
    expect(site.maps).toEqual(['assets/app-4a6b2c1d.js.map', 'stray.MAP'])
    expect(site.unhashedMaps).toEqual([])
  })

  describe('with publicMaps', () => {
    const files = [
      file('index.html', '<html>'),
      file('assets/app.4a6b2c1d.js'),
      file('assets/app.4a6b2c1d.js.map', '{"version":3}'),
      file('assets/app.9f8e7d6c.css.map'),
      file('sw.js'),
      file('sw.js.map'),
      file('stray.MAP')
    ]

    it('sorts a hashed map in with the hashed files, and keeps the rest apart', () => {
      const site = planSite({ files, links: [], others: [] }, { maxBytes: 1024, image: IMAGE, publicMaps: true })
      expect(site.hashed.map(entry => [entry.key, entry.immutable, entry.cacheControl, entry.contentType])).toEqual([
        ['assets/app.4a6b2c1d.js', true, HASHED_CACHE_CONTROL, 'text/javascript; charset=utf-8'],
        ['assets/app.4a6b2c1d.js.map', true, HASHED_CACHE_CONTROL, 'application/json; charset=utf-8'],
        ['assets/app.9f8e7d6c.css.map', true, HASHED_CACHE_CONTROL, 'application/json; charset=utf-8']
      ])
      expect(site.hashed[1].contents.toString()).toBe('{"version":3}')
      expect(site.unhashedMaps.map(entry => [entry.key, entry.immutable, entry.cacheControl, entry.contentType])).toEqual([
        ['sw.js.map', false, DEFAULT_CACHE_CONTROL, 'application/json; charset=utf-8'],
        ['stray.MAP', false, DEFAULT_CACHE_CONTROL, 'application/json; charset=utf-8']
      ])
      expect(site.unhashed.map(entry => entry.key)).toEqual(['sw.js'])
      expect(site.maps).toEqual(['assets/app.4a6b2c1d.js.map', 'assets/app.9f8e7d6c.css.map', 'sw.js.map', 'stray.MAP'])
    })

    it('still runs every check on the maps, which are now uploaded', () => {
      expect(() => planSite({ files: [file('index.html'), file('a//b.js.map')], links: [], others: [] }, {
        maxBytes: 1024, image: IMAGE, publicMaps: true
      })).toThrow('it has an empty path segment')
    })
  })

  it('keeps a hard-linked file, which tar.js has already followed', () => {
    const site = plan([file('index.html'), { ...file('copy.html', '<html>'), linkTo: 'site/index.html' }])
    expect(site.html.map(entry => entry.key)).toEqual(['copy.html'])
  })

  it('refuses a site with no index.html at its root', () => {
    expect(() => plan([file('about/index.html'), file('app.js')])).toThrow(/has no \/site\/index\.html/)
  })

  it('refuses an image with nothing under /site', () => {
    expect(() => plan([])).toThrow(/has nothing under \/site/)
  })

  it('refuses a file over the per-file limit, naming it and its size', () => {
    expect(() => plan([file('index.html'), file('video.mp4', null, 5000)])).toThrow(
      'the site is too big to deploy: site/video.mp4 (5000 bytes) is over the 1024-byte limit for one file'
    )
  })

  it('refuses a symbolic link, naming its target', () => {
    expect(() => plan([file('index.html')], { links: [{ path: 'site/latest.js', name: 'latest.js', type: '2', target: 'app-4a6b2c1d.js' }] })).toThrow(
      /\/site in .* holds links, which the deploy cannot copy to a bucket: site\/latest\.js is a symbolic link to app-4a6b2c1d\.js/
    )
  })

  it('refuses a hard link whose target the layer does not hold, saying it is a hard link', () => {
    expect(() => plan([file('index.html')], { links: [{ path: 'site/copy.js', name: 'copy.js', type: '1', target: 'build/app.js' }] })).toThrow(
      'site/copy.js is a hardlink to build/app.js, which is not in the same layer'
    )
  })

  it.each([
    ['6', 'FIFO'],
    ['3', 'character device'],
    ['4', 'block device'],
    ['S', 'tar type S']
  ])('refuses an entry of type %s (%s) loudly, not by skipping it', (type, label) => {
    expect(() => plan([file('index.html')], { others: [{ path: 'site/odd', name: 'odd', type }] })).toThrow(
      `holds entries that are not files or directories: site/odd (${label})`
    )
  })

  it.each([
    ['a .. segment', '../escape.html', 'it has a . or .. path segment'],
    ['a . segment', './dot.js', 'it has a . or .. path segment'],
    ['a nested .. segment', 'assets/../../x.js', 'it has a . or .. path segment'],
    ['an empty segment', 'assets//double.js', 'it has an empty path segment'],
    ['a leading /', '/double.js', 'it starts with /'],
    ['an overlay whiteout', '.wh.old.js', 'it is an overlay whiteout (.wh.*)'],
    ['an opaque-directory whiteout', 'assets/.wh..wh..opq', 'it is an overlay whiteout (.wh.*)'],
    ['a name that is not UTF-8', '\ufffd.js', 'it is not valid UTF-8'],
    ['a control character', 'bad\u0007name.js', 'it holds a control character'],
    ['a key over 1024 bytes', `${'k'.repeat(1100)}.js`, "it is over S3's 1024-byte limit for a key"],
    ['1024 bytes of multi-byte characters', `${'é'.repeat(513)}`, "it is over S3's 1024-byte limit for a key"]
  ])('refuses %s, before anything is uploaded', (_label, name, why) => {
    expect(() => plan([file('index.html'), file(name)])).toThrow(`holds names that cannot be object keys: `)
    expect(() => plan([file('index.html'), file(name)])).toThrow(why)
  })

  it('accepts a key of exactly 1024 bytes, and UTF-8 names', () => {
    const site = plan([file('index.html'), file(`${'k'.repeat(1021)}.js`), file('assets/café-4a6b2c1d.css')])
    expect(site.unhashed.map(entry => entry.key.length)).toEqual([1024])
    expect(site.hashed.map(entry => entry.key)).toEqual(['assets/café-4a6b2c1d.css'])
  })

  it('quotes a name with a line break, so it cannot start a workflow command', () => {
    const error = (() => { try { plan([file('index.html'), file('x\n::error::y.js')]) } catch (e) { return e } })()
    expect(error.message).not.toContain('\n')
    expect(error.message).toContain('"site/x\\n::error::y.js"')
  })

  it('refuses a name that appears twice, since which copy to serve is a guess', () => {
    expect(() => plan([file('index.html', 'first'), file('app.js'), file('index.html', 'second')])).toThrow(
      'holds the same name more than once, so which copy to serve is a guess: site/index.html'
    )
  })
})

describe('servesSourceMaps', () => {
  it('is on for exactly "true"', () => {
    expect(servesSourceMaps({ 'org.cru.public-sourcemaps': 'true' })).toBe(true)
  })

  it.each([
    ['no labels', undefined],
    ['no such label', { 'org.cru.sourcemaps': 'abc1234' }],
    ['false', { 'org.cru.public-sourcemaps': 'false' }],
    ['True', { 'org.cru.public-sourcemaps': 'True' }],
    ['true with a space', { 'org.cru.public-sourcemaps': ' true' }],
    ['yes', { 'org.cru.public-sourcemaps': 'yes' }],
    ['1', { 'org.cru.public-sourcemaps': '1' }],
    ['empty', { 'org.cru.public-sourcemaps': '' }]
  ])('is off for %s', (_label, labels) => {
    expect(servesSourceMaps(labels)).toBe(false)
  })
})
