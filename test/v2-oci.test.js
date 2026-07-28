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

import { openImage, parseRegistryRef } from '../src/v2/oci.js'
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

beforeEach(() => {
  requestMock.mockReset()
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
