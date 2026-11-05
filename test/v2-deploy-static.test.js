import { describe, it, expect, beforeEach, vi } from 'vitest'

// The static site deploy, end to end against mocked cloud calls: the S3,
// CloudFront, app-info and ECR calls in src/v2/aws.js, the SSM read in
// src/aws.js, and the image reader in src/v2/oci.js. What is pinned here is
// the order things change in, what each upload carries, and what a failure
// leaves behind.
const { aws, ssmParameterValue, openImage, publishSourceMaps, core, events } = vi.hoisted(() => ({
  aws: {
    appInfoItem: vi.fn(),
    s3HeadObject: vi.fn(),
    s3PutObject: vi.fn(),
    cloudfrontCreateInvalidation: vi.fn(),
    cloudfrontInvalidationStatus: vi.fn(),
    ecrTagsForDigest: vi.fn()
  },
  ssmParameterValue: vi.fn(),
  openImage: vi.fn(),
  publishSourceMaps: vi.fn(),
  core: { info: vi.fn(), warning: vi.fn(), notice: vi.fn(), setSecret: vi.fn() },
  events: []
}))

vi.mock('../src/v2/aws.js', async importOriginal => {
  const real = await importOriginal()
  return {
    ...aws,
    STATIC_DEPLOY_ROLE: real.STATIC_DEPLOY_ROLE,
    isAccessDenied: real.isAccessDenied,
    ecrImageRef: (name, digest) => `000000000000.dkr.ecr.us-east-1.amazonaws.com/${name}@${digest}`
  }
})
vi.mock('../src/aws.js', async importOriginal => ({ isPermanentAwsError: (await importOriginal()).isPermanentAwsError, ssmParameterValue }))
vi.mock('../src/v2/oci.js', () => ({ openImage }))
vi.mock('../src/v2/sourcemaps.js', async importOriginal => ({ ...(await importOriginal()), publishSourceMaps }))
vi.mock('@actions/core', () => core)

import { INVALIDATION_WAIT_MS, MAX_SITE_FILE_BYTES, PUT_BACK_RESERVE_MS, deployStatic, releaseIdentity } from '../src/v2/deploy-static.js'
import { STEP_CAP_MS } from '../src/v2/rollout-budget.js'

const REGISTRY = '000000000000.dkr.ecr.us-east-1.amazonaws.com'
const NEW = 'sha256:' + 'b'.repeat(64)
const OLD = 'sha256:' + 'a'.repeat(64)
const IMAGE = `${REGISTRY}/example-app@${NEW}`
const OLD_IMAGE = `${REGISTRY}/example-app@${OLD}`
const BUCKET = 'example-site-prod'
const DISTRIBUTION = 'E000EXAMPLE000'
const APP_URL = 'https://example-site.example.org'

const ROW = { Type: 'static', PipelineVersion: '2', Bucket: BUCKET, DistributionId: DISTRIBUTION }
const OLD_METADATA = { 'cru-digest': OLD, 'cru-revision': 'release-2026-10-01-10090', 'cru-sha': 'aaa1111' }

const file = (name, contents = `contents of ${name}`) => ({ path: `site/${name}`, name, size: Buffer.byteLength(contents), contents: Buffer.from(contents) })

// The release being deployed: a hashed and an unhashed asset, a map under
// /site that must never reach the bucket, a nested page and index.html.
const NEW_SITE = {
  files: [
    file('index.html', '<html>new</html>'),
    file('assets/app-4a6b2c1d.js'),
    file('assets/app-4a6b2c1d.js.map'),
    file('about/index.html'),
    file('favicon.ico'),
    file('assets/app-9f8e7d6c.css')
  ],
  links: []
}

// The release that was live before it.
const OLD_SITE = {
  files: [
    file('index.html', '<html>old</html>'),
    file('assets/app-1a2b3c4d.js'),
    file('about/index.html', '<html>old about</html>'),
    file('favicon.ico', 'old icon')
  ],
  links: []
}

const handle = (tree, labels = {}) => ({ labels, readTree: vi.fn(async () => tree), readDir: vi.fn(async () => []) })

let images
let clock

