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
// never ran a task may be run again, while anything we cannot prove ran nothing
// must fail the deploy instead.

const JOB = `projects/flightdeck-stage-fybm/locations/${DEFAULT_REGION}/jobs/db-migrate`
const EXEC = `${JOB}/executions/db-migrate-4vdmx`
const EXEC2 = `${JOB}/executions/db-migrate-b7k2p`

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
// Cloud Run's own verdict after two hours: terminal, and no task ever ran.
const neverRan = name => [{ name, completionTime: { seconds: 2 }, taskCount: 1 }]
// Terminal AND ran — the ordering trap: the proto does not promise start_time
// lands before completion_time, so the counters have to be believed too.
const ranAndFinished = name => [{ name, completionTime: { seconds: 2 }, failedCount: 1, taskCount: 1 }]

const cancelOperation = execution => [{ promise: () => Promise.resolve([execution]) }]

// Non-transient, so retryTransient gives up at once instead of backing off.
function denied (message = 'PERMISSION_DENIED') {
  const error = new Error(message)
  error.code = 7
  return error
}

// Tiny values so the stall paths do not actually wait.
const FAST = { startDeadlineMs: 30, pollIntervalMs: 5, cancelTimeoutMs: 50 }

describe('runJob', () => {
  beforeEach(() => {
    runJobMock.mockReset()
    getExecutionMock.mockReset()
    cancelExecutionMock.mockReset()
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

  // A terminal execution with no task counts is Cloud Run telling us it gave up
  // scheduling. Nothing to cancel, and nothing ran.
  it('re-runs a terminal execution that never started, without cancelling it', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    getExecutionMock.mockImplementation(({ name }) =>
      Promise.resolve(name === EXEC ? neverRan(EXEC) : started(EXEC2))
    )

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC2 })

    expect(runJobMock).toHaveBeenCalledTimes(2)
    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  // Still pending when our deadline passes: Cloud Run could still schedule it,
  // so it has to be cancelled before the job runs again.
  it('cancels a still-pending execution before re-running, and confirms nothing ran', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    let cancelled = false
    cancelExecutionMock.mockImplementation(() => {
      cancelled = true
      return Promise.resolve(cancelOperation({ name: EXEC, completionTime: { seconds: 3 }, cancelledCount: 1 }))
    })
    getExecutionMock.mockImplementation(({ name }) => {
      if (name === EXEC2) return Promise.resolve(started(EXEC2))
      return Promise.resolve(cancelled
        ? [{ name: EXEC, completionTime: { seconds: 3 }, cancelledCount: 1, taskCount: 1 }]
        : pending(EXEC))
    })

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC2 })

    expect(cancelExecutionMock).toHaveBeenCalledWith({ name: EXEC })
    expect(runJobMock).toHaveBeenCalledTimes(2)
  })

  // Finding: a swallowed cancel failure would start a second execution while the
  // first is still schedulable.
  it('refuses to re-run when the cancellation fails', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(pending(EXEC))
    cancelExecutionMock.mockRejectedValue(denied())

    await expect(runJob(JOB, FAST)).rejects.toThrow('PERMISSION_DENIED')

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  // Finding: the task can start between the last poll and the cancel landing.
  it('refuses to re-run when the execution turns out to have started', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    cancelExecutionMock.mockResolvedValue(cancelOperation({ name: EXEC }))
    let cancelled = false
    cancelExecutionMock.mockImplementation(() => {
      cancelled = true
      return Promise.resolve(cancelOperation({ name: EXEC }))
    })
    getExecutionMock.mockImplementation(() => Promise.resolve(cancelled
      ? [{ name: EXEC, startTime: { seconds: 9 }, completionTime: { seconds: 10 }, cancelledCount: 1, taskCount: 1 }]
      : pending(EXEC)))

    await expect(runJob(JOB, FAST)).rejects.toThrow('ran a task after all')

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to re-run when the execution is still not terminal after cancelling', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    cancelExecutionMock.mockResolvedValue(cancelOperation({ name: EXEC }))
    getExecutionMock.mockResolvedValue(pending(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow('neither finished nor cancelled')

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  // Finding: start_time is not guaranteed to land before completion_time, so a
  // finished-but-failed execution must not read as "never started".
  it('believes the task counters when completion lands before start_time', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC, { succeededCount: 0, failedCount: 1 }))
    getExecutionMock.mockResolvedValue(ranAndFinished(EXEC))

    await expect(runJob(JOB, FAST)).rejects.toThrow('Job execution did not succeed')

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  // Finding: polling is less tolerant than the operation wait it replaced, so a
  // read that fails outright falls back rather than failing the deploy.
  it('falls back to waiting on the operation when the execution cannot be read', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockRejectedValue(denied('cannot read'))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  // Finding: an unbounded cancel would put back the two-hour wait.
  it('bounds the cancellation rather than hanging on it', async () => {
    runJobMock.mockResolvedValue(runOperation(EXEC))
    getExecutionMock.mockResolvedValue(pending(EXEC))
    cancelExecutionMock.mockResolvedValue([{ promise: () => new Promise(() => {}) }])

    await expect(runJob(JOB, { ...FAST, cancelTimeoutMs: 20 })).rejects.toThrow('did not finish within')

    expect(runJobMock).toHaveBeenCalledTimes(1)
  })

  it('fails the deploy when it never starts twice, and says whether the second was cancelled', async () => {
    runJobMock
      .mockResolvedValueOnce(runOperation(EXEC))
      .mockResolvedValueOnce(runOperation(EXEC2))
    getExecutionMock.mockImplementation(({ name }) => Promise.resolve(neverRan(name)))

    await expect(runJob(JOB, FAST)).rejects.toThrow(/failed to start twice.*already terminal/s)

    expect(runJobMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the original unbounded wait when the operation names no execution', async () => {
    runJobMock.mockResolvedValue(runOperation(undefined, { name: EXEC }))

    await expect(runJob(JOB, FAST)).resolves.toMatchObject({ name: EXEC })

    expect(getExecutionMock).not.toHaveBeenCalled()
    expect(runJobMock).toHaveBeenCalledTimes(1)
  })
})
