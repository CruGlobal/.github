import { describe, it, expect, beforeEach, vi } from 'vitest'

// Artifact Registry REST client (tag/digest lookups).
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))

// v1 gcp module: only cloudrunListServices is exercised here. DEFAULT_REGION is
// re-exported so src/v2/gcp.js's SHARED_LOCATION resolves under the mock.
vi.mock('../src/gcp.js', () => ({
  DEFAULT_REGION: 'us-central1',
  cloudrunListServices: vi.fn()
}))

import * as gcp from '../src/gcp.js'
import { resolveCloudRun } from '../src/v2/resolve-cloudrun.js'

const HOST = 'us-central1-docker.pkg.dev'
const REPO = `${HOST}/cru-shared-artifacts/hoax/hoax`
const IMAGES = [
  { uri: `${REPO}@sha256:aaa`, tags: ['candidate-10012', 'sha-abc123'] },
  { uri: `${REPO}@sha256:bbb`, tags: ['candidate-10013', 'release-3'] }
]

beforeEach(() => {
  requestMock.mockReset()
  gcp.cloudrunListServices.mockReset()
})

describe('resolveCloudRun mode=tag', () => {
  it('resolves a tag to a digest reference in the shared registry', async () => {
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveCloudRun({ mode: 'tag', projectName: 'hoax', tag: 'candidate-10012' })

    expect(result).toEqual({
      image: `${REPO}@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc123']
    })
    expect(gcp.cloudrunListServices).not.toHaveBeenCalled()
  })
})

describe('resolveCloudRun mode=environment', () => {
  it('returns the running digest ref as-is and reports its tags', async () => {
    gcp.cloudrunListServices.mockResolvedValue([
      {
        name: 'projects/p/locations/us-central1/services/hoax-web',
        template: {
          containers: [
            { image: `${REPO}@sha256:aaa`, ports: [{ containerPort: 8080 }] },
            { name: 'datadog', image: 'gcr.io/datadoghq/agent:latest' }
          ]
        }
      }
    ])
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveCloudRun({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'production',
      runtimeProject: 'hoax-prod-1234'
    })

    expect(result).toEqual({
      image: `${REPO}@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc123']
    })
    expect(gcp.cloudrunListServices).toHaveBeenCalledWith('hoax-prod-1234')
  })

  it('resolves the tag when the running image is a tag reference', async () => {
    gcp.cloudrunListServices.mockResolvedValue([
      {
        name: 'projects/p/locations/us-central1/services/hoax-web',
        template: { containers: [{ image: `${REPO}:release-3`, ports: [{ containerPort: 8080 }] }] }
      }
    ])
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveCloudRun({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'production',
      runtimeProject: 'hoax-prod-1234'
    })

    expect(result).toEqual({
      image: `${REPO}@sha256:bbb`,
      digest: 'sha256:bbb',
      tags: ['candidate-10013', 'release-3']
    })
  })

  it('throws when no runtime-project is given', async () => {
    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'hoax', environment: 'production' })
    ).rejects.toThrow(/runtime-project is required/)
  })

  it('throws when no running app image is found', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'hoax', environment: 'production', runtimeProject: 'p' })
    ).rejects.toThrow(/Could not find a running app container/)
  })
})

describe('resolveCloudRun invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveCloudRun({ mode: 'nope', projectName: 'hoax' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
