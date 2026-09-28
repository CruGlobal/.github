import * as core from '@actions/core'
import { ecsDescribeService, ecsUpdateService, isPermanentAwsError } from '../aws'
import { POLL_INTERVAL_MS, PROGRESS_INTERVAL_MS, formatDuration, progressLogger, rolloutBudget } from './rollout-budget'

// Roll a new task definition out to an app's ECS services, one after another,
// and make sure the step's outcome is what ends up serving.
//
// UpdateService returns as soon as ECS has taken the change, long before any
// new task is healthy, and the app module does not wait either
// (wait_for_steady_state is off). If the step moved on there, every record
// step (Datadog, the ledger row, the release event, and on promote the release
// tag and GitHub Release) would run seconds later, naming a release that can
// still fail. And it can: the services run the deployment circuit breaker with
// rollback on, so a rollout whose tasks keep failing is rolled back by ECS on
// its own, minutes after the records said it shipped.
//
// What the fleet showed, read-only, for every service the v2 pipeline deploys:
// the ECS deployment controller, rolling updates, the breaker with rollback,
// minimumHealthyPercent 100 and maximumPercent 200, and a rolloutState on every
// deployment. A normal rollout takes about a minute and a half (rarely more
// than six). The breaker has tripped anywhere from under a minute to about
// fifteen minutes into a rollout. And the shapes this module reads:
//
//   - UpdateService answers with the service, whose PRIMARY deployment is the
//     one the update made. The deployments already there stay in the list as
//     ACTIVE until their tasks have drained.
//   - A rollout that lands: our deployment is PRIMARY with rolloutState
//     COMPLETED, and the ones before it have left the list.
//   - The breaker: our deployment reads FAILED, and in the same instant the
//     deployment that served before it is PRIMARY again, with its OLD id, and
//     rolls out to COMPLETED. The breaker never makes a new deployment. Ours
//     is gone from the list once that rollback has completed, which took from
//     under a minute to about seven minutes across the fleet's rollbacks, so a
//     look normally sees it FAILED first. The service events keep the reason,
//     written the moment the breaker trips:
//     "(deployment <id>) deployment failed: tasks failed to start."
//   - The rollback can fail too, when the deployment it goes back to cannot
//     start either.
//   - The breaker with nothing to go back to (a service's first deployment,
//     or one whose previous deployment never completed): ours reads FAILED and
//     stays PRIMARY.
//   - Another update: a NEW deployment id becomes PRIMARY. Ours stays ACTIVE
//     until its tasks drain, then leaves the list. An update that changes
//     something else about the service re-sends the task definition it
//     already has: a Terraform apply does, since the app module leaves the
//     task definition alone. Its new deployment then runs ours.
//
// So each look at the service decides (see `judge`):
//
//   - landed: carry on exactly as today, so every record step runs;
//   - a new PRIMARY that runs the task definition this deploy registered: it
//     is still this deploy's release rolling out, so the wait follows that
//     deployment instead, under the same rules and budget;
//   - superseded (a PRIMARY on another task definition, that is neither ours
//     nor one from before our update): stop at once and change nothing, since
//     the service is someone else's now;
//   - failed (ours reads FAILED, or it is gone, an earlier deployment is
//     PRIMARY again and the events say ours failed): ECS is rolling the
//     service back, or has nothing to roll it back to. Either way ECS owns that
//     service, and it is never sent back;
//   - a read that fails for good: stop at once and change nothing, since what
//     the rollout did is unknown;
//   - anything else: look again, within the deploy's rollout budget
//     (./rollout-budget.js).
//
// Every way the rollout ends short except "superseded" and a read that failed
// for good sends every service this deploy moved back to the task definition
// it ran before (see `stopRollout`), so the services stay on the release the
// records name, and fails. Only a service whose deployment had COMPLETED when
// this deploy started is sent back: that is the one task definition known to
// have been live.
//
// A rollback is the exception: it never sends anything back (see
// `stopRolloutOnFailure`). And it always moves the scheduled tasks to the
// release it deploys, however the rollout ends, as the Cloud Run rollback
// moves its jobs. The one exception is "superseded", where the service is
// another update's now.
//
// Capacity while a service goes back: a send-back is an UpdateService like any
// other, so ECS starts a deployment of the old task definition and stops ours.
// With minimumHealthyPercent 100 and maximumPercent 200, ECS never stops a
// healthy task before its replacement is healthy: the new tasks start first
// (up to twice the desired count) and the old ones drain only once the new ones
// pass their health checks, which is what every rollout in the fleet showed.
// So a service whose rollout stalled keeps serving from the tasks it had all
// along, and one that had landed keeps serving from its new tasks until the old
// release's are healthy again. Capacity never drops below the desired count; it
// briefly needs room for up to twice it. A service at minimumHealthyPercent 0
// would drop to nothing while it goes back, but none the pipeline deploys is.

