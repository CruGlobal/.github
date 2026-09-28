import * as core from '@actions/core'
import {
  OperationWaitExpired,
  cloudrunGetRevision,
  cloudrunGetService,
  isReadinessDeadline,
  pinServiceTraffic,
  updateService
} from '../gcp'
import { isTransientError } from '../grpc-retry'
import { TRAFFIC_REVISION, revisionPath, servingRevision, trafficShares } from './cloudrun-traffic'
import { POLL_INTERVAL_MS, PROGRESS_INTERVAL_MS, formatDuration, progressLogger, rolloutBudget } from './rollout-budget'

// Roll new containers out to an app's Cloud Run services, one after another,
// and make sure the step's outcome is what ends up serving.
//
// An update's operation is not the whole answer. The case this module exists
// for is rare (a fraction of a percent of revisions): Google is slow to start
// a new revision's first instance, and the operation fails after about
// fourteen minutes on the readiness deadline. Cloud Run does not give up
// there, and the revision can become ready five to twenty minutes later. The
// services' traffic is one LATEST entry at 100%, so they follow the latest
// ready revision, and a release whose deploy "failed" would go live with
// nothing recording it. The other way round, an operation can also report
// success for an update that did not land: one a later update replaced, or one
// whose revision was born retired and never started. So every update is
// checked against the service itself:
//
//   - landed (see `landed` below): carry on exactly as after a normal update,
//     so every record step runs;
//   - superseded by a later update: stop at once and touch nothing, since the
//     traffic is someone else's now;
//   - a read that fails for good: stop at once and touch nothing, since what
//     the rollout did is unknown and pinning could take production off a
//     release that landed;
//   - anything else, including the readiness deadline: poll until it lands,
//     within the deploy's rollout budget (./rollout-budget.js).
//
// Every other way the rollout can end short (the budget running out, a
// revision that failed for good, an operation or RPC that failed) pins every
// service this deploy moved back to the revision that served before it, so the
// services stay on the release the records name, and fails. Only the services
// go back: the migration has already run and the jobs already run the new
// image. A rollback is the exception: it never pins (see
// `stopRolloutOnFailure`).
//
// Which revision is ours: the v2 API hides the force-revision annotation, so
// it cannot say. The generation can. The operation's metadata gives the
// generation our update moved the service to. While the service is still at
// that generation, a latest created revision other than the one before our
// update is ours; a later generation means another update replaced ours.

// What the wait keeps back from the budget for pinning traffic at the bound,
// and how long each pin's operation is given. A pin only changes traffic, so it
// should take seconds; the reserve is what keeps it inside the step's cap.
export const PIN_RESERVE_MS = 3 * 60 * 1000
const PIN_WAIT_MS = 60 * 1000
const MIN_PIN_WAIT_MS = 15 * 1000

// How often to look in the first minute after an update's operation reports.
// A pin being released (and any other change to the traffic setting) takes up
// to about 35 seconds to show in trafficStatuses, so looking every 5 seconds
// then saves most of a normal poll's wait. After that minute, the normal
// interval.
const EARLY_POLL_INTERVAL_MS = 5 * 1000
const EARLY_POLL_MS = 60 * 1000

// Staying inside the step's cap when the API is in trouble. Each look in the
// wait is ONE attempt with a short timeout (a quick read, see ../gcp.js), so a
// look takes half a minute at most and the wait's own next look is the retry.
// The one read that is not a look, the read of a service right before its
// update, keeps the shared retry (about three minutes at worst) unless the
// stop point is closer than this, and the budget is checked again after it.
// The pins then run inside the reserve, one bounded operation and quick reads
// each. Together that keeps every path to within about a minute past the cap
// for an app of one or two services; each further service this deploy moved
// can add about a minute more, since each has its pin to make.
const QUICK_READS_WITHIN_MS = 4 * 60 * 1000