function stubs ({ live = { metadata: OLD_METADATA }, labels = {}, newSite = NEW_SITE } = {}) {
  images = { [IMAGE]: handle(newSite, labels), [OLD_IMAGE]: handle(OLD_SITE) }
  openImage.mockImplementation(async ref => {
    if (!images[ref]) throw new Error(`no image ${ref}`)
    events.push(`open:${ref === IMAGE ? 'new' : 'old'}`)
    return images[ref]
  })
  aws.appInfoItem.mockResolvedValue(ROW)
  aws.s3HeadObject.mockResolvedValue(live)
  aws.ecrTagsForDigest.mockResolvedValue(['candidate-2026-11-04-10150', 'sha-bbb2222', 'release-2026-11-04-10150'])
  aws.s3PutObject.mockImplementation(async (bucket, key) => { events.push(`put:${key}`) })
  aws.cloudfrontCreateInvalidation.mockImplementation(async () => { events.push('invalidate'); return 'I000EXAMPLE' })
  aws.cloudfrontInvalidationStatus.mockResolvedValue('Completed')
  publishSourceMaps.mockImplementation(async () => { events.push('maps'); return { status: 'uploaded', uploaded: 1, failed: 0 } })
}

const deploy = (args = {}) => deployStatic({
  projectName: 'example-app',
  environment: 'production',
  image: IMAGE,
  appUrl: APP_URL,
  revision: 'release-2026-11-04-10150',
  ...args
}, clock)

const puts = () => aws.s3PutObject.mock.calls.map(([, key]) => key)
const putOf = key => aws.s3PutObject.mock.calls.filter(([, k]) => k === key)

beforeEach(() => {
  for (const fn of [...Object.values(aws), ssmParameterValue, openImage, publishSourceMaps, ...Object.values(core)]) fn.mockReset()
  events.length = 0
  let now = 0
  clock = { now: () => now, sleep: async ms => { now += ms }, stepStartedAt: 0 }
})

