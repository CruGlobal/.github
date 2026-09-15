import { describe, it, expect, beforeEach, vi } from 'vitest'
import { gzipSync, zstdCompressSync } from 'node:zlib'

// Mock google-auth-library so the registry reads hit a canned client instead of
// the network — same shape as test/v2-gcp.test.js.
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))

// Same treatment for the ECR transport: the SDK is canned, so BatchGetImage and
// GetDownloadUrlForLayer are asserted on directly. Every command src/v2/aws.js
// imports has to exist here too, or its named import fails under the mock.
const { ecrSend, ecrConfigs } = vi.hoisted(() => ({ ecrSend: vi.fn(), ecrConfigs: [] }))
vi.mock('@aws-sdk/client-ecr', () => {
  const command = op => class {
    constructor (input) {
      this.op = op
      this.input = input
    }
  }
  return {
    ECRClient: class {
      constructor (config) { ecrConfigs.push(config) }
      send (cmd) { return ecrSend(cmd) }
    },
    BatchGetImageCommand: command('BatchGetImage'),
    GetDownloadUrlForLayerCommand: command('GetDownloadUrlForLayer'),
    DescribeImagesCommand: command('DescribeImages'),
    PutImageCommand: command('PutImage'),
    ImageAlreadyExistsException: class extends Error {}
  }
})

import { MAX_LAYER_BLOB_BYTES, openImage, parseRegistryRef } from '../src/v2/oci.js'
import { MAX_ENTRY_BYTES } from '../src/v2/tar.js'
import { tarArchive, tarEntry } from './support/tar-fixture.js'

const HOST = 'us-central1-docker.pkg.dev'
const NAME = `${HOST}/cru-shared-artifacts/bills/bills`
const IMAGE = `${NAME}@sha256:top`
const PAGE = '<!DOCTYPE html><title>Sign in</title>'
const SIGNIN = 'cru/iap-signin/signin'

const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip'
const DOCKER_LAYER = 'application/vnd.docker.image.rootfs.diff.tar.gzip'

function config (labels) {
  return { config: labels === undefined ? {} : { Labels: labels } }
}

function manifest ({ layers = [], configDigest = 'sha256:config' } = {}) {
  return { config: { digest: configDigest }, layers }
}

function layer (digest, mediaType = OCI_LAYER) {
  return { digest, mediaType }
}

function gzipLayer (...entries) {
  return gzipSync(tarArchive(...entries))
}

// Route requests by the /v2/<repo>/<kind>/<reference> tail of the URL.
function serve (documents) {
  requestMock.mockImplementation(async ({ url }) => {
    const match = url.match(/\/v2\/(?:.+)\/(manifests|blobs)\/(.+)$/)
    if (!match) throw new Error(`unexpected registry url: ${url}`)
    const key = `${match[1]}/${match[2]}`
    if (!(key in documents)) {
      const error = new Error(`no such object: ${key}`)
      error.response = { status: 404 }
      throw error
    }
    const value = documents[key]
    return { data: Buffer.isBuffer(value) ? value : JSON.stringify(value) }
  })
}

// Blob GETs, excluding the config blob every openImage() makes.
function layerFetches () {
  return requestMock.mock.calls
    .map(([options]) => options.url)
    .filter(url => url.includes('/blobs/') && !url.includes('sha256:config'))
}

// --- ECR fixtures -----------------------------------------------------------

const ECR_HOST = '056154071827.dkr.ecr.us-east-1.amazonaws.com'
const ECR_IMAGE = `${ECR_HOST}/smaug@sha256:top`

// Canned ECR: manifests come back from BatchGetImage as the verbatim JSON string
// the registry stores, and blobs through a presigned URL that `fetch` then
// serves. Keyed exactly like serve() above so the two transports can be given
// the same image.
function serveEcr (documents) {
  const blobUrl = digest => `https://starport-layer-bucket.s3.example/${encodeURIComponent(digest)}?X-Amz-Signature=abc`

  ecrSend.mockImplementation(async cmd => {
    if (cmd.op === 'BatchGetImage') {
      const { imageDigest, imageTag } = cmd.input.imageIds[0]
      const key = `manifests/${imageDigest ?? imageTag}`
      if (!(key in documents)) {
        return { images: [], failures: [{ failureCode: 'ImageNotFound', failureReason: 'Requested image not found' }] }
      }
      return {
        images: [{ imageManifest: JSON.stringify(documents[key]), imageManifestMediaType: 'application/vnd.oci.image.manifest.v1+json' }]
      }
    }
    if (cmd.op === 'GetDownloadUrlForLayer') {
      return { downloadUrl: blobUrl(cmd.input.layerDigest) }
    }
    throw new Error(`unexpected ECR command: ${cmd.op}`)
  })

  vi.stubGlobal('fetch', vi.fn(async url => {
    const digest = decodeURIComponent(new URL(url).pathname.slice(1))
    const key = `blobs/${digest}`
    if (!(key in documents)) return new Response(null, { status: 404 })
    const value = documents[key]
    return new Response(Buffer.isBuffer(value) ? value : JSON.stringify(value), { status: 200 })
  }))
}

