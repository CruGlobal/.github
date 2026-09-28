import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The Cloud Run client library, replaced by the fake in
// test/support/fake-cloudrun.js. Everything above it (src/gcp.js included) is
// the real code.
const { cloud } = vi.hoisted(() => ({ cloud: { run: null } }))
vi.mock('@google-cloud/run', () => ({
  v2: {
    ServicesClient: class {
      listServices (...args) { return cloud.run.listServices(...args) }
      getService (...args) { return cloud.run.getService(...args) }
      updateService (...args) { return cloud.run.updateService(...args) }
    },
    JobsClient: class {
      listJobs (...args) { return cloud.run.listJobs(...args) }
      updateJob (...args) { return cloud.run.updateJob(...args) }
      runJob (...args) { return cloud.run.runJob(...args) }
    },
    ExecutionsClient: class {},
    RevisionsClient: class {
      getRevision (...args) { return cloud.run.getRevision(...args) }
    }
  }
}))

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    listSecrets () { return Promise.resolve([[]]) }
  }
}))

// The shared registry, for the resolver in the pin-release test.
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal()),
  info: vi.fn(),
  warning: vi.fn()
}))

import * as core from '@actions/core'
import { deployCloudRun } from '../src/v2/deploy-cloudrun.js'
import { resolveCloudRun } from '../src/v2/resolve-cloudrun.js'
import { sharedRegistryImage } from '../src/v2/gcp.js'
import { PIN_RESERVE_MS } from '../src/v2/cloudrun-rollout.js'
import { ROLLOUT_BUDGET_MS, STEP_CAP_MS, rolloutBudget } from '../src/v2/rollout-budget.js'
import {
  DEADLINE_MESSAGE,
  DEADLINE_ON_READY,
  LATEST,
  MINUTE,
  PINNED,
  READINESS_DEADLINE_MS,
  STILL_TRYING,
  advance,
  fakeCloudRun
} from './support/fake-cloudrun.js'
import { serveRegistry } from './support/registry-fixture.js'

const PROJECT = 'example-stage'
const REPO = sharedRegistryImage('example-app')
const OLD = `${REPO}@sha256:old`
const NEW = `${REPO}@sha256:new`
const FORCE_REVISION = 'client.knative.dev/force-revision'
const RETRYING = 'Retrying container health check; still waiting to become healthy...'

// Several services carry a Datadog serverless-init sidecar next to the app.
const SIDECAR = { name: 'serverless-init', image: 'gcr.io/datadoghq/serverless-init:1' }
const containers = image => [
  { name: 'app', image, ports: [{ containerPort: 8080 }], env: [{ name: 'FOO', value: 'bar' }] },
  SIDECAR
]

// When the deploy step started, on the faked clock.
const STEP_STARTED_AT = new Date('2030-01-01T00:00:00Z').getTime()
const elapsed = () => Date.now() - STEP_STARTED_AT

const deploy = (args = {}) => deployCloudRun(
  { image: NEW, runtimeProject: PROJECT, ...args },
  { budget: rolloutBudget({ sleep: async ms => advance(ms), stepStartedAt: STEP_STARTED_AT }) }
)
const rollback = () => deploy({ stopRolloutOnFailure: false })
const failure = promise => promise.then(() => { throw new Error('expected the deploy to fail') }, error => error)

const NORMAL_RESULT = {
  deployedImage: NEW,
  services: ['app'],
  signin: { published: false },
  sourcemaps: { status: 'skipped', uploaded: 0, failed: 0 }
}
const BACK_ON_APP = 'all traffic is pinned: app to revision app-00001-abc.'
const MIGRATION_NOTE = 'Only the services go back: the database migration, if the app has one, has already run, ' +
  'and its jobs already run the new image.'

const warnings = () => core.warning.mock.calls.map(([message]) => message)
const infos = () => core.info.mock.calls.map(([message]) => message)
const grpcError = (code, message) => Object.assign(new Error(message), { code })

let run
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(STEP_STARTED_AT)
  run = cloud.run = fakeCloudRun({ project: PROJECT })
  core.info.mockReset()
  core.warning.mockReset()
  requestMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Where a deploy that ran out of time leaves a service: pinned to 00001, while