describe('deployStatic: a deploy that works', () => {
  it('uploads hashed files, then maps, then the other files, then HTML, then index.html last, then invalidates', async () => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    ssmParameterValue.mockResolvedValue('server-token')

    const result = await deploy()

    expect(events).toEqual([
      'open:new',
      'put:assets/app-4a6b2c1d.js', 'put:assets/app-9f8e7d6c.css',
      'maps',
      'put:favicon.ico',
      'put:about/index.html',
      'put:index.html',
      'invalidate'
    ])
    expect(result).toEqual({ deployedImage: IMAGE, services: [BUCKET], sourcemaps: { status: 'uploaded', uploaded: 1, failed: 0 } })
    expect(aws.cloudfrontCreateInvalidation).toHaveBeenCalledWith(DISTRIBUTION, ['/*'], expect.stringMatching(/^cru-pipeline-v2-/))
  })

  it('never puts a .map file in the bucket, and only ever puts', async () => {
    stubs()
    await deploy()
    expect(puts().filter(key => /\.map$/i.test(key))).toEqual([])
    expect(aws.s3PutObject.mock.calls.every(([bucket]) => bucket === BUCKET)).toBe(true)
    // The deploy has no way to delete: the only S3 write it calls is a put.
    expect(Object.keys(aws).filter(name => /delete|remove/i.test(name))).toEqual([])
  })

  it('sends each file with its Content-Type and Cache-Control', async () => {
    stubs()
    await deploy()
    const sent = Object.fromEntries(aws.s3PutObject.mock.calls.map(([, key, body, options]) => [key, { body: body.toString(), ...options }]))
    expect(sent['assets/app-4a6b2c1d.js']).toMatchObject({ contentType: 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' })
    expect(sent['assets/app-9f8e7d6c.css']).toMatchObject({ contentType: 'text/css; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' })
    expect(sent['favicon.ico']).toMatchObject({ contentType: 'image/x-icon', cacheControl: 'public, max-age=300' })
    expect(sent['about/index.html']).toMatchObject({ contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' })
    expect(sent['index.html']).toMatchObject({ body: '<html>new</html>', contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' })
  })

  it('records the release on index.html only', async () => {
    stubs()
    await deploy()
    expect(putOf('index.html')[0][3].metadata).toEqual({ 'cru-digest': NEW, 'cru-revision': 'release-2026-11-04-10150', 'cru-sha': 'bbb2222' })
    for (const [, key, , options] of aws.s3PutObject.mock.calls) {
      if (key !== 'index.html') expect(options.metadata).toBeUndefined()
    }
  })

  it('reads what is live before it changes anything', async () => {
    stubs()
    aws.s3HeadObject.mockImplementation(async () => { events.push('head'); return { metadata: OLD_METADATA } })
    await deploy()
    expect(events.indexOf('head')).toBeLessThan(events.findIndex(event => event.startsWith('put:')))
    expect(aws.s3HeadObject).toHaveBeenCalledWith(BUCKET, 'index.html')
  })

  it('reads the site with a per-file limit above the reader\'s 8 MB default', async () => {
    stubs()
    await deploy()
    expect(images[IMAGE].readTree).toHaveBeenCalledWith('/site', { maxBytes: MAX_SITE_FILE_BYTES })
    expect(MAX_SITE_FILE_BYTES).toBeGreaterThan(8 * 1024 * 1024)
  })

  it('deploys the first time, when the bucket has no index.html yet', async () => {
    stubs({ live: null })
    await deploy()
    expect(puts()).toContain('index.html')
  })
})

describe('releaseIdentity', () => {
  it('takes the name the workflow passed, and the sha from the sha- tag', () => {
    expect(releaseIdentity(['candidate-2026-11-04-10150', 'sha-bbb2222'], 'candidate-2026-11-04-10150')).toEqual({ revision: 'candidate-2026-11-04-10150', sha: 'bbb2222' })
  })

  it('falls back to the image\'s release tag, then its candidate tag, for an older workflow', () => {
    expect(releaseIdentity(['candidate-2026-11-04-10150', 'release-2026-11-04-10150', 'sha-bbb2222']).revision).toBe('release-2026-11-04-10150')
    expect(releaseIdentity(['sha-bbb2222', 'candidate-2026-11-04-10150']).revision).toBe('candidate-2026-11-04-10150')
    expect(releaseIdentity([])).toEqual({ revision: '', sha: '' })
  })
})

describe('deployStatic: refusals before anything changes', () => {
  it.each([
    ['no Bucket', { ...ROW, Bucket: undefined }, /has no Bucket/],
    ['no DistributionId', { ...ROW, DistributionId: undefined }, /has no DistributionId/],
    ['no row', null, /No CruApplicationInfo row/]
  ])('refuses a site whose app-info row has %s', async (_label, row, message) => {
    stubs()
    aws.appInfoItem.mockResolvedValue(row)
    await expect(deploy()).rejects.toThrow(message)
    await expect(deploy()).rejects.toThrow(/Nothing was changed\.$/)
    expect(openImage).not.toHaveBeenCalled()
    expect(aws.s3PutObject).not.toHaveBeenCalled()
    expect(aws.cloudfrontCreateInvalidation).not.toHaveBeenCalled()
  })

  it('refuses a tag reference', async () => {
    await expect(deploy({ image: `${REGISTRY}/example-app:candidate-1` })).rejects.toThrow(/digest-pinned/)
    expect(aws.appInfoItem).not.toHaveBeenCalled()
  })

  it('refuses an image it cannot read, saying nothing changed', async () => {
    stubs()
    openImage.mockRejectedValue(new Error('ECR returned no manifest'))
    await expect(deploy()).rejects.toThrow(/Could not read the image .*ECR returned no manifest\. Nothing was changed\./)
    expect(aws.s3PutObject).not.toHaveBeenCalled()
  })

  it.each([
    ['the site is in two layers', new Error('/site has files in more than one layer (1/2 and 2/2)')],
    ['a layer is over the size cap', new Error('layer 1/1 (sha256:big) is 300000000 bytes, over the 268435456-byte limit the deploy reads')]
  ])('refuses an image where %s', async (_label, error) => {
    stubs()
    images[IMAGE].readTree.mockRejectedValue(error)
    await expect(deploy()).rejects.toThrow(new RegExp(`Could not deploy the site in .*${error.message.replace(/[()/]/g, '.')}.*Nothing was changed`))
    expect(aws.s3PutObject).not.toHaveBeenCalled()
  })

  it('refuses a site with a file over the per-file limit', async () => {
    stubs({ newSite: { files: [file('index.html'), { path: 'site/huge.mp4', name: 'huge.mp4', size: MAX_SITE_FILE_BYTES + 1, contents: null }], links: [] } })
    await expect(deploy()).rejects.toThrow(/the site is too big to deploy: site\/huge\.mp4/)
    expect(aws.s3PutObject).not.toHaveBeenCalled()
  })

  it('refuses a site with no index.html', async () => {
    stubs({ newSite: { files: [file('app.js')], links: [] } })
    await expect(deploy()).rejects.toThrow(/has no \/site\/index\.html/)
    expect(aws.s3PutObject).not.toHaveBeenCalled()
  })

  it('stops on a bucket it may not read, before uploading', async () => {
    stubs()
    aws.s3HeadObject.mockRejectedValue(new Error(`S3 refused s3:GetObject (HeadObject) on s3://${BUCKET}/index.html (access denied). The policy of bucket ${BUCKET} must grant the GitHubDeployStatic role s3:PutObject, s3:GetObject, s3:ListBucket.`))
    await expect(deploy()).rejects.toThrow(/policy of bucket example-site-prod must grant the GitHubDeployStatic role.*Nothing was changed\.$/)
    expect(aws.s3PutObject).not.toHaveBeenCalled()
  })
})

describe('deployStatic: source maps', () => {
  it('reads no token when the image declares no maps', async () => {
    stubs()
    const result = await deploy()
    expect(ssmParameterValue).not.toHaveBeenCalled()
    expect(publishSourceMaps).not.toHaveBeenCalled()
    expect(result.sourcemaps).toEqual({ status: 'skipped', uploaded: 0, failed: 0 })
  })

  it('reads the token from the environment\'s SSM path and uploads to the default endpoint', async () => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    ssmParameterValue.mockResolvedValue('server-token')
    await deploy({ environment: 'release-candidate', revision: 'candidate-2026-11-04-10150' })
    expect(ssmParameterValue).toHaveBeenCalledWith('/ecs/example-app/stage/FLIGHTDECK_SOURCEMAP_TOKEN')
    expect(publishSourceMaps).toHaveBeenCalledWith({
      oci: images[IMAGE], appUrl: APP_URL, token: 'server-token', endpoint: 'https://flightdeck.cru.org/api/1/sourcemap'
    })
  })

  it('skips quietly when the environment has no token', async () => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    ssmParameterValue.mockResolvedValue(null)
    const result = await deploy()
    expect(publishSourceMaps).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
    expect(result.sourcemaps.status).toBe('skipped')
  })

  it('names the grant when the token read is refused, and deploys anyway', async () => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    ssmParameterValue.mockRejectedValue(Object.assign(new Error('User is not authorized to perform: ssm:GetParameters'), {
      name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 }
    }))
    const result = await deploy()
    expect(result.sourcemaps.status).toBe('failed')
    expect(core.warning).toHaveBeenCalledWith(
      'source maps not uploaded (deploy unaffected): User is not authorized to perform: ssm:GetParameters (the ' +
      "GitHubDeployStatic role's policy must allow ssm:GetParameters on /ecs/example-app/prod/FLIGHTDECK_SOURCEMAP_TOKEN)"
    )
  })

  it.each([
    ['the token read', () => ssmParameterValue.mockRejectedValue(new Error('socket hang up'))],
    ['the upload', () => publishSourceMaps.mockRejectedValue(new Error('socket hang up'))]
  ])('warns and deploys anyway when %s fails', async (_label, fail) => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    ssmParameterValue.mockResolvedValue('server-token')
    fail()
    const result = await deploy()
    expect(result.sourcemaps).toEqual({ status: 'failed', uploaded: 0, failed: 0 })
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/^source maps not uploaded \(deploy unaffected\)/))
    expect(puts()).toContain('index.html')
  })
})