// What the wait keeps back from the budget for the send-backs at the bound,
// and how long each ECS call is given. A send-back is one UpdateService and at
// most one quick read, so it takes seconds; the reserve keeps it inside the
// step's cap. Each further service this deploy moved can add up to about a
// minute past it, since each has its own send-back to make.
export const SEND_BACK_RESERVE_MS = 2 * 60 * 1000
const UPDATE_TIMEOUT_MS = 60 * 1000
const SEND_BACK_TIMEOUT_MS = 30 * 1000
const MIN_CALL_TIMEOUT_MS = 15 * 1000

// Most rollouts land in a minute or two, so the first minute after an update
// is looked at every 5 seconds, then every 15.
const EARLY_POLL_INTERVAL_MS = 5 * 1000
const EARLY_POLL_MS = 60 * 1000

const PRIMARY = 'PRIMARY'
const COMPLETED = 'COMPLETED'
const FAILED = 'FAILED'

// Service ARNs are …:service/<cluster>/<name>; task-definition ARNs are
// …:task-definition/<family>:<revision>.
const shortName = arn => String(arn).split('/').pop()

// Update each service in turn and wait for each to land. `updates` is
// [{ serviceArn, taskDefinitionArn, previous }], where taskDefinitionArn is the
// revision just registered and `previous` is what the service ran before this
// deploy: { taskDefinitionArn, placeholder, live, deployment, rolloutState }.
// `placeholder` is true when that was the scratch image of a service never
// deployed, and `live` when its PRIMARY deployment had COMPLETED on that task
// definition (`deployment` and `rolloutState` say what it was). Returns the
// short names of the services that landed. Throws when a rollout did not land.
//
// `options.cluster` is the cluster the services are in.
// `options.stopRolloutOnFailure` false (a rollback) never sends anything back,
// on any path: that would be the release being rolled back from, in the middle
// of an incident. It still waits in full, so a late landing is recorded.
// `options.repointScheduledTasks` moves the scheduled tasks to the release
// this deploy registered. The caller runs it once every service has landed; a
// rollback that ends short runs it here as well (see stopRollout).
// `options.budget` is the deploy's rollout budget; tests pass one on a fake
// clock, along with the poll and progress intervals.
export async function rollOutServices (updates, options = {}) {
  const { cluster, budget = rolloutBudget(), stopRolloutOnFailure = true, repointScheduledTasks, ...timing } = options
  const moved = []
  const landed = []
  const stop = outcome =>
    stopRollout({ moved, landed, outcome, cluster, budget, stopRolloutOnFailure, repointScheduledTasks })
  for (const update of updates) {
    const entry = { ...update, name: shortName(update.serviceArn) }
    budget.start()
    if (budget.remaining(SEND_BACK_RESERVE_MS) <= 0) throw await stop({ kind: 'bound', name: entry.name, untouched: true })

    core.info(`updating ECS service ${entry.name} -> ${entry.taskDefinitionArn}`)
    const sentAt = budget.now()
    let service
    try {
      service = await ecsUpdateService(entry.serviceArn, cluster, entry.taskDefinitionArn, {
        timeoutMs: callTimeout(budget, UPDATE_TIMEOUT_MS)
      })
    } catch (error) {
      // A 4xx is a refusal, so the service did not move. Anything else may have
      // reached ECS, so the service counts as moved: sending one back that did
      // not move changes nothing, since it already runs that task definition.
      if (!isPermanentAwsError(error)) moved.push(entry)
      throw await stop({ kind: 'failed', name: entry.name, error })
    }
    moved.push(entry)

    const outcome = await waitForDeployment(entry, service, sentAt, cluster, budget, timing)
    if (!outcome.landed) throw await stop(outcome)
    landed.push(entry.name)
  }
  return landed
}

// A call made near the bound gets only the time left, but never so little that
// it cannot answer.
function callTimeout (budget, maxMs) {
  return Math.max(MIN_CALL_TIMEOUT_MS, Math.min(maxMs, budget.remaining()))
}

