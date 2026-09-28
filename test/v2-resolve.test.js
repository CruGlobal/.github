import { describe, it, expect, beforeEach, vi } from 'vitest'

// Artifact Registry REST client (tag/digest lookups).
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))

// v1 gcp module: only the Cloud Run list/get calls are exercised here.
// DEFAULT_REGION is re-exported so src/v2/gcp.js's SHARED_LOCATION resolves
// under the mock.
vi.mock('../src/gcp.js', () => ({
  DEFAULT_REGION: 'us-central1',
  cloudrunListServices: vi.fn(),
  cloudrunListJobs: vi.fn(),
  cloudrunGetRevision: vi.fn()
}))

// Keep the real @actions/core but capture the log lines the resolver writes.
vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal()),
  info: vi.fn(),
  warning: vi.fn()
}))

import * as core from '@actions/core'
import * as gcp from '../src/gcp.js'
import { resolveCloudRun } from '../src/v2/resolve-cloudrun.js'
import { TagNotFoundError } from '../src/v2/errors.js'

const HOST = 'us-central1-docker.pkg.dev'
const REPO = `${HOST}/cru-shared-artifacts/example-app/example-app`
const IMAGES = [
  { uri: `${REPO}@sha256:aaa`, tags: ['candidate-10012', 'sha-abc123'] },
  { uri: `${REPO}@sha256:bbb`, tags: ['candidate-10013', 'release-3'] }
]

const PLACEHOLDER = 'us-docker.pkg.dev/cloudrun/container/hello'
const LATEST = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'
const PINNED = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'

const PROJECT = 'example-app-stage-1234'
const SERVICES = `projects/${PROJECT}/locations/us-central1/services`
const revisionName = (service, id) => `${SERVICES}/${service}/revisions/${id}`

// A Cloud Run service the way ListServices returns it. `image` is what the
// service TEMPLATE names, which is what the last update asked for. What is
// actually serving is `trafficStatuses`: by default all traffic follows the
// latest ready revision, `ready`. Pass ready: '' for "no revision is ready".
function service (name, image, { ready = `${name}-00001-aaa`, statuses, traffic, containers } = {}) {
  return {
    name: `${SERVICES}/${name}`,
    template: { containers: containers ?? [{ image, ports: [{ containerPort: 8080 }] }] },
    traffic: traffic ?? [{ type: LATEST, percent: 100 }],
    trafficStatuses: statuses ?? (ready ? [{ type: LATEST, revision: ready, percent: 100 }] : []),
    latestReadyRevision: ready ? revisionName(name, ready) : ''
  }
}

// The revisions GetRevision can return, keyed by full resource name.
let revisions
function revision (serviceName, id, image, containers) {
  const name = revisionName(serviceName, id)
  revisions[name] = { name, containers: containers ?? [{ image, ports: [{ containerPort: 8080 }] }] }
}

// A Cloud Run job resource: image lives at template.template.containers.
function job (name, image) {
  return {
    name: `projects/p/locations/us-central1/jobs/${name}`,
    template: { template: { containers: [{ image }] } }
  }
}

const resolveEnv = () => resolveCloudRun({
  mode: 'environment',
  projectName: 'example-app',
  environment: 'release-candidate',
  runtimeProject: PROJECT
})

const warnings = () => core.warning.mock.calls.map(([message]) => message)

beforeEach(() => {
  requestMock.mockReset()
  requestMock.mockResolvedValue({ data: { dockerImages: IMAGES } })
  gcp.cloudrunListServices.mockReset()
  gcp.cloudrunListJobs.mockReset()
  gcp.cloudrunListJobs.mockResolvedValue([])
  revisions = {}
  gcp.cloudrunGetRevision.mockReset()
  gcp.cloudrunGetRevision.mockImplementation(async name => {
    if (!revisions[name]) throw Object.assign(new Error(`5 NOT_FOUND: ${name}`), { code: 5 })
    return revisions[name]
  })
  core.info.mockReset()
  core.warning.mockReset()
})