// Blob downloads ECR was asked for, config blob included, in order.
function ecrLayerRequests () {
  return ecrSend.mock.calls
    .map(([cmd]) => cmd)
    .filter(cmd => cmd.op === 'GetDownloadUrlForLayer')
    .map(cmd => cmd.input.layerDigest)
}

beforeEach(() => {
  requestMock.mockReset()
  ecrSend.mockReset()
  ecrConfigs.length = 0
  vi.unstubAllGlobals()
})

describe('parseRegistryRef', () => {
  it('splits a digest ref into host, repository path and reference', () => {
    expect(parseRegistryRef(IMAGE)).toEqual({
      host: HOST,
      repository: 'cru-shared-artifacts/bills/bills',
      reference: 'sha256:top'
    })
  })

  it('accepts a tag ref (used only for ad-hoc reads; deploys pin digests)', () => {
    expect(parseRegistryRef(`${NAME}:candidate-10012`).reference).toBe('candidate-10012')
  })

  it('rejects a bare image name with no registry host', () => {
    expect(() => parseRegistryRef('bills@sha256:top')).toThrow(/no registry host/)
  })

  it('rejects a reference pinned to neither a digest nor a tag', () => {
    expect(() => parseRegistryRef(NAME)).toThrow(/not pinned/)
  })
})

describe('openImage labels', () => {
  it('reads labels from the image config blob', async () => {
    serve({
      'manifests/sha256:top': manifest(),
      'blobs/sha256:config': config({ 'org.cru.iap-signin': 'signin' })
    })
    const image = await openImage(IMAGE)
    expect(image.labels).toEqual({ 'org.cru.iap-signin': 'signin' })
  })

  it('returns an empty object for an image with no labels', async () => {
    serve({ 'manifests/sha256:top': manifest(), 'blobs/sha256:config': config() })
    expect((await openImage(IMAGE)).labels).toEqual({})
  })

  it('fails clearly when the manifest carries no config descriptor', async () => {
    serve({ 'manifests/sha256:top': { layers: [] } })
    await expect(openImage(IMAGE)).rejects.toThrow(/no config descriptor/)
  })
})

describe('openImage platform selection', () => {
  it('resolves an image index to the linux/amd64 manifest', async () => {
    serve({
      'manifests/sha256:top': {
        manifests: [
          { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
          { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } },
          { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } }
        ]
      },
      'manifests/sha256:amd': manifest(),
      'blobs/sha256:config': config({ 'org.cru.iap-signin': 'signin' })
    })
    const image = await openImage(IMAGE)
    expect(image.labels['org.cru.iap-signin']).toBe('signin')
  })

  it('fails with the platforms it did find when amd64 is absent', async () => {
    serve({
      'manifests/sha256:top': {
        manifests: [{ digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } }]
      }
    })
    await expect(openImage(IMAGE)).rejects.toThrow(/no linux\/amd64 manifest \(found: linux\/arm64\)/)
  })
})

