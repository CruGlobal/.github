import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The ECS client, replaced by the fake in test/support/fake-ecs.js. The calls
// the rollout makes (UpdateService and DescribeServices, in src/aws.js) run for
// real against it, so their one-attempt reads and time limits are exercised.
// Everything else src/aws.js does for a deploy (listing, registering,
// EventBridge, SSM) is mocked here, as in test/v2-deploy-ecs.test.js.
const { ecs } = vi.hoisted(() => ({ ecs: { fake: null } }))
vi.mock('@aws-sdk/client-ecs', async importOriginal => ({
  ...(await importOriginal()),
  ECSClient: class {
    constructor (config) { this.config = config }
    send (command, options) { return ecs.fake.client.send(command, options, this.config) }
  }
}))

vi.mock('../src/aws.js', async importOriginal => ({
  ...(await importOriginal()),
  ecsListServices: vi.fn(),
  ecsServiceTaskDefinitions: vi.fn(),
  ecsDescribeTaskDefinition: vi.fn(),
  ecsRegisterTaskDefinition: vi.fn(),
  eventBridgeListRules: vi.fn(),
  eventBridgeListTargets: vi.fn(),
  eventBridgeUpdateTarget: vi.fn(),
  ssmParameterValue: vi.fn()
}))

// No registry reads: the images here name no companions unless a test says so,
// and every companion image is there.
vi.mock('../src/v2/oci.js', () => ({ openImage: vi.fn(async () => ({ labels: {} })) }))
vi.mock('../src/v2/aws.js', async importOriginal => ({
  ...(await importOriginal()),
  ecrDigestExists: vi.fn(async () => true)
}))

vi.mock('../src/ecs-config.js', async importOriginal => ({
  ...(await importOriginal()),
  runtimeSecrets: vi.fn()
}))

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal()),
  info: vi.fn(),
  warning: vi.fn()
}))

import * as core from '@actions/core'
import { ClientException } from '@aws-sdk/client-ecs'
import * as aws from '../src/aws.js'
import { DEFAULT_ACCOUNT, ecrRegistry, runtimeSecrets } from '../src/ecs-config.js'
import { deployEcs } from '../src/v2/deploy-ecs.js'
import { openImage } from '../src/v2/oci.js'
import { ecrDigestExists } from '../src/v2/aws.js'
import { SEND_BACK_RESERVE_MS } from '../src/v2/ecs-rollout.js'
import { ROLLOUT_BUDGET_MS, rolloutBudget } from '../src/v2/rollout-budget.js'
import { MINUTE, ROLLOUT_MS, fakeEcs, serviceArn, taskDefinitionArn } from './support/fake-ecs.js'

const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)
const IMAGE = `${REGISTRY}/example-app@sha256:new`
const OLD_IMAGE = `${REGISTRY}/example-app@sha256:old`
const WEB = 'example-app-prod-web-abcd'
const WORKER = 'example-app-prod-worker-efgh'
const family = name => name.replace(/-[a-z0-9]{4}$/, '')
// What each service runs before the deploy, and what the deploy registers.
const previous = name => taskDefinitionArn(family(name), 41)
const next = name => taskDefinitionArn(family(name), 42)
const JOB_TARGET = taskDefinitionArn('example-app-prod-nightly', 7)

const AFTERMATH =
  'Nothing was recorded for this deploy. The database migration, if the app has one, has already run, and the ' +
  'scheduled tasks were not re-pointed: they still run the task definitions they ran before this deploy.'

let fake
beforeEach(() => {
  fake = ecs.fake = fakeEcs({ cluster: 'prod' })
  for (const fn of Object.values(aws)) fn.mockReset?.()
  core.info.mockReset()
  core.warning.mockReset()
  runtimeSecrets.mockReset()
  runtimeSecrets.mockResolvedValue([])
  aws.ecsDescribeTaskDefinition.mockImplementation(async name => {
    if (name.endsWith('-db-migrate')) throw new ClientException({ message: 'Unable to describe task definition.', $metadata: {} })
    return {
      taskDefinition: { family: name, containerDefinitions: [{ name: 'app', image: 'scratch' }] },
      tags: []
    }
  })
  aws.ecsRegisterTaskDefinition.mockImplementation(async definition => taskDefinitionArn(definition.family, 42))
  aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-example-app-prod-nightly' }])
  aws.eventBridgeListTargets.mockImplementation(async () => [
    { Id: 'nightly', EcsParameters: { TaskDefinitionArn: JOB_TARGET } }
  ])
  aws.eventBridgeUpdateTarget.mockResolvedValue({})
})

