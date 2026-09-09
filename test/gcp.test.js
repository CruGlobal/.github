import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the gRPC Cloud Run clients so the retry behaviour of the mutation and
// list calls can be driven without the network. src/gcp.js destructures
// { ServicesClient, JobsClient } off the module's `v2` export at load time, so
// the mock has to provide that shape.
const {
  updateServiceMock, listJobsMock, updateJobMock,
  runJobMock, getExecutionMock, cancelExecutionMock
} = vi.hoisted(() => ({
  updateServiceMock: vi.fn(),
  listJobsMock: vi.fn(),
  updateJobMock: vi.fn(),
  runJobMock: vi.fn(),
  getExecutionMock: vi.fn(),
  cancelExecutionMock: vi.fn()
}))

vi.mock('@google-cloud/run', () => ({
  v2: {
    ServicesClient: class {
      constructor () {
        this.updateService = updateServiceMock
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
    }
  }
}))

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {}
}))

import {
  DEFAULT_REGION,
  cloudrunListJobs,
  gcrImageTag,
  gcrRegistry,
  runJob,
  updateJob,
  updateService
} from '../src/gcp.js'

const SERVICE = `projects/hoax-prod-1234/locations/${DEFAULT_REGION}/services/hoax`
const CONTAINERS = [{ name: 'app', image: 'gcr.io/p/hoax@sha256:abc', ports: [{ containerPort: 8080 }] }]

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

    await expect(cloudrunListJobs('hoax-prod-1234')).resolves.toEqual([{ name: 'db-migrate' }])
    expect(listJobsMock).toHaveBeenCalledTimes(2)
  })
})


// --- runJob -----------------------------------------------------------------
//
// The job is never re-run automatically: the deadline exists so a stalled
// execution fails the deploy in fifteen minutes instead of two hours, and the
// cancellation is housekeeping so a late start cannot collide with whatever the
// operator runs next.

const JOB = `projects/flightdeck-stage-fybm/locations/${DEFAULT_REGION}/jobs/db-migrate`
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