describe('openImage readFile', () => {
  it('finds the page and fetches only the layer containing it', async () => {
    serve({
      'manifests/sha256:top': manifest({
        layers: [layer('sha256:base'), layer('sha256:app'), layer('sha256:page')]
      }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
    // Newest-first: the base and app layers are never downloaded.
    expect(layerFetches()).toEqual([expect.stringContaining('sha256:page')])
  })

  it('prefers the newest layer when several carry the path', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:old'), layer('sha256:new')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:old': gzipLayer(tarEntry(SIGNIN, 'stale')),
      'blobs/sha256:new': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
  })

  it('returns null when no layer carries the path', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:a'), layer('sha256:b')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:a': gzipLayer(tarEntry('app/server.js', 'x')),
      'blobs/sha256:b': gzipLayer(tarEntry('app/page.js', 'y'))
    })
    const image = await openImage(IMAGE)
    expect(await image.readFile(`/${SIGNIN}`)).toBeNull()
    expect(layerFetches()).toHaveLength(2)
  })

  it('reads docker-format gzip layers', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:page', DOCKER_LAYER)] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
  })

  it('reads zstd layers', async () => {
    serve({
      'manifests/sha256:top': manifest({
        layers: [layer('sha256:page', 'application/vnd.oci.image.layer.v1.tar+zstd')]
      }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': zstdCompressSync(tarArchive(tarEntry(SIGNIN, PAGE)))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
  })

  it('reads uncompressed tar layers', async () => {
    serve({
      'manifests/sha256:top': manifest({
        layers: [layer('sha256:page', 'application/vnd.oci.image.layer.v1.tar')]
      }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': tarArchive(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
  })

  it('skips foreign layers, which are not hosted here', async () => {
    serve({
      'manifests/sha256:top': manifest({
        layers: [
          layer('sha256:foreign', 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip'),
          layer('sha256:page')
        ]
      }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
    expect(layerFetches()).toEqual([expect.stringContaining('sha256:page')])
  })

  it('returns null for an image with no layers at all', async () => {
    serve({ 'manifests/sha256:top': manifest(), 'blobs/sha256:config': config() })
    const image = await openImage(IMAGE)
    expect(await image.readFile(`/${SIGNIN}`)).toBeNull()
  })
})

describe('openImage readFile byte caps', () => {
  it('skips an oversized layer without downloading it', async () => {
    const huge = { ...layer('sha256:huge'), size: MAX_LAYER_BLOB_BYTES + 1 }
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:page'), huge] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    // Newest-first would read the huge layer first; the cap skips it and the
    // page still resolves from the layer underneath.
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
    expect(layerFetches()).toEqual([expect.stringContaining('sha256:page')])
  })

  it('reads a layer whose declared size is within the cap', async () => {
    const sized = { ...layer('sha256:page'), size: MAX_LAYER_BLOB_BYTES }
    serve({
      'manifests/sha256:top': manifest({ layers: [sized] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    const image = await openImage(IMAGE)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)
  })

  // The decompressed-output cap is enforced by node:zlib's maxOutputLength; a
  // test for it would have to build a >1GiB layer, so it is left untested here.

  it('refuses an entry larger than the per-file cap', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:page')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, Buffer.alloc(MAX_ENTRY_BYTES + 1, 0x61)))
    })
    const image = await openImage(IMAGE)
    await expect(image.readFile(`/${SIGNIN}`)).rejects.toThrow(/over the .*-byte limit/)
  })
})

describe('openImage readDir', () => {
  const MAPS = 'cru/sourcemaps'
  const MAP_A = '{"version":3,"file":"a.js"}'
  const MAP_B = '{"version":3,"file":"b.js"}'

  it('returns every file under the prefix, named relative to it', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:maps')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:maps': gzipLayer(
        tarEntry('app/server.js', 'console.log(1)'),
        tarEntry(`${MAPS}/main.js.map`, MAP_A),
        tarEntry(`${MAPS}/_next/chunks/abc.js.map`, MAP_B)
      )
    })
    const image = await openImage(IMAGE)
    const files = await image.readDir(`/${MAPS}`)
    expect(files.map(file => file.name)).toEqual(['main.js.map', '_next/chunks/abc.js.map'])
    expect(files[0].contents.toString()).toBe(MAP_A)
  })

  it('returns [] when no layer has anything under the prefix', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:base')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:base': gzipLayer(tarEntry('app/server.js', 'console.log(1)'))
    })
    const image = await openImage(IMAGE)
    expect(await image.readDir(`/${MAPS}`)).toEqual([])
  })

  it('takes the newest layer that has anything there and stops', async () => {
    // Documented, not detected: two COPYs into the same directory means the
    // older one is invisible. Fine for a directory one build step fills.
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:old'), layer('sha256:new')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:old': gzipLayer(tarEntry(`${MAPS}/old.js.map`, MAP_A)),
      'blobs/sha256:new': gzipLayer(tarEntry(`${MAPS}/new.js.map`, MAP_B))
    })
    const image = await openImage(IMAGE)
    expect((await image.readDir(`/${MAPS}`)).map(file => file.name)).toEqual(['new.js.map'])
    expect(layerFetches()).toEqual([expect.stringContaining('sha256:new')])
  })

  it('keeps scanning past layers that have nothing under the prefix', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:maps'), layer('sha256:top-layer')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:maps': gzipLayer(tarEntry(`${MAPS}/main.js.map`, MAP_A)),
      'blobs/sha256:top-layer': gzipLayer(tarEntry('etc/hosts', '127.0.0.1'))
    })
    const image = await openImage(IMAGE)
    expect((await image.readDir(`/${MAPS}`)).map(file => file.name)).toEqual(['main.js.map'])
  })

  it('skips an oversized layer without downloading it', async () => {
    const huge = { ...layer('sha256:huge'), size: MAX_LAYER_BLOB_BYTES + 1 }
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:maps'), huge] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:maps': gzipLayer(tarEntry(`${MAPS}/main.js.map`, MAP_A))
    })
    const image = await openImage(IMAGE)
    expect((await image.readDir(`/${MAPS}`)).map(file => file.name)).toEqual(['main.js.map'])
    expect(layerFetches()).toEqual([expect.stringContaining('sha256:maps')])
  })

  it('reports an over-cap file with null contents rather than failing the listing', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:maps')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:maps': gzipLayer(
        tarEntry(`${MAPS}/huge.js.map`, Buffer.alloc(4096, 0x61)),
        tarEntry(`${MAPS}/main.js.map`, MAP_A)
      )
    })
    const image = await openImage(IMAGE)
    const files = await image.readDir(`/${MAPS}`, { maxBytes: 1024 })
    expect(files.map(file => [file.name, file.contents === null])).toEqual([
      ['huge.js.map', true],
      ['main.js.map', false]
    ])
  })
})