// An app with these services, each at rest on revision 41 of its family. A
// name in `placeholder` has never been deployed: it runs the scratch image. One
// in `neverCompleted` has a deployment that failed, one in `inProgress` one
// still rolling out, and every service has `desiredCount` tasks.
function app (names, { placeholder = [], neverCompleted = [], inProgress = [], desiredCount = 2 } = {}) {
  const state = name => neverCompleted.includes(name) ? 'FAILED' : inProgress.includes(name) ? 'IN_PROGRESS' : 'COMPLETED'
  const arns = names.map(name => {
    const image = placeholder.includes(name) ? 'scratch' : OLD_IMAGE
    fake.addTaskDefinition(previous(name), image)
    return fake.addService(name, { taskDefinition: previous(name), rolloutState: state(name), desiredCount })
  })
  aws.ecsListServices.mockResolvedValue(arns)
  aws.ecsServiceTaskDefinitions.mockImplementation(async list => Object.fromEntries(list.map(arn => {
    const name = arn.split('/').pop()
    return [arn, {
      taskDefinitionArn: previous(name),
      family: family(name),
      containerDefinitions: [{ name: 'app', image: placeholder.includes(name) ? 'scratch' : OLD_IMAGE }]
    }]
  })))
  return Object.fromEntries(names.map((name, i) => [name, arns[i]]))
}

const deploy = ({ stepStartedAt = 0, ...args } = {}) => deployEcs(
  { projectName: 'example-app', environment: 'production', image: IMAGE, ...args },
  { budget: rolloutBudget({ now: fake.now, sleep: fake.sleep, stepStartedAt }) }
)
const rollback = () => deploy({ stopRolloutOnFailure: false })
const failure = promise => promise.then(() => { throw new Error('expected the deploy to fail') }, error => error)

const infos = () => core.info.mock.calls.map(([message]) => message)
const followed = () => infos().filter(line => line.includes('so the wait follows'))
// Where each EventBridge target was re-pointed to.
const repointed = () => aws.eventBridgeUpdateTarget.mock.calls.map(([, target]) => target.EcsParameters.TaskDefinitionArn)
const JOB_RELEASE = taskDefinitionArn('example-app-prod-nightly', 42)
const updates = () => fake.calls.updates.map(({ service, taskDefinition }) => `${service} -> ${taskDefinition.split('/').pop()}`)
const deploymentId = name => fake.service(serviceArn('prod', name)).deployments.find(d => d.taskDefinition === next(name))?.id

describe('an ECS deploy waits for each deployment to land', () => {
  it('returns as a normal success once the deployment is COMPLETED, so every record step runs', async () => {
    app([WEB])

    const result = await deploy()

    expect(result).toEqual({ deployedImage: IMAGE, services: [WEB], sourcemaps: { status: 'skipped', uploaded: 0, failed: 0 } })
    expect(fake.now()).toBe(ROLLOUT_MS)
    expect(infos()).toContainEqual(expect.stringMatching(
      new RegExp(`^${WEB}: deployment ecs-svc/\\d+ completed, 1m 30s after its update was sent\\.$`)
    ))
    // Then the scheduled task is re-pointed, as before.
    expect(aws.eventBridgeUpdateTarget).toHaveBeenCalledTimes(1)
  })

  it('looks every 5 seconds for the first minute, then every 15, each look one quick attempt', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { lands: 2 * MINUTE })

    await deploy()

    // One read of every service before the update, with the usual retries,
    // then the looks.
    const [before, ...looks] = fake.calls.reads
    expect(before).toMatchObject({ at: 0, maxAttempts: 5, timed: false })
    expect(looks.map(read => read.at / 1000)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 75, 90, 105, 120])
    expect(looks.every(read => read.maxAttempts === 1 && read.timed)).toBe(true)
  })

  it('logs one line about every minute, with the rollout state, the task counts and the latest event', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { lands: 12 * MINUTE })

    await deploy()

    const waiting = infos().filter(line => line.includes('to finish rolling out'))
    expect(waiting).toHaveLength(12)
    expect(waiting[0]).toMatch(new RegExp(
      `^${WEB}: waiting for deployment ecs-svc/\\d+ to finish rolling out \\(rolloutState IN_PROGRESS, 0 of 2 tasks ` +
      `running, 2 pending; latest event: \\(service ${WEB}\\) has started 2 tasks: \\(task [0-9a-f]+\\)\\.\\)\\. ` +
      'Waited 0s, 43m 0s left\\.$'
    ))
    expect(waiting[1]).toMatch(/Waited 1m 0s, 42m 0s left\.$/)
  })

  it('takes its deployment from the first read when UpdateService answers without one', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { bareAnswer: true })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(ROLLOUT_MS)
  })

  it('updates the services one after another, each once the one before it has landed', async () => {
    app([WEB, WORKER])

    await expect(deploy()).resolves.toMatchObject({ services: [WEB, WORKER] })

    expect(fake.calls.updates.map(({ at, service }) => [service, at])).toEqual([[WEB, 0], [WORKER, ROLLOUT_MS]])
    expect(fake.now()).toBe(2 * ROLLOUT_MS)
  })

  it('takes the steady state for landed when AWS reports no rolloutState, as for a Classic Load Balancer', async () => {
    fake = ecs.fake = fakeEcs({ cluster: 'prod', rolloutState: false })
    app([WEB])

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(ROLLOUT_MS)
  })

  it('waits for a service scaled to zero tasks too, whose deployment completes in seconds', async () => {
    app([WEB], { desiredCount: 0 })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(20 * 1000)
  })

  it('registers every revision before the first update, so a registration that fails moves nothing', async () => {
    app([WEB, WORKER])
    const register = aws.ecsRegisterTaskDefinition.getMockImplementation()
    aws.ecsRegisterTaskDefinition.mockImplementation(async definition => {
      if (definition.family === family(WORKER)) throw new Error('Too many revisions of this family.')
      return register(definition)
    })

    await expect(deploy()).rejects.toThrow('Too many revisions of this family.')
    expect(aws.ecsRegisterTaskDefinition).toHaveBeenCalledTimes(2)
    expect(fake.calls.updates).toHaveLength(0)
    expect(aws.eventBridgeUpdateTarget).not.toHaveBeenCalled()
  })

  it('leaves a jobs-only app as it was: nothing to wait on, and the scheduled tasks are re-pointed', async () => {
    app([])

    await expect(deploy()).resolves.toEqual({ deployedImage: IMAGE, services: [], sourcemaps: expect.any(Object) })

    expect(fake.calls.updates).toHaveLength(0)
    expect(fake.calls.reads).toHaveLength(0)
    expect(fake.now()).toBe(0)
    expect(aws.eventBridgeUpdateTarget).toHaveBeenCalledTimes(1)
  })
})