// Returns { landed: true }, or how the wait ended short:
//   { kind: 'bound', name, id, status }            the budget ran out
//   { kind: 'failed', verdict: true, name, message, rolledBack, rollbackFailed }
//   { kind: 'superseded', name, message }          another update won
//   { kind: 'unreadable', name, error }            a read failed for good
async function waitForDeployment (entry, response, sentAt, cluster, budget, timing) {
  const {
    pollIntervalMs = POLL_INTERVAL_MS,
    earlyPollIntervalMs = EARLY_POLL_INTERVAL_MS,
    progressIntervalMs = PROGRESS_INTERVAL_MS
  } = timing
  const mine = trackDeployment(entry, response)
  const log = progressLogger(budget, progressIntervalMs)
  for (;;) {
    const seen = await observe(mine, cluster)
    if (seen.verdict === 'landed') {
      core.info(
        `${entry.name}: deployment ${mine.id} completed, ${formatDuration(budget.now() - sentAt)} after its update was sent.`
      )
      return { landed: true }
    }
    if (seen.verdict === 'unreadable') return { kind: 'unreadable', name: entry.name, error: seen.error }
    if (seen.verdict === 'superseded') return { kind: 'superseded', name: entry.name, message: seen.message }
    if (seen.verdict === 'failed') {
      const { message, rolledBack, rollbackFailed } = seen
      return { kind: 'failed', verdict: true, name: entry.name, message, rolledBack, rollbackFailed }
    }

    const left = budget.remaining(SEND_BACK_RESERVE_MS)
    if (left <= 0) return { kind: 'bound', name: entry.name, id: mine.id, status: seen.status }
    log(
      `${entry.name}: waiting for ${mine.id ? `deployment ${mine.id}` : 'its new deployment'} to finish rolling out ` +
      `(${seen.status}). Waited ${formatDuration(budget.now() - sentAt)}, ${formatDuration(left)} left.`
    )
    const early = budget.now() - sentAt < EARLY_POLL_MS
    await budget.sleep(Math.min(early ? earlyPollIntervalMs : pollIntervalMs, left))
  }
}

// Which deployment is ours, and which were there before it. UpdateService's
// answer names ours as its PRIMARY deployment on the task definition just
// registered; without one there, the first look that shows such a PRIMARY
// decides (see judge).
function trackDeployment (entry, response) {
  const deployments = response?.deployments ?? []
  const primary = deployments.find(deployment => deployment.status === PRIMARY)
  const ours = primary?.id && primary.taskDefinition === entry.taskDefinitionArn ? primary : null
  return {
    ...entry,
    id: ours?.id ?? null,
    earlier: ours ? deployments.filter(deployment => deployment !== ours).map(deployment => deployment.id) : []
  }
}

// One look at the service. A read that fails for a passing reason is only a
// look that saw nothing; one that fails for good (see isPermanentAwsError in
// ../aws.js) ends the wait as 'unreadable'.
async function observe (mine, cluster) {
  let service
  try {
    service = await ecsDescribeService(mine.serviceArn, cluster, { quick: true })
  } catch (error) {
    if (isPermanentAwsError(error)) return { verdict: 'unreadable', error }
    return { verdict: 'waiting', status: `could not read it: ${error.message}` }
  }
  if (!service) return { verdict: 'unreadable', error: new Error('ECS reports the service missing') }
  if (service.status && service.status !== 'ACTIVE') {
    return { verdict: 'unreadable', error: new Error(`the service is ${service.status}`) }
  }
  return judge(service, mine)
}

