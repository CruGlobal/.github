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

// Stub only the publish call; signinBucket stays real so the detection path
// (Terraform's IAP_SIGNIN_BUCKET on the app container) is exercised for real.
// Covered in depth by test/v2-signin.test.js.
vi.mock('../src/v2/signin.js', async importOriginal => ({
  ...(await importOriginal()),
  publishSigninPage: vi.fn()
}))

import * as gcp from '../src/gcp.js'
import { publishSigninPage } from '../src/v2/signin.js'
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

// A service whose app container carries Terraform's IAP_SIGNIN_BUCKET — the
// signal that this environment expects a sign-in page.
function serviceWithSignin () {
  const svc = service()
  svc.template.containers[0].env.push({ name: 'IAP_SIGNIN_BUCKET', value: BUCKET })
  return svc
}

const BUCKET = 'hoax-stage-1234-iap-signin'

beforeEach(() => {
  for (const fn of Object.values(gcp)) fn.mockReset?.()
  publishSigninPage.mockReset()
  publishSigninPage.mockResolvedValue({ published: true, bucket: BUCKET, objectKey: 'signin', bytes: 42 })
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

    expect(result).toEqual({
      deployedImage: IMAGE,
      services: ['hoax-web'],
      // No IAP_SIGNIN_BUCKET on this service -> nothing to publish.
      signin: { published: false }
    })
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

describe('deployCloudRun publishes the IAP sign-in page', () => {
  beforeEach(() => {
    gcp.cloudrunListJobs.mockResolvedValue([])
    gcp.listSecrets.mockResolvedValue([])
    gcp.updateService.mockResolvedValue({})
  })

  it('does nothing for an app with no sign-in bucket', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service()])

    const result = await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    // Detection is bucket-first precisely so most apps never pay a registry read.
    expect(publishSigninPage).not.toHaveBeenCalled()
    expect(result.signin).toEqual({ published: false })
  })

  it('publishes the page carried by the deployed image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([serviceWithSignin()])

    const result = await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    expect(publishSigninPage).toHaveBeenCalledWith({ image: IMAGE, bucket: BUCKET })
    expect(result.signin).toEqual({ published: true, bucket: BUCKET, objectKey: 'signin', bytes: 42 })
  })

  it('publishes after the services are updated', async () => {
    gcp.cloudrunListServices.mockResolvedValue([serviceWithSignin()])

    await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    // The page is the last thing to move: a deploy that fails partway must not
    // leave a new sign-in page in front of an old app.
    expect(publishSigninPage.mock.invocationCallOrder[0]).toBeGreaterThan(
      gcp.updateService.mock.invocationCallOrder[0]
    )
  })

  it('reads the bucket from the service as it was before the update', async () => {
    // The rewritten container drops plain env for secrets, so resolution has to
    // happen against the pre-update spec.
    gcp.cloudrunListServices.mockResolvedValue([serviceWithSignin()])
    gcp.listSecrets.mockResolvedValue(SECRETS)

    await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    expect(publishSigninPage).toHaveBeenCalledWith({ image: IMAGE, bucket: BUCKET })
  })

  it('does not fail the deploy when the page cannot be published', async () => {
    gcp.cloudrunListServices.mockResolvedValue([serviceWithSignin()])
    publishSigninPage.mockRejectedValue(new Error('403 storage.objects.create denied'))

    // A cosmetic, pre-auth page must never take down a production promote.
    const result = await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    expect(result.deployedImage).toBe(IMAGE)
    expect(result.services).toEqual(['hoax-web'])
    expect(result.signin.published).toBe(false)
  })

  it('does not fail the deploy when the image carries no page', async () => {
    // The normal case when rolling back to a release built before the image
    // carried the page.
    gcp.cloudrunListServices.mockResolvedValue([serviceWithSignin()])
    publishSigninPage.mockResolvedValue({ published: false, reason: 'no-label' })

    const result = await deployCloudRun({ image: IMAGE, runtimeProject: 'p' })

    expect(result.services).toEqual(['hoax-web'])
    expect(result.signin).toEqual({ published: false, reason: 'no-label' })
  })
})

describe('deployCloudRun ignores version (Terraform owns Cloud Run env)', () => {
  beforeEach(() => {
    gcp.listSecrets.mockResolvedValue(SECRETS)
    gcp.updateService.mockResolvedValue({})
    gcp.updateJob.mockResolvedValue({})
    gcp.runJob.mockResolvedValue({})
  })

  // Unlike ECS (task_definition wholly ignored by Terraform), the Cloud Run
  // service's app-container env is Terraform-managed with ignore_changes on
  // the image only -- an injected DD_VERSION would drift on every plan and be
  // removed by every apply. Version telemetry rides the deployment events.
  it('never injects DD_VERSION, even when version is set', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service()])
    gcp.cloudrunListJobs.mockResolvedValue(jobs())

    await deployCloudRun({ image: IMAGE, runtimeProject: 'p', version: 'release-2026-07-23-10057' })

    const [, containers] = gcp.updateService.mock.calls[0]
    expect(containers[0].env.some(e => e.name === 'DD_VERSION')).toBe(false)
    // datadog sidecar is not the app container -> unchanged
    expect(containers[1]).toEqual({ name: 'datadog', image: 'gcr.io/datadoghq/agent:latest' })
    for (const [job] of gcp.updateJob.mock.calls) {
      expect(job.template.template.containers[0].env.some(e => e.name === 'DD_VERSION')).toBe(false)
    }
  })

  it('preserves a pre-existing DD_VERSION env entry untouched (it belongs to Terraform)', async () => {
    const svc = service()
    svc.template.containers[0].env = [{ name: 'DD_VERSION', value: 'tf-owned' }, { name: 'FOO', value: 'bar' }]
    gcp.cloudrunListServices.mockResolvedValue([svc])
    gcp.cloudrunListJobs.mockResolvedValue([])

    await deployCloudRun({ image: IMAGE, runtimeProject: 'p', version: 'release-new' })

    const [, containers] = gcp.updateService.mock.calls[0]
    expect(containers[0].env).toContainEqual({ name: 'DD_VERSION', value: 'tf-owned' })
    expect(containers[0].env).toContainEqual({ name: 'FOO', value: 'bar' })
  })
})
