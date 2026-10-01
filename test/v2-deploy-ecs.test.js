import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for every ECS / EventBridge SDK op. src/ecs-config.js is
// partially mocked: runtimeSecrets is stubbed, ecsCluster (pure) stays real.
// src/v2/aws.js (composeTaskDefinition / isEcsAppContainer / ecsServiceRegExp)
// and src/v2/env.js run for real, so the compose semantics are exercised end to
// end.
vi.mock('../src/aws.js', () => ({
  ecsListServices: vi.fn(),
  ecsServiceTaskDefinitions: vi.fn(),
  ecsDescribeServices: vi.fn(),
  ecsDescribeTaskDefinition: vi.fn(),
  ecsRegisterTaskDefinition: vi.fn(),
  ecsRunTask: vi.fn(),
  ecsDescribeTasks: vi.fn(),
  ecsWaitUntilTasksStopped: vi.fn(),
  ecsUpdateService: vi.fn(),
  ecsDescribeService: vi.fn(),
  isPermanentAwsError: vi.fn(),
  eventBridgeListRules: vi.fn(),
  eventBridgeListTargets: vi.fn(),
  eventBridgeUpdateTarget: vi.fn(),
  ssmParameterValue: vi.fn()
}))

// No registry reads: openImage is covered by test/v2-oci.test.js (ECR transport
// included). Mocked here so the gate tests can assert it is NOT called.
vi.mock('../src/v2/oci.js', () => ({ openImage: vi.fn() }))

// Stub only the publish call; sourceMapsEndpointFor and TOKEN_SECRET stay real
// so the ROLLBAR_ENDPOINT detection path is exercised here for real. The upload
// itself is covered in depth by test/v2-sourcemaps.test.js.
vi.mock('../src/v2/sourcemaps.js', async importOriginal => ({
  ...(await importOriginal()),
  publishSourceMaps: vi.fn()
}))

vi.mock('../src/ecs-config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runtimeSecrets: vi.fn()
}))

// @aws-sdk/client-ecs is NOT mocked here, so deploy-ecs.js's `ClientException`
// and the one we throw below are the same real class (instanceof holds).
import { ClientException } from '@aws-sdk/client-ecs'
import * as aws from '../src/aws.js'
import { DEFAULT_ACCOUNT, ecrRegistry, runtimeSecrets } from '../src/ecs-config.js'
import { openImage } from '../src/v2/oci.js'
import { publishSourceMaps } from '../src/v2/sourcemaps.js'
import { deployEcs } from '../src/v2/deploy-ecs.js'

const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)
const IMAGE = `${REGISTRY}/example-app@sha256:new`
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:000000000000:service/prod/example-app-production-web'
const SECRETS = [{ name: 'DATABASE_URL', valueFrom: '/ecs/example-app/prod/DATABASE_URL' }]

// No ROLLBAR_ACCESS_TOKEN in SECRETS, so every test that does not opt in to the
// source-map suite below reports a skip.
const SKIPPED = { status: 'skipped', uploaded: 0, failed: 0 }

// The RUNTIME parameter whose presence says this environment is wired for error
// tracking. runtimeSecrets returns names AND their SSM paths, so the gate costs
// no extra call and the path never has to be rebuilt here.
const TOKEN_PARAMETER = '/ecs/example-app/prod/ROLLBAR_ACCESS_TOKEN'
const SECRETS_WITH_TOKEN = [...SECRETS, { name: 'ROLLBAR_ACCESS_TOKEN', valueFrom: TOKEN_PARAMETER }]

const APP_URL = 'https://example-app.example.org'
const TOKEN = 'server-scope-token'
const IMAGE_HANDLE = { labels: {}, readFile: vi.fn(), readDir: vi.fn() }
const UPLOADED = { status: 'uploaded', uploaded: 3, failed: 0, skipped: 0, failures: [] }

// A CURRENT task definition whose app container declares an ingestion endpoint.
// ECS spells plain env vars `environment`, not `env`.
function currentTaskDefinition (environment) {
  return {
    family: 'example-app-prod-web',
    containerDefinitions: [
      { name: 'app', image: `${REGISTRY}/example-app@sha256:old`, environment },
      {
        name: 'datadog',
        image: 'public.ecr.aws/datadog/agent:latest',
        environment: [{ name: 'ROLLBAR_ENDPOINT', value: 'https://wrong.example.org' }]
      }
    ]
  }
}