describe('openImage layer cache', () => {
  it('fetches a layer once across readDir and readFile on the same handle', async () => {
    // The deploy reads the same image twice — source maps, then the sign-in
    // page — and both scans start at the newest layer.
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:both')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:both': gzipLayer(
        tarEntry('cru/sourcemaps/main.js.map', '{"version":3}'),
        tarEntry(SIGNIN, PAGE)
      )
    })
    const image = await openImage(IMAGE)

    expect((await image.readDir('/cru/sourcemaps')).length).toBe(1)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)

    expect(layerFetches()).toEqual([expect.stringContaining('sha256:both')])
  })

  it('caches layers that miss, so a second scan re-fetches nothing', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:page'), layer('sha256:noise')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE)),
      'blobs/sha256:noise': gzipLayer(tarEntry('etc/hosts', '127.0.0.1'))
    })
    const image = await openImage(IMAGE)

    expect(await image.readFile(`/${SIGNIN}`)).not.toBeNull()
    const first = layerFetches().length
    expect(first).toBe(2) // newest (miss) then the page layer

    expect(await image.readFile(`/${SIGNIN}`)).not.toBeNull()
    expect(layerFetches().length).toBe(first)
  })

  it('does not share a cache between handles', async () => {
    serve({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:page')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:page': gzipLayer(tarEntry(SIGNIN, PAGE))
    })
    await (await openImage(IMAGE)).readFile(`/${SIGNIN}`)
    await (await openImage(IMAGE)).readFile(`/${SIGNIN}`)
    expect(layerFetches().length).toBe(2)
  })
})