// its own revision, 00002, became ready later with no traffic.
function pinnedAfterAStall (image = `${REPO}@sha256:stuck`) {
  run.addService('app', containers(OLD))
  run.addReadyRevision('app', containers(image))
  run.pinTo('app', 'app-00001-abc')
}

describe('every update is checked against the service', () => {
  it('lands a normal update as soon as its operation succeeds', async () => {
    run.addService('app', containers(OLD))

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    expect(elapsed()).toBe(30 * 1000)
    expect(infos()).toContainEqual(expect.stringMatching(/revision app-00002-abc is ready and serves all traffic, 30s after/))
  })

  it('waits out trafficStatuses lagging the release of a pin, after an operation that succeeded', async () => {
    pinnedAfterAStall()
    run.plan('app', { lands: 10 * 1000 })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    // The operation took 10 seconds; the routed traffic caught up at 30.
    expect(elapsed()).toBe(30 * 1000)
  })

  it('looks every 5 seconds for the first minute after the operation reports, and still logs about once a minute', async () => {
    run = cloud.run = fakeCloudRun({ project: PROJECT, statusLagMs: 35 * 1000 })
    pinnedAfterAStall()

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    // The operation took 30 seconds and the routed traffic caught up 5 later:
    // seen at 35 seconds, where a 15-second poll would have waited until 45.
    expect(elapsed()).toBe(35 * 1000)
    // The read before the update, then one per look: 30 and 35 seconds.
    expect(run.reads.getService).toBe(1 + 2)
    expect(infos().filter(line => line.includes(': waiting for'))).toHaveLength(1)
  })

  it('fails when another update superseded this one, even though its operation succeeded, and pins nothing', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { lands: 2 * MINUTE, supersededAfter: MINUTE })

    await expect(deploy()).rejects.toThrow(
      'app: another update reached the service while this deploy waited (it is at generation 3; this ' +
      "deploy's update made generation 2), so this deploy's revision is no longer the one rolling out. " +
      'Nothing is recorded for this deploy. Check what the service is serving before running it again.'
    )
    // Theirs to record: the traffic is left alone.
    expect(run.pins()).toHaveLength(0)
  })

  it('takes the generation from the first read when a replay leaves no operation, and waits for its revision', async () => {
    // The update was accepted but its answer was lost, and the replay was
    // ABORTED because the first attempt was still rolling out.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    run.addService('app', containers(OLD))
    run.plan('app', { lands: MINUTE, abortedReplay: true, createdAfter: 20 * 1000 })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    // Not the revision that was already there, serving: this deploy's, once it
    // had been created, was ready and took the traffic.
    expect(run.requests).toHaveLength(2)
    expect(elapsed()).toBe(MINUTE)
    expect(infos()).toContainEqual(expect.stringMatching(/waiting for its new revision .*\(it has not been created yet\)/))
    expect(infos()).toContainEqual(expect.stringMatching(/revision app-00002-abc is ready and serves all traffic/))
  })

  it('is not fooled into "superseded" by a read that lags an ABORTED replay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    run.addService('app', containers(OLD))
    // The first read after the replay still shows generation 1 and the old
    // revision; taking its generation would make our own generation 2 look
    // like someone else's.
    run.plan('app', { lands: 30 * 1000, abortedReplay: true, laggingReads: 1 })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
  })

  it('treats an unset generation in the metadata as unknown, and takes it from the service', async () => {
    run.addService('app', containers(OLD))
    // An unset int64 decodes as 0; taken at face value, every read would look
    // like a later update.
    run.plan('app', { lands: 30 * 1000, metadataGeneration: 0 })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
  })

  it('does not take a service that is still reconciling for landed', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { lands: 30 * 1000, reconcilingFor: 5 * MINUTE })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    expect(elapsed()).toBe(5 * MINUTE)
  })

  it('never takes a retired revision for landed, though it reads Ready', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { lands: 30 * 1000, retiredFor: 20 * MINUTE })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    expect(elapsed()).toBe(20 * MINUTE)
    expect(infos()).toContainEqual(expect.stringMatching(/waiting for revision app-00002-abc .*\(it is retired\)/))
  })
})