// The db-migrate family is absent by default: DescribeTaskDefinition on a missing
// family throws ClientException, which the migration phase treats as "not opted
// in -> skip". Tests that DO exercise migrations override ecsDescribeTaskDefinition.
function taskDefinitionNotFound () {
  return new ClientException({ message: 'Unable to describe task definition.', $metadata: {} })
}

// The FAMILY'S LATEST revision — Terraform's template. Carries a template-only
// field (cpu) absent from the service's pinned current revision, so asserting it
// survives proves the deploy composes from the latest family revision, not the
// running one.
function familyLatest (family) {
  return {
    taskDefinition: {
      family,
      taskDefinitionArn: `arn:aws:ecs:us-east-1:1:task-definition/${family}:9`,
      revision: 9,
      status: 'ACTIVE',
      requiresAttributes: [{ name: 'x' }],
      compatibilities: ['FARGATE'],
      cpu: '512',
      containerDefinitions: [
        { name: 'app', image: 'scratch', secrets: [] },
        { name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' }
      ]
    },
    tags: [{ key: 'managed-by', value: 'terraform' }]
  }
}

beforeEach(() => {
  for (const fn of Object.values(aws)) fn.mockReset()
  runtimeSecrets.mockReset()
  runtimeSecrets.mockResolvedValue(SECRETS)
  openImage.mockReset()
  openImage.mockResolvedValue(IMAGE_HANDLE)
  publishSourceMaps.mockReset()
  publishSourceMaps.mockResolvedValue(UPLOADED)
  IMAGE_HANDLE.readDir.mockReset()
  aws.ecsRegisterTaskDefinition.mockImplementation(td => Promise.resolve(`arn:aws:ecs:us-east-1:1:task-definition/${td.family}:10`))
  // Every update lands on the first look: the rollout wait itself is covered
  // by test/v2-ecs-rollout.test.js.
  const deployment = (taskDefinition, rolloutState) => ({ id: 'ecs-svc/2', status: 'PRIMARY', taskDefinition, rolloutState })
  aws.ecsUpdateService.mockImplementation(async (serviceArn, cluster, taskDefinition) => ({
    serviceArn,
    taskDefinition,
    deployments: [deployment(taskDefinition, 'IN_PROGRESS')]
  }))
  aws.ecsDescribeService.mockImplementation(async serviceArn => {
    const [, , taskDefinition] = aws.ecsUpdateService.mock.calls.findLast(([arn]) => arn === serviceArn)
    return { serviceArn, status: 'ACTIVE', taskDefinition, deployments: [deployment(taskDefinition, 'COMPLETED')] }
  })
  // The read of each service's deployments right before the updates.
  aws.ecsDescribeServices.mockResolvedValue([])
  aws.eventBridgeUpdateTarget.mockResolvedValue({})
})

describe('deployEcs digest invariant', () => {
  it('rejects a tag reference before touching infrastructure', async () => {
    await expect(
      deployEcs({ projectName: 'example-app', environment: 'production', image: `${REGISTRY}/example-app:release-3` })
    ).rejects.toThrow(/digest-pinned/)
    expect(aws.ecsListServices).not.toHaveBeenCalled()
  })
})

describe('deployEcs compose-from-family-latest semantics', () => {
  beforeEach(() => {
    aws.ecsListServices.mockResolvedValue([SERVICE_ARN])
    // Current (pinned) revision — only its family matters.
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { family: 'example-app-prod-web' } })
    aws.ecsDescribeTaskDefinition.mockImplementation(family =>
      family.endsWith('-db-migrate')
        ? Promise.reject(taskDefinitionNotFound())
        : Promise.resolve(familyLatest(family))
    )
    aws.eventBridgeListRules.mockResolvedValue([])
    aws.eventBridgeListTargets.mockResolvedValue([])
  })

  it('composes from the family LATEST revision, swaps only the app image, refreshes secrets, preserves sidecars', async () => {
    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    // production -> nickname prod -> cluster prod
    expect(aws.ecsListServices).toHaveBeenCalledWith(expect.any(RegExp), 'prod')
    expect(runtimeSecrets).toHaveBeenCalledWith('example-app', 'prod')

    // The family's LATEST revision is described by the BARE family name.
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith('example-app-prod-web')

    const registered = aws.ecsRegisterTaskDefinition.mock.calls[0][0]
    // read-only fields stripped
    expect(registered).not.toHaveProperty('taskDefinitionArn')
    expect(registered).not.toHaveProperty('revision')
    // template-only field survives -> we composed from family latest
    expect(registered.cpu).toBe('512')
    // template tags carried over
    expect(registered.tags).toEqual([{ key: 'managed-by', value: 'terraform' }])
    // only the app container swapped; secrets refreshed
    expect(registered.containerDefinitions[0]).toEqual({ name: 'app', image: IMAGE, secrets: SECRETS })
    // sidecar untouched
    expect(registered.containerDefinitions[1]).toEqual({ name: 'fluentbit', image: 'amazon/aws-for-fluent-bit:latest' })

    // service updated to the newly-registered revision
    const registered10 = await aws.ecsRegisterTaskDefinition.mock.results[0].value
    expect(registered10).toMatch(/:task-definition\/example-app-prod-web:10$/)
    expect(aws.ecsUpdateService).toHaveBeenCalledWith(SERVICE_ARN, 'prod', registered10, { timeoutMs: expect.any(Number) })
    expect(result).toEqual({ deployedImage: IMAGE, services: ['example-app-production-web'], sourcemaps: SKIPPED })
  })

  it('fails clearly when a service has no resolvable task-definition family', async () => {
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { error: new Error('boom') } })
    await expect(
      deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/Could not determine the task-definition family/)
  })
})