// Reasons on our revision's conditions that mean it will never become ready,
// so waiting is waste. Kept short on purpose, since the stall this waits out
// could not be reproduced: a revision that is really doomed but reads as
// "still trying" costs only a wait to the bound, and the pin protects
// production. These lists are the place to adjust as real reports are seen.
const FATAL_REVISION_REASONS = ['HEALTH_CHECK_CONTAINER_ERROR']
const FATAL_COMMON_REASONS = [
  'CONTAINER_MISSING',
  'CONTAINER_PERMISSION_DENIED',
  'CONTAINER_IMAGE_UNAUTHORIZED',
  'CONTAINER_IMAGE_AUTHORIZATION_CHECK_FAILED',
  'SECRETS_ACCESS_CHECK_FAILED',
  'ENCRYPTION_KEY_PERMISSION_DENIED',
  'ENCRYPTION_KEY_CHECK_FAILED',
  'VPC_NETWORK_NOT_FOUND',
  'REVISION_FAILED'
]
// A retired revision is never taken as landed, nor as failed. It can read
// Ready: succeeded though it never started, or, when a revision still being
// tried was pinned away from, Ready: reconciling beside Active: failed, both
// with the RETIRED reason.
const RETIRED = 'RETIRED'
const READY = 'Ready'
// Retry conditions come and go on healthy and stuck revisions alike, so no
// rule reads one.
const RETRY = 'Retry'
const CONDITION_FAILED = 'CONDITION_FAILED'
const CONDITION_SUCCEEDED = 'CONDITION_SUCCEEDED'

const shortName = resource => resource.split('/').pop()

// Which read errors end a wait. grpc-retry.js's isTransientError was written
// for mutations, where only a clear blip is safe to replay, so it calls
// INTERNAL, RESOURCE_EXHAUSTED and UNKNOWN (which grpc-js reports when a
// credential refresh fails) permanent. A read changes nothing, and ending a
// wait early is what lets a stuck revision go live unrecorded, so for a read it
// is the other way round: only an answer that cannot change ends it. That is a
// bad request, a missing service, a missing permission or bad credentials, or
// an error with no gRPC code that is not a network errno, which is a bug of
// ours. Anything else is a look that saw nothing.
const READ_FAILED_FOR_GOOD_CODES = [
  3, // INVALID_ARGUMENT
  5, // NOT_FOUND
  7, // PERMISSION_DENIED
  16 // UNAUTHENTICATED
]

function readFailedForGood (error) {
  if (typeof error?.code === 'number') return READ_FAILED_FOR_GOOD_CODES.includes(error.code)
  // No gRPC code: a network errno may pass (isTransientError knows them);
  // anything else is ours.
  return !isTransientError(error)
}

// int64 fields arrive as a string, a number or a Long, depending on the path
// they took, so they are compared as numbers. A generation stays far below the
// point where that loses precision, and starts at 1, so anything else is
// unknown.
function generationOf (value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(String(value))
  return Number.isFinite(number) && number > 0 ? number : null
}

// Update each service in turn and wait for each to land. `updates` is
// [{ service, containers }], with `service` as it was listed before the deploy.
// Throws when a rollout did not land.
//
// `options.stopRolloutOnFailure` false (a rollback) never pins, on any path:
// pinning would send traffic back to the release being rolled back from, in
// the middle of an incident. It still waits in full, so a late landing is
// recorded. `options.budget` is the deploy's rollout budget; tests pass one on
// a fake clock, along with `pollIntervalMs` and `progressIntervalMs`.
export async function rollOutServices (updates, options = {}) {
  const { budget = rolloutBudget(), stopRolloutOnFailure = true, ...timing } = options
  const moved = []
  const stop = outcome => stopRollout(moved, outcome, budget, stopRolloutOnFailure)
  const outOfTime = () => budget.remaining(PIN_RESERVE_MS) <= 0
  for (const { service, containers } of updates) {
    budget.start()
    if (outOfTime()) throw await stop({ kind: 'bound', name: service.name, untouched: true })
    let current
    try {
      current = await cloudrunGetService(service.name, { quick: budget.remaining(PIN_RESERVE_MS) < QUICK_READS_WITHIN_MS })
    } catch (error) {
      throw await stop({ kind: 'failed', name: service.name, error, before: 'could not read it before its update' })
    }
    // The read may have taken a while.
    if (outOfTime()) throw await stop({ kind: 'bound', name: service.name, untouched: true })

    const update = {
      name: service.name,
      previous: previousRevision(current),
      // The latest created revision before this update: any newer one at our
      // generation is ours.
      createdBefore: current.latestCreatedRevision ? revisionPath(current, current.latestCreatedRevision) : '',
      // Sent with the update, and sent back with a pin so the pin leaves the
      // template as it is (see pinServiceTraffic in ../gcp.js).
      forceRevision: Date.now().toString()
    }
    core.info(`updating service: ${service.name} (${containers.length} container(s))`)
    const outcome = await rollOutService(update, containers, budget, timing)
    // Moved once the update was accepted. An update the RPC refused left the
    // service as it was, and pinning it would send a force-revision value its
    // template does not carry, which makes a revision.
    if (outcome.accepted) moved.push(update)
    if (!outcome.landed) throw await stop(outcome)
  }
}

