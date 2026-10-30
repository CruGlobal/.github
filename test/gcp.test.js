import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the gRPC Cloud Run clients so the retry behaviour of the mutation and
// list calls can be driven without the network. src/gcp.js destructures
// { ServicesClient, JobsClient } off the module's `v2` export at load time, so
// the mock has to provide that shape.
const {
  updateServiceMock, getServiceMock, servicesMade, revisionsMade, listJobsMock, updateJobMock,
  runJobMock, getExecutionMock, cancelExecutionMock, getRevisionMock
} = vi.hoisted(() => ({
  updateServiceMock: vi.fn(),
  getServiceMock: vi.fn(),
  servicesMade: [],
  revisionsMade: [],
  listJobsMock: vi.fn(),
  updateJobMock: vi.fn(),
  runJobMock: vi.fn(),
  getExecutionMock: vi.fn(),
  cancelExecutionMock: vi.fn(),
  getRevisionMock: vi.fn()
}))

vi.mock('@google-cloud/run', () => ({
  v2: {
    ServicesClient: class {
      constructor () {
        servicesMade.push(this)
        this.updateService = updateServiceMock
        this.getService = getServiceMock
      }
    },
    JobsClient: class {
      constructor () {
        this.listJobs = listJobsMock
        this.updateJob = updateJobMock
        this.runJob = runJobMock
      }
    },
    ExecutionsClient: class {
      constructor () {
        this.getExecution = getExecutionMock
        this.cancelExecution = cancelExecutionMock
        this.close = () => Promise.resolve()
      }
    },
    RevisionsClient: class {
      constructor () {
        revisionsMade.push(this)
        this.getRevision = getRevisionMock
      }
    }
  }
}))

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {}
}))

import {
  DEFAULT_REGION,
  OperationUnreadable,
  OperationWaitExpired,
  QUICK_READ_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  cloudrunGetRevision,
  cloudrunGetService,
  cloudrunListJobs,
  gcrImageTag,
  gcrRegistry,
  isReadinessDeadline,
  pinServiceTraffic,
  runJob,
  updateJob,
  updateService
} from '../src/gcp.js'

const SERVICE = `projects/example-app-prod-abcd/locations/${DEFAULT_REGION}/services/example-app`
const CONTAINERS = [{ name: 'app', image: 'gcr.io/p/example-app@sha256:abc', ports: [{ containerPort: 8080 }] }]

// The error google-gax raises for the production flake: UpdateService is
// classified non_idempotent, so nothing under us retries it.
function unavailable () {
  const error = new Error('14 UNAVAILABLE: The service is currently unavailable.')
  error.code = 14
  return error
}

function aborted () {
  const error = new Error('10 ABORTED: Resource is being modified.')
  error.code = 10
  return error
}

// A resolved long-running operation, in the [operation] / [response] shape the
// generated clients return.
function operation (response = { name: SERVICE }) {
  return [{ promise: () => Promise.resolve([response]) }]
}

const OPERATION = `projects/example-app-stage-abcd/locations/${DEFAULT_REGION}/operations/0000-example`

// An operation whose wait (promise) fails with `waitError`, and whose re-reads
// (getOperation) answer from `reads` in turn, the way gax's do: not done yet,
// done with a result, or done with the operation's own error; or a read that
// fails on the wire. gax sets latestResponse before it reports an operation's
// own error, and so does this. `reads` may also be a function that returns the
// next read, for reads that never end.
function blippedOperation (reads, { waitError = unavailable(), metadata } = {}) {
  const op = {
    name: OPERATION,
    metadata,
    latestResponse: { name: OPERATION, done: false },
    promise: vi.fn(() => Promise.reject(waitError)),
    getOperation: vi.fn(async () => {
      const read = typeof reads === 'function' ? reads() : reads.shift()
      if (read.wire) throw read.wire
      op.latestResponse = { name: OPERATION, done: read.done }
      if (read.error) throw read.error
      return [read.done ? (read.result ?? null) : null, metadata, op.latestResponse]
    })
  }
  return op
}

describe('gcrRegistry', () => {
  it('builds the Artifact Registry path using the default region', () => {
    expect(gcrRegistry('my-gcp-project', 'myproject')).toBe(
      `${DEFAULT_REGION}-docker.pkg.dev/my-gcp-project/container/myproject`
    )
  })

  it('honors a custom region', () => {
    expect(gcrRegistry('my-gcp-project', 'myproject', 'europe-west1')).toBe(
      'europe-west1-docker.pkg.dev/my-gcp-project/container/myproject'
    )
  })
})