describe('deployEcs scheduled tasks', () => {
  beforeEach(() => {
    aws.ecsListServices.mockResolvedValue([])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({})
    aws.ecsDescribeTaskDefinition.mockImplementation(family =>
      family.endsWith('-db-migrate')
        ? Promise.reject(taskDefinitionNotFound())
        : Promise.resolve(familyLatest(family))
    )
  })

  it('re-points EventBridge scheduled tasks to a new revision from the target family latest', async () => {
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-example-app-prod-nightly' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      { Id: 'target-1', EcsParameters: { TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-job:3' } }
    ])

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    // rule prefix is ecstask-<project>-<nickname>
    expect(aws.eventBridgeListRules).toHaveBeenCalledWith('ecstask-example-app-prod')
    // family parsed from the target's task-def ARN, then LATEST described by name
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith('example-app-prod-job')

    const [ruleName, target] = aws.eventBridgeUpdateTarget.mock.calls[0]
    expect(ruleName).toBe('ecstask-example-app-prod-nightly')
    expect(target.EcsParameters.TaskDefinitionArn).toBe('arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-job:10')

    const registered = aws.ecsRegisterTaskDefinition.mock.calls[0][0]
    expect(registered.containerDefinitions[0]).toEqual({ name: 'app', image: IMAGE, secrets: SECRETS })
  })
})