// The revision to pin a service back to: the one serving right before its
// update, which is the release the records name. That is normally
// latestReadyRevision, but not after an earlier deploy ran out of time and its
// revision became ready later: that one is then the latest ready while the
// pinned one still serves, and pinning to it would put an unrecorded release
// live. Traffic split by hand has no one answer, so it falls back to
// latestReadyRevision. '' when nothing has ever been ready (a first deploy).
function previousRevision (service) {
  const serving = servingRevision(service)
  if (serving && serving !== 'split') return serving
  return service.latestReadyRevision ? revisionPath(service, service.latestReadyRevision) : ''
}

// One service: send the update, then check it against the service, however
// its operation ended, unless it ended in a way that is final. Returns
// { landed: true, accepted: true }, or how it ended short (see waitForRevision).
async function rollOutService (update, containers, budget, timing) {
  const mine = { ...update, accepted: false, generation: null, deadlineReported: false, sentAt: budget.now() }
  const onAccepted = value => {
    mine.accepted = true
    const generation = generationOf(value)
    if (generation !== null) mine.generation = generation
  }
  try {
    await updateService(update.name, containers, {
      forceRevision: update.forceRevision,
      waitMs: budget.remaining(PIN_RESERVE_MS),
      trafficToLatest: true,
      onAccepted
    })
    // Resolved, so accepted, the ABORTED-replay path included.
    mine.accepted = true
  } catch (error) {
    if (isReadinessDeadline(error)) {
      mine.deadlineReported = true
      core.warning(
        `${update.name}: ${error.message} Cloud Run keeps retrying a revision that missed its readiness deadline, ` +
        'and it may still become ready and take the traffic, so this deploy waits for it for up to ' +
        `${formatDuration(budget.remaining(PIN_RESERVE_MS))}.`
      )
    } else if (!(error instanceof OperationWaitExpired)) {
      return { kind: 'failed', name: update.name, error, accepted: mine.accepted }
    }
  }
  return waitForRevision(mine, budget, timing)
}

// Returns { landed: true, accepted: true }, or how the wait ended short:
//   { kind: 'bound', name, revision, message, accepted }   the budget ran out
//   { kind: 'failed', verdict: true, error, accepted: true } failed for good
//   { kind: 'superseded', error }                          another update won
//   { kind: 'unreadable', name, error }                    a read failed for good
async function waitForRevision (mine, budget, timing) {
  const {
    pollIntervalMs = POLL_INTERVAL_MS,
    earlyPollIntervalMs = EARLY_POLL_INTERVAL_MS,
    progressIntervalMs = PROGRESS_INTERVAL_MS
  } = timing
  const log = progressLogger(budget, progressIntervalMs)
  const reportedAt = budget.now()
  for (;;) {
    const seen = await observe(mine)
    const revision = seen.revision ? `revision ${shortName(seen.revision)}` : 'its new revision'
    if (seen.verdict === 'landed') {
      core.info(
        `${mine.name}: ${revision} is ready and serves all traffic, ` +
        `${formatDuration(budget.now() - mine.sentAt)} after its update was sent.`
      )
      return { landed: true, accepted: true }
    }
    if (seen.verdict === 'unreadable') return { kind: 'unreadable', name: mine.name, error: seen.error, accepted: mine.accepted }
    if (seen.verdict === 'superseded') return { kind: 'superseded', error: new Error(seen.message) }
    if (seen.verdict === 'failed') {
      return { kind: 'failed', verdict: true, name: mine.name, error: new Error(seen.message), accepted: true }
    }

    const left = budget.remaining(PIN_RESERVE_MS)
    if (left <= 0) {
      return { kind: 'bound', name: mine.name, revision: seen.revision, message: seen.message, accepted: mine.accepted }
    }
    log(
      `${mine.name}: waiting for ${revision} to be ready and take all the traffic (${seen.message}). ` +
      `Waited ${formatDuration(budget.now() - mine.sentAt)}, ${formatDuration(left)} left.`
    )
    const early = budget.now() - reportedAt < EARLY_POLL_MS
    await budget.sleep(Math.min(early ? earlyPollIntervalMs : pollIntervalMs, left))
  }
}

