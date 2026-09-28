// A fake Cloud Run for the deploy's rollout tests. It stands in for the client
// library, so the real src/gcp.js runs against it: the request updateService
// builds, the rule that stops a replay, the bound on an operation, the reads
// and the pin all go through the code that ships.
//
// It copies what a trial against the real API showed:
//   - the readiness deadline fails the operation with code 13 and a message,
//     and nothing else;
//   - the operation's metadata, when the RPC returns, already carries the new
//     generation and still names the OLD latest created revision;
//   - the v2 API never shows the force-revision annotation, on the template or
//     on a revision;
//   - a stuck revision reads as still trying (STILL_TRYING), and as retired
//     once the traffic is pinned away from it;
//   - trafficStatuses lags a change to the traffic setting (STATUS_LAG_MS, or
//     statusLagMs), and only such a change: an update that keeps LATEST shows
//     at once;
//   - traffic entries take a revision's short name, and refuse a full path
//     with code 3;
//   - an update that leaves the force-revision value out of its request reads
//     as a template change, and makes a copy of the current revision;
//   - observedGeneration always matches generation.
//
// Time is the faked Date (vi.useFakeTimers({ toFake: ['Date'] })), so gcp.js's
// own bound on an operation, the deploy's rollout budget and this fake share
// one clock, and a wait of forty minutes runs in no time. `advance` moves it.
//
// Each update of a service follows the next plan queued for it with `plan`:
//   { lands: ms }                  the revision is ready ms after the update,
//                                  and the operation succeeds then (the
//                                  default, 30 seconds)
//   { lands, retiredFor: ms }      ... but the revision reads as retired (and
//                                  Ready) for ms after the update
//   { lands, reconcilingFor: ms }  ... but the service reads as reconciling
//                                  for ms after the update
//   { lands, terminal }            ... and until then the service reads as
//                                  failed with this message, done reconciling
//   { lands, metadataGeneration: n } ... and the operation's metadata carries
//                                  this generation (0: unset, as it decodes)
//   { lands, supersededAfter: ms } ... and another update reaches the service
//                                  ms after this one; the operation still
//                                  succeeds, returning the newer service
//   { lands, abortedReplay: true, createdAfter: ms, laggingReads: n }
//                                  the RPC is accepted but its answer is lost
//                                  (UNAVAILABLE), the replay is ABORTED, the
//                                  revision is created ms after the update,
//                                  and the next n reads show the service as it
//                                  was before the update
//   { stalls: { readyAfter } }     the operation fails on the readiness
//                                  deadline after 14 minutes, while Cloud Run
//                                  keeps trying: the revision becomes ready
//                                  readyAfter ms after the update (left out:
//                                  never)
//   { stalls: { conditions } }     ... reporting these conditions until then
//   { stalls: { terminal } }       ... with this message on the failed
//                                  terminalCondition in place of the deadline's
//   { stalls: { supersededAfter } } ... and another update reaches the service
//   { fails: error }               the operation fails with this error
//   { refused: error }             the RPC is refused with this error, and
//                                  nothing changes
// A pin (an update without new containers) succeeds, unless failPins was given
// an error (the RPC is refused) or failPinOperations one (the pin is taken, but
// its operation fails). `updateFromElsewhere` schedules an update from outside
// the deploy. `failReads` makes GetService fail for a while, and
// `failReadsOncePinned` from the first pin on (for the next n reads, if given). `slowRead` makes the next read
// of a service take that long, and `failNextRead` fail with an error.
import { vi } from 'vitest'

export const MINUTE = 60 * 1000
export const READINESS_DEADLINE_MS = 14 * MINUTE
export const STATUS_LAG_MS = 30 * 1000
export const DEADLINE_MESSAGE = 'Deploying Revision. Resource readiness deadline exceeded.'
export const LATEST = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'
export const PINNED = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'
const FORCE_REVISION = 'client.knative.dev/force-revision'
const RETRYING = 'Retrying container health check; still waiting to become healthy...'

