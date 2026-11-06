import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stage-less verify of a static site, against a mocked image reader. The
// deploy's own site checks run for real (planImageSite in
// src/v2/deploy-static.js), so what is pinned here is that verify refuses
// exactly what the deploy refuses, adds the link check, and never touches a
// bucket, a distribution, SSM or the error tracker.
const { aws, ssm, openImage, publishSourceMaps, core } = vi.hoisted(() => ({
  aws: {
    appInfoItem: vi.fn(),
    s3HeadObject: vi.fn(),
    s3PutObject: vi.fn(),
    cloudfrontCreateInvalidation: vi.fn(),
    cloudfrontInvalidationStatus: vi.fn(),
    ecrTagsForDigest: vi.fn()
  },
  ssm: { ssmParameterValue: vi.fn() },
  openImage: vi.fn(),
  publishSourceMaps: vi.fn(),
  core: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    getInput: vi.fn(),
    setOutput: vi.fn(),
    ExitCode: { Success: 0, Failure: 1 }
  }
}))

vi.mock('../src/v2/aws.js', async importOriginal => ({ ...(await importOriginal()), ...aws }))
vi.mock('../src/aws.js', async importOriginal => ({ ...(await importOriginal()), ...ssm }))
vi.mock('../src/v2/oci.js', () => ({ openImage }))
vi.mock('../src/v2/sourcemaps.js', async importOriginal => ({ ...(await importOriginal()), publishSourceMaps }))
vi.mock('@actions/core', () => core)

import { MAX_SITE_FILE_BYTES } from '../src/v2/deploy-static.js'
import { verifyStatic } from '../src/v2/verify-static.js'
import { run } from '../src/verify-static-site.js'

const IMAGE = `000000000000.dkr.ecr.us-east-1.amazonaws.com/example-app@sha256:${'b'.repeat(64)}`

const file = (name, contents = `contents of ${name}`) => ({ path: `site/${name}`, name, size: Buffer.byteLength(contents), contents: Buffer.from(contents) })
const tree = (files, extra = {}) => ({ files, links: [], others: [], ...extra })
const handle = (siteTree, labels = {}) => ({ labels, readTree: vi.fn(async () => siteTree), readDir: vi.fn(async () => []) })

// A small site whose every local link resolves.
const GOOD_SITE = [
  file('index.html', [
    '<!doctype html>',
    '<link rel="stylesheet" href="/assets/app-4a6b2c1d.css">',
    '<script src="/assets/app-9f8e7d6c.js"></script>',
    '<a href="about/">About</a> <a href="/guide">Guide</a> <a href="https://example.org/">elsewhere</a>',
    '<a href="mailto:someone@example.org">mail</a> <a href="#top">top</a>'
  ].join('\n')),
  file('about/index.html', '<img src="../favicon.ico"><a href="..">home</a><a href="/about/?tab=team">team</a>'),
  file('guide/index.html', '<a href="../about/">about</a>'),
  file('assets/app-4a6b2c1d.css'),
  file('assets/app-9f8e7d6c.js'),
  file('assets/app-9f8e7d6c.js.map'),
  file('favicon.ico')
]

function serve (siteTree, labels) {
  const image = handle(siteTree, labels)
  openImage.mockResolvedValue(image)
  return image
}

beforeEach(() => {
  for (const fn of [...Object.values(aws), ...Object.values(ssm), openImage, publishSourceMaps]) fn.mockReset()
  for (const fn of Object.values(core)) if (typeof fn === 'function') fn.mockReset()
  process.exitCode = undefined
})

function expectNothingTouched () {
  for (const fn of [...Object.values(aws), ...Object.values(ssm), publishSourceMaps]) expect(fn).not.toHaveBeenCalled()
}