// One look at the service and, once it exists, at our revision. A read that
// fails for a passing reason is only a look that saw nothing; any other read
// error (permission, not found, a bug of ours) ends the wait as 'unreadable'.
async function observe (mine) {
  let service, latest, revision
  try {
    service = await cloudrunGetService(mine.name, { quick: true })
    latest = service.latestCreatedRevision ? revisionPath(service, service.latestCreatedRevision) : ''
    const created = Boolean(latest) && latest !== mine.createdBefore
    const generation = generationOf(service.generation)
    if (mine.generation === null) {
      // No generation from the operation: the ABORTED-replay path, or metadata
      // without one. A read can lag our write, so the generation is taken only
      // from a read that already shows a new revision.
      if (!created || generation === null) return { verdict: 'waiting', message: 'it has not been created yet' }
      mine.generation = generation
      mine.accepted = true
    }
    if (generation > mine.generation) return superseded(mine, generation)
    // An older generation is a read that lags our write.
    if (generation < mine.generation || !created) return { verdict: 'waiting', message: 'it has not been created yet' }
    // The service is at our generation and has a revision newer than the one
    // before our update: that revision is ours.
    revision = await cloudrunGetRevision(latest, { quick: true })
  } catch (error) {
    if (!readFailedForGood(error)) return { verdict: 'waiting', message: `could not read it: ${error.message}` }
    return { verdict: 'unreadable', error }
  }
  return { revision: latest, ...judge(service, revision, latest, mine) }
}

const superseded = (mine, generation) => ({
  verdict: 'superseded',
  message:
    `${shortName(mine.name)}: another update reached the service while this deploy waited (it is at ` +
    `generation ${generation}; this deploy's update made generation ${mine.generation}), so this deploy's ` +
    'revision is no longer the one rolling out. Nothing is recorded for this deploy. Check what the service ' +
    'is serving before running it again.'
})

// Called only with the service at our generation and our revision in hand.
//
// Once the operation has reported the readiness deadline, the service's own
// failed terminalCondition no longer counts for the rest of the wait: the
// stall this waits out could not be reproduced, so how the service words it is
// unknown, and it must not end the wait on the first look. Only the fatal
// reasons on our revision's conditions count then. The service-level rule
// still applies when the operation succeeded, or when our own wait ran out
// before it reported anything.
function judge (service, revision, ours, mine) {
  const conditions = revision.conditions ?? []
  const ready = conditions.find(condition => condition.type === READY)
  if (conditions.some(condition => condition.revisionReason === RETIRED)) {
    return { verdict: 'waiting', message: `it is retired${ready?.message ? `: ${ready.message}` : ''}` }
  }
  if (landed(service, ours)) return { verdict: 'landed' }
  const fatal = conditions.find(isFatal) ?? (mine.deadlineReported ? null : terminalFailure(service))
  if (fatal) return { verdict: 'failed', message: failedForGood(service, ours, fatal.message) }
  const message = ready?.message || service.terminalCondition?.message || 'it does not take all the traffic yet'
  return { verdict: 'waiting', message }
}