function judge (service, mine) {
  const deployments = service.deployments ?? []
  const primary = deployments.find(deployment => deployment.status === PRIMARY)
  if (mine.id === null) {
    const notYet = { verdict: 'waiting', status: `its deployment does not show yet; ${latestEvent(service)}` }
    if (!primary?.id) return notYet
    if (primary.taskDefinition !== mine.taskDefinitionArn) {
      // A PRIMARY still on the task definition from before our update is a
      // read that lags it. One on any other task definition is another
      // update's, made before we could see ours.
      const before = mine.previous?.taskDefinitionArn
      if (before && primary.taskDefinition !== before) return { verdict: 'superseded', message: superseded(mine, primary) }
      return notYet
    }
    mine.id = primary.id
    mine.earlier = deployments.filter(deployment => deployment !== primary).map(deployment => deployment.id)
  }

  // The breaker only ever brings back a deployment that was there before, so
  // a PRIMARY that is neither that nor ours was made by another update. One
  // that runs our task definition is still our release: follow it. The one it
  // replaced joins the earlier ones, so a read that lags the change cannot
  // flip the wait back to it.
  if (primary && primary.id !== mine.id && !mine.earlier.includes(primary.id)) {
    if (primary.taskDefinition !== mine.taskDefinitionArn) return { verdict: 'superseded', message: superseded(mine, primary) }
    core.info(
      `${mine.name}: another update replaced deployment ${mine.id} with ${primary.id}, which runs this deploy's ` +
      `task definition (${shortName(mine.taskDefinitionArn)}), so the wait follows ${primary.id} now.`
    )
    mine.earlier.push(mine.id)
    mine.id = primary.id
  }
  const ours = deployments.find(deployment => deployment.id === mine.id)

  if (ours?.rolloutState === FAILED) {
    return failed(mine, ours.rolloutStateReason, primary && primary !== ours ? primary : null)
  }
  if (ours && primary === ours && landed(ours, deployments)) return { verdict: 'landed' }
  // Gone, with a deployment from before ours PRIMARY again: the breaker rolled
  // ours back and ECS has already dropped it, but only if the events say ours
  // failed. Without that event it is a read that shows the service as it was
  // before our update, which can come at any time, not only right after it: a
  // real trip writes the event at once, and normally leaves ours in the list
  // as FAILED while the rollback runs. Should the event never show, the wait
  // runs to the bound, and the send-back goes where the service already is.
  if (!ours && primary && mine.earlier.includes(primary.id)) {
    const reason = failedEventReason(service, mine.id)
    if (reason) return failed(mine, reason, primary)
    return { verdict: 'waiting', status: `its deployment does not show; ${latestEvent(service)}` }
  }
  return { verdict: 'waiting', status: progress(ours, service) }
}

// COMPLETED is ECS's own word that the rollout is done: every new task is
// healthy and the old ones have drained. AWS leaves rolloutState out for a
// service behind a Classic Load Balancer; none of the pipeline's services is,
// but should one be, the steady state stands in for it: ours is the only
// deployment left and runs every task it wants.
function landed (ours, deployments) {
  if (ours.rolloutState) return ours.rolloutState === COMPLETED
  return deployments.length === 1 && ours.runningCount === ours.desiredCount
}

function failed (mine, reason, rolledBackTo) {
  const head = `${mine.name}: its deployment ${mine.id} failed: ${sentence(reason)}`
  if (rolledBackTo?.rolloutState === FAILED) {
    return {
      verdict: 'failed',
      rolledBack: true,
      rollbackFailed: true,
      message: `${head} ECS rolled the service back to the deployment that served before this deploy ` +
        `(${rolledBackTo.id}, task definition ${shortName(rolledBackTo.taskDefinition)}), but that failed too: ` +
        `${sentence(rolledBackTo.rolloutStateReason)} The service may be serving neither release. Check it.`
    }
  }
  if (rolledBackTo) {
    return {
      verdict: 'failed',
      rolledBack: true,
      message: `${head} ECS is rolling the service back to the deployment that served before this deploy ` +
        `(${rolledBackTo.id}, task definition ${shortName(rolledBackTo.taskDefinition)}), so it should return to ` +
        'the release that was live before, unless that rollback fails too.'
    }
  }
  return {
    verdict: 'failed',
    rolledBack: false,
    message: `${head} ECS found no earlier deployment to roll it back to (as on a service's first deployment, or ` +
      'when the deployment before it never completed), so the service stays on the failed deployment.'
  }
}

// "tasks failed to start." and "tasks failed to start" both end as one
// sentence.
const sentence = reason => `${reason ? String(reason).trim().replace(/\.$/, '') : 'ECS gave no reason'}.`

// The events are newest first, and each failed deployment gets one line:
// "(service <name>) (deployment <id>) deployment failed: <reason>".
function failedEventReason (service, id) {
  const marker = `(deployment ${id}) deployment failed`
  const event = (service.events ?? []).find(({ message }) => message?.includes(marker))
  if (!event) return ''
  return event.message.slice(event.message.indexOf(marker) + marker.length).replace(/^:\s*/, '') || 'no reason given'
}

const superseded = (mine, primary) =>
  `${mine.name}: another deployment (${primary.id}, task definition ${shortName(primary.taskDefinition)}) replaced ` +
  `this deploy's deployment${mine.id ? ` (${mine.id})` : ''} while it rolled out, so this deploy's release is no ` +
  'longer the one rolling out. Nothing was sent back.'