describe('resolveCloudRun mode=tag', () => {
  it('resolves a tag to a digest reference in the shared registry', async () => {
    const result = await resolveCloudRun({ mode: 'tag', projectName: 'example-app', tag: 'candidate-10012' })

    expect(result).toEqual({
      image: `${REPO}@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc123']
    })
    expect(gcp.cloudrunListServices).not.toHaveBeenCalled()
  })

  it('throws TagNotFoundError when no image carries the tag', async () => {
    const attempt = resolveCloudRun({ mode: 'tag', projectName: 'example-app', tag: 'sha-nope' })

    await expect(attempt).rejects.toBeInstanceOf(TagNotFoundError)
    await expect(attempt).rejects.toThrow('Tag "sha-nope" not found in cru-shared-artifacts/example-app')
  })
})

describe('resolveCloudRun mode=environment', () => {
  it('returns the serving digest ref as-is and reports its tags', async () => {
    const containers = [
      { image: `${REPO}@sha256:aaa`, ports: [{ containerPort: 8080 }] },
      { name: 'datadog', image: 'gcr.io/datadoghq/agent:latest' }
    ]
    gcp.cloudrunListServices.mockResolvedValue([service('web', null, { containers })])
    revision('web', 'web-00001-aaa', null, containers)

    const result = await resolveEnv()

    expect(result).toEqual({
      image: `${REPO}@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc123']
    })
    expect(gcp.cloudrunListServices).toHaveBeenCalledWith(PROJECT)
    expect(gcp.cloudrunGetRevision).toHaveBeenCalledWith(revisionName('web', 'web-00001-aaa'))
    expect(warnings()).toEqual([])
  })

  it('resolves the tag when the serving image is a tag reference', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service('web', `${REPO}:release-3`)])
    revision('web', 'web-00001-aaa', `${REPO}:release-3`)

    const result = await resolveEnv()

    expect(result).toEqual({
      image: `${REPO}@sha256:bbb`,
      digest: 'sha256:bbb',
      tags: ['candidate-10013', 'release-3']
    })
  })

  it('reports no comparable digest for a pre-v2 tag ref outside the shared registry', async () => {
    const preV2 = `${HOST}/example-app-stage-1234/container/example-app:staging-10108`
    gcp.cloudrunListServices.mockResolvedValue([service('web', preV2)])
    revision('web', 'web-00001-aaa', preV2)

    const result = await resolveEnv()

    expect(result).toEqual({ image: preV2, digest: '', tags: [] })
    // The old registry's tag must never be looked up in the shared registry.
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('throws when no runtime-project is given', async () => {
    await expect(
      resolveCloudRun({ mode: 'environment', projectName: 'example-app', environment: 'production' })
    ).rejects.toThrow(/runtime-project is required/)
  })

  it('throws when neither services nor jobs yield an app image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    await expect(resolveEnv()).rejects.toThrow(
      /Could not find a running app container image .*checked Cloud Run services and jobs/s
    )
  })
})