describe('a revision that misses the readiness deadline', () => {
  it('is waited for, and a late landing is a normal success, so every record step runs', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 25 * MINUTE } })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    // Once: the deadline is never replayed.
    expect(run.requests).toHaveLength(1)
    expect(run.pins()).toHaveLength(0)
    expect(elapsed()).toBe(25 * MINUTE)
    expect(warnings()[0]).toMatch(/Deploying Revision\. Resource readiness deadline exceeded\. Cloud Run keeps retrying/)
    expect(infos()).toContainEqual(expect.stringMatching(/revision app-00002-abc is ready and serves all traffic, 25m 0s after/))
  })

  it('logs one line about every minute while it waits, saying what it waits for and for how long', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 25 * MINUTE } })

    await deploy()

    const waiting = infos().filter(line => line.includes(': waiting for'))
    // From the deadline at 14 minutes to the landing at 25: a line a minute,
    // not one a poll.
    expect(waiting).toHaveLength(11)
    expect(waiting[0]).toBe(
      `projects/${PROJECT}/locations/us-central1/services/app: waiting for revision app-00002-abc to be ready ` +
      `and take all the traffic (${RETRYING}). Waited 14m 0s, 28m 0s left.`
    )
    expect(waiting[1]).toMatch(/Waited 15m 0s, 27m 0s left\.$/)
  })

  it('waits the same when the revision carries the deadline\'s message on its Ready condition', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE, conditions: DEADLINE_ON_READY } })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
    expect(infos()).toContainEqual(expect.stringContaining(`(${DEADLINE_MESSAGE})`))
  })

  it('keeps waiting while the revision reports REVISION_FAILED with the deadline message', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', {
      stalls: {
        readyAfter: 25 * MINUTE,
        conditions: [{ type: 'Ready', state: 'CONDITION_FAILED', reason: 'REVISION_FAILED', message: DEADLINE_MESSAGE }]
      }
    })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
  })

  it('keeps waiting past a failed service status in other words, once the operation reported the deadline', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE, terminal: 'Revision is not ready and cannot serve traffic.' } })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)

    expect(elapsed()).toBe(20 * MINUTE)
  })

  it('still stops on a failed service status when its own wait ran out before the operation reported, and pins', async () => {
    // A long migration leaves the update 7 minutes, and it takes 10.
    run.addJob('db-migrate', { runs: 40 * MINUTE })
    run.addService('app', containers(OLD))
    run.plan('app', { lands: 10 * MINUTE, terminal: 'The revision cannot be scheduled.' })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Revision app-00002-abc of app failed and will not become ready: The revision cannot be scheduled\./)
    expect(error.message).toContain(BACK_ON_APP)
  })

  // Retry conditions came and went on healthy and stuck revisions alike, so no
  // rule reads them: the same revision gets the same answer with or without one.
  const RETRY = { type: 'Retry', state: 'CONDITION_RECONCILING', reason: 'IMMEDIATE_RETRY', message: 'System will retry after 00:30.' }
  const stuck = STILL_TRYING.filter(condition => condition.type !== 'Retry')

  it.each([['without', []], ['with', [RETRY]]])('waits for a stuck revision %s a Retry condition', async (_, retry) => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE, conditions: [...stuck, ...retry] } })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
  })

  it.each([['without', []], ['with', [RETRY]]])('fails a doomed revision %s a Retry condition, and pins', async (_, retry) => {
    run.addService('app', containers(OLD))
    const fatal = { type: 'ContainerReady', state: 'CONDITION_FAILED', reason: 'CONTAINER_MISSING', message: 'Image not found.' }
    run.plan('app', { stalls: { conditions: [...stuck, fatal, ...retry] } })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Revision app-00002-abc of app failed and will not become ready: Image not found\./)
    expect(error.message).toContain(BACK_ON_APP)
  })

  it.each([
    ['HEALTH_CHECK_CONTAINER_ERROR', { revisionReason: 'HEALTH_CHECK_CONTAINER_ERROR' }],
    ...[
      'CONTAINER_MISSING',
      'CONTAINER_PERMISSION_DENIED',
      'CONTAINER_IMAGE_UNAUTHORIZED',
      'CONTAINER_IMAGE_AUTHORIZATION_CHECK_FAILED',
      'SECRETS_ACCESS_CHECK_FAILED',
      'ENCRYPTION_KEY_PERMISSION_DENIED',
      'ENCRYPTION_KEY_CHECK_FAILED',
      'VPC_NETWORK_NOT_FOUND',
      'REVISION_FAILED'
    ].map(reason => [reason, { reason }])
  ])('stops at once on %s, pins the service back, and gives the condition\'s message', async (_, why) => {
    run.addService('app', containers(OLD))
    const fatal = { type: 'ContainerReady', state: 'CONDITION_FAILED', message: 'It cannot start.', ...why }
    // Even if the verdict were wrong and it became ready later, the pin keeps
    // an unrecorded release from going live.
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE, conditions: [...stuck, fatal] } })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Revision app-00002-abc of app failed and will not become ready: It cannot start\./)
    // No sleep: the first look was enough.
    expect(elapsed()).toBeLessThan(READINESS_DEADLINE_MS + MINUTE)
    expect(run.pins()).toHaveLength(1)
    expect(run.service('app').traffic).toEqual([{ type: PINNED, revision: 'app-00001-abc', percent: 100 }])
    expect(error.message).not.toContain('may still become ready')
  })

  it.each([
    ['a condition that has not failed', { type: 'ContainerReady', state: 'CONDITION_RECONCILING', reason: 'CONTAINER_MISSING' }],
    ['a Retry condition', { type: 'Retry', state: 'CONDITION_FAILED', reason: 'REVISION_FAILED' }]
  ])('counts no fatal reason on %s', async (_, condition) => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE, conditions: [...stuck, { message: 'x', ...condition }] } })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
  })

  it('stops at once, and pins nothing, when another update supersedes it during the wait', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { supersededAfter: 20 * MINUTE } })

    await expect(deploy()).rejects.toThrow(/app: another update reached the service while this deploy waited/)
    expect(elapsed()).toBe(20 * MINUTE)
    expect(run.pins()).toHaveLength(0)
  })
})