describe('deployStatic: the invalidation wait', () => {
  it('polls until the invalidation completes', async () => {
    stubs()
    aws.cloudfrontInvalidationStatus.mockResolvedValueOnce('InProgress').mockResolvedValueOnce('InProgress').mockResolvedValue('Completed')
    await deploy()
    expect(aws.cloudfrontInvalidationStatus).toHaveBeenCalledTimes(3)
    expect(aws.cloudfrontInvalidationStatus).toHaveBeenCalledWith(DISTRIBUTION, 'I000EXAMPLE')
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns and finishes when the wait runs out, since the files are live at the origin', async () => {
    stubs()
    aws.cloudfrontInvalidationStatus.mockResolvedValue('InProgress')
    const result = await deploy()
    expect(result.deployedImage).toBe(IMAGE)
    expect(clock.now()).toBe(INVALIDATION_WAIT_MS)
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/invalidation I000EXAMPLE on E000EXAMPLE000 had not completed after 10m 0s\. The files are live at the origin, so the deploy is done/))
  })

  it('never waits past the deploy step\'s own cap', async () => {
    stubs()
    aws.cloudfrontInvalidationStatus.mockResolvedValue('InProgress')
    // The step started long enough ago that only seven minutes of its cap are
    // left: enough to upload, and less than the ten-minute wait.
    clock.stepStartedAt = -(STEP_CAP_MS - 7 * 60 * 1000)
    await deploy()
    expect(clock.now()).toBe(7 * 60 * 1000)
  })

  it('warns and finishes when the status cannot be read', async () => {
    stubs()
    aws.cloudfrontInvalidationStatus.mockRejectedValue(new Error('CloudFront refused cloudfront:GetInvalidation on distribution E000EXAMPLE000 (access denied).'))
    const result = await deploy()
    expect(result.services).toEqual([BUCKET])
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/could not check CloudFront invalidation I000EXAMPLE: .*access denied.*The files are live at the origin/))
  })
})

