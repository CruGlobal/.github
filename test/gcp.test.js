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
// The distinction under test is the whole point of the retry: an execution that
// never STARTED ran no migration and may be run again, while a task that ran and
// failed must fail the deploy on the first attempt.

const JOB = `projects/flightdeck-stage-fybm/locations/${DEFAULT_REGION}/jobs/db-migrate`
const EXEC = `${JOB}/executions/db-migrate-4vdmx`
const EXEC2 = `${JOB}/executions/db-migrate-b7k2p`

// The RunJob long-running operation: Execution as metadata (available before it
// resolves) and the finished Execution as the response.
function runOperation (executionName, response = {}) {
  return [{
    metadata: executionName ? { name: executionName } : undefined,
    promise: () => Promise.resolve([{ name: executionName, taskCount: 1, succeededCount: 1, ...response }])
  }]
}

const started = name => [{ name, startTime: { seconds: 1 }, taskCount: 1 }]
const pending = name => [{ name, taskCount: 1 }]
const neverStarted = name => [{ name, completionTime: { seconds: 2 }, taskCount: 1 }]

// Tiny values so the stall paths do not actually wait.
const FAST = { startDeadlineMs: 30, pollIntervalMs: 5 }

describe('runJob', () => {
  beforeEach(() => {
    runJobMock.mockReset()
    getExecutionMock.mockReset()
    cancelExecutionMock.mockReset()
    cancelExecutionMock.mockResolvedValue([{ promise: () => Promise.resolve([{}]) }])
  })

  it('waits for a started execution and returns it', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(runJobMock).toHaveBeenCalledWith({ name: JOB })
    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  it('does NOT retry a task that ran and failed', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC, { succeededCount: 0, failedCount: 1 }))
    getExecutionMock.mockResolvedValue(started(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow('Job execution did not succeed')

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  it('cancels and retries once when the execution never started', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    getExecutionMock
      .mockResolvedValueOnce(neverStarted(EXEC))
      .mockResolvedValue(started(EXEC2))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC2 })

    expect(runJobMock).toHaveBeenCalledTimes(2)
    expect(cancelExecutionMock).toHaveBeenCalledTimes(1)
    expect(cancelExecutionMock).toHaveBeenCalledWith({ name: EXEC })
  })

  it('treats our own start deadline as a stall while the execution is still pending', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    // Keyed by name, not call order: the first execution stays pending however
    // many times it is polled, so the deadline is what ends the wait.
    getExecutionMock.mockImplementation(({ name }) =>
      Promise.resolve(name === EXEC ? pending(EXEC) : started(EXEC2))
    )

    await expect(runJob(JOB, { startDeadlineMs: 12, pollIntervalMs: 5 })).resolves.toMatchObject({ name: EXEC2 })

    expect(cancelExecutionMock).toHaveBeenCalledWith({ name: EXEC })
  })

  it('fails the deploy when it never starts twice', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    getExecutionMock
      .mockResolvedValueOnce(neverStarted(EXEC))
      .mockResolvedValueOnce(neverStarted(EXEC2))

    await expect(runJob(JOB, FAST)).rejects.toThrow('failed to start twice')

    expect(runJobMock).toHaveBeenCalledTimes(2)
    expect(cancelExecutionMock).toHaveBeenCalledTimes(2)
  })

  it('carries on when cancelling the stalled execution fails', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    getExecutionMock
      .mockResolvedValueOnce(neverStarted(EXEC))
      .mockResolvedValue(started(EXEC2))
    cancelExecutionMock.mockRejectedValue(new Error('already terminated'))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC2 })
  })

  it('keeps the original unbounded wait when the operation names no execution', async () => {
    runJobMock.mockResolvedValue(runOperation(undefined, { name: EXEC }))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(getExecutionMock).not.toHaveBeenCalled()
    expect(runJobMock).toHaveBeenCalledTimes(1)
  })
})
