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
    ['Bucket', { Bucket: undefined }, /has no Bucket\. A static site deploys/],
    ['DistributionId', { DistributionId: undefined }, /has no DistributionId\. A static site deploys/],
    ['both', { Bucket: '', DistributionId: ' ' }, /has no Bucket and no DistributionId\./]
  ])('refuses a row with no %s, before anything changes', async (_label, change, message) => {
    appInfoItem.mockResolvedValue({ ...ROW, ...change })
    const error = await staticSiteTarget('example-app', 'production').catch(e => e)
    expect(error.message).toMatch(message)
    expect(error.message).toContain("example-app's CruApplicationInfo row for 'production'")
    expect(error.message).toMatch(/Nothing was changed\.$/)
  })

  it('refuses a missing row', async () => {
    appInfoItem.mockResolvedValue(null)
    await expect(staticSiteTarget('example-app', 'production')).rejects.toThrow(/No CruApplicationInfo row for example-app in 'production'.*Nothing was changed/)
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
    ['data.unknownext', 'application/octet-stream']
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
    'fonts/inter.1a2b3c4d5e6f7a8b9c0d.woff2'
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
    ['a base64 hash', 'assets/index-DiwrgTda.js']
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
  const plan = (files, links = []) => planSite({ files, links }, { maxBytes: 1024, image: IMAGE })

  it('sorts files into assets, HTML and index.html, and keeps .map files out', () => {
    const site = plan([
      file('index.html', '<html>'),
      file('about/index.html'),
      file('assets/app-4a6b2c1d.js'),
      file('assets/app-4a6b2c1d.js.map'),
      file('robots.txt'),
      file('stray.MAP')
    ])
    expect(site.index).toMatchObject({ key: 'index.html', contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', immutable: false })
    expect(site.index.contents.toString()).toBe('<html>')
    expect(site.html.map(entry => entry.key)).toEqual(['about/index.html'])
    expect(site.assets.map(entry => [entry.key, entry.immutable, entry.cacheControl])).toEqual([
      ['assets/app-4a6b2c1d.js', true, HASHED_CACHE_CONTROL],
      ['robots.txt', false, DEFAULT_CACHE_CONTROL]
    ])
    expect(site.maps).toEqual(['assets/app-4a6b2c1d.js.map', 'stray.MAP'])
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

  it('refuses links, which cannot be copied to a bucket', () => {
    expect(() => plan([file('index.html')], [{ path: 'site/latest.js', name: 'latest.js', type: '2' }])).toThrow(
      /\/site in .* holds links, which the deploy cannot copy to a bucket: site\/latest\.js/
    )
  })
})