describe('deployStatic: a deploy that fails partway', () => {
  const failOn = (key, error = new Error(`S3 s3:PutObject on s3://${BUCKET}/${key} failed: timed out`)) => {
    const put = aws.s3PutObject.getMockImplementation()
    aws.s3PutObject.mockImplementation(async (bucket, k, ...rest) => {
      if (k === key && openImage.mock.calls.length === 1) throw error
      return put(bucket, k, ...rest)
    })
  }

  it('puts back the release that was live when HTML fails, and still fails', async () => {
    stubs()
    failOn('about/index.html')
    const error = await deploy().catch(e => e)
    expect(error.message).toMatch(/^S3 s3:PutObject on s3:\/\/example-site-prod\/about\/index\.html failed: timed out\./)
    expect(error.message).toContain('The files release-2026-10-01-10090 served were put back in s3://example-site-prod, so it serves release-2026-10-01-10090 again.')

    // After the failure: the old release's image is read, its unhashed files
    // and HTML go back, index.html last with ITS metadata, then CloudFront
    // is invalidated again.
    const after = events.slice(events.indexOf('open:old'))
    expect(after).toEqual(['open:old', 'put:favicon.ico', 'put:about/index.html', 'put:index.html', 'invalidate'])
    const index = putOf('index.html')
    expect(index).toHaveLength(1)
    expect(index[0][2].toString()).toBe('<html>old</html>')
    expect(index[0][3].metadata).toEqual(OLD_METADATA)
    // The old release's hashed file was never touched, so it is not re-sent.
    expect(puts()).not.toContain('assets/app-1a2b3c4d.js')
    expect(aws.cloudfrontInvalidationStatus).not.toHaveBeenCalled()
  })

  it('puts back the release that was live when the invalidation is refused', async () => {
    stubs()
    const denied = new Error(`CloudFront refused cloudfront:CreateInvalidation on distribution ${DISTRIBUTION} (AccessDenied: User is not authorized). The GitHubDeployStatic role may use cloudfront:CreateInvalidation and cloudfront:GetInvalidation only on a distribution tagged pipeline_v2_invalidate = "true", so distribution ${DISTRIBUTION} must carry that tag, and the GitHubDeployStatic role must exist with that grant.`)
    aws.cloudfrontCreateInvalidation.mockRejectedValue(denied)
    const error = await deploy().catch(e => e)
    expect(error.message).toMatch(/^CloudFront refused cloudfront:CreateInvalidation on distribution E000EXAMPLE000 \(AccessDenied: User is not authorized\)\. .*must carry that tag/)
    expect(error.message).toContain('The files release-2026-10-01-10090 served were put back in s3://example-site-prod, but invalidating CloudFront afterwards failed')
    expect(putOf('index.html').map(([, , body]) => body.toString())).toEqual(['<html>new</html>', '<html>old</html>'])
  })

  it('puts back an overwritten unhashed file even before any HTML changed', async () => {
    stubs({ newSite: { files: [...NEW_SITE.files, file('loader.js')], links: [] } })
    failOn('loader.js')
    const error = await deploy().catch(e => e)
    expect(error.message).toContain('so it serves release-2026-10-01-10090 again')
    expect(putOf('favicon.ico').map(([, , body]) => body.toString())).toEqual(['contents of favicon.ico', 'old icon'])
  })

  it('needs nothing put back when a hashed file fails, and never reaches the unhashed ones', async () => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    failOn('assets/app-9f8e7d6c.css')
    const error = await deploy().catch(e => e)
    expect(error.message).toMatch(/No file a live page uses had been changed yet\.$/)
    expect(puts()).not.toContain('favicon.ico')
    expect(publishSourceMaps).not.toHaveBeenCalled()
    expect(openImage).toHaveBeenCalledTimes(1)
  })

  it('has changed nothing a live page uses while the source maps upload', async () => {
    stubs({ labels: { 'org.cru.sourcemaps': '2026-11-04-10150' } })
    ssmParameterValue.mockResolvedValue('server-token')
    // The source maps take the deploy step up to the reserve its uploads
    // leave for a put-back, so the unhashed files never start.
    publishSourceMaps.mockImplementation(async () => {
      events.push('maps')
      await clock.sleep(STEP_CAP_MS - PUT_BACK_RESERVE_MS - clock.now())
      return { status: 'uploaded', uploaded: 1, failed: 0 }
    })
    const error = await deploy().catch(e => e)
    expect(events).toEqual(['open:new', 'put:assets/app-4a6b2c1d.js', 'put:assets/app-9f8e7d6c.css', 'maps'])
    expect(error.message).toMatch(/^The deploy step is within 5m 0s of its 50m 0s cap, so no more uploads were started; 0 of 1 in this phase were\./)
    expect(error.message).toMatch(/No file a live page uses had been changed yet\.$/)
    expect(openImage).toHaveBeenCalledTimes(1)
  })

  it('puts nothing back when nothing a live page uses had changed', async () => {
    stubs({
      newSite: { files: [file('index.html'), file('assets/app-4a6b2c1d.js'), file('assets/app-9f8e7d6c.css')], links: [] }
    })
    failOn('assets/app-4a6b2c1d.js', new Error(`S3 refused s3:PutObject on s3://${BUCKET}/assets/app-4a6b2c1d.js (access denied). The policy of bucket ${BUCKET} must grant the GitHubDeployStatic role s3:PutObject, s3:GetObject, s3:ListBucket.`))
    const error = await deploy().catch(e => e)
    expect(error.message).toMatch(/^S3 refused s3:PutObject on s3:\/\/example-site-prod\/assets\/app-4a6b2c1d\.js \(access denied\)\. The policy of bucket example-site-prod must grant the GitHubDeployStatic role/)
    expect(error.message).toMatch(/No file a live page uses had been changed yet\.$/)
    expect(openImage).toHaveBeenCalledTimes(1)
    expect(puts()).not.toContain('index.html')
    expect(aws.cloudfrontCreateInvalidation).not.toHaveBeenCalled()
  })

  describe('an unhashed file whose upload failed', () => {
    const site = { files: [file('index.html'), file('favicon.ico')], links: [] }
    const denied = Object.assign(new Error(`S3 refused s3:PutObject on s3://${BUCKET}/favicon.ico (access denied).`), {
      cause: Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    })
    const timedOut = Object.assign(new Error(`S3 s3:PutObject on s3://${BUCKET}/favicon.ico failed: Request aborted`), {
      cause: Object.assign(new Error('Request aborted'), { name: 'AbortError' })
    })

    it('counts as unchanged when S3 refused it outright, so nothing is put back', async () => {
      stubs({ newSite: site })
      failOn('favicon.ico', denied)
      const error = await deploy().catch(e => e)
      expect(error.message).toMatch(/No file a live page uses had been changed yet\.$/)
      expect(openImage).toHaveBeenCalledTimes(1)
    })

    it('counts as changed when it may have landed (a timeout), so the old release is put back', async () => {
      stubs({ newSite: site })
      failOn('favicon.ico', timedOut)
      const error = await deploy().catch(e => e)
      expect(error.message).toContain('so it serves release-2026-10-01-10090 again')
      // The attempt that timed out, then the old release's copy.
      expect(putOf('favicon.ico').map(([, , body]) => body.toString())).toEqual(['contents of favicon.ico', 'old icon'])
    })
  })

  it('stops starting uploads after the first failure', async () => {
    const many = Array.from({ length: 40 }, (_, i) => file(`img/photo-${i}.png`))
    stubs({ newSite: { files: [file('index.html'), ...many], links: [] }, live: null })
    failOn('img/photo-0.png')
    await expect(deploy()).rejects.toThrow(/photo-0\.png failed/)
    expect(puts().length).toBeLessThan(many.length)
    expect(puts()).not.toContain('index.html')
  })

  it('on a rollback, puts nothing back and says so', async () => {
    stubs()
    failOn('about/index.html')
    const error = await deploy({ stopRolloutOnFailure: false }).catch(e => e)
    expect(error.message).toContain('This is a rollback, so nothing was put back')
    expect(openImage).toHaveBeenCalledTimes(1)
    expect(puts().filter(key => key === 'index.html')).toEqual([])
    expect(aws.cloudfrontCreateInvalidation).not.toHaveBeenCalled()
  })

  it('says there was nothing to put back on a first deploy', async () => {
    stubs({ live: null })
    failOn('about/index.html')
    const error = await deploy().catch(e => e)
    expect(error.message).toContain('Pipeline v2 had not deployed this site before, so there was no release to put back')
    expect(openImage).toHaveBeenCalledTimes(1)
  })

  it('says there was nothing to put back when index.html names no release', async () => {
    stubs({ live: { metadata: {} } })
    failOn('about/index.html')
    const error = await deploy().catch(e => e)
    expect(error.message).toContain('there was no release to put back')
  })

  it('says so when putting the old release back fails too', async () => {
    stubs()
    failOn('about/index.html')
    delete images[OLD_IMAGE]
    const error = await deploy().catch(e => e)
    expect(error.message).toContain(`Putting back release-2026-10-01-10090 (${OLD}) failed as well: no image ${OLD_IMAGE}.`)
    expect(error.message).toContain('may serve a mix of the two releases')
  })

  it('gives the deploy and the put-back invalidations of their own', async () => {
    stubs()
    aws.cloudfrontCreateInvalidation.mockRejectedValueOnce(new Error('CloudFront cloudfront:CreateInvalidation on distribution E000EXAMPLE000 failed: throttled'))
    await deploy().catch(e => e)
    const references = aws.cloudfrontCreateInvalidation.mock.calls.map(([, , reference]) => reference)
    expect(references).toHaveLength(2)
    expect(references[0]).not.toBe(references[1])
    for (const reference of references) expect(reference).toMatch(/^cru-pipeline-v2-[0-9a-f-]{36}$/)
  })

  it('gives each deploy an invalidation of its own', async () => {
    stubs()
    await deploy()
    await deploy()
    const [first, second] = aws.cloudfrontCreateInvalidation.mock.calls.map(([, , reference]) => reference)
    expect(first).not.toBe(second)
  })
})