describe('gcrImageTag', () => {
  it('builds a fully-qualified Artifact Registry image tag', () => {
    expect(gcrImageTag('my-gcp-project', 'myproject', 'production', '10042')).toBe(
      `${DEFAULT_REGION}-docker.pkg.dev/my-gcp-project/container/myproject:production-10042`
    )
  })
})

describe('transient gRPC failures', () => {
  beforeEach(() => {
    updateServiceMock.mockReset()
    updateJobMock.mockReset()
    listJobsMock.mockReset()
    getRevisionMock.mockReset()
    // Pin the jitter to its floor so the backoff is a predictable 1s and the
    // suite does not pay for the random half of the window.
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('updateService rides out an UNAVAILABLE', async () => {
    updateServiceMock
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(operation())

    await expect(updateService(SERVICE, CONTAINERS)).resolves.toEqual({ name: SERVICE })
    expect(updateServiceMock).toHaveBeenCalledTimes(2)
  })

  it('updateService replays the identical desired state, so the replay is a no-op update', async () => {
    const sent = []
    updateServiceMock.mockImplementation(request => {
      sent.push(structuredClone(request))
      if (sent.length === 1) return Promise.reject(unavailable())
      return Promise.resolve(operation())
    })

    await updateService(SERVICE, CONTAINERS)

    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    // The force-revision annotation is the one field that would otherwise
    // differ per attempt and turn a replay into a second revision.
    const annotation = 'client.knative.dev/force-revision'
    expect(sent[1].service.template.annotations[annotation])
      .toBe(sent[0].service.template.annotations[annotation])
  })

  it('updateService fails immediately on a real API answer', async () => {
    const denied = new Error('7 PERMISSION_DENIED: nope')
    denied.code = 7
    updateServiceMock.mockRejectedValue(denied)

    await expect(updateService(SERVICE, CONTAINERS)).rejects.toBe(denied)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  it('updateService treats an ABORTED on a replay as the earlier attempt landing', async () => {
    updateServiceMock
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValue(aborted())

    await expect(updateService(SERVICE, CONTAINERS)).resolves.toBeNull()
    expect(updateServiceMock).toHaveBeenCalledTimes(2)
  })

  it('updateService still fails on an ABORTED from the first attempt', async () => {
    const conflict = aborted()
    updateServiceMock.mockRejectedValue(conflict)

    await expect(updateService(SERVICE, CONTAINERS)).rejects.toBe(conflict)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  it('updateJob rides out an UNAVAILABLE', async () => {
    const job = { name: `projects/p/locations/${DEFAULT_REGION}/jobs/db-migrate` }
    updateJobMock
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(operation(job))

    await expect(updateJob(job)).resolves.toEqual(job)
    expect(updateJobMock).toHaveBeenCalledTimes(2)
  })

  it('cloudrunListJobs rides out an UNAVAILABLE', async () => {
    listJobsMock
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue([[{ name: 'db-migrate' }]])

    await expect(cloudrunListJobs('example-app-prod-abcd')).resolves.toEqual([{ name: 'db-migrate' }])
    expect(listJobsMock).toHaveBeenCalledTimes(2)
  })

  it('cloudrunGetRevision rides out an UNAVAILABLE and asks for the revision by name', async () => {
    const name = `projects/example-app-stage/locations/${DEFAULT_REGION}/services/app/revisions/app-00002-xyz`
    getRevisionMock
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue([{ name, containers: CONTAINERS }])

    await expect(cloudrunGetRevision(name)).resolves.toEqual({ name, containers: CONTAINERS })
    expect(getRevisionMock).toHaveBeenCalledTimes(2)
    expect(getRevisionMock).toHaveBeenCalledWith({ name }, { timeout: READ_TIMEOUT_MS })
  })

  it('cloudrunGetRevision fails immediately on a real API answer', async () => {
    const missing = new Error('5 NOT_FOUND: revision not found')
    missing.code = 5
    getRevisionMock.mockRejectedValue(missing)

    await expect(cloudrunGetRevision('projects/p/locations/l/services/s/revisions/r')).rejects.toBe(missing)
    expect(getRevisionMock).toHaveBeenCalledTimes(1)
  })
})


// --- rollouts ---------------------------------------------------------------
//
// What src/v2/cloudrun-rollout.js relies on from the requests and the retry.

// How gax reports an operation that failed on the readiness deadline, as a
// trial against the real API showed it: code 13 and this message, nothing else.
function readinessDeadline () {
  const error = new Error('Deploying Revision. Resource readiness deadline exceeded.')
  error.code = 13
  return error
}

describe('updateService requests', () => {
  beforeEach(() => {
    updateServiceMock.mockReset()
    updateServiceMock.mockResolvedValue(operation())
  })

  it('sends all traffic to the latest revision, with traffic in the mask, when asked', async () => {
    await updateService(SERVICE, CONTAINERS, { trafficToLatest: true })
    await updateService(SERVICE, CONTAINERS, { trafficToLatest: true, waitMs: 60000 })

    for (const [request] of updateServiceMock.mock.calls) {
      expect(request.service.traffic).toEqual([{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }])
      expect(request.updateMask.paths).toEqual(['template.containers', 'template.annotations', 'traffic'])
      expect(request.service.template.containers).toEqual(CONTAINERS)
    }
  })

  it('leaves traffic alone when not asked, as v1 always has', async () => {
    await updateService(SERVICE, CONTAINERS)

    const [[request]] = updateServiceMock.mock.calls
    expect(request.service).not.toHaveProperty('traffic')
    expect(request.updateMask.paths).toEqual(['template.containers', 'template.annotations'])
  })

  it('stamps the force-revision value it is given, so the caller can find its revision', async () => {
    await updateService(SERVICE, CONTAINERS, { forceRevision: 'ours' })

    const [[request]] = updateServiceMock.mock.calls
    expect(request.service.template.annotations).toEqual({ 'client.knative.dev/force-revision': 'ours' })
  })

  it('waits on the operation as long as it takes when no bound is given', async () => {
    await updateService(SERVICE, CONTAINERS)

    expect(updateServiceMock.mock.calls[0][1]).toBeUndefined()
  })

  it('hands over the generation from the operation\'s metadata the moment the RPC returns', async () => {
    const heard = []
    // The metadata already carries the new generation, as a Long, and still
    // names the OLD latest created revision.
    const metadata = { generation: { low: 7, high: 0, toString: () => '7' }, latestCreatedRevision: `${SERVICE}/revisions/old` }
    updateServiceMock.mockResolvedValue([{
      metadata,
      promise: () => {
        heard.push('promise')
        return Promise.resolve([{ name: SERVICE }])
      }
    }])

    await updateService(SERVICE, CONTAINERS, { onAccepted: generation => heard.push(String(generation)) })

    expect(heard).toEqual(['7', 'promise'])
  })

  it('says the update was accepted even when the metadata carries no generation', async () => {
    const heard = []

    await updateService(SERVICE, CONTAINERS, { onAccepted: generation => heard.push(generation) })

    expect(heard).toEqual([undefined])
  })
})

describe('updateService and the readiness deadline', () => {
  beforeEach(() => {
    updateServiceMock.mockReset()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it.each([
    ['its real code, 13', 13],
    ['DEADLINE_EXCEEDED, which the shared retry would replay', 4]
  ])('is never replayed with %s: the update was accepted, and a replay would only wait on it again', async (_, code) => {
    const stalled = Object.assign(readinessDeadline(), { code })
    updateServiceMock.mockResolvedValue([{ promise: () => Promise.reject(stalled) }])

    await expect(updateService(SERVICE, CONTAINERS)).rejects.toBe(stalled)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  it('bounds the wait on the operation, and never replays the bound running out', async () => {
    // gax fails an operation poll that outlived totalTimeoutMillis like this.
    const timedOut = Object.assign(new Error('Total timeout exceeded before any response was received'), { code: 4 })
    updateServiceMock.mockResolvedValue([{
      promise: () => new Promise((resolve, reject) => setTimeout(() => reject(timedOut), 40))
    }])

    const error = await updateService(SERVICE, CONTAINERS, { waitMs: 20 }).catch(error => error)

    expect(error).toBeInstanceOf(OperationWaitExpired)
    expect(error.cause).toBe(timedOut)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
    const [[, options]] = updateServiceMock.mock.calls
    expect(options.longrunning.totalTimeoutMillis).toBeGreaterThan(0)
    expect(options.longrunning.totalTimeoutMillis).toBeLessThanOrEqual(20)
  })

  it('still replays a transient failure of the RPC itself', async () => {
    updateServiceMock
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(operation())

    await expect(updateService(SERVICE, CONTAINERS, { waitMs: 60000 })).resolves.toEqual({ name: SERVICE })
    expect(updateServiceMock).toHaveBeenCalledTimes(2)
  })
})

// --- a blip in the wait -------------------------------------------------------
//
// gax polls an operation with the settings of the call that started it, so for
// these non_idempotent calls a poll carries no retry, and one UNAVAILABLE fails
// the wait while the work goes on. The operation is read again instead, and
// nothing is sent twice.

describe('updateService and a blip in the wait', () => {
  beforeEach(() => {
    updateServiceMock.mockReset()
    updateJobMock.mockReset()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('reads the same operation again, and never sends the update again', async () => {
    const op = blippedOperation([{ done: true, result: { name: SERVICE } }])
    updateServiceMock.mockResolvedValue([op])

    await expect(updateService(SERVICE, CONTAINERS, { waitMs: 60000 })).resolves.toEqual({ name: SERVICE })
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
    expect(op.getOperation).toHaveBeenCalledTimes(1)
  })

  it('does the same for an update with no bound on the wait', async () => {
    const job = { name: `projects/p/locations/${DEFAULT_REGION}/jobs/db-migrate` }
    const op = blippedOperation([{ done: true, result: job }])
    updateJobMock.mockResolvedValue([op])

    await expect(updateJob(job)).resolves.toEqual(job)
    expect(updateJobMock).toHaveBeenCalledTimes(1)
  })

  // The outage that failed real deploys outlasted the shared retry's half a
  // minute by minutes, with every replayed update accepted and every wait lost.
  it('keeps reading through an outage of minutes, while waitMs allows, and sends the update once', async () => {
    vi.useFakeTimers()
    try {
      const op = blippedOperation([
        ...Array.from({ length: 20 }, () => ({ wire: unavailable() })),
        { done: true, result: { name: SERVICE } }
      ])
      updateServiceMock.mockResolvedValue([op])

      const outcome = updateService(SERVICE, CONTAINERS, { waitMs: 20 * 60 * 1000 }).catch(error => error)
      await vi.runAllTimersAsync()

      expect(await outcome).toEqual({ name: SERVICE })
      expect(op.getOperation).toHaveBeenCalledTimes(21)
      expect(updateServiceMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends reads that run past waitMs as OperationWaitExpired, still without a replay', async () => {
    const op = blippedOperation(() => ({ done: false }))
    updateServiceMock.mockResolvedValue([op])

    const error = await updateService(SERVICE, CONTAINERS, { waitMs: 30 }).catch(error => error)

    expect(error).toBeInstanceOf(OperationWaitExpired)
    // The reads saw it running, so the blip that started them is not the story.
    expect(error.message).toMatch(/was still running at the last read/)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  it('names the last failed read when the reads fail until waitMs runs out', async () => {
    let last = null
    const op = blippedOperation(() => {
      last = unavailable()
      return { wire: last }
    })
    updateServiceMock.mockResolvedValue([op])

    const error = await updateService(SERVICE, CONTAINERS, { waitMs: 30 }).catch(error => error)

    expect(error).toBeInstanceOf(OperationWaitExpired)
    expect(error.cause).toBe(last)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  it('with no waitMs, gives up after ten minutes of failed reads, and never replays', async () => {
    vi.useFakeTimers()
    try {
      const job = { name: `projects/p/locations/${DEFAULT_REGION}/jobs/db-migrate` }
      const op = blippedOperation(() => ({ wire: unavailable() }))
      updateJobMock.mockResolvedValue([op])

      const outcome = updateJob(job).catch(error => error)
      await vi.runAllTimersAsync()
      const error = await outcome

      expect(error).toBeInstanceOf(OperationUnreadable)
      expect(error.message).toMatch(/could not read .* for 10 minutes .*check it before running this again/)
      expect(error.cause.code).toBe(14)
      expect(updateJobMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // So a caller with another way to tell, the v2 rollout, can turn to it well
  // before its own bound runs out.
  it('ends a run of failed reads as OperationUnreadable when readOutageMs comes before waitMs', async () => {
    vi.useFakeTimers()
    try {
      const op = blippedOperation(() => ({ wire: unavailable() }))
      updateServiceMock.mockResolvedValue([op])
      const start = Date.now()

      const outcome = updateService(SERVICE, CONTAINERS, { waitMs: 30 * 60 * 1000, readOutageMs: 2 * 60 * 1000 })
        .catch(error => error)
      await vi.runAllTimersAsync()
      const error = await outcome

      expect(error).toBeInstanceOf(OperationUnreadable)
      expect(error.message).toContain('for 2 minutes')
      expect(Date.now() - start).toBeLessThan(3 * 60 * 1000)
      expect(updateServiceMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends the wait at once on a read that failed for good', async () => {
    const denied = grpcError(7, '7 PERMISSION_DENIED: not allowed')
    const op = blippedOperation([{ wire: denied }])
    updateServiceMock.mockResolvedValue([op])

    await expect(updateService(SERVICE, CONTAINERS, { waitMs: 60000 })).rejects.toBe(denied)
    expect(op.getOperation).toHaveBeenCalledTimes(1)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  // Not a code the mutation retry replays, but a read changes nothing, so it
  // is read again (readFailedForGood).
  it('reads again after a wait that failed with INTERNAL on the wire', async () => {
    const op = blippedOperation([{ done: true, result: { name: SERVICE } }], {
      waitError: grpcError(13, '13 INTERNAL: Received RST_STREAM with code 2')
    })
    updateServiceMock.mockResolvedValue([op])

    await expect(updateService(SERVICE, CONTAINERS, { waitMs: 60000 })).resolves.toEqual({ name: SERVICE })
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })

  it('passes the readiness deadline from a re-read through, unreplayed', async () => {
    const stalled = readinessDeadline()
    updateServiceMock.mockResolvedValue([blippedOperation([{ done: true, error: stalled }])])

    await expect(updateService(SERVICE, CONTAINERS, { waitMs: 60000 })).rejects.toBe(stalled)
    expect(updateServiceMock).toHaveBeenCalledTimes(1)
  })
})

describe('isReadinessDeadline', () => {
  it('matches the message, in any case, on an error or a condition', () => {
    expect(isReadinessDeadline(readinessDeadline())).toBe(true)
    expect(isReadinessDeadline({ type: 'Ready', state: 'CONDITION_FAILED', message: 'Resource readiness deadline exceeded.' })).toBe(true)
    expect(isReadinessDeadline(new Error('4 DEADLINE_EXCEEDED: resource READINESS DEADLINE EXCEEDED'))).toBe(true)
  })

  it('matches the reason on a condition', () => {
    expect(isReadinessDeadline({ type: 'Ready', state: 'CONDITION_FAILED', reason: 'PROGRESS_DEADLINE_EXCEEDED' })).toBe(true)
  })

  it('matches nothing else', () => {
    expect(isReadinessDeadline(unavailable())).toBe(false)
    expect(isReadinessDeadline(Object.assign(new Error('Total timeout exceeded before any response was received'), { code: 4 }))).toBe(false)
    expect(isReadinessDeadline(Object.assign(new Error('9 FAILED_PRECONDITION: container failed to start'), { code: 9 }))).toBe(false)
    expect(isReadinessDeadline(undefined)).toBe(false)
  })
})

describe('pinServiceTraffic', () => {
  beforeEach(() => {
    updateServiceMock.mockReset()
    updateServiceMock.mockResolvedValue(operation())
  })

  it('sends one revision by short name at 100%, and the template\'s own force-revision value back', async () => {
    await pinServiceTraffic(SERVICE, 'example-app-00001-abc', 'value-the-deploy-sent', 60000)

    const [[request, options]] = updateServiceMock.mock.calls
    // Left out, the v2 API drops the hidden value, reads the template as
    // changed and mints a copy of the current revision.
    expect(request).toEqual({
      service: {
        name: SERVICE,
        template: { annotations: { 'client.knative.dev/force-revision': 'value-the-deploy-sent' } },
        traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'example-app-00001-abc', percent: 100 }]
      },
      updateMask: { paths: ['traffic', 'template.annotations'] }
    })
    expect(options.longrunning.totalTimeoutMillis).toBeLessThanOrEqual(60000)
  })
})

describe('cloudrunGetService', () => {
  beforeEach(() => {
    getServiceMock.mockReset()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('rides out an UNAVAILABLE, and bounds each read so a poll cannot spend minutes on one', async () => {
    getServiceMock
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue([{ name: SERVICE }])

    await expect(cloudrunGetService(SERVICE)).resolves.toEqual({ name: SERVICE })
    expect(getServiceMock).toHaveBeenCalledTimes(2)
    expect(getServiceMock).toHaveBeenCalledWith({ name: SERVICE }, { timeout: READ_TIMEOUT_MS })
  })

  it('makes a quick read ONE attempt with a short timeout, for a caller whose next look is the retry', async () => {
    const blip = unavailable()
    getServiceMock.mockRejectedValue(blip)
    getRevisionMock.mockReset()
    getRevisionMock.mockRejectedValue(blip)

    await expect(cloudrunGetService(SERVICE, { quick: true })).rejects.toBe(blip)
    await expect(cloudrunGetRevision(`${SERVICE}/revisions/r`, { quick: true })).rejects.toBe(blip)

    expect(getServiceMock.mock.calls).toEqual([[{ name: SERVICE }, { timeout: QUICK_READ_TIMEOUT_MS }]])
    expect(getRevisionMock.mock.calls).toEqual([[{ name: `${SERVICE}/revisions/r` }, { timeout: QUICK_READ_TIMEOUT_MS }]])
  })

  it('fails immediately on a real API answer', async () => {
    const missing = Object.assign(new Error('5 NOT_FOUND: service not found'), { code: 5 })
    getServiceMock.mockRejectedValue(missing)

    await expect(cloudrunGetService(SERVICE)).rejects.toBe(missing)
    expect(getServiceMock).toHaveBeenCalledTimes(1)
  })

  it('reuses one client for every read, so a long poll does not redo the credential exchange each time', async () => {
    getServiceMock.mockResolvedValue([{ name: SERVICE }])
    getRevisionMock.mockResolvedValue([{ name: 'r' }])
    servicesMade.length = 0
    revisionsMade.length = 0

    for (let poll = 0; poll < 3; poll++) {
      await cloudrunGetService(SERVICE)
      await cloudrunGetRevision(`${SERVICE}/revisions/r`)
    }

    // Made on an earlier test's first read, if not this one's, and never again.
    expect(servicesMade.length).toBeLessThanOrEqual(1)
    expect(revisionsMade.length).toBeLessThanOrEqual(1)
  })
})

// --- runJob -----------------------------------------------------------------
//
// The job is never re-run automatically: the deadline exists so a stalled
// execution fails the deploy in fifteen minutes instead of two hours, and the
// cancellation is housekeeping so a late start cannot collide with whatever the
// operator runs next.

const JOB = `projects/example-app-stage-abcd/locations/${DEFAULT_REGION}/jobs/db-migrate`
const EXEC = `${JOB}/executions/db-migrate-4vdmx`

// The RunJob long-running operation: Execution as metadata (readable before it
// resolves) and the finished Execution as the response.
function runOperation (executionName, response = {}) {
  return [{
    metadata: executionName ? { name: executionName } : undefined,
    promise: () => Promise.resolve([{ name: executionName, taskCount: 1, succeededCount: 1, ...response }])
  }]
}

const started = name => [{ name, startTime: { seconds: 1 }, taskCount: 1 }]
const pending = name => [{ name, taskCount: 1 }]
// Terminal AND ran — the ordering trap: the proto does not promise start_time
// lands before completion_time, so the counters have to be believed too.
const ranAndFinished = name => [{ name, completionTime: { seconds: 2 }, failedCount: 1, taskCount: 1 }]

const cancelOperation = execution => [{ promise: () => Promise.resolve([execution]) }]

function grpcError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// Tiny values so the stall path does not actually wait.
const FAST = { startDeadlineMs: 30, pollIntervalMs: 5 }

describe('runJob', () => {
  beforeEach(() => {
    runJobMock.mockReset()
    getExecutionMock.mockReset()
    cancelExecutionMock.mockReset()
    cancelExecutionMock.mockResolvedValue(cancelOperation({ name: EXEC, cancelledCount: 0 }))
  })

  it('waits for a started execution and returns it', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  it('never re-runs the job, whatever happens', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC, { succeededCount: 0, failedCount: 1 }))
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow('Job execution did not succeed')

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  // start_time is not guaranteed to land before completion_time, so a finished
  // execution is judged by the run operation rather than by the timestamps.
  it('lets the run operation report a terminal execution', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC, { succeededCount: 0, failedCount: 1 }))
    getExecutionMock.mockResolvedValue(ranAndFinished(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow('Job execution did not succeed')

    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  it('fails in minutes when the execution never starts, and cancels it', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(pending(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow(/had not started.*has been cancelled/s)

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(cancelExecutionMock).toHaveBeenCalledWith({ name: EXEC }, expect.objectContaining({
      longrunning: expect.objectContaining({ totalTimeoutMillis: expect.any(Number) })
    }))
  })

  it('says so when the stalled execution could not be cancelled', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(pending(EXEC))
    cancelExecutionMock.mockRejectedValue(grpcError(7, 'PERMISSION_DENIED'))

    await expect(runJob(JOB, FAST)).rejects.toThrow(/could NOT be cancelled.*confirm it is not running/s)
  })

  it('says so when the execution started while being cancelled', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(pending(EXEC))
    cancelExecutionMock.mockResolvedValue(cancelOperation({ name: EXEC, cancelledCount: 1 }))

    await expect(runJob(JOB, FAST)).rejects.toThrow(/STARTED while being cancelled/)
  })

  it('carries the execution conditions into the failure', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue([{
      name: EXEC,
      taskCount: 1,
      conditions: [{ type: 'ContainerReady', message: 'Imported container image in 26.13s.' }]
    }])

    await expect(runJob(JOB, FAST)).rejects.toThrow('Imported container image in 26.13s.')
  })

  // Read-after-write lag on the first poll must not switch the deadline off.
  it('keeps polling through NOT_FOUND', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock
      .mockRejectedValueOnce(grpcError(5, 'NOT_FOUND'))
      .mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(getExecutionMock).toHaveBeenCalledTimes(2)
  })

  it('fails loudly when the execution cannot be read for want of permission', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockRejectedValue(grpcError(7, 'PERMISSION_DENIED'))

    await expect(runJob(JOB, FAST)).rejects.toThrow('PERMISSION_DENIED')

    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  // Any other read failure is not evidence either way, so it falls back to the
  // behaviour this replaced rather than failing a running migration's deploy.
  it('falls back to waiting on the operation when the execution cannot be read', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockRejectedValue(grpcError(9, 'FAILED_PRECONDITION'))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  it('keeps the original wait when the operation names no execution', async () => {
    runJobMock.mockResolvedValue(runOperation(undefined, { name: EXEC }))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(getExecutionMock).not.toHaveBeenCalled()
  })

  // The case that failed real deploys: the migration finished, and the deploy
  // only lost the wait for it.
  it('rides out a blip in the wait by reading the run operation again, and never re-runs the job', async () => {
    const op = blippedOperation([
      { done: false },
      { done: true, result: { name: EXEC, taskCount: 1, succeededCount: 1 } }
    ], { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(op.getOperation).toHaveBeenCalledTimes(2)
  })

  it('still fails the deploy when the re-read finds the execution failed', async () => {
    const op = blippedOperation([
      { done: true, result: { name: EXEC, taskCount: 1, succeededCount: 0, failedCount: 1 } }
    ], { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow('Job execution did not succeed')

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  // More failed reads in a row than the shared retry's five: the next read is
  // the retry, for as long as the outage bound allows.
  it('keeps reading through a run of failed reads, and never re-runs the job', async () => {
    const op = blippedOperation([
      ...Array.from({ length: 8 }, () => ({ wire: unavailable() })),
      { done: true, result: { name: EXEC, taskCount: 1, succeededCount: 1 } }
    ], { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(op.getOperation).toHaveBeenCalledTimes(9)
    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  // An operation's own error is its final answer, whatever its code, and a
  // read cannot change it.
  it('passes the operation\'s own error through without reading it again, even with a retryable code', async () => {
    const failed = grpcError(14, 'Task db-migrate-4vdmx-task0 failed.')
    const op = blippedOperation([{ done: true, error: failed }], { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toBe(failed)

    expect(op.getOperation).toHaveBeenCalledTimes(1)
    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  it('does not read again when the wait failed with the operation\'s own answer', async () => {
    const failed = grpcError(14, 'Task db-migrate-4vdmx-task0 failed.')
    const op = blippedOperation([], { waitError: failed, metadata: { name: EXEC } })
    op.latestResponse.done = true
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toBe(failed)

    expect(op.getOperation).not.toHaveBeenCalled()
  })

  it('does not read again when the wait failed for a real reason', async () => {
    const denied = grpcError(7, 'PERMISSION_DENIED')
    const op = blippedOperation([], { waitError: denied, metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toBe(denied)

    expect(op.getOperation).not.toHaveBeenCalled()
  })

  it('gives up once the reads have failed for the outage bound, names the execution, and never re-runs the job', async () => {
    const op = blippedOperation(() => ({ wire: unavailable() }), { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock.mockResolvedValue(started(EXEC))

    const error = await runJob(JOB, { ...FAST, readOutageMs: 40 }).catch(error => error)

    expect(error).toBeInstanceOf(OperationUnreadable)
    expect(error.message).toContain(`runJob ${EXEC}: could not read ${OPERATION}`)
    expect(error.message).toContain('check it before running this again')
    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  // The operation's answer is the finished Execution, so the execution's own
  // record answers just as well while the operation cannot be read.
  it('takes a finished execution from its own record while the run operation cannot be read', async () => {
    const op = blippedOperation(() => ({ wire: unavailable() }), { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock
      .mockResolvedValueOnce(started(EXEC))
      .mockResolvedValue([{ name: EXEC, completionTime: { seconds: 2 }, taskCount: 1, succeededCount: 1 }])

    await expect(runJob(JOB, { ...FAST, readOutageMs: 60000 })).resolves.toMatchObject({ name: EXEC })

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  it('still fails the deploy on a finished execution that failed, read from its own record', async () => {
    const op = blippedOperation(() => ({ wire: unavailable() }), { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock
      .mockResolvedValueOnce(started(EXEC))
      .mockResolvedValue([{
        name: EXEC,
        completionTime: { seconds: 2 },
        taskCount: 1,
        succeededCount: 0,
        failedCount: 1,
        conditions: [{ type: 'Completed', message: 'Task db-migrate-4vdmx-task0 failed.' }]
      }])

    // The record's reason comes along, as the operation's own error would carry it.
    await expect(runJob(JOB, { ...FAST, readOutageMs: 60000 }))
      .rejects.toThrow(`Job execution did not succeed: ${EXEC} (Completed: Task db-migrate-4vdmx-task0 failed.)`)
  })

  it('does not take an execution that is still reconciling', async () => {
    const op = blippedOperation(() => ({ wire: unavailable() }), { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock
      .mockResolvedValueOnce(started(EXEC))
      .mockResolvedValue([{ name: EXEC, completionTime: { seconds: 2 }, reconciling: true, taskCount: 1, succeededCount: 1 }])

    const error = await runJob(JOB, { ...FAST, readOutageMs: 40 }).catch(error => error)

    expect(error).toBeInstanceOf(OperationUnreadable)
  })

  it('carries on reading the operation when its look at the execution fails', async () => {
    const op = blippedOperation([
      { wire: unavailable() },
      { wire: unavailable() },
      { done: true, result: { name: EXEC, taskCount: 1, succeededCount: 1 } }
    ], { metadata: { name: EXEC } })
    runJobMock.mockResolvedValue([op])
    getExecutionMock
      .mockResolvedValueOnce(started(EXEC))
      .mockRejectedValue(grpcError(7, 'PERMISSION_DENIED'))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(op.getOperation).toHaveBeenCalledTimes(3)
  })

  it('reads for ten minutes by default before it gives up', async () => {
    vi.useFakeTimers()
    try {
      const op = blippedOperation(() => ({ wire: unavailable() }), { metadata: { name: EXEC } })
      runJobMock.mockResolvedValue([op])
      getExecutionMock.mockResolvedValue(started(EXEC))
      const start = Date.now()

      const outcome = runJob(JOB, { startDeadlineMs: 30 }).catch(error => error)
      await vi.runAllTimersAsync()
      const error = await outcome

      expect(error).toBeInstanceOf(OperationUnreadable)
      expect(Date.now() - start).toBeGreaterThanOrEqual(10 * 60 * 1000)
      expect(Date.now() - start).toBeLessThan(11 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })
})