export const advance = ms => vi.setSystemTime(Date.now() + ms)

const shortName = name => name.split('/').pop()

// What gax raises when an operation fails on the readiness deadline.
export function readinessDeadline () {
  return Object.assign(new Error(DEADLINE_MESSAGE), { code: 13 })
}

// How the stuck revision read in the trial while Cloud Run kept trying it.
export const STILL_TRYING = [
  { type: 'Ready', state: 'CONDITION_RECONCILING', message: RETRYING },
  { type: 'ContainerHealthy', state: 'CONDITION_RECONCILING', message: RETRYING },
  { type: 'Retry', state: 'CONDITION_SUCCEEDED', reason: 'WAITING_FOR_OPERATION' }
]
// The same, with the deadline's message on its Ready condition.
export const DEADLINE_ON_READY = [
  { type: 'Ready', state: 'CONDITION_FAILED', message: DEADLINE_MESSAGE },
  ...STILL_TRYING.slice(1)
]

const READY = [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }]
const DEPLOYING = [{ type: 'Ready', state: 'CONDITION_RECONCILING', message: 'Deploying revision.' }]
const RETIRED = [{ type: 'Ready', state: 'CONDITION_SUCCEEDED', revisionReason: 'RETIRED' }]
const PINNED_AWAY = { type: 'Active', state: 'CONDITION_FAILED', revisionReason: 'RETIRED' }

// A Long, the shape an int64 can arrive in.
const long = value => ({ low: value, high: 0, unsigned: false, toString: () => String(value) })