describe('reading the service', () => {
  // A read changes nothing, so only an answer that cannot change ends a wait.
  // INTERNAL, RESOURCE_EXHAUSTED and UNKNOWN (what grpc-js reports when a
  // credential refresh fails) are passing for a read, whatever the mutation
  // retry makes of them.
  it.each([
    [14, 'UNAVAILABLE'],
    [13, 'INTERNAL'],
    [8, 'RESOURCE_EXHAUSTED'],
    [2, 'UNKNOWN'],
    [4, 'DEADLINE_EXCEEDED']
  ])('keeps polling through a %i %s blip during a stall, and lands', async (code, name) => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE } })
    run.failReads(grpcError(code, `${code} ${name}: blip`), { after: 15 * MINUTE, lasting: 15 * 1000 })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
    expect(infos()).toContainEqual(expect.stringContaining(`(could not read it: ${code} ${name}: blip)`))
  })

  it('keeps polling through a network error with no gRPC code', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE } })
    run.failReads(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), { after: 15 * MINUTE, lasting: 15 * 1000 })

    await expect(deploy()).resolves.toEqual(NORMAL_RESULT)
  })

  it.each([
    [3, 'INVALID_ARGUMENT'],
    [5, 'NOT_FOUND'],
    [7, 'PERMISSION_DENIED'],
    [16, 'UNAUTHENTICATED']
  ])('fails at once, pinning nothing, on a %i %s, since the rollout\'s state is unknown', async (code, name) => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 30 * MINUTE } })
    const failed = grpcError(code, `${code} ${name}: no`)
    run.failReads(failed, { after: 20 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toBe(
      `app: could not read the service while waiting for its rollout (${code} ${name}: no). The ` +
      "rollout's state is unknown: its new revision may still land, and nothing would record it. Nothing was " +
      'pinned, since that could take the service off a release that did land. Check what the services are serving.'
    )
    expect(error.cause).toBe(failed)
    expect(elapsed()).toBe(20 * MINUTE)
    expect(run.pins()).toHaveLength(0)
  })

  it('fails at once on an error with no gRPC code that is not a network error, a bug of ours', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 30 * MINUTE } })
    run.failReads(new TypeError('Cannot read properties of undefined'), { after: 20 * MINUTE })

    await expect(deploy()).rejects.toThrow(/^app: could not read the service while waiting for its rollout \(Cannot read/)
    expect(run.pins()).toHaveLength(0)
  })

  it('names the services that already landed when a later one\'s read fails for good', async () => {
    run.addService('app', containers(OLD))
    run.addService('worker', containers(OLD))
    run.plan('worker', { stalls: { readyAfter: 30 * MINUTE } })
    run.failReads(grpcError(7, '7 PERMISSION_DENIED: no'), { after: 20 * MINUTE })

    await expect(deploy()).rejects.toThrow(/Nothing was pinned, .* app already landed on the new release, and stays there\./)
    expect(run.pins()).toHaveLength(0)
  })
})