describe('deployStatic: the step\'s time limit', () => {
  it('stops starting uploads near the step\'s cap, keeping time for the put-back', async () => {
    const many = Array.from({ length: 30 }, (_, i) => file(`img/photo-${i}.png`))
    stubs({ newSite: { files: [file('index.html'), ...many], links: [] } })
    // Each upload takes a minute of the fake clock, and the step started 30
    // minutes before the deploy, so the uploads stop at 15 minutes in.
    clock.stepStartedAt = -30 * 60 * 1000
    const put = aws.s3PutObject.getMockImplementation()
    aws.s3PutObject.mockImplementation(async (...args) => { await clock.sleep(60 * 1000); return put(...args) })

    const error = await deploy().catch(e => e)
    expect(error.message).toMatch(/^The deploy step is within 5m 0s of its 50m 0s cap, so no more uploads were started; \d+ of 30 in this phase were\./)
    expect(puts().filter(key => key.startsWith('img/')).length).toBeLessThan(30)
    // The new release's HTML never went up; only the old release's came back.
    expect(putOf('about/index.html').map(([, , body]) => body.toString())).toEqual(['<html>old about</html>'])
    // The put-back ran, in the time the uploads left for it.
    expect(error.message).toContain('so it serves release-2026-10-01-10090 again')
    expect(putOf('index.html').map(([, , body]) => body.toString())).toEqual(['<html>old</html>'])
  })

  it('says the step has reached its cap, not that it is within 0s of it, when the put-back runs out of time', async () => {
    stubs()
    const put = aws.s3PutObject.getMockImplementation()
    aws.s3PutObject.mockImplementation(async (bucket, key, ...rest) => {
      if (key === 'about/index.html' && openImage.mock.calls.length === 1) throw new Error('S3 s3:PutObject failed: timed out')
      return put(bucket, key, ...rest)
    })
    // Reading the old release's image takes the step to its cap.
    const open = openImage.getMockImplementation()
    openImage.mockImplementation(async ref => {
      if (ref === OLD_IMAGE) await clock.sleep(STEP_CAP_MS - clock.now())
      return open(ref)
    })
    const error = await deploy().catch(e => e)
    expect(error.message).toContain(
      'Putting back release-2026-10-01-10090 (' + OLD + ') failed as well: The deploy step has reached its 50m 0s cap, so ' +
      'no more uploads were started; 0 of 1 in this phase were.'
    )
    expect(error.message).not.toContain('within 0s')
  })

  it('gives each upload only the time left before the step\'s cap', async () => {
    stubs()
    clock.stepStartedAt = -40 * 60 * 1000
    await deploy()
    for (const [, , , options] of aws.s3PutObject.mock.calls) {
      expect(options.timeoutMs).toBe(STEP_CAP_MS - 40 * 60 * 1000 - PUT_BACK_RESERVE_MS)
    }
  })
})