describe('a deployment the circuit breaker fails', () => {
  it('fails with its reason, says ECS is taking the service back, and records nothing', async () => {
    const { [WEB]: web } = app([WEB])
    const before = fake.service(web).deployments[0].id
    fake.plan(web, { fails: 5 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toBe(
      `${WEB}: its deployment ${deploymentId(WEB)} failed: ECS deployment circuit breaker: tasks failed to start. ` +
      `ECS is rolling the service back to the deployment that served before this deploy (${before}, task definition ` +
      'example-app-prod-web:41), so it should return to the release that was live before, unless that rollback ' +
      `fails too. ${AFTERMATH}`
    )
    expect(fake.now()).toBe(5 * MINUTE)
    // ECS takes it back; nothing else is sent.
    expect(updates()).toEqual([`${WEB} -> example-app-prod-web:42`])
  })

  it('takes a deployment the breaker already dropped from the list for failed too, with the reason its event gives', async () => {
    const { [WEB]: web } = app([WEB])
    // It fails between two looks, and leaves the list in the same instant.
    fake.plan(web, { fails: 5 * MINUTE + 2000, removedAfter: 0 })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(`^${WEB}: its deployment ecs-svc/\\d+ failed: tasks failed to start\\. ECS is rolling`))
    expect(fake.now()).toBe(5 * MINUTE + 15 * 1000)
  })

  it('is not fooled by a stale read long after its deployment was seen, with no failed event', async () => {
    const { [WEB]: web } = app([WEB])
    // Three reads, from three minutes in, show the service as it was before the
    // update: the old deployment PRIMARY, ours not in the list.
    fake.plan(web, { lands: 10 * MINUTE, laggingReads: 3, laggingFrom: 3 * MINUTE })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(10 * MINUTE)
    expect(fake.calls.updates).toHaveLength(1)
  })

  it('hedges while ECS rolls the service back, since that rollback can fail as well', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { fails: 2 * MINUTE, rollbackFails: 3 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain('so it should return to the release that was live before, unless that rollback fails too.')
  })

  it('says so when the look finds the rollback already failed too, as in a "Rollback failed." deployment', async () => {
    const { [WEB]: web } = app([WEB])
    const before = fake.service(web).deployments[0].id
    // Between two looks: ours fails, leaves the list, and the rollback to the
    // deployment before it fails too.
    fake.plan(web, { fails: 5 * MINUTE + 2000, rollbackFails: 0, removedAfter: 0 })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(
      `^${WEB}: its deployment ecs-svc/\\d+ failed: tasks failed to start\\. ECS rolled the service back to the ` +
      `deployment that served before this deploy \\(${before}, task definition example-app-prod-web:41\\), but that ` +
      'failed too: ECS deployment circuit breaker: tasks failed to start\\. The service may be serving neither ' +
      'release\\. Check it\\. '
    ))
    expect(fake.calls.updates).toHaveLength(1)
  })

  it('is not fooled by a read that lags the update and still shows the deployment from before', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { laggingReads: 3 })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(ROLLOUT_MS)
  })

  it('sends the earlier services back when a later one fails, and leaves the failed one to ECS', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(worker, { fails: 3 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(`^${WORKER}: its deployment ecs-svc/\\d+ failed: ECS deployment circuit breaker`))
    expect(error.message).toContain(
      `To keep the app on the release that was serving before this deploy, ECS was told to send ${WEB} back to ` +
      'example-app-prod-web:41. ECS stops the new deployment and rolls each one back on its own'
    )
    expect(error.message.endsWith(AFTERMATH)).toBe(true)
    expect(updates()).toEqual([
      `${WEB} -> example-app-prod-web:42`,
      `${WORKER} -> example-app-prod-worker:42`,
      `${WEB} -> example-app-prod-web:41`
    ])
    expect(fake.service(web).taskDefinition).toBe(previous(WEB))
  })

  it('says so when ECS finds nothing to roll the failed deployment back to', async () => {
    const { [WEB]: web } = app([WEB], { neverCompleted: [WEB] })
    fake.plan(web, { fails: 2 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(
      `^${WEB}: its deployment ecs-svc/\\d+ failed: ECS deployment circuit breaker: tasks failed to start\\. ECS found ` +
      "no earlier deployment to roll it back to \\(as on a service's first deployment, or when the deployment " +
      'before it never completed\\), so the service stays on the failed deployment\\. '
    ))
    expect(fake.calls.updates).toHaveLength(1)
  })
})