// Landed: at our generation (see observe), our revision is the latest ready
// one and takes all the traffic, and the service has finished reconciling
// with success. trafficStatuses is what traffic Cloud Run routes, and it lags
// a change to the traffic setting by up to about 35 seconds. observedGeneration
// says nothing here: it matched generation throughout a reconcile.
function landed (service, ours) {
  const ready = service.latestReadyRevision ? revisionPath(service, service.latestReadyRevision) : ''
  return ready === ours &&
    trafficShares(service).get(ours) === 100 &&
    service.terminalCondition?.state === CONDITION_SUCCEEDED &&
    !service.reconciling
}

// A reason counts only on a condition that has failed, never on a Retry
// condition, and never on one that names the readiness deadline, which means
// "still trying" whatever its reason says.
const isFatal = condition =>
  condition.type !== RETRY &&
  condition.state === CONDITION_FAILED &&
  !isReadinessDeadline(condition) &&
  (FATAL_REVISION_REASONS.includes(condition.revisionReason) || FATAL_COMMON_REASONS.includes(condition.reason))

function terminalFailure (service) {
  const terminal = service.terminalCondition
  const final = terminal?.state === CONDITION_FAILED && !service.reconciling && !isReadinessDeadline(terminal)
  return final ? terminal : null
}

const failedForGood = (service, ours, message) =>
  `Revision ${shortName(ours)} of ${shortName(service.name)} failed and will not become ready: ${message}`

// How a rollout that ended short fails the step, pinning first where it
// should. A failure before any service moved is thrown as it came.
async function stopRollout (moved, outcome, budget, stopRolloutOnFailure) {
  if (outcome.kind === 'superseded') return outcome.error
  if (outcome.kind === 'unreadable') {
    const landed = moved.filter(entry => entry.name !== outcome.name).map(entry => shortName(entry.name))
    return withCause(new Error(unreadable(outcome, landed)), outcome.error)
  }
  if (outcome.kind === 'failed' && moved.length === 0) return outcome.error
  const headline = headlineOf(outcome, budget)
  if (!stopRolloutOnFailure) return withCause(new Error(`${headline} ${notStopped(outcome)}`), outcome.error)

  const pins = []
  for (const { name, previous, forceRevision } of moved) {
    pins.push({ name, previous, ...(previous ? await pin(name, shortName(previous), forceRevision, budget) : {}) })
  }
  return withCause(new Error([headline, ...pinReport(pins, outcome)].join(' ')), outcome.error)
}

function withCause (error, cause) {
  if (cause) error.cause = cause
  return error
}

// A pin keeps the new revision from taking traffic. It does not stop Cloud Run
// from trying it: a stuck revision can keep an instance, or start one, for a
// while after it is pinned away from, until its own startup window runs out.
async function pin (name, revision, forceRevision, budget) {
  const waitMs = Math.max(MIN_PIN_WAIT_MS, Math.min(PIN_WAIT_MS, budget.remaining()))
  const until = budget.now() + waitMs
  try {
    await pinServiceTraffic(name, revision, forceRevision, waitMs)
    return { pinned: true }
  } catch (error) {
    // The operation reports on the whole service, stuck revision included, so
    // it can fail or run out while the pin itself was taken. The pin is the
    // service's traffic setting, so that is what decides.
    let holds
    try {
      holds = await pinHolds(name, revision, until, budget)
    } catch (readError) {
      return { pinned: false, error: new Error(`${error.message}; its traffic could not be read back either: ${readError.message}`) }
    }
    if (!holds) return { pinned: false, error }
    core.warning(`${name}: traffic is pinned to ${revision}, though its operation did not succeed (${error.message}).`)
    return { pinned: true }
  }
}

// Judged by the traffic setting, which is what the pin set, and not by
// trafficStatuses, which lags it. A read that fails for a passing reason (see
// readFailedForGood) is tried again until the pin's own time is up; any other
// read error is thrown.
async function pinHolds (name, revision, until, budget) {
  for (;;) {
    let service
    try {
      service = await cloudrunGetService(name, { quick: true })
    } catch (error) {
      if (readFailedForGood(error)) throw error
      if (budget.now() >= until) return false
      await budget.sleep(Math.min(EARLY_POLL_INTERVAL_MS, until - budget.now()))
      continue
    }
    const traffic = service.traffic ?? []
    const target = revisionPath(service, revision)
    const toTarget = traffic.every(entry =>
      entry.type === TRAFFIC_REVISION && Boolean(entry.revision) && revisionPath(service, entry.revision) === target
    )
    return toTarget && traffic.reduce((sum, entry) => sum + (entry.percent ?? 0), 0) === 100
  }
}

