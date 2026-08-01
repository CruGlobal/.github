import { describe, it, expect, beforeEach, vi } from 'vitest'

// Artifact Registry REST client (tag/digest lookups).
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))

// v1 gcp module: only the Cloud Run list calls are exercised here.
// DEFAULT_REGION is re-exported so src/v2/gcp.js's SHARED_LOCATION resolves
// under the mock.
vi.mock('../src/gcp.js', () => ({
  DEFAULT_REGION: 'us-central1',
  cloudrunListServices: vi.fn(),
  cloudrunListJobs: vi.fn()
}))

import * as gcp from '../src/gcp.js'
import { resolveCloudRun } from '../src/v2/resolve-cloudrun.js'

const HOST = 'us-central1-docker.pkg.dev'
const REPO = `${HOST}/cru-shared-artifacts/hoax/hoax`
const IMAGES = [
  { uri: `${REPO}@sha256:aaa`, tags: ['candidate-10012', 'sha-abc123'] },
  { uri: `${REPO}@sha256:bbb`, tags: ['candidate-10013', 'release-3'] }
]

const PLACEHOLDER = 'us-docker.pkg.dev/cloudrun/container/hello'

// A Cloud Run job resource: image lives at template.template.containers.
function job (name, image) {
  return {
    name: `projects/p/locations/us-central1/jobs/${name}`,
    template: { template: { containers: [{ image }] } }
  }
}

beforeEach(() => {
  requestMock.mockReset()
  gcp.cloudrunListServices.mockReset()
  gcp.cloudrunListJobs.mockReset()
  gcp.cloudrunListJobs.mockResolvedValue([])
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

  it('reports no comparable digest for a pre-v2 tag ref outside the shared registry', async () => {
    const preV2 = `${HOST}/hoax-stage-1234/container/hoax:staging-10108`
    gcp.cloudrunListServices.mockResolvedValue([
      {
        name: 'projects/p/locations/us-central1/services/hoax-web',
        template: { containers: [{ image: preV2, ports: [{ containerPort: 8080 }] }] }
      }
    ])

    const result = await resolveCloudRun({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'production',
      runtimeProject: 'hoax-stage-1234'
    })

    expect(result).toEqual({ image: preV2, digest: '', tags: [] })
    // The old registry's tag must never be looked up in the shared registry.
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('throws when no runtime-project is given', async () => {
    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'hoax', environment: 'production' })
    ).rejects.toThrow(/runtime-project is required/)
  })

  it('throws when neither services nor jobs yield an app image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'hoax', environment: 'production', runtimeProject: 'p' })
    ).rejects.toThrow(/Could not find a running app container image .*checked Cloud Run services and jobs/s)
  })
})

describe('resolveCloudRun mode=environment jobs-only apps', () => {
  it('falls back to a job when the app has no services', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([
      job('db-migrate', `${REPO}@sha256:bbb`),
      job('hoax-worker', `${REPO}@sha256:aaa`)
    ])
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveCloudRun({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'production',
      runtimeProject: 'hoax-prod-1234'
    })

    // db-migrate is skipped, so the worker's digest wins.
    expect(result).toEqual({
      image: `${REPO}@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc123']
    })
    expect(gcp.cloudrunListJobs).toHaveBeenCalledWith('hoax-prod-1234')
  })

  it('resolves a tag ref carried by a job', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([job('hoax-worker', `${REPO}:release-3`)])
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

  it('throws when db-migrate is the only job', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([job('db-migrate', `${REPO}@sha256:aaa`)])

    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'hoax', environment: 'production', runtimeProject: 'p' })
    ).rejects.toThrow(/Could not find a running app container/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('throws when the only job still runs the never-deployed placeholder image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([job('hoax-worker', PLACEHOLDER)])

    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'hoax', environment: 'production', runtimeProject: 'p' })
    ).rejects.toThrow(/Could not find a running app container/)
  })

  it('skips a placeholder job and keeps looking', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([
      job('hoax-idle', `${PLACEHOLDER}:latest`),
      job('hoax-worker', `${REPO}@sha256:aaa`)
    ])
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveCloudRun({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'production',
      runtimeProject: 'p'
    })

    expect(result.digest).toBe('sha256:aaa')
  })

  it('never lists jobs when a service already yields the app image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([
      {
        name: 'projects/p/locations/us-central1/services/hoax-web',
        template: { containers: [{ image: `${REPO}@sha256:aaa`, ports: [{ containerPort: 8080 }] }] }
      }
    ])
    requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })

    const result = await resolveCloudRun({
      mode: 'environment',
      projectName: 'hoax',
      environment: 'production',
      runtimeProject: 'p'
    })

    expect(result.digest).toBe('sha256:aaa')
    expect(gcp.cloudrunListJobs).not.toHaveBeenCalled()
  })
})

describe('resolveCloudRun invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveCloudRun({ mode: 'nope', projectName: 'hoax' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