function progress (ours, service) {
  const counts = ours
    ? `rolloutState ${ours.rolloutState ?? 'unknown'}, ${ours.runningCount ?? 0} of ${ours.desiredCount ?? 0} tasks ` +
      `running, ${ours.pendingCount ?? 0} pending`
    : 'its deployment is not in the list'
  return `${counts}; ${latestEvent(service)}`
}

function latestEvent (service) {
  const message = service.events?.[0]?.message
  if (!message) return 'no service events yet'
  return `latest event: ${message.length > 200 ? `${message.slice(0, 197)}...` : message}`
}

// How a rollout that ended short fails the step, sending services back first
// where it should. A failure before any service moved is thrown as it came,
// except on a rollback, which says what it did with the scheduled tasks.
async function stopRollout ({ moved, landed, outcome, cluster, budget, stopRolloutOnFailure, repointScheduledTasks }) {
  if (outcome.kind === 'superseded') {
    return new Error([
      outcome.message,
      ...stayOnNewRelease(landed),
      'Check what the services are serving before running it again.',
      AFTERMATH
    ].join(' '))
  }
  if (!stopRolloutOnFailure) {
    const jobs = await moveScheduledTasks(repointScheduledTasks)
    if (outcome.kind === 'unreadable') return withCause(new Error(`${unreadable(outcome, landed)} ${jobs}`), outcome.error)
    return withCause(new Error([headline(outcome, budget), notStopped(outcome, landed), jobs].join(' ')), outcome.error)
  }
  if (outcome.kind === 'unreadable') return withCause(new Error(`${unreadable(outcome, landed)} ${AFTERMATH}`), outcome.error)
  if (outcome.kind === 'failed' && !outcome.verdict && moved.length === 0) return outcome.error

  // A service whose own deployment FAILED belongs to ECS: it is being rolled
  // back already, or there is nothing to roll it back to.
  const toSend = moved.filter(entry => !(outcome.verdict && entry.name === outcome.name))
  const results = []
  for (const entry of toSend) {
    const landedHere = landed.includes(entry.name)
    if (entry.previous?.placeholder || !entry.previous?.taskDefinitionArn) {
      results.push({ entry, landedHere, nothingToSend: true })
    } else if (!entry.previous.live) {
      results.push({ entry, landedHere, notLive: true })
    } else {
      results.push({ entry, landedHere, ...await sendBack(entry, cluster, budget) })
    }
  }
  const lines = [headline(outcome, budget), ...sendBackReport(results), AFTERMATH]
  return withCause(new Error(lines.join(' ')), outcome.error)
}

const stayOnNewRelease = landed => landed.length > 0
  ? [`${landed.join(', ')} already landed on the new release, and stay${landed.length === 1 ? 's' : ''} there.`]
  : []

function withCause (error, cause) {
  if (cause) error.cause = cause
  return error
}

// What a rollout failure leaves behind, outside a rollback. The scheduled
// tasks are re-pointed only after every service has landed (see
// ./deploy-ecs.js), so a failure here leaves them as they were.
const AFTERMATH =
  'Nothing was recorded for this deploy. The database migration, if the app has one, has already run, and the ' +
  'scheduled tasks were not re-pointed: they still run the task definitions they ran before this deploy.'

// A rollback moves its scheduled tasks however its rollout ended, and says so.
async function moveScheduledTasks (repointScheduledTasks) {
  const recorded = 'Nothing was recorded for this deploy. The database migration, if the app has one, has already run.'
  try {
    await repointScheduledTasks?.()
  } catch (error) {
    return `${recorded} Moving the scheduled tasks to the rollback target failed (${error.message}), so some of ` +
      'them may still run the release being rolled back from.'
  }
  return `${recorded} The scheduled tasks were moved to the rollback target anyway, as a rollback always moves ` +
    'them, while a service may still be on the release being rolled back from.'
}

// Send one service back to the task definition it ran before this deploy, and
// confirm ECS took it. Not waited on: going back is an ECS rollout of its own,
// which ECS finishes on its own.
async function sendBack ({ serviceArn, previous }, cluster, budget) {
  const target = previous.taskDefinitionArn
  try {
    const service = await ecsUpdateService(serviceArn, cluster, target, { timeoutMs: callTimeout(budget, SEND_BACK_TIMEOUT_MS) })
    if (service?.taskDefinition === target) return { sent: true }
    const read = await ecsDescribeService(serviceArn, cluster, { quick: true })
    if (read?.taskDefinition === target) return { sent: true }
    return {
      sent: false,
      error: new Error(`ECS answered, but the service runs ${shortName(read?.taskDefinition ?? service?.taskDefinition ?? 'an unknown task definition')}`)
    }
  } catch (error) {
    return { sent: false, error }
  }
}