describe('verifyStatic: a site that passes', () => {
  it('reads the image by digest, checks every local link, and says how many', async () => {
    const image = serve(tree(GOOD_SITE))

    const result = await verifyStatic({ image: IMAGE })

    expect(openImage).toHaveBeenCalledWith(IMAGE)
    expect(image.readTree).toHaveBeenCalledWith('/site', { maxBytes: MAX_SITE_FILE_BYTES })
    // The .map file is not uploaded without the label, so it is not counted.
    expect(result).toEqual({ pages: 3, links: 8, files: 6 })
    expect(core.info).toHaveBeenCalledWith('all 8 local links in 3 HTML pages name a file in the site')
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('touches no bucket, no distribution, no SSM parameter and no error tracker', async () => {
    serve(tree(GOOD_SITE), { 'org.cru.sourcemaps': '2026-11-06-10200', 'org.cru.public-sourcemaps': 'true' })
    await verifyStatic({ image: IMAGE })
    expectNothingTouched()
  })

  it('counts a served .map file as part of the site when the image serves its maps', async () => {
    serve(tree([...GOOD_SITE.filter(f => f.name !== 'index.html'), file('index.html', '<a href="/assets/app-9f8e7d6c.js.map">map</a>')]), {
      'org.cru.public-sourcemaps': 'true'
    })
    const result = await verifyStatic({ image: IMAGE })
    expect(result.files).toBe(7)
  })
})

describe('verifyStatic: a site the deploy would refuse', () => {
  it.each([
    ['no index.html', tree(GOOD_SITE.filter(f => f.name !== 'index.html')), 'has no /site/index.html'],
    ['nothing under /site', tree([]), 'has nothing under /site'],
    ['a symbolic link', tree(GOOD_SITE, { links: [{ path: 'site/latest', type: '2', target: 'v2' }] }), 'holds links, which the deploy cannot copy to a bucket'],
    ['a FIFO', tree(GOOD_SITE, { others: [{ path: 'site/pipe', type: '6' }] }), 'holds entries that are not files or directories'],
    ['a name that cannot be a key', tree([...GOOD_SITE, file('a/../b.html')]), 'holds names that cannot be object keys'],
    ['a file over the size limit', tree([...GOOD_SITE, { path: 'site/big.mp4', name: 'big.mp4', size: MAX_SITE_FILE_BYTES + 1, contents: null }]), 'is over the']
  ])('refuses a site with %s, in the deploy\'s own words', async (_label, siteTree, words) => {
    serve(siteTree)
    const error = await verifyStatic({ image: IMAGE }).catch(e => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(new RegExp(`^The deploy would refuse the site in ${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
    expect(error.message).toContain(words)
    expectNothingTouched()
  })

  it('refuses a site the image reader cannot read whole (two layers under /site)', async () => {
    openImage.mockResolvedValue({
      labels: {},
      readTree: vi.fn(async () => { throw new Error('/site has files in more than one layer (1/2 and 2/2)') })
    })
    const error = await verifyStatic({ image: IMAGE }).catch(e => e)
    expect(error.message).toBe(`The deploy would refuse the site in ${IMAGE}: /site has files in more than one layer (1/2 and 2/2)`)
  })

  it('says so when it cannot read the image at all', async () => {
    openImage.mockRejectedValue(new Error('ECR returned no manifest for example-app@sha256:bbb: ImageNotFound'))
    const error = await verifyStatic({ image: IMAGE }).catch(e => e)
    expect(error.message).toBe(`Could not read the image ${IMAGE}: ECR returned no manifest for example-app@sha256:bbb: ImageNotFound`)
  })

  it('refuses a tag reference before it reads anything', async () => {
    const error = await verifyStatic({ image: '000000000000.dkr.ecr.us-east-1.amazonaws.com/example-app:candidate-2026-11-06-10200' }).catch(e => e)
    expect(error.message).toContain('Expected a digest-pinned image reference')
    expect(openImage).not.toHaveBeenCalled()
  })
})

describe('verifyStatic: broken links', () => {
  const withIndex = html => tree([...GOOD_SITE.filter(f => f.name !== 'index.html'), file('index.html', html)])

  it('fails, naming each missing file, and logs every broken link', async () => {
    serve(tree([
      ...GOOD_SITE.filter(f => !['index.html', 'guide/index.html'].includes(f.name)),
      file('index.html', '<a href="/missing/">m</a>\n<img src="/img/none.png">'),
      file('guide/index.html', '<a href="/missing/">m</a>')
    ]))
    const error = await verifyStatic({ image: IMAGE }).catch(e => e)
    expect(error.message).toBe(
      '3 of the 6 local links in the site\'s 3 HTML pages point at files that are not in the site, so those links would ' +
      'be broken once it is live. Missing: missing/index.html (2 links, first index.html line 1: href="/missing/"); ' +
      'img/none.png (1 link, first index.html line 2: src="/img/none.png")'
    )
    expect(core.startGroup).toHaveBeenCalledWith('3 broken local links')
    expect(core.info).toHaveBeenCalledWith('index.html line 1: <a href="/missing/"> wants missing/index.html')
    expect(core.info).toHaveBeenCalledWith('guide/index.html line 1: <a href="/missing/"> wants missing/index.html')
    expect(core.info).toHaveBeenCalledWith('index.html line 2: <img src="/img/none.png"> wants img/none.png')
    expect(core.endGroup).toHaveBeenCalled()
    expectNothingTouched()
  })

  it('counts a link to a .map file the deploy will not upload as broken', async () => {
    serve(withIndex('<a href="/assets/app-9f8e7d6c.js.map">map</a>'))
    const error = await verifyStatic({ image: IMAGE }).catch(e => e)
    expect(error.message).toContain('Missing: assets/app-9f8e7d6c.js.map (1 link')
  })

  it('names both files an extensionless link could have been', async () => {
    serve(withIndex('<a href="/nowhere">x</a>'))
    await verifyStatic({ image: IMAGE }).catch(() => {})
    expect(core.info).toHaveBeenCalledWith('index.html line 1: <a href="/nowhere"> wants nowhere or nowhere/index.html')
  })
})

describe('verifyStatic: warnings that do not fail it', () => {
  it('warns about a linked file that will be served as application/octet-stream, and not one nobody links to', async () => {
    serve(tree([
      ...GOOD_SITE.filter(f => f.name !== 'index.html'),
      file('index.html', '<a href="/files/tool.tf">tool</a>'),
      file('files/tool.tf'),
      file('CNAME')
    ]))
    const result = await verifyStatic({ image: IMAGE })
    expect(result.pages).toBe(3)
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning.mock.calls[0][0]).toContain('link to 1 files the deploy will serve as application/octet-stream')
    expect(core.warning.mock.calls[0][0]).toContain('files/tool.tf')
    expect(core.warning.mock.calls[0][0]).not.toContain('CNAME')
  })

  it('warns about a served .map file with no file next to it to map', async () => {
    serve(tree([...GOOD_SITE, file('assets/orphan-1a2b3c4d.js.map')]), { 'org.cru.public-sourcemaps': 'true' })
    await verifyStatic({ image: IMAGE })
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning.mock.calls[0][0]).toContain('1 .map files under /site have no file next to them to map')
    expect(core.warning.mock.calls[0][0]).toContain('assets/orphan-1a2b3c4d.js.map')
  })

  it('does not look at unpaired maps when the image does not serve them', async () => {
    serve(tree([...GOOD_SITE, file('assets/orphan-1a2b3c4d.js.map')]))
    await verifyStatic({ image: IMAGE })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('passes on the deploy\'s warning about a public-sourcemaps label it does not know', async () => {
    serve(tree(GOOD_SITE), { 'org.cru.public-sourcemaps': 'yes' })
    await verifyStatic({ image: IMAGE })
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('org.cru.public-sourcemaps="yes", which is not the string "true"'))
  })
})

describe('the verify-static-site action', () => {
  it('sets its outputs on a pass', async () => {
    serve(tree(GOOD_SITE))
    core.getInput.mockReturnValue(IMAGE)
    await run()
    expect(core.getInput).toHaveBeenCalledWith('image', { required: true })
    expect(core.setOutput.mock.calls).toEqual([['pages', '3'], ['links', '8'], ['files', '6']])
    expect(core.error).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('fails the step with a "Verification failed" error that says the candidate is not verified', async () => {
    serve(tree(GOOD_SITE.filter(f => f.name !== 'index.html')))
    core.getInput.mockReturnValue(IMAGE)
    await run()
    expect(core.error).toHaveBeenCalledTimes(1)
    const [message, properties] = core.error.mock.calls[0]
    expect(properties).toEqual({ title: 'Verification failed' })
    expect(message).toMatch(/^The deploy would refuse the site in .*has no \/site\/index\.html\. A static site needs one at its root: .*\. This candidate is not verified\.$/)
    expect(process.exitCode).toBe(1)
    expect(core.setOutput).not.toHaveBeenCalled()
  })
})