// Pre-deploy migration phase — the db-migrate family runs to completion BEFORE
// any service is updated; a failure fails the deploy with services untouched.
describe('deployEcs pre-deploy database migrations', () => {
  const MIGRATE_ARN = 'arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-db-migrate:10'
  const TASK_ARN = 'arn:aws:ecs:us-east-1:1:task/prod/abc123'
  const NETWORK_CONFIG = {
    awsvpcConfiguration: { subnets: ['subnet-1'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' }
  }
  // The shape of a legacy EC2 capacity-provider service:
  // launchType null, capacityProviderStrategy set, and NO networkConfiguration
  // at all because the task definition runs in bridge mode.
  const CAPACITY_PROVIDER_STRATEGY = [
    { capacityProvider: 'cp-ecs-stage-app-a', weight: 1, base: 1 },
    { capacityProvider: 'cp-ecs-stage-app-b', weight: 1, base: 0 }
  ]

  // The db-migrate family: a single container (named db-migrate) starting from
  // the scratch placeholder, so composeTaskDefinition swaps its image + secrets.
  function dbMigrateFamilyLatest (family) {
    return {
      taskDefinition: {
        family,
        taskDefinitionArn: `arn:aws:ecs:us-east-1:1:task-definition/${family}:9`,
        revision: 9,
        status: 'ACTIVE',
        cpu: '256',
        memory: '512',
        containerDefinitions: [{ name: 'db-migrate', image: 'scratch', secrets: [] }]
      },
      tags: [{ key: 'managed-by', value: 'terraform' }]
    }
  }

  const migrateRegistration = () =>
    aws.ecsRegisterTaskDefinition.mock.calls.map(c => c[0]).find(td => td.family === 'example-app-prod-db-migrate')

  beforeEach(() => {
    // Family PRESENT; one matching service to borrow run config from; migration
    // runs, stops cleanly, exits 0.
    aws.ecsListServices.mockResolvedValue([SERVICE_ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { family: 'example-app-prod-web' } })
    aws.ecsDescribeTaskDefinition.mockImplementation(family =>
      family.endsWith('-db-migrate')
        ? Promise.resolve(dbMigrateFamilyLatest(family))
        : Promise.resolve(familyLatest(family))
    )
    aws.ecsDescribeServices.mockResolvedValue([{ networkConfiguration: NETWORK_CONFIG, launchType: 'FARGATE' }])
    aws.ecsRunTask.mockResolvedValue({ tasks: [{ taskArn: TASK_ARN }] })
    aws.ecsWaitUntilTasksStopped.mockResolvedValue({ state: 'SUCCESS' })
    aws.ecsDescribeTasks.mockResolvedValue({ tasks: [{ containers: [{ name: 'db-migrate', exitCode: 0 }] }] })
    aws.eventBridgeListRules.mockResolvedValue([])
    aws.eventBridgeListTargets.mockResolvedValue([])
  })

  it('skips when the db-migrate family does not exist (app not opted in)', async () => {
    aws.ecsDescribeTaskDefinition.mockImplementation(family =>
      family.endsWith('-db-migrate')
        ? Promise.reject(taskDefinitionNotFound())
        : Promise.resolve(familyLatest(family))
    )

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(aws.ecsRunTask).not.toHaveBeenCalled()
    // the deploy still updates the app's services
    expect(result).toEqual({ deployedImage: IMAGE, services: ['example-app-production-web'], sourcemaps: SKIPPED })
  })

  it('composes from family latest, runs one task, waits, and requires exit 0 BEFORE updating services', async () => {
    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    // family looked up by the bare convention name
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith('example-app-prod-db-migrate')

    // composed with the release digest + refreshed secrets, like services
    expect(migrateRegistration().containerDefinitions[0]).toEqual({ name: 'db-migrate', image: IMAGE, secrets: SECRETS })

    // one task, borrowed run config, deterministic startedBy
    expect(aws.ecsRunTask).toHaveBeenCalledWith({
      cluster: 'prod',
      taskDefinition: MIGRATE_ARN,
      count: 1,
      startedBy: 'cru-pipeline-v2',
      networkConfiguration: NETWORK_CONFIG,
      launchType: 'FARGATE'
    })
    expect(aws.ecsWaitUntilTasksStopped).toHaveBeenCalledWith('prod', [TASK_ARN])
    expect(aws.ecsDescribeTasks).toHaveBeenCalledWith('prod', [TASK_ARN])

    // migrations ran to completion BEFORE any service update
    expect(aws.ecsRunTask.mock.invocationCallOrder[0])
      .toBeLessThan(aws.ecsUpdateService.mock.invocationCallOrder[0])
    expect(result.services).toEqual(['example-app-production-web'])
  })

  // A bridge-mode service is a valid thing to borrow from, not a miss: most
  // legacy Cru ECS apps run EC2 capacity-provider services whose task defs use
  // ECS's default bridge network mode, so DescribeServices reports no
  // networkConfiguration and RunTask must not be given one.
  it('borrows a bridge service capacity provider strategy and sends NO network configuration', async () => {
    aws.ecsDescribeServices.mockResolvedValue([
      { launchType: null, capacityProviderStrategy: CAPACITY_PROVIDER_STRATEGY, networkConfiguration: undefined }
    ])

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(aws.ecsRunTask).toHaveBeenCalledWith({
      cluster: 'prod',
      taskDefinition: MIGRATE_ARN,
      count: 1,
      startedBy: 'cru-pipeline-v2',
      capacityProviderStrategy: CAPACITY_PROVIDER_STRATEGY
    })
    // RunTask rejects networkConfiguration on a non-awsvpc task definition, so
    // the key must be ABSENT — toHaveBeenCalledWith alone would tolerate a
    // present-but-undefined one.
    expect(aws.ecsRunTask.mock.calls[0][0]).not.toHaveProperty('networkConfiguration')
    // the service answered, so the scheduled-task fallback was never consulted
    expect(aws.ecsRunTask.mock.invocationCallOrder[0])
      .toBeLessThan(aws.eventBridgeListRules.mock.invocationCallOrder[0])
  })

  it('borrows a bridge service plain launchType when it has no capacity provider strategy', async () => {
    aws.ecsDescribeServices.mockResolvedValue([{ launchType: 'EC2', capacityProviderStrategy: [] }])

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(aws.ecsRunTask).toHaveBeenCalledWith({
      cluster: 'prod',
      taskDefinition: MIGRATE_ARN,
      count: 1,
      startedBy: 'cru-pipeline-v2',
      launchType: 'EC2'
    })
    expect(aws.ecsRunTask.mock.calls[0][0]).not.toHaveProperty('networkConfiguration')
  })

  it('throws and leaves services untouched when the migration exits nonzero', async () => {
    aws.ecsDescribeTasks.mockResolvedValue({
      tasks: [{ stoppedReason: 'Essential container in task exited', containers: [{ name: 'db-migrate', exitCode: 1, reason: 'boom' }] }]
    })

    await expect(
      deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/Database migrations failed/)

    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
  })

  it('throws when the wait does not reach SUCCESS (timeout / task failure)', async () => {
    aws.ecsWaitUntilTasksStopped.mockResolvedValue({ state: 'TIMEOUT' })

    await expect(
      deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/did not stop cleanly/)

    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
  })

  it('falls back to the EventBridge scheduled-task network config for a jobs-only app', async () => {
    aws.ecsListServices.mockResolvedValue([])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({})
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-example-app-prod-nightly' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      {
        Id: 'target-1',
        EcsParameters: {
          TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-job:3',
          // EventBridge uses PascalCase awsvpc keys; RunTask needs camelCase.
          NetworkConfiguration: { awsvpcConfiguration: { Subnets: ['subnet-9'], SecurityGroups: ['sg-9'], AssignPublicIp: 'ENABLED' } },
          LaunchType: 'FARGATE'
        }
      }
    ])

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    // no service to borrow from, so ecsDescribeServices is never consulted
    expect(aws.ecsDescribeServices).not.toHaveBeenCalled()
    expect(aws.ecsRunTask).toHaveBeenCalledWith(expect.objectContaining({
      taskDefinition: MIGRATE_ARN,
      count: 1,
      startedBy: 'cru-pipeline-v2',
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: { subnets: ['subnet-9'], securityGroups: ['sg-9'], assignPublicIp: 'ENABLED' }
      }
    }))
  })

  it('falls back to a BRIDGE scheduled-task target (no NetworkConfiguration) for a jobs-only app', async () => {
    aws.ecsListServices.mockResolvedValue([])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({})
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-example-app-prod-nightly' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      {
        Id: 'target-1',
        EcsParameters: {
          TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-job:3',
          // An EC2/bridge target carries a launch type and nothing else.
          LaunchType: 'EC2'
        }
      }
    ])

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    const params = aws.ecsRunTask.mock.calls[0][0]
    expect(params).toMatchObject({ taskDefinition: MIGRATE_ARN, count: 1, launchType: 'EC2' })
    expect(params).not.toHaveProperty('networkConfiguration')
  })

  it('throws a clear error when there is no service or scheduled task to borrow run config from', async () => {
    aws.ecsListServices.mockResolvedValue([])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({})
    aws.eventBridgeListRules.mockResolvedValue([])
    aws.eventBridgeListTargets.mockResolvedValue([])

    await expect(
      deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/no service or scheduled task to borrow run configuration from/)

    expect(aws.ecsRunTask).not.toHaveBeenCalled()
    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
  })
})