export function fakeCloudRun ({ project = 'example-stage', statusLagMs = STATUS_LAG_MS } = {}) {
  const services = new Map()
  const jobs = []
  const plans = new Map()
  const requests = []
  const reads = { getService: 0, getRevision: 0 }
  let pinFailure = null
  let pinOperationFailure = null
  let readFailure = null
  let pinnedReadFailure = null
  const slowReads = new Map()
  const failingReads = new Map()

  const fullName = short => `projects/${project}/locations/us-central1/services/${short}`
  const serviceOf = short => services.get(fullName(short))

  function addRevision (service, fields) {
    const id = String(service.revisions.length + 1).padStart(5, '0')
    const revision = {
      name: `${service.name}/revisions/${shortName(service.name)}-${id}-abc`,
      containers: structuredClone(service.template.containers),
      readyAt: Date.now(),
      reportsAt: -Infinity,
      retiredUntil: -Infinity,
      reconcilingUntil: -Infinity,
      conditions: READY,
      ...fields
    }
    service.revisions.push(revision)
    return revision
  }

  // Traffic as set, with the time it was set, so trafficStatuses can lag a
  // change. Setting what is already set is no change.
  function route (service, traffic, at = Date.now()) {
    const current = service.routes[service.routes.length - 1]?.traffic
    if (JSON.stringify(current) === JSON.stringify(traffic)) return
    service.routes.push({ at, traffic: structuredClone(traffic) })
  }

  // A service Terraform made, whose first revision is ready unless
  // ready: false (a service that has never had a ready revision).
  function addService (short, containers, { ready = true } = {}) {
    const service = {
      name: fullName(short),
      generation: 1,
      template: { containers: structuredClone(containers), forceRevision: 'terraform' },
      routes: [],
      revisions: [],
      scheduled: [],
      lagging: null
    }
    services.set(service.name, service)
    route(service, [{ type: LATEST, percent: 100 }], -Infinity)
    addRevision(service, ready
      ? { readyAt: -Infinity }
      : { readyAt: Infinity, terminal: 'The container failed to start.', conditions: [{ type: 'Ready', state: 'CONDITION_FAILED', message: 'The container failed to start.' }] })
    return service.name
  }

  // An earlier deploy's revision of `short`, ready since long ago.
  function addReadyRevision (short, containers) {
    const service = serviceOf(short)
    service.generation += 1
    service.template = { containers: structuredClone(containers), forceRevision: 'earlier' }
    return addRevision(service, { readyAt: -Infinity }).name
  }

  // Traffic pinned to one revision, long ago, the way a deploy that ran out of
  // time left it.
  function pinTo (short, revision) {
    const service = serviceOf(short)
    service.generation += 1
    route(service, [{ type: PINNED, revision: shortName(revision), percent: 100 }], -Infinity)
  }

  function addJob (short, { runs = MINUTE } = {}) {
    jobs.push({
      name: `projects/${project}/locations/us-central1/jobs/${short}`,
      runs,
      template: { template: { containers: [{ image: 'placeholder', env: [] }] } }
    })
  }

  function plan (short, ...queued) {
    plans.set(fullName(short), [...(plans.get(fullName(short)) ?? []), ...queued])
  }

  function settle () {
    for (const service of services.values()) {
      const due = service.scheduled.filter(event => event.at <= Date.now())
      service.scheduled = service.scheduled.filter(event => event.at > Date.now())
      for (const event of due) event.apply()
    }
  }

  const newest = (revisions, when) => [...revisions].reverse().find(revision => revision.readyAt <= when)
  const trafficAt = (service, when) => [...service.routes].reverse().find(entry => entry.at <= when).traffic
  const currentTraffic = service => service.routes[service.routes.length - 1].traffic

  function snapshot (service) {
    settle()
    const now = Date.now()
    const created = service.revisions[service.revisions.length - 1]
    const ready = newest(service.revisions, now)
    const terminal = terminalCondition(created, now)
    return {
      name: service.name,
      generation: String(service.generation),
      observedGeneration: String(service.generation),
      reconciling: terminal.state === 'CONDITION_RECONCILING' || created.reconcilingUntil > now,
      // The v2 API never shows the force-revision annotation.
      template: { containers: structuredClone(service.template.containers), annotations: {} },
      traffic: structuredClone(currentTraffic(service)),
      trafficStatuses: trafficStatuses(service, now),
      latestCreatedRevision: created.name,
      latestReadyRevision: ready?.name ?? '',
      terminalCondition: terminal
    }
  }

  // A stall reads as reconciling until its operation reports, then as failed.
  function terminalCondition (created, now) {
    if (created.readyAt <= now) return { type: 'Ready', state: 'CONDITION_SUCCEEDED' }
    if (created.terminal && created.reportsAt <= now) {
      return { type: 'Ready', state: 'CONDITION_FAILED', message: created.terminal }
    }
    return { type: 'Ready', state: 'CONDITION_RECONCILING', message: 'Deploying revision.' }
  }

  // What traffic Cloud Run routes: the traffic setting as it was statusLagMs
  // ago. LATEST routes to the revision that is the latest ready now.
  function trafficStatuses (service, now) {
    const traffic = trafficAt(service, now - statusLagMs)
    if (traffic.every(target => target.type === LATEST)) {
      const ready = newest(service.revisions, now)
      return ready ? [{ type: LATEST, revision: shortName(ready.name), percent: 100 }] : []
    }
    return traffic.map(({ type, revision, percent }) => ({ type, revision, percent }))
  }

  function revisionFor (planned, sentAt) {
    if (planned.stalls) {
      return {
        readyAt: sentAt + (planned.stalls.readyAfter ?? Infinity),
        reportsAt: sentAt + READINESS_DEADLINE_MS,
        conditions: planned.stalls.conditions ?? STILL_TRYING,
        terminal: planned.stalls.terminal ?? DEADLINE_MESSAGE
      }
    }
    if (planned.fails) {
      return {
        readyAt: Infinity,
        conditions: [{ type: 'Ready', state: 'CONDITION_FAILED', message: planned.fails.message }],
        terminal: planned.fails.message
      }
    }
    return {
      readyAt: sentAt + planned.lands,
      retiredUntil: sentAt + (planned.retiredFor ?? -Infinity),
      reconcilingUntil: sentAt + (planned.reconcilingFor ?? -Infinity),
      terminal: planned.terminal,
      conditions: DEPLOYING
    }
  }

  // The long-running operation. It takes as long as the plan says, unless the
  // caller bounded its wait for less, when it fails the way gax does.
  async function operation (planned, service, options) {
    const takes = planned.stalls ? READINESS_DEADLINE_MS : planned.lands ?? 0
    const limit = options?.longrunning?.totalTimeoutMillis ?? Infinity
    if (limit < takes) {
      advance(limit)
      throw Object.assign(new Error('Total timeout exceeded before any response was received'), { code: 4 })
    }
    advance(takes)
    if (planned.fails) throw planned.fails
    if (planned.stalls) throw readinessDeadline()
    return [snapshot(service)]
  }

  // Another update, from outside this deploy.
  function supersede (service) {
    service.generation += 1
    service.template = { ...service.template, forceRevision: 'another-update' }
    addRevision(service, { readyAt: Date.now() + 30 * 1000, conditions: DEPLOYING })
  }

  const accepted = (service, created, promise, generation = service.generation) =>
    Promise.resolve([{ metadata: { name: service.name, generation: long(generation), latestCreatedRevision: created }, promise }])

  // An update without new containers: the pin.
  function trafficUpdate (service, request) {
    if (pinFailure) return Promise.reject(pinFailure)
    const created = service.revisions[service.revisions.length - 1].name
    service.generation += 1
    // Left out of the request, the hidden value is dropped, and the template
    // reads as changed: Cloud Run makes a copy of the current revision.
    const forceRevision = request.updateMask.paths.includes('template.annotations')
      ? request.service.template?.annotations?.[FORCE_REVISION]
      : undefined
    if (forceRevision !== service.template.forceRevision) {
      service.template = { ...service.template, forceRevision }
      addRevision(service, {})
    }
    route(service, request.service.traffic)
    const failure = pinOperationFailure
    return accepted(service, created, async () => {
      if (failure) throw failure
      return [snapshot(service)]
    })
  }

  function updateService (request, options) {
    requests.push({ request: structuredClone(request), options })
    const fullPath = (request.service.traffic ?? []).find(target => target.revision?.includes('/'))
    if (fullPath) {
      return Promise.reject(Object.assign(new Error(`3 INVALID_ARGUMENT: bad revision ${fullPath.revision}`), { code: 3 }))
    }
    const service = services.get(request.service.name)
    if (!request.updateMask.paths.includes('template.containers')) return trafficUpdate(service, request)
    if (service.replaying) {
      service.replaying = false
      return Promise.reject(Object.assign(new Error('10 ABORTED: Resource is being modified.'), { code: 10 }))
    }

    const planned = (plans.get(service.name) ?? []).shift() ?? { lands: 30 * 1000 }
    if (planned.refused) return Promise.reject(planned.refused)
    const sentAt = Date.now()
    const before = snapshot(service)
    const created = service.revisions[service.revisions.length - 1].name
    service.generation += 1
    service.template = {
      containers: structuredClone(request.service.template.containers),
      forceRevision: request.service.template.annotations?.[FORCE_REVISION]
    }
    if (request.updateMask.paths.includes('traffic')) route(service, request.service.traffic)
    if (planned.createdAfter !== undefined) {
      service.scheduled.push({ at: sentAt + planned.createdAfter, apply: () => addRevision(service, revisionFor(planned, sentAt)) })
    } else {
      addRevision(service, revisionFor(planned, sentAt))
    }
    if (planned.laggingReads) service.lagging = { snapshot: before, reads: planned.laggingReads }
    const supersededAfter = planned.supersededAfter ?? planned.stalls?.supersededAfter
    if (supersededAfter !== undefined) {
      service.scheduled.push({ at: sentAt + supersededAfter, apply: () => supersede(service) })
    }
    if (planned.abortedReplay) {
      service.replaying = true
      return Promise.reject(Object.assign(new Error('14 UNAVAILABLE: The service is currently unavailable.'), { code: 14 }))
    }
    return accepted(service, created, () => operation(planned, service, options), planned.metadataGeneration)
  }

  function getService ({ name }) {
    reads.getService += 1
    if (slowReads.has(name)) {
      advance(slowReads.get(name))
      slowReads.delete(name)
    }
    if (failingReads.has(name)) {
      const error = failingReads.get(name)
      failingReads.delete(name)
      return Promise.reject(error)
    }
    const now = Date.now()
    if (readFailure && readFailure.from <= now && now < readFailure.until) return Promise.reject(readFailure.error)
    if (pinnedReadFailure?.reads > 0 && requests.some(({ request }) => !request.updateMask.paths.includes('template.containers'))) {
      pinnedReadFailure.reads -= 1
      return Promise.reject(pinnedReadFailure.error)
    }
    const service = services.get(name)
    if (service.lagging?.reads > 0) {
      service.lagging.reads -= 1
      return Promise.resolve([structuredClone(service.lagging.snapshot)])
    }
    return Promise.resolve([snapshot(service)])
  }

  function revisionView (service, revision, now) {
    if (revision.retiredUntil > now) return RETIRED
    if (revision.readyAt <= now) return READY
    const traffic = currentTraffic(service)
    const pinnedAway = traffic.every(target => target.type === PINNED && target.revision !== shortName(revision.name))
    return pinnedAway ? [...revision.conditions, PINNED_AWAY] : revision.conditions
  }

  function getRevision ({ name }) {
    reads.getRevision += 1
    settle()
    const service = [...services.values()].find(entry => entry.revisions.some(revision => revision.name === name))
    const revision = service?.revisions.find(entry => entry.name === name)
    if (!revision) return Promise.reject(Object.assign(new Error(`5 NOT_FOUND: ${name}`), { code: 5 }))
    return Promise.resolve([{
      name: revision.name,
      containers: structuredClone(revision.containers),
      // Hidden by the v2 API, like the template's.
      annotations: {},
      conditions: revisionView(service, revision, Date.now())
    }])
  }

  return {
    addService,
    addReadyRevision,
    addJob,
    pinTo,
    plan,
    failPins: error => { pinFailure = error },
    failPinOperations: error => { pinOperationFailure = error },
    failReads: (error, { after = 0, lasting = Infinity } = {}) => {
      readFailure = { error, from: Date.now() + after, until: Date.now() + after + lasting }
    },
    failReadsOncePinned: (error, reads = Infinity) => { pinnedReadFailure = { error, reads } },
    slowRead: (short, ms) => slowReads.set(fullName(short), ms),
    failNextRead: (short, error) => failingReads.set(fullName(short), error),
    updateFromElsewhere: (short, after) =>
      serviceOf(short).scheduled.push({ at: Date.now() + after, apply: () => supersede(serviceOf(short)) }),
    requests,
    reads,
    // The updates this deploy sent with new containers, and the pins.
    updates: () => requests.filter(({ request }) => request.updateMask.paths.includes('template.containers')),
    pins: () => requests.filter(({ request }) => !request.updateMask.paths.includes('template.containers')),
    revisionCount: short => serviceOf(short).revisions.length,
    service: short => snapshot(serviceOf(short)),

    // The client methods, for the vi.mock of @google-cloud/run.
    listServices: () => Promise.resolve([[...services.values()].map(snapshot)]),
    getService,
    updateService,
    getRevision,
    listJobs: () => Promise.resolve([structuredClone(jobs)]),
    updateJob: ({ job }) => Promise.resolve([{ promise: async () => [job] }]),
    runJob: ({ name }) => Promise.resolve([{
      promise: async () => {
        advance(jobs.find(job => job.name === name).runs)
        return [{ name: `${name}/executions/run-1`, taskCount: 1, succeededCount: 1 }]
      }
    }])
  }
}