function sendBackReport (results) {
  const lines = []
  const sent = results.filter(result => result.sent)
  if (sent.length > 0) {
    lines.push(
      'To keep the app on the release that was serving before this deploy, ECS was told to send ' +
      sent.map(({ entry }) => `${entry.name} back to ${shortName(entry.previous.taskDefinitionArn)}`).join(', ') +
      '. ECS stops the new deployment and rolls each one back on its own, keeping the tasks that serve now until ' +
      'the old ones are healthy again.'
    )
  }
  for (const { entry, landedHere } of results.filter(result => result.nothingToSend)) {
    lines.push(
      `${entry.name} had never been deployed before this deploy (it ran the scratch placeholder), so there is ` +
      'nothing to send it back to. ' +
      (landedHere
        ? 'It already serves the new release, with nothing recording it.'
        : 'If its new deployment lands, it will serve the new release with nothing recording it.')
    )
  }
  for (const { entry } of results.filter(result => result.notLive)) {
    const { taskDefinitionArn, deployment, rolloutState } = entry.previous
    lines.push(
      `${entry.name} was not sent back: when this deploy started, its deployment${deployment ? ` ${deployment}` : ''} ` +
      `on ${shortName(taskDefinitionArn)} had not completed (rolloutState ${rolloutState ?? 'unknown'}), so it is ` +
      'not known to have been serving. Check what it serves, and send it back by hand if it should go back: ' +
      updateServiceCommand(entry.serviceArn, taskDefinitionArn)
    )
  }
  for (const { entry, error } of results.filter(result => !result.sent && !result.nothingToSend && !result.notLive)) {
    const target = entry.previous.taskDefinitionArn
    lines.push(
      `Could not send ${entry.name} back to ${shortName(target)} (${error.message}), so it may keep the new ` +
      `release unrecorded. Send it back by hand: ${updateServiceCommand(entry.serviceArn, target)}`
    )
  }
  return lines
}

// arn:aws:ecs:<region>:<account>:service/<cluster>/<service>
function updateServiceCommand (serviceArn, taskDefinitionArn) {
  const [cluster, service] = String(serviceArn).split('/').slice(-2)
  return `aws ecs update-service --cluster ${cluster} --service ${service} --task-definition ${taskDefinitionArn}`
}

function headline (outcome, budget) {
  // A verdict's message names the deployment and its service already.
  if (outcome.kind === 'failed') {
    if (outcome.verdict) return outcome.message
    return `Could not update ${outcome.name}: ${outcome.error.message}.`
  }
  if (outcome.untouched) {
    return `The rollout budget ran out before ${outcome.name} could be updated, so it was left as it was: this ` +
      'step has to stop well inside its job\'s timeout, and the migration or the services before it used the time.'
  }
  return `ECS did not finish rolling out ${outcome.id ? `deployment ${outcome.id} of ` : ''}${outcome.name} within ` +
    `${formatDuration(budget.elapsed())} of this deploy's first update (${outcome.status}).`
}

function unreadable ({ name, error }, landed) {
  return [
    `${name}: could not read the service while waiting for its rollout (${error.message}). The rollout's ` +
    'state is unknown: its new deployment may still land, and nothing would record it. Nothing was sent back, ' +
    'since that could take the service off a release that did land.',
    ...stayOnNewRelease(landed),
    'Check what the services are serving.'
  ].join(' ')
}

// A rollback never sends anything back, so say plainly where that leaves each
// service.
function notStopped (outcome, landed) {
  const lines = [
    'This deploy does not stop a rollout (a rollback), so nothing was sent back: that would be the release it is ' +
    'rolling back from.'
  ]
  if (outcome.rollbackFailed) {
    lines.push(
      `ECS tried to take ${outcome.name} back to the release this rollback set out to replace, and that failed ` +
      'too, so check what production serves.'
    )
  } else if (outcome.verdict && outcome.rolledBack) {
    lines.push(
      `ECS is taking ${outcome.name} back to the release this rollback set out to replace, so production is on ` +
      'that release again.'
    )
  } else if (outcome.kind === 'bound' && !outcome.untouched) {
    lines.push('Its new deployment may still land, and nothing will record it.')
  }
  if (landed.length > 0) {
    lines.push(`${landed.join(', ')} already landed on this rollback's release, and stay${landed.length === 1 ? 's' : ''} there.`)
  }
  lines.push('Check what the services are serving.')
  return lines.join(' ')
}
