// A fake ECS for the deploy's rollout tests and the running-image resolver. It
// stands in for the SDK client (see `client`), so the real src/aws.js calls run
// against it: the quick one-attempt reads, the time limits, and what they
// return.
//
// Its shapes are the ones a read-only sweep of the real fleet captured:
//   - UpdateService answers with the service, whose PRIMARY deployment is the
//     new one (rolloutState IN_PROGRESS); the deployment before it stays in
//     the list as ACTIVE until its tasks drain;
//   - a rollout that lands reads PRIMARY and COMPLETED ("ECS deployment <id>
//     completed."), and the deployments before it leave the list;
//   - the circuit breaker marks ours FAILED and, in the same instant, makes the
//     deployment that served before it PRIMARY again with its OLD id, which
//     rolls out to COMPLETED ("rolling back to deployment <id>"); it never makes
//     a new deployment. Ours then leaves the list once drained. With no earlier
//     deployment that completed, ours reads FAILED and stays PRIMARY;
//   - another update makes a NEW deployment id PRIMARY; the one it replaced
//     stays ACTIVE until the new one lands, then leaves the list;
//   - the service events, newest first, as ECS words them.
// The FAILED rolloutStateReason is AWS's documented wording; the sweep saw a
// failed deployment only through its events and deployment history.
//
// Time is the fake's own clock (`now`, `sleep`), which the tests hand to the
// rollout budget, so a wait of forty minutes runs in no time.
//
// Each update of a service follows the next plan queued for it with `plan`:
//   { lands: ms }             the deployment completes ms after the update
//                             (the default, 90 seconds, about the fleet's
//                             median; 20 seconds at desiredCount 0, about the
//                             fleet's median for a service scaled to zero)
//   { fails: ms, reason, rollbackTakes, removedAfter }
//                             the breaker fails it ms after the update; the
//                             rollback to the deployment before it takes
//                             rollbackTakes (30 seconds), and ours leaves the
//                             list removedAfter ms after it failed (by default
//                             when the rollback completes)
//   { fails, rollbackFails: ms } ... and the rollback fails too, ms after it
//                             started, as when the deployment it goes back to
//                             cannot start either; ours then stays in the list
//                             unless removedAfter says otherwise
//   { never: true }           it never finishes, and never fails
//   { supersededAfter: ms, by } another update reaches the service ms after
//                             this one, with task definition `by` (by
//                             default the next revision of the same family)
//   { resentAfter: ms, then } another update re-sends this one's task
//                             definition ms after it, as a Terraform apply
//                             does; its new deployment follows plan `then`
//                             (by default it lands)
//   { refused: error }        UpdateService throws this, and nothing changes
//   { bareAnswer: true }      UpdateService answers with no deployments and
//                             no task definition
//   { ignored: true }         UpdateService answers, but nothing changes
//   { laggingReads: n, laggingFrom: ms }
//                             ... combined with any of the above: n reads show
//                             the service as it was before the update, from
//                             laggingFrom ms after it (by default at once)
// A service with no queued plan lands, which is how a send-back behaves.
// `failReads` makes DescribeServices fail with an error for a while.
// `staleReads(arn, { capturedAt, from, reads })` takes the service as it is at
// capturedAt, and shows it that way to n reads from `from` on.
// `fakeEcs({ rolloutState: false })` leaves rolloutState out of every read, as
// AWS does for a service behind a Classic Load Balancer.
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  UpdateServiceCommand
} from '@aws-sdk/client-ecs'

export const MINUTE = 60 * 1000
export const ROLLOUT_MS = 90 * 1000
export const ACCOUNT = '000000000000'
export const REGION = 'us-east-1'
const ROLLBACK_MS = 30 * 1000
const ZERO_TASKS_MS = 20 * 1000
export const BREAKER_REASON = 'ECS deployment circuit breaker: tasks failed to start.'

export const serviceArn = (cluster, name) => `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${cluster}/${name}`
export const taskDefinitionArn = (family, revision) =>
  `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${family}:${revision}`