describe('deployStatic: a stage deploy that did not finish', () => {
  const FORCE = 'run deploy-candidate for it again with force set: without force, the run finds this release live and ' +
    'stops at "Already deployed", with the deploy unfinished.'
  const invalidationFails = () => aws.cloudfrontCreateInvalidation.mockRejectedValue(
    new Error('CloudFront cloudfront:CreateInvalidation on distribution E000EXAMPLE000 failed: throttled')
  )

  it('says to re-run with force when index.html names this release and nothing was put back (first deploy)', async () => {
    stubs({ live: null })
    invalidationFails()
    const error = await deploy({ environment: 'release-candidate' }).catch(e => e)
    expect(error.message).toContain(`index.html may already name this release, so ${FORCE}`)
  })

  it('says to re-run with force when the put-back failed', async () => {
    stubs()
    invalidationFails()
    delete images[OLD_IMAGE]
    const error = await deploy({ environment: 'release-candidate' }).catch(e => e)
    expect(error.message).toContain('failed as well')
    expect(error.message).toContain(FORCE)
  })

  it('says nothing about force when index.html was put back', async () => {
    stubs()
    invalidationFails()
    const error = await deploy({ environment: 'release-candidate' }).catch(e => e)
    expect(error.message).toContain('put back')
    expect(error.message).not.toContain('force')
  })

  it('says nothing about force before index.html changed', async () => {
    stubs({ live: null })
    const put = aws.s3PutObject.getMockImplementation()
    aws.s3PutObject.mockImplementation(async (bucket, key, ...rest) => {
      if (key === 'about/index.html') throw new Error('S3 s3:PutObject failed: timed out')
      return put(bucket, key, ...rest)
    })
    const error = await deploy({ environment: 'release-candidate' }).catch(e => e)
    expect(error.message).not.toContain('force')
  })

  it('says nothing about force on a promote, which has no "Already deployed" to skip it', async () => {
    stubs({ live: null })
    invalidationFails()
    const error = await deploy({ environment: 'production' }).catch(e => e)
    expect(error.message).not.toContain('force')
  })

  it('notes in the log, calmly, that index.html now names the release, for a step stopped from outside', async () => {
    stubs()
    await deploy({ environment: 'release-candidate' })
    expect(core.info).toHaveBeenCalledWith('index.html now names this release, so deploying it to release-candidate again takes force')
    // A deploy that works says nothing about a deploy left unfinished.
    const logged = [...core.info.mock.calls, ...core.warning.mock.calls].map(([line]) => line).join('\n')
    expect(logged).not.toContain('Already deployed')
    expect(logged).not.toContain('unfinished')
  })

  it('notes nothing of the kind on a promote', async () => {
    stubs()
    await deploy({ environment: 'production' })
    expect(core.info.mock.calls.map(([line]) => line).join('\n')).not.toContain('takes force')
  })
})
