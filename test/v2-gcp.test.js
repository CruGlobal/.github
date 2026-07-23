import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock google-auth-library so the Artifact Registry REST calls in listDockerImages
// / resolveTag / tagsForDigest hit a canned client instead of the network.
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))

import {
  SHARED_LOCATION,
  SHARED_PROJECT,
  assertDigestRef,
  findAppContainer,
  isAppContainer,
  isDigestRef,
  isTagRef,
  listDockerImages,
  parseImageRef,
  resolveTag,
  sharedImageDigest,
  sharedImageTag,
  sharedRegistryImage,
  sharedRegistryRepo,
  tagsForDigest
} from '../src/v2/gcp.js'

const HOST = `${SHARED_LOCATION}-docker.pkg.dev`

describe('shared registry path construction', () => {
  it('names the repo after the app', () => {
    expect(sharedRegistryRepo('hoax')).toBe('hoax')
  })

  it('builds the image path host/project/repo/image', () => {
    expect(sharedRegistryImage('hoax')).toBe(
      `${HOST}/${SHARED_PROJECT}/hoax/hoax`
    )
  })

  it('builds a tag-pinned reference', () => {
    expect(sharedImageTag('hoax', 'candidate-10012')).toBe(
      `${HOST}/cru-shared-artifacts/hoax/hoax:candidate-10012`
    )
  })

  it('builds a digest-pinned reference', () => {
    expect(sharedImageDigest('hoax', 'sha256:abc')).toBe(
      `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:abc`
    )
  })
})

describe('parseImageRef', () => {
  it('parses a digest reference', () => {
    expect(parseImageRef(`${HOST}/p/r/i@sha256:abc`)).toEqual({
      name: `${HOST}/p/r/i`,
      digest: 'sha256:abc',
      tag: null
    })
  })

  it('parses a tag reference', () => {
    expect(parseImageRef(`${HOST}/p/r/i:candidate-1`)).toEqual({
      name: `${HOST}/p/r/i`,
      digest: null,
      tag: 'candidate-1'
    })
  })

  it('parses a bare reference (no tag/digest)', () => {
    expect(parseImageRef(`${HOST}/p/r/i`)).toEqual({
      name: `${HOST}/p/r/i`,
      digest: null,
      tag: null
    })
  })
})

describe('reference kind predicates', () => {
  it('recognizes digest refs', () => {
    expect(isDigestRef(`${HOST}/p/r/i@sha256:abc`)).toBe(true)
    expect(isDigestRef(`${HOST}/p/r/i:candidate-1`)).toBe(false)
  })

  it('recognizes tag refs', () => {
    expect(isTagRef(`${HOST}/p/r/i:candidate-1`)).toBe(true)
    expect(isTagRef(`${HOST}/p/r/i@sha256:abc`)).toBe(false)
    expect(isTagRef(`${HOST}/p/r/i`)).toBe(false)
  })

  it('assertDigestRef passes a digest ref and rejects a tag ref', () => {
    expect(() => assertDigestRef(`${HOST}/p/r/i@sha256:abc`)).not.toThrow()
    expect(() => assertDigestRef(`${HOST}/p/r/i:release-3`)).toThrow(/digest-pinned/)
  })
})

describe('app container heuristics', () => {
  const repo = `${HOST}/cru-shared-artifacts/hoax/hoax`
  const app = { image: `${repo}@sha256:aaa`, ports: [{ containerPort: 8080 }] }
  const sidecar = { name: 'datadog', image: 'gcr.io/datadoghq/agent:latest' }

  it('treats the only container as the app', () => {
    const only = [{ image: 'anything:v1' }]
    expect(isAppContainer(only[0], only, repo)).toBe(true)
    expect(findAppContainer(only, repo)).toBe(only[0])
  })

  it('matches the app container by image repo, preserving sidecars', () => {
    const containers = [app, sidecar]
    expect(isAppContainer(app, containers, repo)).toBe(true)
    expect(isAppContainer(sidecar, containers, repo)).toBe(false)
    expect(findAppContainer(containers, repo)).toBe(app)
  })

  it('falls back to the container with a port when no repo matches', () => {
    const ingress = { image: 'placeholder:latest', ports: [{ containerPort: 3000 }] }
    const containers = [sidecar, ingress]
    expect(findAppContainer(containers, repo)).toBe(ingress)
  })
})

describe('Artifact Registry resolution (mocked client)', () => {
  const IMAGES = [
    {
      uri: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:aaa`,
      tags: ['candidate-10012', 'sha-abc123']
    },
    {
      uri: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:bbb`,
      tags: ['candidate-10013', 'release-3']
    }
  ]

  beforeEach(() => {
    requestMock.mockReset()
  })

  it('listDockerImages follows pagination and hits the correct endpoint', async () => {
    requestMock
      .mockResolvedValueOnce({ data: { dockerImages: [IMAGES[0]], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { dockerImages: [IMAGES[1]] } })

    const images = await listDockerImages(SHARED_PROJECT, 'hoax')

    expect(images).toEqual(IMAGES)
    expect(requestMock).toHaveBeenCalledTimes(2)
    const firstUrl = requestMock.mock.calls[0][0].url
    expect(firstUrl).toContain(
      `/projects/${SHARED_PROJECT}/locations/${SHARED_LOCATION}/repositories/hoax/dockerImages`
    )
  })

  it('resolveTag returns the digest reference and tags for a tag', async () => {
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveTag('hoax', 'release-3')

    expect(result).toEqual({
      image: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:bbb`,
      digest: 'sha256:bbb',
      tags: ['candidate-10013', 'release-3']
    })
  })

  it('resolveTag finds a dated release from a bare build number (D10 fallback)', async () => {
    requestMock.mockResolvedValue({
      data: {
        dockerImages: [
          { uri: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:ddd`, tags: ['candidate-2026-07-23-10056', 'release-2026-07-23-10056'] },
          { uri: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:eee`, tags: ['candidate-2026-07-23-10057'] }
        ]
      }
    })

    const result = await resolveTag('hoax', 'release-10056')

    expect(result.digest).toBe('sha256:ddd')
    expect(result.tags).toContain('release-2026-07-23-10056')
  })

  it('resolveTag never guesses between ambiguous dated matches', async () => {
    requestMock.mockResolvedValue({
      data: {
        dockerImages: [
          { uri: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:ddd`, tags: ['release-2026-07-23-10056'] },
          { uri: `${HOST}/cru-shared-artifacts/hoax/hoax@sha256:eee`, tags: ['release-2026-07-24-10056'] }
        ]
      }
    })

    await expect(resolveTag('hoax', 'release-10056')).rejects.toThrow(/not found/)
  })

  it('resolveTag throws when the tag is not present', async () => {
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })
    await expect(resolveTag('hoax', 'candidate-99999')).rejects.toThrow(/not found/)
  })

  it('tagsForDigest returns the tags on a digest, or [] when unknown', async () => {
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })
    expect(await tagsForDigest('hoax', 'sha256:aaa')).toEqual(['candidate-10012', 'sha-abc123'])
    expect(await tagsForDigest('hoax', 'sha256:missing')).toEqual([])
  })
})