describe('deployEcs source maps', () => {
  beforeEach(() => {
    aws.ecsListServices.mockResolvedValue([SERVICE_ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { family: 'example-app-prod-web' } })
    aws.ecsDescribeTaskDefinition.mockImplementation(family =>
      family.endsWith('-db-migrate')
        ? Promise.reject(taskDefinitionNotFound())
        : Promise.resolve(familyLatest(family))
    )
    aws.eventBridgeListRules.mockResolvedValue([])
    aws.eventBridgeListTargets.mockResolvedValue([])
    runtimeSecrets.mockResolvedValue(SECRETS_WITH_TOKEN)
    aws.ssmParameterValue.mockResolvedValue(TOKEN)
  })

  it('does nothing — and reads nothing more — when the environment has no token parameter', async () => {
    // The gate is cheapest-first on purpose: runtimeSecrets already told us the
    // parameter NAMES, so an app with no error tracking pays no call for it.
    // The one image read is the companion label check, which every deploy makes.
    runtimeSecrets.mockResolvedValue(SECRETS)

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(aws.ssmParameterValue).not.toHaveBeenCalled()
    expect(openImage).toHaveBeenCalledTimes(1)
    expect(IMAGE_HANDLE.readDir).not.toHaveBeenCalled()
    expect(publishSourceMaps).not.toHaveBeenCalled()
    expect(result.sourcemaps).toEqual(SKIPPED)
  })

  it('reads the token from the SSM path runtimeSecrets already resolved', async () => {
    // Not rebuilt here: /ecs/<project>/<nick>/<KEY> uses the Terraform nickname
    // (prod), which is neither the v2 name (production) nor the legacy one.
    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(aws.ssmParameterValue).toHaveBeenCalledWith(TOKEN_PARAMETER)
    expect(publishSourceMaps).toHaveBeenCalledWith({
      oci: IMAGE_HANDLE,
      appUrl: APP_URL,
      token: TOKEN,
      endpoint: 'https://flightdeck.cru.org/api/1/sourcemap'
    })
    expect(result.sourcemaps).toEqual(UPLOADED)
  })

  it('spells the release-candidate path with the stage nickname', async () => {
    runtimeSecrets.mockResolvedValue([{ name: 'ROLLBAR_ACCESS_TOKEN', valueFrom: '/ecs/example-app/stage/ROLLBAR_ACCESS_TOKEN' }])

    await deployEcs({ projectName: 'example-app', environment: 'release-candidate', image: IMAGE, appUrl: APP_URL })

    expect(runtimeSecrets).toHaveBeenCalledWith('example-app', 'stage')
    expect(aws.ssmParameterValue).toHaveBeenCalledWith('/ecs/example-app/stage/ROLLBAR_ACCESS_TOKEN')
  })

  it('reads labels but no directory when the image carries no source-map label', async () => {
    // publishSourceMaps owns the label gate; what matters here is that the
    // handle is opened (config blob = labels) and nothing pulls a layer.
    publishSourceMaps.mockResolvedValue({ ...SKIPPED, reason: 'no-label' })

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(openImage).toHaveBeenCalledTimes(1)
    expect(openImage).toHaveBeenCalledWith(IMAGE)
    expect(IMAGE_HANDLE.readDir).not.toHaveBeenCalled()
    expect(result.sourcemaps.status).toBe('skipped')
  })

  it('skips with a reason when the environment has no app URL', async () => {
    // app-url is fed from the app-info lookup; an app with no AppUrl row cannot
    // have its staged paths turned into the URLs a browser reports.
    publishSourceMaps.mockResolvedValue({ ...SKIPPED, reason: 'no-app-url' })

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(publishSourceMaps.mock.calls[0][0].appUrl).toBeUndefined()
    expect(result.sourcemaps.reason).toBe('no-app-url')
  })

  it('honours the app container ROLLBAR_ENDPOINT origin, ignoring a sidecar that sets the same var', async () => {
    aws.ecsServiceTaskDefinitions.mockResolvedValue({
      [SERVICE_ARN]: currentTaskDefinition([{ name: 'ROLLBAR_ENDPOINT', value: 'https://errors.example.org/api/1/item' }])
    })

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(publishSourceMaps.mock.calls[0][0].endpoint).toBe('https://errors.example.org/api/1/sourcemap')
  })

  it('defaults the endpoint when the app container names none', async () => {
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: currentTaskDefinition([{ name: 'FOO', value: 'bar' }]) })

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(publishSourceMaps.mock.calls[0][0].endpoint).toBe('https://flightdeck.cru.org/api/1/sourcemap')
  })

  it('uploads AFTER the migration task and BEFORE the first service update', async () => {
    // Load bearing. Occurrences that arrive before their maps land are never
    // re-processed, so a new task's first seconds of errors would stay
    // unresolved forever if this ran last. Migrations still go first: a failed
    // migration must upload nothing at all.
    aws.ecsDescribeTaskDefinition.mockImplementation(family => Promise.resolve(familyLatest(family)))
    aws.ecsRunTask.mockResolvedValue({ tasks: [{ taskArn: 'arn:task/1' }] })
    aws.ecsWaitUntilTasksStopped.mockResolvedValue({ state: 'SUCCESS' })
    aws.ecsDescribeTasks.mockResolvedValue({ tasks: [{ containers: [{ name: 'db-migrate', exitCode: 0 }] }] })
    aws.ecsDescribeServices.mockResolvedValue([{ launchType: 'EC2' }])

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(aws.ecsRunTask.mock.invocationCallOrder[0])
      .toBeLessThan(publishSourceMaps.mock.invocationCallOrder[0])
    expect(publishSourceMaps.mock.invocationCallOrder[0])
      .toBeLessThan(aws.ecsUpdateService.mock.invocationCallOrder[0])
  })

  it('uploads nothing when the migration task fails', async () => {
    aws.ecsDescribeTaskDefinition.mockImplementation(family => Promise.resolve(familyLatest(family)))
    aws.ecsDescribeServices.mockResolvedValue([{ launchType: 'EC2' }])
    aws.ecsRunTask.mockResolvedValue({ tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] })

    await expect(deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL }))
      .rejects.toThrow(/Failed to start db-migrate task/)
    expect(publishSourceMaps).not.toHaveBeenCalled()
  })

  it('does not fail the deploy when the upload throws', async () => {
    publishSourceMaps.mockRejectedValue(new Error('registry unreachable'))

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(result.deployedImage).toBe(IMAGE)
    expect(result.services).toEqual(['example-app-production-web'])
    expect(aws.ecsUpdateService).toHaveBeenCalledTimes(1)
    expect(result.sourcemaps).toEqual({ status: 'failed', uploaded: 0, failed: 0 })
  })

  it('does not fail the deploy when the token cannot be read', async () => {
    aws.ssmParameterValue.mockRejectedValue(new Error('AccessDeniedException'))

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(result.services).toEqual(['example-app-production-web'])
    expect(result.sourcemaps.status).toBe('failed')
    expect(publishSourceMaps).not.toHaveBeenCalled()
  })

  it('skips silently when the parameter exists but has no value', async () => {
    aws.ssmParameterValue.mockResolvedValue(null)

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(publishSourceMaps).not.toHaveBeenCalled()
    expect(result.sourcemaps).toEqual(SKIPPED)
  })

  it('describes the service task definitions ONCE for both the endpoint read and the update', async () => {
    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(aws.ecsServiceTaskDefinitions).toHaveBeenCalledTimes(1)
    expect(aws.ecsUpdateService).toHaveBeenCalledTimes(1)
  })
})