describe('resolveCloudRun mode=environment reads the serving revision, not the template', () => {
  it('resolves a template that is newer than the serving revision to the serving image', async () => {
    // The last update asked for bbb, but its revision never became ready, so
    // the revision running aaa still takes all the traffic.
    gcp.cloudrunListServices.mockResolvedValue([service('web', `${REPO}@sha256:bbb`)])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:aaa`)

    const result = await resolveEnv()

    expect(result.image).toBe(`${REPO}@sha256:aaa`)
    expect(result.tags).toEqual(['candidate-10012', 'sha-abc123'])
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatch(
      /services\/web: the service template names .*@sha256:bbb, but the revision serving its traffic \(web-00001-aaa\) runs .*@sha256:aaa\. A rollout looks stuck, failed or still in progress/
    )
  })

  it('counts a service with no ready revision as nothing deployed, without falling back to jobs', async () => {
    // A new environment whose first revision never started. The deploy had
    // already put the new image on the job, so the job must not be believed.
    gcp.cloudrunListServices.mockResolvedValue([service('web', `${REPO}@sha256:bbb`, { ready: '' })])
    gcp.cloudrunListJobs.mockResolvedValue([job('worker', `${REPO}@sha256:bbb`)])

    await expect(resolveEnv()).rejects.toThrow(
      /Could not find a running app container image in project example-app-stage-1234: no Cloud Run service has a ready revision/
    )
    expect(gcp.cloudrunGetRevision).not.toHaveBeenCalled()
    expect(gcp.cloudrunListJobs).not.toHaveBeenCalled()
    expect(warnings()[0]).toMatch(/names .*@sha256:bbb, but no ready revision is serving it/)
  })

  it('counts a service still serving the placeholder image as nothing deployed', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service('web', PLACEHOLDER)])
    revision('web', 'web-00001-aaa', PLACEHOLDER)

    await expect(resolveEnv()).rejects.toThrow(/no Cloud Run service has a ready revision serving the app image/)
    expect(warnings()).toEqual([])
  })

  it('falls back to latestReadyRevision when traffic follows LATEST and trafficStatuses is missing', async () => {
    const web = service('web', `${REPO}@sha256:aaa`, { ready: 'web-00004-ddd' })
    delete web.trafficStatuses
    gcp.cloudrunListServices.mockResolvedValue([web])
    revision('web', 'web-00004-ddd', `${REPO}@sha256:aaa`)

    const result = await resolveEnv()

    expect(result.digest).toBe('sha256:aaa')
    expect(gcp.cloudrunGetRevision).toHaveBeenCalledWith(revisionName('web', 'web-00004-ddd'))
  })

  it('falls back to latestReadyRevision when there is no traffic block and trafficStatuses is empty', async () => {
    const web = service('web', `${REPO}@sha256:aaa`, { ready: 'web-00004-ddd', statuses: [], traffic: [] })
    gcp.cloudrunListServices.mockResolvedValue([web])
    revision('web', 'web-00004-ddd', `${REPO}@sha256:aaa`)

    await expect(resolveEnv()).resolves.toMatchObject({ digest: 'sha256:aaa' })
  })

  it('uses latestReadyRevision when the LATEST traffic status names no revision', async () => {
    // The generated client fills an unset string with ''.
    const web = service('web', `${REPO}@sha256:aaa`, {
      ready: 'web-00004-ddd',
      statuses: [{ type: LATEST, revision: '', percent: 100 }]
    })
    gcp.cloudrunListServices.mockResolvedValue([web])
    revision('web', 'web-00004-ddd', `${REPO}@sha256:aaa`)

    await expect(resolveEnv()).resolves.toMatchObject({ digest: 'sha256:aaa' })
  })

  it('follows traffic pinned to a named revision', async () => {
    const web = service('web', `${REPO}@sha256:bbb`, {
      ready: 'web-00005-eee',
      traffic: [{ type: PINNED, revision: 'web-00003-ccc', percent: 100 }],
      statuses: [{ type: PINNED, revision: 'web-00003-ccc', percent: 100 }]
    })
    gcp.cloudrunListServices.mockResolvedValue([web])
    revision('web', 'web-00003-ccc', `${REPO}@sha256:aaa`)
    revision('web', 'web-00005-eee', `${REPO}@sha256:bbb`)

    const result = await resolveEnv()

    expect(result.digest).toBe('sha256:aaa')
    expect(gcp.cloudrunGetRevision).toHaveBeenCalledTimes(1)
    expect(gcp.cloudrunGetRevision).toHaveBeenCalledWith(revisionName('web', 'web-00003-ccc'))
  })

  it('does not trust latestReadyRevision when traffic is pinned but not yet resolved', async () => {
    const web = service('web', `${REPO}@sha256:bbb`, {
      ready: 'web-00005-eee',
      traffic: [{ type: PINNED, revision: 'web-00003-ccc', percent: 100 }],
      statuses: []
    })
    gcp.cloudrunListServices.mockResolvedValue([web])
    revision('web', 'web-00005-eee', `${REPO}@sha256:bbb`)

    await expect(resolveEnv()).rejects.toThrow(/no Cloud Run service has a ready revision/)
  })

  it('resolves nothing when traffic is split between revisions', async () => {
    const web = service('web', `${REPO}@sha256:bbb`, {
      statuses: [
        { type: PINNED, revision: 'web-00001-aaa', percent: 90 },
        { type: PINNED, revision: 'web-00002-bbb', percent: 10 }
      ]
    })
    gcp.cloudrunListServices.mockResolvedValue([web])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:aaa`)
    revision('web', 'web-00002-bbb', `${REPO}@sha256:bbb`)

    await expect(resolveEnv()).rejects.toThrow(
      /services in example-app-stage-1234 do not all serve one app image \(web splits its traffic between revisions\)/
    )
    expect(gcp.cloudrunGetRevision).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('resolves the image when every service serves the same one', async () => {
    gcp.cloudrunListServices.mockResolvedValue([
      service('web', `${REPO}@sha256:aaa`),
      service('worker', `${REPO}@sha256:aaa`)
    ])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:aaa`)
    revision('worker', 'worker-00001-aaa', `${REPO}@sha256:aaa`)

    await expect(resolveEnv()).resolves.toMatchObject({ digest: 'sha256:aaa' })
    expect(gcp.cloudrunGetRevision).toHaveBeenCalledTimes(2)
  })

  it('resolves nothing when two services serve different images', async () => {
    // The first service's update landed, the second one's did not.
    gcp.cloudrunListServices.mockResolvedValue([
      service('web', `${REPO}@sha256:bbb`),
      service('worker', `${REPO}@sha256:bbb`)
    ])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:bbb`)
    revision('worker', 'worker-00001-aaa', `${REPO}@sha256:aaa`)

    const attempt = resolveEnv()

    await expect(attempt).rejects.toThrow(/do not all serve one app image/)
    await expect(attempt).rejects.toThrow(
      `(web serves ${REPO}@sha256:bbb; worker serves ${REPO}@sha256:aaa)`
    )
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('resolves nothing when one service serves the image and another has no ready revision', async () => {
    gcp.cloudrunListServices.mockResolvedValue([
      service('web', `${REPO}@sha256:aaa`),
      service('worker', `${REPO}@sha256:aaa`, { ready: '' })
    ])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:aaa`)

    await expect(resolveEnv()).rejects.toThrow(
      /web serves .*@sha256:aaa; worker has no ready revision serving the app image/
    )
  })

  it('ignores a service that carries no app container', async () => {
    // Two containers, neither this app's image nor the ingress one: a deploy
    // never touches it, so it is no witness either way.
    const other = service('other', null, {
      containers: [{ image: 'gcr.io/other/one:1' }, { image: 'gcr.io/other/two:1' }]
    })
    gcp.cloudrunListServices.mockResolvedValue([other, service('web', `${REPO}@sha256:aaa`)])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:aaa`)

    await expect(resolveEnv()).resolves.toMatchObject({ digest: 'sha256:aaa' })
    expect(gcp.cloudrunGetRevision).toHaveBeenCalledTimes(1)
  })
})

describe('resolveCloudRun mode=environment jobs-only apps', () => {
  it('falls back to a job when the app has no services', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([
      job('db-migrate', `${REPO}@sha256:bbb`),
      job('example-app-worker', `${REPO}@sha256:aaa`)
    ])

    const result = await resolveEnv()

    // db-migrate is skipped, so the worker's digest wins.
    expect(result).toEqual({
      image: `${REPO}@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc123']
    })
    expect(gcp.cloudrunListJobs).toHaveBeenCalledWith(PROJECT)
    // Jobs have no traffic and no revisions: the template is the answer.
    expect(gcp.cloudrunGetRevision).not.toHaveBeenCalled()
  })

  it('resolves a tag ref carried by a job', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([job('example-app-worker', `${REPO}:release-3`)])

    const result = await resolveEnv()

    expect(result).toEqual({
      image: `${REPO}@sha256:bbb`,
      digest: 'sha256:bbb',
      tags: ['candidate-10013', 'release-3']
    })
  })

  it('throws when db-migrate is the only job', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([job('db-migrate', `${REPO}@sha256:aaa`)])

    await expect(resolveEnv()).rejects.toThrow(/Could not find a running app container/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('throws when the only job still runs the never-deployed placeholder image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([job('example-app-worker', PLACEHOLDER)])

    await expect(resolveEnv()).rejects.toThrow(/Could not find a running app container/)
  })

  it('skips a placeholder job and keeps looking', async () => {
    gcp.cloudrunListServices.mockResolvedValue([])
    gcp.cloudrunListJobs.mockResolvedValue([
      job('example-app-idle', `${PLACEHOLDER}:latest`),
      job('example-app-worker', `${REPO}@sha256:aaa`)
    ])

    const result = await resolveEnv()

    expect(result.digest).toBe('sha256:aaa')
  })

  it('never lists jobs when a service already yields the app image', async () => {
    gcp.cloudrunListServices.mockResolvedValue([service('web', `${REPO}@sha256:aaa`)])
    revision('web', 'web-00001-aaa', `${REPO}@sha256:aaa`)

    const result = await resolveEnv()

    expect(result.digest).toBe('sha256:aaa')
    expect(gcp.cloudrunListJobs).not.toHaveBeenCalled()
  })
})

describe('resolveCloudRun invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveCloudRun({ mode: 'nope', projectName: 'example-app' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