describe('openImage against ECR', () => {
  // The ECR transport exists because ECR serves no usable v2 API to an IAM
  // caller. Everything above it — index resolution, newest-first layer order,
  // the cache — is shared with Artifact Registry and covered above; these
  // exercise the two SDK reads that replace the HTTP ones.

  it('reads labels, serving the CONFIG blob through GetDownloadUrlForLayer', async () => {
    // Load bearing and verified against a real ECR image: ECR stores an image's
    // config as a blob of the repository like any layer, so one call serves
    // both kinds and no registry-token exchange is needed. If this ever stops
    // being true the fallback is the v2 API via GetAuthorizationToken.
    serveEcr({
      'manifests/sha256:top': manifest(),
      'blobs/sha256:config': config({ 'org.cru.sourcemaps': 'release-10187' })
    })
    const image = await openImage(ECR_IMAGE)

    expect(image.labels).toEqual({ 'org.cru.sourcemaps': 'release-10187' })
    expect(ecrLayerRequests()).toEqual(['sha256:config'])
  })

  it('takes the registry account and region from the image host', async () => {
    serveEcr({ 'manifests/sha256:top': manifest(), 'blobs/sha256:config': config() })
    await openImage(ECR_IMAGE)

    expect(ecrConfigs[0]).toMatchObject({ region: 'us-east-1' })
    expect(ecrSend.mock.calls[0][0].input).toMatchObject({
      registryId: '056154071827',
      repositoryName: 'smaug',
      imageIds: [{ imageDigest: 'sha256:top' }]
    })
  })

  it('asks by tag when the reference is a tag', async () => {
    serveEcr({ 'manifests/release-10187': manifest(), 'blobs/sha256:config': config() })
    await openImage(`${ECR_HOST}/smaug:release-10187`)

    expect(ecrSend.mock.calls[0][0].input.imageIds).toEqual([{ imageTag: 'release-10187' }])
  })

  it('resolves an image index through a second BatchGetImage on the child digest', async () => {
    // Nothing tags an index's children, so this only works because
    // BatchGetImage answers for an untagged digest — verified against a real
    // multi-arch image.
    serveEcr({
      'manifests/sha256:top': {
        manifests: [
          { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }
        ]
      },
      'manifests/sha256:amd': manifest(),
      'blobs/sha256:config': config({ 'org.cru.sourcemaps': 'release-10187' })
    })
    const image = await openImage(ECR_IMAGE)

    expect(image.labels['org.cru.sourcemaps']).toBe('release-10187')
    expect(ecrSend.mock.calls.filter(([cmd]) => cmd.op === 'BatchGetImage').map(([cmd]) => cmd.input.imageIds[0]))
      .toEqual([{ imageDigest: 'sha256:top' }, { imageDigest: 'sha256:amd' }])
  })

  it('lists the source maps out of the newest layer that has any', async () => {
    const MAPS = 'cru/sourcemaps'
    serveEcr({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:base'), layer('sha256:maps')] }),
      'blobs/sha256:config': config({ 'org.cru.sourcemaps': 'release-10187' }),
      'blobs/sha256:maps': gzipLayer(tarEntry(`${MAPS}/main.js.map`, '{"version":3}'))
    })
    const image = await openImage(ECR_IMAGE)

    expect((await image.readDir(`/${MAPS}`)).map(file => file.name)).toEqual(['main.js.map'])
    // Newest-first: the base layer is never downloaded.
    expect(ecrLayerRequests()).toEqual(['sha256:config', 'sha256:maps'])
  })

  it('fetches the presigned URL with no Authorization header', async () => {
    // The URL carries its own credentials in the query string; an Authorization
    // header makes S3 reject the signature.
    serveEcr({ 'manifests/sha256:top': manifest(), 'blobs/sha256:config': config() })
    await openImage(ECR_IMAGE)

    const [, init] = fetch.mock.calls[0]
    expect(init?.headers).toBeUndefined()
    expect(fetch.mock.calls[0][0]).toContain('X-Amz-Signature')
  })

  it('caches inflated layers on the handle, as the Artifact Registry path does', async () => {
    serveEcr({
      'manifests/sha256:top': manifest({ layers: [layer('sha256:both')] }),
      'blobs/sha256:config': config(),
      'blobs/sha256:both': gzipLayer(
        tarEntry('cru/sourcemaps/main.js.map', '{"version":3}'),
        tarEntry(SIGNIN, PAGE)
      )
    })
    const image = await openImage(ECR_IMAGE)

    expect((await image.readDir('/cru/sourcemaps')).length).toBe(1)
    expect((await image.readFile(`/${SIGNIN}`)).toString()).toBe(PAGE)

    expect(ecrLayerRequests()).toEqual(['sha256:config', 'sha256:both'])
  })

  it('names the failure code when the reference is not in the repository', async () => {
    // A miss is a `failures` entry, not an exception, so it has to be read out
    // or it presents as a manifest with no config descriptor.
    serveEcr({})
    await expect(openImage(ECR_IMAGE)).rejects.toThrow(/no manifest for smaug@sha256:top: ImageNotFound/)
  })

  it('retries a blob download that fails transiently', async () => {
    serveEcr({ 'manifests/sha256:top': manifest(), 'blobs/sha256:config': config({ a: 'b' }) })
    const serve503Once = fetch.getMockImplementation()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async url => {
      calls++
      return calls === 1 ? new Response(null, { status: 503 }) : serve503Once(url)
    }))

    expect((await openImage(ECR_IMAGE)).labels).toEqual({ a: 'b' })
    expect(calls).toBe(2)
  })

  it('does not retry a blob download the server refused outright', async () => {
    serveEcr({ 'manifests/sha256:top': manifest(), 'blobs/sha256:config': config() })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))

    await expect(openImage(ECR_IMAGE)).rejects.toThrow(/HTTP 403 downloading smaug@sha256:config/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