describe('a rollout that ends short, and is stopped', () => {
  it('sends every service this deploy moved back at the bound, the stalled one included, and fails', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(worker, { never: true })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(
      `^ECS did not finish rolling out deployment ecs-svc/\\d+ of ${WORKER} within 43m \\d+s of this deploy's first ` +
      `update \\(rolloutState IN_PROGRESS, 0 of 2 tasks running, 2 pending; latest event: `
    ))
    expect(error.message).toContain(
      `ECS was told to send ${WEB} back to example-app-prod-web:41, ${WORKER} back to example-app-prod-worker:41.`
    )
    expect(error.message.endsWith(AFTERMATH)).toBe(true)
    expect(updates().slice(2)).toEqual([`${WEB} -> example-app-prod-web:41`, `${WORKER} -> example-app-prod-worker:41`])
    // ECS took both: each service's PRIMARY deployment is its old task definition.
    expect(fake.service(web).taskDefinition).toBe(previous(WEB))
    expect(fake.service(worker).taskDefinition).toBe(previous(WORKER))
    // The wait stopped with the reserve in hand, and the send-backs took seconds.
    expect(fake.now()).toBeGreaterThanOrEqual(ROLLOUT_BUDGET_MS - SEND_BACK_RESERVE_MS)
    expect(fake.now()).toBeLessThan(ROLLOUT_BUDGET_MS)
  })

  it('shares one budget between the services, and leaves one it has no time for untouched', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(web, { lands: 43 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(`^The rollout budget ran out before ${WORKER} could be updated, so it was left as it was`))
    expect(error.message).toContain(`ECS was told to send ${WEB} back to example-app-prod-web:41.`)
    expect(fake.calls.updates.filter(({ service }) => service === WORKER)).toHaveLength(0)
    expect(fake.service(web).taskDefinition).toBe(previous(WEB))
    expect(fake.service(worker).taskDefinition).toBe(previous(WORKER))
  })

  it('never runs past the 50-minute step cap, even after a long migration', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { never: true })

    // The step started 20 minutes before the first update.
    const error = await failure(deploy({ stepStartedAt: -20 * MINUTE }))

    expect(error.message).toMatch(/within 28m \d+s of this deploy's first update/)
    expect(fake.now()).toBeLessThanOrEqual(30 * MINUTE)
  })

  it('has nothing to send back to on a first deploy, and says the new release may land unrecorded', async () => {
    app([WEB], { placeholder: [WEB] })
    fake.plan(serviceArn('prod', WEB), { never: true })

    const error = await failure(deploy())

    expect(error.message).toContain(
      `${WEB} had never been deployed before this deploy (it ran the scratch placeholder), so there is nothing to ` +
      'send it back to. If its new deployment lands, it will serve the new release with nothing recording it.'
    )
    expect(fake.calls.updates).toHaveLength(1)
  })

  it('does not send back a service that was mid-rollout when this deploy started, and says to check it', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER], { inProgress: [WEB] })
    const started = fake.service(web).deployments[0].id
    fake.plan(worker, { fails: MINUTE })
    // WEB's rollout from before this deploy is replaced by ours, which lands.
    fake.plan(web, {})

    const error = await failure(deploy())

    expect(error.message).toContain(
      `${WEB} was not sent back: when this deploy started, its deployment ${started} on example-app-prod-web:41 had ` +
      'not completed (rolloutState IN_PROGRESS), so it is not known to have been serving. Check what it serves, and ' +
      `send it back by hand if it should go back: aws ecs update-service --cluster prod --service ${WEB} ` +
      `--task-definition ${previous(WEB)}`
    )
    expect(fake.calls.updates).toHaveLength(2)
  })

  it('says a placeholder service that already landed serves the new release, unrecorded', async () => {
    const { [WORKER]: worker } = app([WEB, WORKER], { placeholder: [WEB] })
    fake.plan(worker, { fails: MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(
      `${WEB} had never been deployed before this deploy (it ran the scratch placeholder), so there is nothing to ` +
      'send it back to. It already serves the new release, with nothing recording it.'
    )
  })

  it('gives the command to send a service back by hand when ECS refuses the send-back', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(web, {})
    fake.plan(web, { refused: Object.assign(new Error('User is not authorized to perform: ecs:UpdateService'), {
      name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 }
    }) })
    fake.plan(worker, { fails: MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(
      `Could not send ${WEB} back to example-app-prod-web:41 (User is not authorized to perform: ecs:UpdateService), ` +
      `so it may keep the new release unrecorded. Send it back by hand: aws ecs update-service --cluster prod ` +
      `--service ${WEB} --task-definition ${previous(WEB)}`
    )
  })

  it('confirms a send-back by reading the service when ECS\'s answer does not show it', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(web, {})
    fake.plan(web, { bareAnswer: true })
    fake.plan(worker, { fails: MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(`ECS was told to send ${WEB} back to example-app-prod-web:41.`)
    expect(fake.service(web).taskDefinition).toBe(previous(WEB))
  })

  it('does not count a send-back ECS answered but did not take', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(web, {})
    fake.plan(web, { ignored: true })
    fake.plan(worker, { fails: MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(
      `Could not send ${WEB} back to example-app-prod-web:41 (ECS answered, but the service runs ` +
      'example-app-prod-web:42), so it may keep the new release unrecorded. Send it back by hand:'
    )
    expect(error.message).not.toContain('ECS was told to send')
  })

  it('throws a refused first update as it came, having moved nothing', async () => {
    const { [WEB]: web } = app([WEB])
    const refused = Object.assign(new Error('The service is draining.'), {
      name: 'InvalidParameterException', $metadata: { httpStatusCode: 400 }
    })
    fake.plan(web, { refused })

    await expect(deploy()).rejects.toBe(refused)
    expect(fake.calls.updates).toHaveLength(1)
  })

  it('sends back a service whose update failed for a passing reason, since it may have gone through', async () => {
    const { [WEB]: web, [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(worker, { refused: Object.assign(new Error('Service Unavailable'), { name: 'ServerException', $metadata: { httpStatusCode: 503 } }) })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(`^Could not update ${WORKER}: Service Unavailable\\. `))
    expect(error.message).toContain(
      `ECS was told to send ${WEB} back to example-app-prod-web:41, ${WORKER} back to example-app-prod-worker:41.`
    )
    expect(fake.service(web).taskDefinition).toBe(previous(WEB))
    // The worker never moved, so its send-back changed nothing.
    expect(fake.service(worker).deployments).toHaveLength(1)
  })
})

describe('another deployment replacing ours', () => {
  it('stops at once and sends nothing back when the new deployment runs another task definition', async () => {
    const { [WORKER]: worker } = app([WEB, WORKER])
    fake.plan(worker, { supersededAfter: 2 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(
      `^${WORKER}: another deployment \\(ecs-svc/\\d+, task definition example-app-prod-worker:43\\) replaced this ` +
      "deploy's deployment \\(ecs-svc/\\d+\\) while it rolled out, so this deploy's release is no longer the one " +
      `rolling out\\. Nothing was sent back\\. ${WEB} already landed on the new release, and stays there\\. Check ` +
      'what the services are serving before running it again\\. '
    ))
    expect(error.message.endsWith(AFTERMATH)).toBe(true)
    expect(fake.calls.updates).toHaveLength(2)
    expect(fake.now()).toBe(ROLLOUT_MS + 2 * MINUTE)
  })

  it('stops as superseded when UpdateService\'s answer lacked ours and the first look shows another task definition', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { bareAnswer: true, supersededAfter: 0 })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(
      `^${WEB}: another deployment \\(ecs-svc/\\d+, task definition example-app-prod-web:43\\) replaced this ` +
      "deploy's deployment while it rolled out"
    ))
    expect(fake.now()).toBe(0)
    expect(fake.calls.updates).toHaveLength(1)
  })

  it('does not flip back to the deployment it stopped following when a stale read still shows it', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { resentAfter: 2 * MINUTE })
    // Taken while ours was still PRIMARY, shown after the re-send.
    fake.staleReads(web, { capturedAt: MINUTE, from: 2 * MINUTE + 20 * 1000, reads: 2 })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(followed()).toHaveLength(1)
    expect(fake.now()).toBe(2 * MINUTE + ROLLOUT_MS)
  })

  it('follows a new deployment that runs this deploy\'s task definition, as after a Terraform apply, and lands', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { resentAfter: 2 * MINUTE })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })

    const [first, second] = [...new Set(infos().flatMap(line => line.match(/ecs-svc\/\d+/g) ?? []))]
    expect(infos()).toContainEqual(
      `${WEB}: another update replaced deployment ${first} with ${second}, which runs this deploy's task definition ` +
      `(example-app-prod-web:42), so the wait follows ${second} now.`
    )
    expect(infos()).toContainEqual(expect.stringMatching(new RegExp(`^${WEB}: deployment ${second} completed, 3m 30s after`)))
    expect(fake.now()).toBe(2 * MINUTE + ROLLOUT_MS)
    expect(aws.eventBridgeUpdateTarget).toHaveBeenCalledTimes(1)
  })

  it('keeps the same rules for the deployment it follows: the breaker failing it is a failure', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { resentAfter: MINUTE, then: { fails: 3 * MINUTE } })

    const error = await failure(deploy())

    expect(error.message).toMatch(new RegExp(
      `^${WEB}: its deployment (ecs-svc/\\d+) failed: ECS deployment circuit breaker: tasks failed to start\\. ECS is ` +
      'rolling the service back to the deployment that served before this deploy'
    ))
    expect(fake.now()).toBe(4 * MINUTE)
  })

  it('keeps the same budget for the deployment it follows, and sends the service back at the bound', async () => {
    const { [WEB]: web } = app([WEB])
    fake.plan(web, { resentAfter: 10 * MINUTE, then: { never: true } })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^ECS did not finish rolling out deployment ecs-svc\/\d+ of example-app-prod-web-abcd within 43m \d+s/)
    expect(error.message).toContain(`ECS was told to send ${WEB} back to example-app-prod-web:41.`)
    expect(fake.now()).toBeLessThan(ROLLOUT_BUDGET_MS)
  })
})

