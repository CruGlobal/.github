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
  eventBridgeListRules: vi.fn(),
  eventBridgeListTargets: vi.fn(),
  eventBridgeUpdateTarget: vi.fn()
}))

vi.mock('../src/ecs-config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runtimeSecrets: vi.fn()
}))

// @aws-sdk/client-ecs is NOT mocked here, so deploy-ecs.js's `ClientException`
// and the one we throw below are the same real class (instanceof holds).
import { ClientException } from '@aws-sdk/client-ecs'
import * as aws from '../src/aws.js'
import { runtimeSecrets } from '../src/ecs-config.js'
import { deployEcs } from '../src/v2/deploy-ecs.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'
const IMAGE = `${REGISTRY}/hoax@sha256:new`
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:056154071827:service/prod/hoax-production-web'
const SECRETS = [{ name: 'DATABASE_URL', valueFrom: '/ecs/hoax/prod/DATABASE_URL' }]

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
  aws.ecsRegisterTaskDefinition.mockImplementation(td => Promise.resolve(`arn:aws:ecs:us-east-1:1:task-definition/${td.family}:10`))
  aws.ecsUpdateService.mockResolvedValue({})
  aws.eventBridgeUpdateTarget.mockResolvedValue({})
})

describe('deployEcs digest invariant', () => {
  it('rejects a tag reference before touching infrastructure', async () => {
    await expect(
      deployEcs({ projectName: 'hoax', environment: 'production', image: `${REGISTRY}/hoax:release-3` })
    ).rejects.toThrow(/digest-pinned/)
    expect(aws.ecsListServices).not.toHaveBeenCalled()
  })
})

describe('deployEcs compose-from-family-latest semantics', () => {
  beforeEach(() => {
    aws.ecsListServices.mockResolvedValue([SERVICE_ARN])
    // Current (pinned) revision — only its family matters.
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { family: 'hoax-prod-web' } })
    aws.ecsDescribeTaskDefinition.mockImplementation(family =>
      family.endsWith('-db-migrate')
        ? Promise.reject(taskDefinitionNotFound())
        : Promise.resolve(familyLatest(family))
    )
    aws.eventBridgeListRules.mockResolvedValue([])
    aws.eventBridgeListTargets.mockResolvedValue([])
  })

  it('composes from the family LATEST revision, swaps only the app image, refreshes secrets, preserves sidecars', async () => {
    const result = await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

    // production -> nickname prod -> cluster prod
    expect(aws.ecsListServices).toHaveBeenCalledWith(expect.any(RegExp), 'prod')
    expect(runtimeSecrets).toHaveBeenCalledWith('hoax', 'prod')

    // The family's LATEST revision is described by the BARE family name.
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith('hoax-prod-web')

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
    expect(aws.ecsUpdateService).toHaveBeenCalledWith(SERVICE_ARN, 'prod', 'arn:aws:ecs:us-east-1:1:task-definition/hoax-prod-web:10')
    expect(result).toEqual({ deployedImage: IMAGE, services: ['hoax-production-web'] })
  })

  it('fails clearly when a service has no resolvable task-definition family', async () => {
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { error: new Error('boom') } })
    await expect(
      deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })
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
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-hoax-prod-nightly' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      { Id: 'target-1', EcsParameters: { TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/hoax-prod-job:3' } }
    ])

    await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

    // rule prefix is ecstask-<project>-<nickname>
    expect(aws.eventBridgeListRules).toHaveBeenCalledWith('ecstask-hoax-prod')
    // family parsed from the target's task-def ARN, then LATEST described by name
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith('hoax-prod-job')

    const [ruleName, target] = aws.eventBridgeUpdateTarget.mock.calls[0]
    expect(ruleName).toBe('ecstask-hoax-prod-nightly')
    expect(target.EcsParameters.TaskDefinitionArn).toBe('arn:aws:ecs:us-east-1:1:task-definition/hoax-prod-job:10')

    const registered = aws.ecsRegisterTaskDefinition.mock.calls[0][0]
    expect(registered.containerDefinitions[0]).toEqual({ name: 'app', image: IMAGE, secrets: SECRETS })
  })
})

