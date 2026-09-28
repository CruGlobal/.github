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
})