describe('the scheduled tasks', () => {
  it.each([
    ['the breaker fails a deployment', { fails: 2 * MINUTE }],
    ['the bound is reached', { never: true }],
    ['another deployment replaces ours', { supersededAfter: MINUTE }]
  ])('are not re-pointed when the services do not land: %s', async (_, plan) => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), plan)

    await failure(deploy())

    expect(aws.eventBridgeUpdateTarget).not.toHaveBeenCalled()
  })
})

describe('reading the service while it rolls out', () => {
  const awsError = (name, status) => Object.assign(new Error(`${name}: it said no`), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } })
  })

  it.each([
    ['AccessDeniedException', 400],
    ['ClusterNotFoundException', 400],
    ['InvalidParameterException', 400],
    ['UnrecognizedClientException', 403]
  ])('fails at once, sending nothing back, on a %s (%i): the rollout\'s state is unknown', async (name, status) => {
    app([WEB, WORKER])
    fake.plan(serviceArn('prod', WORKER), { lands: 10 * MINUTE })
    const error = awsError(name, status)
    // From two minutes into the worker's rollout.
    fake.failReads(error, { from: ROLLOUT_MS + 2 * MINUTE })

    const thrown = await failure(deploy())

    expect(thrown.message).toBe(
      `${WORKER}: could not read the service while waiting for its rollout (${name}: it said no). The rollout's ` +
      'state is unknown: its new deployment may still land, and nothing would record it. Nothing was sent back, ' +
      `since that could take the service off a release that did land. ${WEB} already landed on the new release, ` +
      `and stays there. Check what the services are serving. ${AFTERMATH}`
    )
    expect(thrown.cause).toBe(error)
    expect(fake.calls.updates).toHaveLength(2)
  })

  it.each([
    ['a 429', 'TooManyRequestsException', 429],
    ['a ThrottlingException sent as a 400', 'ThrottlingException', 400],
    ['a 5xx', 'ServerException', 500],
    ['a network error, with no status', 'ECONNRESET', undefined],
    ['the quick read\'s own time limit', 'AbortError', undefined]
  ])('keeps polling through %s, and lands', async (_, name, status) => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { lands: 5 * MINUTE })
    fake.failReads(awsError(name, status), { from: MINUTE, until: 3 * MINUTE })

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(5 * MINUTE)
  })
})