describe('a rollout that ends short, and is stopped', () => {
  // Two services on the same image, the shape of the apps that run a web
  // service and a worker.
  function webAndWorker () {
    run.addService('app', containers(OLD))
    run.addService('worker', containers(OLD))
  }

  const pinOf = (short, revision) => {
    const [update] = run.updates().filter(({ request }) => request.service.name.endsWith(`/${short}`))
    return {
      service: {
        name: `projects/${PROJECT}/locations/us-central1/services/${short}`,
        // The value this deploy's own update sent that service.
        template: { annotations: { [FORCE_REVISION]: update.request.service.template.annotations[FORCE_REVISION] } },
        traffic: [{ type: PINNED, revision, percent: 100 }]
      },
      updateMask: { paths: ['traffic', 'template.annotations'] }
    }
  }

  it('pins every service this deploy moved back by name at the bound, and fails naming the pins', async () => {
    webAndWorker()
    run.plan('worker', { stalls: {} })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Cloud Run did not finish rolling out revision worker-00002-abc of worker within 42m \d+s/)
    expect(error.message).toContain(`(${RETRYING})`)
    expect(error.message).toContain(
      'all traffic is pinned: app to revision app-00001-abc, worker to revision worker-00001-abc. ' +
      'The new revision may still become ready, but it will get no traffic. The next deploy releases the pin, ' +
      `because every deploy sends all traffic to the latest revision. ${MIGRATION_NOTE}`
    )
    // The waiting stopped with the pin reserve still in hand.
    expect(elapsed()).toBeLessThanOrEqual(ROLLOUT_BUDGET_MS - PIN_RESERVE_MS + 30 * 1000)
    // The earlier service had landed, and is back on the release before it.
    expect(run.service('app').traffic).toEqual([{ type: PINNED, revision: 'app-00001-abc', percent: 100 }])
  })

  it('pins by short name, sending back each service\'s own force-revision value, so no copy revision is made', async () => {
    webAndWorker()
    run.plan('worker', { stalls: {} })

    await failure(deploy())

    // One call each: traffic plus the template's annotations, nothing else.
    expect(run.pins().map(({ request }) => request)).toEqual([
      pinOf('app', 'app-00001-abc'),
      pinOf('worker', 'worker-00001-abc')
    ])
    const [appValue, workerValue] = run.pins().map(({ request }) => request.service.template.annotations[FORCE_REVISION])
    expect(appValue).not.toBe(workerValue)
    // Only this deploy's revision on each: the pins minted none.
    expect(run.revisionCount('app')).toBe(2)
    expect(run.revisionCount('worker')).toBe(2)
  })

  it('pins back the earlier services when a later one\'s operation fails, and the failed one too', async () => {
    webAndWorker()
    const failed = grpcError(9, 'Container failed to become healthy. Startup probes timed out after 4m.')
    run.plan('worker', { fails: failed })

    const error = await failure(deploy())

    expect(error.cause).toBe(failed)
    // Which one failed, and no word of it becoming ready: it has failed for good.
    expect(error.message).toMatch(/^worker: Container failed to become healthy\. Startup probes timed out after 4m\. /)
    expect(error.message).toContain('all traffic is pinned: app to revision app-00001-abc, worker to revision worker-00001-abc.')
    expect(error.message).not.toContain('may still become ready')
    // No polling after a failed operation.
    expect(run.reads.getRevision).toBe(1)
  })

  it('pins back only the earlier services when a later update is refused, since that one never moved', async () => {
    webAndWorker()
    const refused = grpcError(7, '7 PERMISSION_DENIED: not allowed')
    run.plan('worker', { refused })

    const error = await failure(deploy())

    expect(error.cause).toBe(refused)
    expect(error.message).toMatch(/^worker: 7 PERMISSION_DENIED: not allowed /)
    expect(error.message).toContain(BACK_ON_APP)
    expect(run.pins().map(({ request }) => request.service.name)).toEqual([`projects/${PROJECT}/locations/us-central1/services/app`])
  })

  it('names the service whose read before its update failed, and pins back the ones before it', async () => {
    run.addService('app', containers(OLD))
    run.addService('worker', containers(OLD))
    const failed = grpcError(7, '7 PERMISSION_DENIED: not allowed')
    run.failNextRead('worker', failed)

    const error = await failure(deploy())

    expect(error.message).toMatch(/^worker: could not read it before its update \(7 PERMISSION_DENIED: not allowed\)\. /)
    expect(error.message).toContain(BACK_ON_APP)
    expect(error.cause).toBe(failed)
  })

  it('throws a failure as it came when no service had moved', async () => {
    run.addService('app', containers(OLD))
    const refused = grpcError(3, '3 INVALID_ARGUMENT: bad container')
    run.plan('app', { refused })

    await expect(deploy()).rejects.toBe(refused)
    expect(run.pins()).toHaveLength(0)
  })

  it('checks a pin by the traffic setting when its operation fails, and counts it when it holds', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: {} })
    run.failPinOperations(grpcError(13, 'Deploying Revision. Something else went wrong.'))

    const error = await failure(deploy())

    expect(error.message).toContain(BACK_ON_APP)
    expect(warnings()).toContainEqual(expect.stringMatching(/traffic is pinned to app-00001-abc, though its operation did not succeed/))
  })

  it('says the pin is unknown when its operation fails and its traffic cannot be read back either', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: {} })
    run.failPinOperations(grpcError(13, 'Deploying Revision. Something else went wrong.'))
    run.failReadsOncePinned(grpcError(7, '7 PERMISSION_DENIED: not allowed'))

    await expect(deploy()).rejects.toThrow(
      'Could not pin app to revision app-00001-abc (Deploying Revision. Something else went wrong.; its traffic ' +
      'could not be read back either: 7 PERMISSION_DENIED: not allowed), so its new revision may still go live unrecorded.'
    )
  })

  it('checks the budget again after the read before an update, and leaves a service it then has no time for', async () => {
    webAndWorker()
    // app lands with a minute to spare before the pin reserve, then reading
    // worker takes two.
    run.plan('app', { stalls: { readyAfter: ROLLOUT_BUDGET_MS - PIN_RESERVE_MS - MINUTE } })
    run.slowRead('worker', 2 * MINUTE)

    const error = await failure(deploy())

    expect(error.message).toMatch(/^The rollout budget ran out before worker could be updated/)
    expect(run.updates().filter(({ request }) => request.service.name.endsWith('/worker'))).toHaveLength(0)
  })

  it('reads a pin back again through an INTERNAL blip, and counts it when it holds', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: {} })
    run.failPinOperations(grpcError(13, 'Deploying Revision. Something else went wrong.'))
    run.failReadsOncePinned(grpcError(13, '13 INTERNAL: blip'), 1)

    const error = await failure(deploy())

    expect(error.message).toContain(BACK_ON_APP)
    expect(warnings()).toContainEqual(expect.stringMatching(/traffic is pinned to app-00001-abc/))
  })

  it('names what serves as the revision to pin back to, not a later one that never served', async () => {
    pinnedAfterAStall(`${REPO}@sha256:unrecorded`)
    run.plan('app', { stalls: {} })

    await expect(deploy()).rejects.toThrow(/all traffic is pinned: app to revision app-00001-abc\./)
  })

  it('reads each service right before its update, so a revision from elsewhere is never taken for ours', async () => {
    // While app waits out a stall, another update gives worker revision 00002.
    // Worker's own update then loses its answer and is ABORTED on the replay,
    // so the first look comes before its revision exists: 00002 must count as
    // "before", not as ours.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    webAndWorker()
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE } })
    run.updateFromElsewhere('worker', 10 * MINUTE)
    run.plan('worker', { lands: MINUTE, abortedReplay: true, createdAfter: 20 * 1000 })

    await deploy()

    expect(infos()).toContainEqual(expect.stringMatching(/services\/worker: revision worker-00003-abc is ready and serves all traffic/))
    expect(infos()).not.toContainEqual(expect.stringMatching(/worker-00002-abc is ready and serves all traffic/))
  })

  it('pins back to what served right before the update, a revision from elsewhere included', async () => {
    webAndWorker()
    run.plan('app', { stalls: { readyAfter: 20 * MINUTE } })
    run.updateFromElsewhere('worker', 10 * MINUTE)
    run.plan('worker', { stalls: {} })

    await expect(deploy()).rejects.toThrow(/app to revision app-00001-abc, worker to revision worker-00002-abc\./)
  })

  it('says the new revision may still go live unrecorded when a pin fails, and how to pin it by hand', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: {} })
    run.failPins(grpcError(7, '7 PERMISSION_DENIED: not allowed'))

    await expect(deploy()).rejects.toThrow(
      'Could not pin app to revision app-00001-abc (7 PERMISSION_DENIED: not allowed), so its new revision may ' +
      'still go live unrecorded. Pin it by hand: gcloud run services update-traffic app ' +
      `--to-revisions=app-00001-abc=100 --region=us-central1 --project=${PROJECT}`
    )
  })

  it('fails without a pin on a first deploy, when nothing was ready before it', async () => {
    run.addService('app', containers(OLD), { ready: false })
    run.plan('app', { stalls: {} })

    const error = await failure(deploy())

    expect(error.message).toContain(
      'app had no ready revision before this deploy (a first deploy), so there is nothing to pin it to. ' +
      'If its new revision becomes ready, it will take the traffic with nothing recording it.'
    )
    expect(error.message).not.toContain('all traffic is pinned')
    expect(run.pins()).toHaveLength(0)
  })

  it('shares one budget between the services, so a slow first one leaves less time for the next', async () => {
    webAndWorker()
    run.plan('app', { stalls: { readyAfter: 40 * MINUTE } })
    run.plan('worker', { lands: 3 * MINUTE })

    const error = await failure(deploy())

    const [appUpdate, workerUpdate] = run.updates()
    expect(appUpdate.options.longrunning.totalTimeoutMillis).toBe(ROLLOUT_BUDGET_MS - PIN_RESERVE_MS)
    // What app left: 45 minutes, less its 40, less the pin reserve.
    expect(workerUpdate.options.longrunning.totalTimeoutMillis).toBe(2 * MINUTE)
    expect(error.message).toMatch(/^Cloud Run did not finish rolling out revision worker-00002-abc of worker within 42m 0s of this deploy's first update/)
    expect(error.message).toContain('app to revision app-00001-abc, worker to revision worker-00001-abc')
  })

  it('leaves a service it has no time for untouched', async () => {
    webAndWorker()
    // app lands on the last look before the pin reserve, leaving worker nothing.
    run.plan('app', { stalls: { readyAfter: ROLLOUT_BUDGET_MS - PIN_RESERVE_MS } })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^The rollout budget ran out before worker could be updated, so it was left as it was/)
    expect(error.message).toContain(BACK_ON_APP)
    expect(run.requests.filter(({ request }) => request.service.name.endsWith('/worker'))).toHaveLength(0)
  })

  it('never runs past the 50-minute step cap, even after a long migration', async () => {
    run.addJob('db-migrate', { runs: 30 * MINUTE })
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: {} })

    await expect(deploy()).rejects.toThrow(/all traffic is pinned: app to revision app-00001-abc/)

    // The budget would run to 30 + 45 = 75 minutes; the cap ends it at 50, and
    // the wait at 50 less the pin reserve.
    expect(STEP_CAP_MS).toBe(50 * MINUTE)
    const [update] = run.updates()
    expect(update.options.longrunning.totalTimeoutMillis).toBe(STEP_CAP_MS - 30 * MINUTE - PIN_RESERVE_MS)
    expect(elapsed()).toBeGreaterThanOrEqual(STEP_CAP_MS - PIN_RESERVE_MS)
    expect(elapsed()).toBeLessThanOrEqual(STEP_CAP_MS)
  })
})