// Pre-deploy migration phase — the db-migrate family runs to completion BEFORE
// any service is updated; a failure fails the deploy with services untouched.
describe('deployEcs pre-deploy database migrations', () => {
  const MIGRATE_ARN = 'arn:aws:ecs:us-east-1:1:task-definition/hoax-prod-db-migrate:10'
  const TASK_ARN = 'arn:aws:ecs:us-east-1:1:task/prod/abc123'
  const NETWORK_CONFIG = {
    awsvpcConfiguration: { subnets: ['subnet-1'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' }
  }
  // The shape of a legacy EC2 capacity-provider service (ararat's real one):
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
    aws.ecsRegisterTaskDefinition.mock.calls.map(c => c[0]).find(td => td.family === 'hoax-prod-db-migrate')

  beforeEach(() => {
    // Family PRESENT; one matching service to borrow run config from; migration
    // runs, stops cleanly, exits 0.
    aws.ecsListServices.mockResolvedValue([SERVICE_ARN])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({ [SERVICE_ARN]: { family: 'hoax-prod-web' } })
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

    const result = await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

    expect(aws.ecsRunTask).not.toHaveBeenCalled()
    // the deploy still updates the app's services
    expect(result).toEqual({ deployedImage: IMAGE, services: ['hoax-production-web'] })
  })

  it('composes from family latest, runs one task, waits, and requires exit 0 BEFORE updating services', async () => {
    const result = await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

    // family looked up by the bare convention name
    expect(aws.ecsDescribeTaskDefinition).toHaveBeenCalledWith('hoax-prod-db-migrate')

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
    expect(result.services).toEqual(['hoax-production-web'])
  })

  // A bridge-mode service is a valid thing to borrow from, not a miss: most
  // legacy Cru ECS apps run EC2 capacity-provider services whose task defs use
  // ECS's default bridge network mode, so DescribeServices reports no
  // networkConfiguration and RunTask must not be given one.
  it('borrows a bridge service capacity provider strategy and sends NO network configuration', async () => {
    aws.ecsDescribeServices.mockResolvedValue([
      { launchType: null, capacityProviderStrategy: CAPACITY_PROVIDER_STRATEGY, networkConfiguration: undefined }
    ])

    await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

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

    await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

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
      deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/Database migrations failed/)

    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
  })

  it('throws when the wait does not reach SUCCESS (timeout / task failure)', async () => {
    aws.ecsWaitUntilTasksStopped.mockResolvedValue({ state: 'TIMEOUT' })

    await expect(
      deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/did not stop cleanly/)

    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
  })

  it('falls back to the EventBridge scheduled-task network config for a jobs-only app', async () => {
    aws.ecsListServices.mockResolvedValue([])
    aws.ecsServiceTaskDefinitions.mockResolvedValue({})
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-hoax-prod-nightly' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      {
        Id: 'target-1',
        EcsParameters: {
          TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/hoax-prod-job:3',
          // EventBridge uses PascalCase awsvpc keys; RunTask needs camelCase.
          NetworkConfiguration: { awsvpcConfiguration: { Subnets: ['subnet-9'], SecurityGroups: ['sg-9'], AssignPublicIp: 'ENABLED' } },
          LaunchType: 'FARGATE'
        }
      }
    ])

    await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

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
    aws.eventBridgeListRules.mockResolvedValue([{ Name: 'ecstask-hoax-prod-nightly' }])
    aws.eventBridgeListTargets.mockResolvedValue([
      {
        Id: 'target-1',
        EcsParameters: {
          TaskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/hoax-prod-job:3',
          // An EC2/bridge target carries a launch type and nothing else.
          LaunchType: 'EC2'
        }
      }
    ])

    await deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })

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
      deployEcs({ projectName: 'hoax', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/no service or scheduled task to borrow run configuration from/)

    expect(aws.ecsRunTask).not.toHaveBeenCalled()
    expect(aws.ecsUpdateService).not.toHaveBeenCalled()
  })
})