describe('the scheduled tasks on a rollback', () => {
  const MOVED = 'The scheduled tasks were moved to the rollback target anyway, as a rollback always moves them, ' +
    'while a service may still be on the release being rolled back from.'

  it.each([
    ['the breaker fails its deployment', { fails: 2 * MINUTE }],
    ['it reaches the bound', { never: true }],
    ['its update fails', {
      refused: Object.assign(new Error('Service Unavailable'), { name: 'ServerException', $metadata: { httpStatusCode: 503 } })
    }]
  ])('are moved to the rollback target even when %s, and the step still fails', async (_, plan) => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), plan)

    const error = await failure(rollback())

    expect(repointed()).toEqual([JOB_RELEASE])
    expect(error.message.endsWith(MOVED)).toBe(true)
    expect(error.message).not.toContain('scheduled tasks were not re-pointed')
  })

  it('are moved when a read fails for good, too', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { never: true })
    fake.failReads(Object.assign(new Error('AccessDeniedException: no'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } }), { from: MINUTE })

    const error = await failure(rollback())

    expect(repointed()).toEqual([JOB_RELEASE])
    expect(error.message).toMatch(/could not read the service while waiting for its rollout/)
    expect(error.message.endsWith(MOVED)).toBe(true)
  })

  it('are left alone when another update took the service over', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { supersededAfter: MINUTE })

    const error = await failure(rollback())

    expect(aws.eventBridgeUpdateTarget).not.toHaveBeenCalled()
    expect(error.message.endsWith(AFTERMATH)).toBe(true)
  })

  it('say so when moving them fails', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { fails: 2 * MINUTE })
    aws.eventBridgeUpdateTarget.mockRejectedValue(new Error('Rule does not exist'))

    const error = await failure(rollback())

    expect(error.message).toContain(
      'Moving the scheduled tasks to the rollback target failed (Rule does not exist), so some of them may still ' +
      'run the release being rolled back from.'
    )
  })

  it('are moved once, after the services land, on a rollback that lands', async () => {
    app([WEB])

    await rollback()

    expect(repointed()).toEqual([JOB_RELEASE])
  })
})