describe('a rollback', () => {
  it('waits in full, and records a late landing as a normal success', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: { readyAfter: 25 * MINUTE } })

    await expect(rollback()).resolves.toEqual(NORMAL_RESULT)
  })

  it('never pins at the bound, and says its revision may still go live unrecorded', async () => {
    run.addService('app', containers(OLD))
    run.plan('app', { stalls: {} })

    const error = await failure(rollback())

    expect(error.message).toMatch(/^Cloud Run did not finish rolling out revision app-00002-abc of app within 42m/)
    expect(error.message).toContain(
      'This deploy does not stop a rollout (a rollback), so nothing was pinned: pinning would send traffic back ' +
      'to the release it is rolling back from. Its new revision may still go live, and nothing will record it. ' +
      'Check what the services are serving.'
    )
    expect(run.pins()).toHaveLength(0)
  })

  it('never pins the earlier services when a later one fails', async () => {
    run.addService('app', containers(OLD))
    run.addService('worker', containers(OLD))
    run.plan('worker', { fails: grpcError(9, 'Container failed to become healthy.') })

    const error = await failure(rollback())

    expect(error.message).toMatch(/^worker: Container failed to become healthy\. This deploy does not stop a rollout/)
    expect(run.pins()).toHaveLength(0)
  })
})