const iso = ms => new Date(Date.UTC(2030, 0, 1) + ms).toISOString()
const clone = value => JSON.parse(JSON.stringify(value))

// A deployment as DescribeServices shows it, with the fields the sweep saw.
export function ecsDeployment ({
  id,
  status = 'PRIMARY',
  taskDefinition,
  desiredCount = 2,
  runningCount = desiredCount,
  pendingCount = 0,
  failedTasks = 0,
  rolloutState = 'COMPLETED',
  rolloutStateReason = rolloutState === 'COMPLETED' ? `ECS deployment ${id} completed.` : `ECS deployment ${id} in progress.`,
  at = 0
}) {
  return {
    id,
    status,
    taskDefinition,
    desiredCount,
    pendingCount,
    runningCount,
    failedTasks,
    createdAt: iso(at),
    updatedAt: iso(at),
    capacityProviderStrategy: [
      { capacityProvider: 'cp-example-a', weight: 1, base: 1 },
      { capacityProvider: 'cp-example-b', weight: 1, base: 0 }
    ],
    rolloutState,
    rolloutStateReason
  }
}

// A service as DescribeServices shows it.
export function ecsService ({ cluster = 'prod', name, deployments, desiredCount = 2, events = [] }) {
  const primary = deployments.find(deployment => deployment.status === 'PRIMARY')
  return {
    serviceArn: serviceArn(cluster, name),
    serviceName: name,
    clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${cluster}`,
    status: 'ACTIVE',
    desiredCount,
    runningCount: deployments.reduce((sum, deployment) => sum + deployment.runningCount, 0),
    pendingCount: deployments.reduce((sum, deployment) => sum + deployment.pendingCount, 0),
    taskDefinition: primary?.taskDefinition,
    deploymentConfiguration: {
      deploymentCircuitBreaker: { enable: true, rollback: true },
      maximumPercent: 200,
      minimumHealthyPercent: 100,
      strategy: 'ROLLING'
    },
    deployments,
    events,
    deploymentController: { type: 'ECS' }
  }
}

export function fakeEcs ({ cluster = 'prod', rolloutState = true } = {}) {
  let clock = 0
  let ids = 1000000000000000000n
  const services = new Map()
  const taskDefinitions = new Map()
  const queue = []
  const calls = { updates: [], reads: [] }
  let readFailure = null

  const nextId = () => `ecs-svc/${++ids}`
  const schedule = (at, run) => {
    queue.push({ at, run })
    queue.sort((a, b) => a.at - b.at)
  }
  // Apply everything due by now, in order.
  const settle = () => {
    while (queue.length > 0 && queue[0].at <= clock) queue.shift().run()
  }

  function record (service, message) {
    service.events.unshift({ id: `event-${service.events.length + 1}`, createdAt: iso(clock), message })
  }

  function addTaskDefinition (arn, image, { family = arn.split('/').pop().split(':')[0] } = {}) {
    taskDefinitions.set(arn, {
      taskDefinitionArn: arn,
      family,
      containerDefinitions: [
        { name: 'app', image },
        { name: 'log_router', image: 'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable' }
      ]
    })
    return arn
  }

  // A service at rest: one PRIMARY deployment, COMPLETED, on `taskDefinition`.
  // `rolloutState: 'FAILED'` makes it one whose only deployment never
  // completed, as a service Terraform started on the scratch placeholder is;
  // 'IN_PROGRESS' one still rolling out when the deploy starts.
  function addService (name, { taskDefinition, desiredCount = 2, rolloutState = 'COMPLETED' } = {}) {
    const unfinished = {
      FAILED: { runningCount: 0, rolloutStateReason: BREAKER_REASON },
      IN_PROGRESS: { runningCount: 0, pendingCount: desiredCount }
    }
    const deployment = ecsDeployment({
      id: nextId(),
      taskDefinition,
      desiredCount,
      rolloutState,
      ...unfinished[rolloutState],
      at: clock - 30 * 24 * 60 * MINUTE
    })
    const service = { ...ecsService({ cluster, name, deployments: [deployment], desiredCount }), plans: [] }
    record(service, `(service ${name}) has reached a steady state.`)
    services.set(service.serviceArn, service)
    return service.serviceArn
  }

  const find = arn => {
    const service = services.get(arn)
    if (!service) throw new Error(`fake ECS has no service ${arn}`)
    return service
  }
  const primaryOf = service => service.deployments.find(deployment => deployment.status === 'PRIMARY')

  function snapshot (service) {
    const view = clone({ ...service, taskDefinition: primaryOf(service)?.taskDefinition })
    // The fake's own bookkeeping, which ECS would not show.
    delete view.plans
    delete view.lag
    if (!rolloutState) {
      for (const deployment of view.deployments) {
        delete deployment.rolloutState
        delete deployment.rolloutStateReason
      }
    }
    return view
  }

  function startDeployment (service, taskDefinition, plan) {
    const previous = primaryOf(service)
    if (previous) previous.status = 'ACTIVE'
    const deployment = ecsDeployment({
      id: nextId(),
      taskDefinition,
      desiredCount: service.desiredCount,
      runningCount: 0,
      pendingCount: service.desiredCount,
      rolloutState: 'IN_PROGRESS',
      at: clock
    })
    service.deployments.unshift(deployment)
    record(service, `(service ${service.serviceName}) has started ${service.desiredCount} tasks: (task 0123456789abcdef0123456789abcdef).`)
    const sentAt = clock
    if (plan.fails !== undefined) {
      schedule(sentAt + plan.fails, () => fail(service, deployment, plan))
    } else if (plan.supersededAfter !== undefined) {
      const by = plan.by ?? taskDefinition.replace(/:(\d+)$/, (_, revision) => `:${Number(revision) + 1}`)
      schedule(sentAt + plan.supersededAfter, () => startDeployment(service, by, { lands: ROLLOUT_MS }))
    } else if (plan.resentAfter !== undefined) {
      schedule(sentAt + plan.resentAfter, () => startDeployment(service, taskDefinition, plan.then ?? {}))
    } else if (!plan.never) {
      schedule(sentAt + (service.desiredCount === 0 ? ZERO_TASKS_MS : plan.lands ?? ROLLOUT_MS), () => complete(service, deployment))
    }
    return deployment
  }

  // Lands only while it is still the PRIMARY one rolling out: a deployment
  // another one replaced never does.
  function complete (service, deployment) {
    if (deployment.status !== 'PRIMARY' || deployment.rolloutState !== 'IN_PROGRESS') return
    Object.assign(deployment, {
      rolloutState: 'COMPLETED',
      rolloutStateReason: `ECS deployment ${deployment.id} completed.`,
      runningCount: deployment.desiredCount,
      pendingCount: 0,
      updatedAt: iso(clock)
    })
    service.deployments = [deployment]
    record(service, `(service ${service.serviceName}) (deployment ${deployment.id}) deployment completed.`)
    record(service, `(service ${service.serviceName}) has reached a steady state.`)
  }

  function fail (service, deployment, plan) {
    if (deployment.status !== 'PRIMARY' || deployment.rolloutState !== 'IN_PROGRESS') return
    Object.assign(deployment, {
      rolloutState: 'FAILED',
      rolloutStateReason: plan.reason ?? BREAKER_REASON,
      runningCount: 0,
      pendingCount: 0,
      failedTasks: 3,
      updatedAt: iso(clock)
    })
    record(service, `(service ${service.serviceName}) (deployment ${deployment.id}) deployment failed: tasks failed to start.`)
    // The breaker goes back to the last deployment that completed, by its id.
    const candidate = service.deployments.find(other => other !== deployment && other.rolloutStateReason?.endsWith('completed.'))
    if (!candidate) return
    deployment.status = 'ACTIVE'
    Object.assign(candidate, {
      status: 'PRIMARY',
      rolloutState: 'IN_PROGRESS',
      rolloutStateReason: `ECS deployment ${candidate.id} in progress.`
    })
    record(service, `(service ${service.serviceName}) rolling back to deployment ${candidate.id}.`)
    const remove = () => { service.deployments = service.deployments.filter(other => other !== deployment) }
    if (plan.rollbackFails !== undefined) {
      if (plan.removedAfter !== undefined) schedule(clock + plan.removedAfter, remove)
      schedule(clock + plan.rollbackFails, () => {
        Object.assign(candidate, { rolloutState: 'FAILED', rolloutStateReason: BREAKER_REASON, runningCount: 0, failedTasks: 3 })
        record(service, `(service ${service.serviceName}) (deployment ${candidate.id}) deployment failed: tasks failed to start.`)
      })
      return
    }
    const rollbackTakes = plan.rollbackTakes ?? ROLLBACK_MS
    schedule(clock + (plan.removedAfter ?? rollbackTakes), remove)
    schedule(clock + rollbackTakes, () => complete(service, candidate))
  }

  function updateService ({ service: arn, taskDefinition }) {
    settle()
    const service = find(arn)
    const plan = service.plans.shift() ?? {}
    calls.updates.push({ at: clock, service: service.serviceName, taskDefinition })
    if (plan.refused) throw plan.refused
    if (plan.ignored) return { service: snapshot(service) }
    if (plan.laggingReads) {
      service.lag = { reads: plan.laggingReads, from: clock + (plan.laggingFrom ?? 0), view: snapshot(service) }
    }
    const primary = primaryOf(service)
    // The task definition it already has, and done: nothing to deploy.
    if (!(primary?.taskDefinition === taskDefinition && primary.rolloutState === 'COMPLETED')) {
      startDeployment(service, taskDefinition, plan)
    }
    settle()
    const answer = snapshot(service)
    return { service: plan.bareAnswer ? { ...answer, deployments: undefined, taskDefinition: undefined } : answer }
  }

  function describeServices ({ services: arns }, config, options) {
    settle()
    calls.reads.push({ at: clock, services: arns, maxAttempts: config?.maxAttempts, timed: Boolean(options?.abortSignal) })
    if (readFailure && readFailure.from <= clock && clock < readFailure.until) throw readFailure.error
    const found = arns.filter(arn => services.has(arn))
    const view = service => {
      if (!service.lag?.reads || clock < service.lag.from) return snapshot(service)
      service.lag.reads--
      return clone(service.lag.view)
    }
    return {
      services: found.map(arn => view(services.get(arn))),
      failures: arns.filter(arn => !services.has(arn)).map(arn => ({ arn, reason: 'MISSING' }))
    }
  }

  function describeTaskDefinition ({ taskDefinition }) {
    const definition = taskDefinitions.get(taskDefinition)
    if (!definition) throw new Error(`fake ECS has no task definition ${taskDefinition}`)
    return { taskDefinition: clone(definition), tags: [] }
  }

  return {
    now: () => clock,
    sleep: async ms => { clock += ms },
    advance: ms => { clock += ms; settle() },
    calls,
    addService,
    addTaskDefinition,
    plan (arn, plan) { find(arn).plans.push(plan) },
    failReads (error, { from = clock, until = Infinity } = {}) { readFailure = { error, from, until } },
    staleReads (arn, { capturedAt, from, reads = 1 }) {
      schedule(capturedAt, () => { find(arn).lag = { reads, from, view: snapshot(find(arn)) } })
    },
    // The service as ECS would describe it now.
    service (arn) { settle(); return snapshot(find(arn)) },
    // The SDK client: what src/aws.js sends. `config` is the client's.
    client: {
      async send (command, options, config) {
        if (command instanceof UpdateServiceCommand) return updateService(command.input)
        if (command instanceof DescribeServicesCommand) return describeServices(command.input, config, options)
        if (command instanceof DescribeTaskDefinitionCommand) return describeTaskDefinition(command.input)
        throw new Error(`fake ECS does not handle ${command.constructor.name}`)
      }
    }
  }
}