describe('a rollback, which never stops its rollout', () => {
  it('waits in full, and records a late landing as a normal success', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { lands: 30 * MINUTE })

    await expect(rollback()).resolves.toMatchObject({ services: [WEB] })
    expect(fake.now()).toBe(30 * MINUTE)
  })

  it('sends nothing back at the bound, and says its new deployment may still land unrecorded', async () => {
    app([WEB, WORKER])
    fake.plan(serviceArn('prod', WORKER), { never: true })

    const error = await failure(rollback())

    expect(error.message).toContain(
      'This deploy does not stop a rollout (a rollback), so nothing was sent back: that would be the release it is ' +
      `rolling back from. Its new deployment may still land, and nothing will record it. ${WEB} already landed on ` +
      "this rollback's release, and stays there. Check what the services are serving."
    )
    expect(fake.calls.updates).toHaveLength(2)
  })

  it('sends nothing back when its own deployment fails, and says plainly production is on the old release again', async () => {
    app([WEB, WORKER])
    fake.plan(serviceArn('prod', WORKER), { fails: 4 * MINUTE })

    const error = await failure(rollback())

    expect(error.message).toMatch(new RegExp(`^${WORKER}: its deployment ecs-svc/\\d+ failed: ECS deployment circuit breaker`))
    expect(error.message).toContain(
      `ECS is taking ${WORKER} back to the release this rollback set out to replace, so production is on that ` +
      `release again. ${WEB} already landed on this rollback's release, and stays there.`
    )
    expect(fake.calls.updates).toHaveLength(2)
  })
})