describe('traffic on every update', () => {
  it('sends all traffic to the latest revision with traffic in the mask, and passes every container through', async () => {
    run.addService('app', containers(OLD))
    run.addService('worker', containers(OLD))

    await deploy()

    expect(run.requests).toHaveLength(2)
    for (const { request } of run.requests) {
      expect(request.service.traffic).toEqual([{ type: LATEST, percent: 100 }])
      expect(request.updateMask.paths).toEqual(['template.containers', 'template.annotations', 'traffic'])
      // The app container gets the new image; the sidecar goes through as it was.
      expect(request.service.template.containers).toEqual([
        { name: 'app', image: NEW, ports: [{ containerPort: 8080 }], env: [{ name: 'FOO', value: 'bar' }] },
        SIDECAR
      ])
    }
  })

  it('releases a pin on the next deploy, and the resolver then reports the new image', async () => {
    const STUCK = `${REPO}@sha256:stuck`
    serveRegistry(requestMock, {
      images: [
        { uri: OLD, tags: ['candidate-1'] },
        { uri: STUCK, tags: ['candidate-2'] },
        { uri: NEW, tags: ['candidate-3'] }
      ]
    })
    pinnedAfterAStall(STUCK)
    const resolve = () => resolveCloudRun({ mode: 'environment', projectName: 'example-app', runtimeProject: PROJECT })
    await expect(resolve()).resolves.toMatchObject({ image: OLD })

    await deploy()

    // One call, template and LATEST together: exactly one new revision, and
    // it takes all the traffic.
    expect(run.requests).toHaveLength(1)
    expect(run.requests[0].request.service.traffic).toEqual([{ type: LATEST, percent: 100 }])
    expect(run.revisionCount('app')).toBe(3)
    expect(run.service('app').trafficStatuses).toEqual([{ type: LATEST, revision: 'app-00003-abc', percent: 100 }])
    await expect(resolve()).resolves.toEqual({ image: NEW, digest: 'sha256:new', tags: ['candidate-3'] })
  })
})