function headlineOf (outcome, budget) {
  const service = shortName(outcome.name)
  // A verdict's message names the revision and its service already.
  if (outcome.kind === 'failed') {
    if (outcome.verdict) return outcome.error.message
    return `${service}: ${outcome.before ? `${outcome.before} (${outcome.error.message}).` : outcome.error.message}`
  }
  if (outcome.untouched) {
    return `The rollout budget ran out before ${service} could be updated, so it was left as it was: this ` +
      'step has to stop well inside its job\'s timeout, and the migration or the services before it used the time.'
  }
  const revision = outcome.revision ? `revision ${shortName(outcome.revision)} of ` : ''
  return `Cloud Run did not finish rolling out ${revision}${service} within ` +
    `${formatDuration(budget.elapsed())} of this deploy's first update` +
    (outcome.message ? ` (${outcome.message})` : '') + '.'
}

function unreadable ({ name, error }, landed) {
  return `${shortName(name)}: could not read the service while waiting for its rollout (${error.message}). The ` +
    'rollout\'s state is unknown: its new revision may still land, and nothing would record it. Nothing was ' +
    'pinned, since that could take the service off a release that did land.' +
    (landed.length > 0 ? ` ${landed.join(', ')} already landed on the new release, and stay${landed.length === 1 ? 's' : ''} there.` : '') +
    ' Check what the services are serving.'
}

function notStopped (outcome) {
  return 'This deploy does not stop a rollout (a rollback), so nothing was pinned: pinning would send traffic ' +
    'back to the release it is rolling back from.' +
    (outcome.kind === 'bound' && !outcome.untouched
      ? ' Its new revision may still go live, and nothing will record it. Check what the services are serving.'
      : ' Check what the services are serving.')
}

// "The new revision may still become ready" is said only when one may: at the
// bound, with a revision still being tried. After a final failure (a failed
// operation, a revision that failed for good) it would mislead.
function pinReport (pins, outcome) {
  const pinned = pins.filter(entry => entry.pinned)
  const lines = []
  if (pinned.length > 0) {
    const stillTrying = outcome.kind === 'bound' && !outcome.untouched
    lines.push(
      'To keep the app on the release that was serving before this deploy, all traffic is pinned: ' +
      pinned.map(entry => `${shortName(entry.name)} to revision ${shortName(entry.previous)}`).join(', ') + '. ' +
      (stillTrying ? 'The new revision may still become ready, but it will get no traffic. ' : '') +
      'The next deploy releases the pin, because every deploy sends all traffic to the latest revision. Only the ' +
      'services go back: the database migration, if the app has one, has already run, and its jobs already run ' +
      'the new image.'
    )
  }
  for (const entry of pins.filter(entry => !entry.previous)) {
    lines.push(
      `${shortName(entry.name)} had no ready revision before this deploy (a first deploy), so there is nothing ` +
      'to pin it to. If its new revision becomes ready, it will take the traffic with nothing recording it.'
    )
  }
  for (const entry of pins.filter(entry => entry.previous && !entry.pinned)) {
    const revision = shortName(entry.previous)
    lines.push(
      `Could not pin ${shortName(entry.name)} to revision ${revision} (${entry.error.message}), so its new ` +
      `revision may still go live unrecorded. Pin it by hand: ${updateTrafficCommand(entry.name, revision)}`
    )
  }
  return lines
}

// A service's full name is projects/<project>/locations/<region>/services/<service>.
function updateTrafficCommand (name, revision) {
  const [, project, , region, , service] = name.split('/')
  return `gcloud run services update-traffic ${service} --to-revisions=${revision}=100 ` +
    `--region=${region} --project=${project}`
}