// Companion images (src/v2/companions.js). When they are registered relative to
// the rollout is covered by test/v2-ecs-rollout.test.js; this suite covers the
// contract, which is checked before anything changes.
describe('deployEcs companion images', () => {
  const WORKER_IMAGE = `${REGISTRY}/example-app-worker@sha256:${'b'.repeat(64)}`
  const WORKER_FAMILY = 'example-app-prod-worker'
  const TEMPLATE_SECRETS = [{ name: 'WORKER_TOKEN', valueFrom: '/ecs/example-app/prod/worker/WORKER_TOKEN' }]
  const labels = companions => openImage.mockResolvedValue({ ...IMAGE_HANDLE, labels: companions })

  // The companion's family as the app's Terraform leaves it: the companion
  // starting from scratch, with its own secrets, beside a sidecar.
  function workerFamilyLatest (family, containerDefinitions) {
    return {
      taskDefinition: {
        family,
        taskDefinitionArn: `arn:aws:ecs:us-east-1:1:task-definition/${family}:3`,
        revision: 3,
        status: 'ACTIVE',
        cpu: '1024',
        containerDefinitions: containerDefinitions ?? [
          { name: 'worker', image: 'scratch', secrets: TEMPLATE_SECRETS },
          { name: 'datadog', image: 'public.ecr.aws/datadog/agent:latest' }
        ]
      },
      tags: [{ key: 'managed-by', value: 'terraform' }]
    }
  }

  const describeFamilies = (worker = family => Promise.resolve(workerFamilyLatest(family))) =>
    aws.ecsDescribeTaskDefinition.mockImplementation(family => {
      if (family.endsWith('-db-migrate')) return Promise.reject(taskDefinitionNotFound())
      if (family === WORKER_FAMILY) return worker(family)
      return Promise.resolve(familyLatest(family))
    })
  const companionRegistrations = () =>
    aws.ecsRegisterTaskDefinition.mock.calls.map(([definition]) => definition).filter(definition => definition.family === WORKER_FAMILY)

  // Nothing changed: no migration, no registration, no service touched.
  function expectNothingChanged () {
    expect(aws.ecsRunTask).not.toHaveBeenCalled()
    expect(aws.ecsRegisterTaskDefinition).not.toHaveBeenCalled()
    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
    expect(aws.eventBridgeUpdateTarget).not.toHaveBeenCalled()
  }

  beforeEach(() => {
    aws.ecsListServices.mockResolvedValue([SERVICE_ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { family: 'example-app-prod-web' } })
    describeFamilies()
    aws.eventBridgeListRules.mockResolvedValue([])
    aws.eventBridgeListTargets.mockResolvedValue([])
    labels({ 'org.cru.companion.worker': WORKER_IMAGE })
  })

  it('registers the companion from its family latest, swapping only its image and keeping its own secrets', async () => {
    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(openImage).toHaveBeenCalledWith(IMAGE)
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith(WORKER_FAMILY)
    const [registered] = companionRegistrations()
    expect(registered).not.toHaveProperty('taskDefinitionArn')
    expect(registered.cpu).toBe('1024')
    expect(registered.tags).toEqual([{ key: 'managed-by', value: 'terraform' }])
    // The app's RUNTIME secrets stay with the app.
    expect(registered.containerDefinitions[0]).toEqual({ name: 'worker', image: WORKER_IMAGE, secrets: TEMPLATE_SECRETS })
    expect(registered.containerDefinitions[1]).toEqual({ name: 'datadog', image: 'public.ecr.aws/datadog/agent:latest' })
    expect(result.services).toEqual(['example-app-production-web'])
  })

  it('swaps the image of a container that already runs the companion repository', async () => {
    describeFamilies(family => Promise.resolve(workerFamilyLatest(family, [
      { name: 'worker', image: `${REGISTRY}/example-app-worker@sha256:${'0'.repeat(64)}` }
    ])))

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(companionRegistrations()[0].containerDefinitions).toEqual([{ name: 'worker', image: WORKER_IMAGE }])
  })

  it('skips a companion whose family does not exist yet', async () => {
    describeFamilies(() => Promise.reject(taskDefinitionNotFound()))

    const result = await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(companionRegistrations()).toEqual([])
    expect(result.services).toEqual(['example-app-production-web'])
  })

  it('reads labels once and shares the handle with the source-map upload', async () => {
    runtimeSecrets.mockResolvedValue(SECRETS_WITH_TOKEN)
    aws.ssmParameterValue.mockResolvedValue(TOKEN)

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE, appUrl: APP_URL })

    expect(openImage).toHaveBeenCalledTimes(1)
    expect(publishSourceMaps.mock.calls[0][0].oci.labels).toEqual({ 'org.cru.companion.worker': WORKER_IMAGE })
  })

  it('ignores labels that are not companion labels', async () => {
    labels({ 'org.cru.sourcemaps': '1.2.3', 'org.opencontainers.image.revision': 'abc' })

    await deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE })

    expect(aws.ecsDescribeTaskDefinition).not.toHaveBeenCalledWith(WORKER_FAMILY)
    expect(aws.eventBridgeListRules).toHaveBeenCalledTimes(1) // the scheduled-task re-point, not a clash check
  })

  it.each([
    ['another app\'s repository', { 'org.cru.companion.worker': `${REGISTRY}/other-app@sha256:${'b'.repeat(64)}` }, /does not start with "example-app-"/],
    ['the app\'s own repository', { 'org.cru.companion.worker': `${REGISTRY}/example-app@sha256:${'b'.repeat(64)}` }, /does not start with "example-app-"/],
    ['a tag, not a digest', { 'org.cru.companion.worker': `${REGISTRY}/example-app-worker:latest` }, /not pinned by a sha256 digest/],
    ['another registry', { 'org.cru.companion.worker': `111111111111.dkr.ecr.us-east-1.amazonaws.com/example-app-worker@sha256:${'b'.repeat(64)}` }, /not in the app image's registry/],
    ['the reserved db-migrate name', { 'org.cru.companion.db-migrate': WORKER_IMAGE }, /taken by the pipeline/],
    ['a name with capitals', { 'org.cru.companion.Worker': WORKER_IMAGE }, /lowercase letters and digits/]
  ])('fails before anything changes when a label names %s', async (_, companions, message) => {
    labels(companions)

    await expect(deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE }))
      .rejects.toThrow(message)
    expectNothingChanged()
  })

  it('fails before anything changes when a companion family is also a service family', async () => {
    labels({ 'org.cru.companion.web': `${REGISTRY}/example-app-web@sha256:${'b'.repeat(64)}` })

    await expect(deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE }))
      .rejects.toThrow('Companion families example-app-prod-web are already used by a service or scheduled task')
    expectNothingChanged()
  })

  it('fails before anything changes when a companion family is also a scheduled task family', async () => {
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-example-app-prod-worker' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      { Id: 'target-1', EcsParameters: { TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-worker:3' } }
    ])

    await expect(deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE }))
      .rejects.toThrow(/example-app-prod-worker are already used/)
    expectNothingChanged()
  })

  it('fails before anything changes when the family has no container to swap the image into', async () => {
    describeFamilies(family => Promise.resolve(workerFamilyLatest(family, [
      { name: 'datadog', image: 'public.ecr.aws/datadog/agent:latest' }
    ])))

    await expect(deployEcs({ projectName: 'example-app', environment: 'production', image: IMAGE }))
      .rejects.toThrow(/No container in task definition family example-app-prod-worker runs example-app-worker/)
    expectNothingChanged()
  })
})
