import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the v1 gcp module so no real Cloud Run / Secret Manager calls happen.
// DEFAULT_REGION is re-exported so src/v2/gcp.js loads under the mock.
vi.mock('../src/gcp.js', () => ({
  DEFAULT_REGION: 'us-central1',
  cloudrunListServices: vi.fn(),
  cloudrunListJobs: vi.fn(),
  listSecrets: vi.fn(),
  runJob: vi.fn(),
  updateJob: vi.fn(),
  updateService: vi.fn()
}))

import * as gcp from '../src/gcp.js'
import { deployCloudRun } from '../src/v2/deploy-cloudrun.js'

const HOST = 'us-central1-docker.pkg.dev'
const REPO = `${HOST}/cru-shared-artifacts/hoax/hoax`
const IMAGE = `${REPO}@sha256:new`
const SECRETS = [{ name: 'projects/p/secrets/DATABASE_URL' }]

function service () {
  return {
    name: 'projects/p/locations/us-central1/services/hoax-web',
    template: {
      containers: [
        {
          image: `${REPO}@sha256:old`,
          ports: [{ containerPort: 8080 }],
          env: [{ name: 'FOO', value: 'bar' }]
        },
        { name: 'datadog', image: 'gcr.io/datadoghq/agent:latest' }
      ]
    }
  }
}

function jobs () {
  return [
    { name: 'projects/p/locations/us-central1/jobs/db-migrate', template: { template: { containers: [{ image: 'old', env: [] }] } } },
    { name: 'projects/p/locations/us-central1/jobs/scheduled', template: { template: { containers: [{ image: 'old', env: [] }] } } }
  ]
}

beforeEach(() => {
  for (const fn of Object.values(gcp)) fn.mockReset?.()
})

describe('deployCloudRun digest invariant', () => {
  it('rejects a tag reference before touching infrastructure', async () => {
    await expect(
      deployCloudRun({ image: `${REPO}:candidate-10012`, runtimeProject: 'p' })
    ).rejects.toThrow(/digest-pinned/)
    expect(gcp.cloudrunListServices).not.toHaveBeenCalled()
  })

  it('requires a runtime-project', async () => {
    await expect(deployCloudRun({ image: IMAGE })).rejects.toThrow(/runtime-project is required/)
  })
})

describe('deployCloudRun orchestration', () => {
  it('runs the migrate job first, refreshes other jobs, then updates services', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service()])
    gcp.cloudrunListJobs.mockResolvedValue(jobs())
    gcp.listSecrets.mockResolvedValue(SECRETS)
    gcp.runJob.mockResolvedValue({})
    gcp.updateJob.mockResolvedValue({})
    gcp.updateService.mockResolvedValue({})

    const result = await deployCloudRun({ image: IMAGE, runtimeProject: 'hoax-prod-1234' })

    // db-migrate is executed to completion, and before any service update.
    expect(gcp.runJob).toHaveBeenCalledTimes(1)
    expect(gcp.runJob).toHaveBeenCalledWith('projects/p/locations/us-central1/jobs/db-migrate')
    expect(gcp.runJob.mock.invocationCallOrder[0]).toBeLessThan(gcp.updateService.mock.invocationCallOrder[0])

    // Both jobs get their image/secrets refreshed.
    expect(gcp.updateJob).toHaveBeenCalledTimes(2)
    for (const [job] of gcp.updateJob.mock.calls) {
      expect(job.template.template.containers[0].image).toBe(IMAGE)
    }

    // Exactly the app container is rewritten; the datadog sidecar is preserved.
    expect(gcp.updateService).toHaveBeenCalledTimes(1)
    const [name, containers] = gcp.updateService.mock.calls[0]
    expect(name).toBe('projects/p/locations/us-central1/services/hoax-web')
    expect(containers[0].image).toBe(IMAGE)
    expect(containers[0].env).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'projects/p/secrets/DATABASE_URL', version: 'latest' } } }
    ])
    expect(containers[1]).toEqual({ name: 'datadog', image: 'gcr.io/datadoghq/agent:latest' })

    expect(result).toEqual({ deployedImage: IMAGE, services: ['hoax-web'] })
  })

  it('aborts the deploy without touching services when the migrate job fails', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service()])
    gcp.cloudrunListJobs.mockResolvedValue(jobs())
    gcp.listSecrets.mockResolvedValue(SECRETS)
    gcp.updateJob.mockResolvedValue({})
    gcp.runJob.mockRejectedValue(new Error('Job execution did not succeed'))

    await expect(deployCloudRun({ image: IMAGE, runtimeProject: 'p' })).rejects.toThrow(/did not succeed/)
    expect(gcp.updateService).not.toHaveBeenCalled()
  })

  it('deploys services when there is no migrate job', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service()])
    gcp.cloudrunListJobs.mockResolvedValue([])
    gcp.listSecrets.mockResolvedValue(SECRETS)
    gcp.updateService.mockResolvedValue({})

    const result = await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    expect(gcp.runJob).not.toHaveBeenCalled()
    expect(gcp.updateJob).not.toHaveBeenCalled()
    expect(gcp.updateService).toHaveBeenCalledTimes(1)
    expect(result.services).toEqual(['hoax-web'])
  })
})