// A companion image the app image names (src/v2/companions.js) is registered
// into its own family with the scheduled tasks: once every service lands, or
// however a rollback ends.
describe('the companions', () => {
  const COMPANION = `${REGISTRY}/example-app/agent@sha256:${'c'.repeat(64)}`
  const AGENT = 'example-app-prod-agent'
  const NOT_MOVED = `The companions (${AGENT}) were not re-registered either: they still run the task definitions ` +
    'they ran before this deploy.'
  const registered = () => aws.ecsRegisterTaskDefinition.mock.calls
    .map(([definition]) => definition)
    .filter(definition => definition.family === AGENT)
    .map(definition => definition.containerDefinitions[0].image)
  const warnings = () => core.warning.mock.calls.map(([message]) => message)

  beforeEach(() => openImage.mockResolvedValue({ labels: { 'org.cru.companion.agent': COMPANION } }))
  afterEach(() => {
    openImage.mockResolvedValue({ labels: {} })
    ecrDigestExists.mockResolvedValue(true)
  })

  it('are registered once, after every service has landed and the scheduled tasks are re-pointed', async () => {
    app([WEB, WORKER])

    await deploy()

    expect(registered()).toEqual([COMPANION])
    const at = aws.ecsRegisterTaskDefinition.mock.calls.findIndex(([definition]) => definition.family === AGENT)
    expect(aws.ecsRegisterTaskDefinition.mock.invocationCallOrder[at])
      .toBeGreaterThan(aws.eventBridgeUpdateTarget.mock.invocationCallOrder[0])
  })

  it.each([
    ['the breaker fails a deployment', { fails: 2 * MINUTE }],
    ['the bound is reached', { never: true }],
    ['another deployment replaces ours', { supersededAfter: MINUTE }]
  ])('are left as they were when the services do not land: %s, and the failure says so', async (_, plan) => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), plan)

    const error = await failure(deploy())

    expect(registered()).toEqual([])
    expect(error.message.endsWith(NOT_MOVED)).toBe(true)
  })

  it('are moved on a rollback however its rollout ends', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { fails: 2 * MINUTE })

    const error = await failure(rollback())

    expect(registered()).toEqual([COMPANION])
    expect(error.message).not.toContain(NOT_MOVED)
  })

  it('are left alone on a rollback when another update took the service over', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { supersededAfter: MINUTE })

    const error = await failure(rollback())

    expect(registered()).toEqual([])
    expect(error.message.endsWith(NOT_MOVED)).toBe(true)
  })

  it('fail a deploy whose services landed when one cannot be registered', async () => {
    app([WEB])
    aws.ecsRegisterTaskDefinition.mockImplementation(async definition => {
      if (definition.family === AGENT) throw new Error('ThrottlingException')
      return taskDefinitionArn(definition.family, 42)
    })

    const error = await failure(deploy())

    expect(error.message).toBe(`Could not register companion agent (${AGENT}): ThrottlingException`)
  })

  it('never fail a rollback: a registration that fails is a warning', async () => {
    app([WEB])
    aws.ecsRegisterTaskDefinition.mockImplementation(async definition => {
      if (definition.family === AGENT) throw new Error('ThrottlingException')
      return taskDefinitionArn(definition.family, 42)
    })

    await expect(rollback()).resolves.toMatchObject({ services: [WEB] })
    expect(warnings()).toContain('companion agent left as it is for this rollback: ThrottlingException')
  })

  it('never fail a rollback: a label that breaks the contract is a warning, and nothing is registered', async () => {
    app([WEB])
    openImage.mockResolvedValue({ labels: { 'org.cru.companion.agent': `${REGISTRY}/other-app/agent@sha256:${'c'.repeat(64)}` } })

    await expect(rollback()).resolves.toMatchObject({ services: [WEB] })
    expect(registered()).toEqual([])
    expect(warnings()).toEqual([expect.stringMatching(/^companions left as they are for this rollback: .*is not one name under "example-app\/"/)])
  })

  it('never fail a rollback: an image no longer in the registry is a warning', async () => {
    app([WEB])
    ecrDigestExists.mockResolvedValue(false)

    await expect(rollback()).resolves.toMatchObject({ services: [WEB] })
    expect(registered()).toEqual([])
    expect(warnings()).toEqual([`companions left as they are for this rollback: Companion agent's image ${COMPANION} is not in the registry`])
  })

  it('are still registered when re-pointing the scheduled tasks fails, and the deploy fails on that', async () => {
    app([WEB])
    aws.eventBridgeUpdateTarget.mockRejectedValue(new Error('Rule does not exist'))

    const error = await failure(deploy())

    expect(registered()).toEqual([COMPANION])
    expect(error.message).toBe('Rule does not exist')
  })

  it('are still moved on a rollback when moving the scheduled tasks fails', async () => {
    app([WEB])
    fake.plan(serviceArn('prod', WEB), { fails: 2 * MINUTE })
    aws.eventBridgeUpdateTarget.mockRejectedValue(new Error('Rule does not exist'))

    const error = await failure(rollback())

    expect(registered()).toEqual([COMPANION])
    expect(error.message).toContain('Moving the scheduled tasks to the rollback target failed (Rule does not exist)')
    expect(error.message).not.toContain(NOT_MOVED)
  })

  it('are not looked for when the image cannot be read, which is a warning and not a failure', async () => {
    app([WEB])
    openImage.mockRejectedValue(new Error('registry unreachable'))

    await expect(deploy()).resolves.toMatchObject({ services: [WEB] })
    expect(registered()).toEqual([])
    expect(warnings()).toContain("could not read the image's labels, so no companion images were looked for: registry unreachable")
  })
})
