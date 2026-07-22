import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for every ECS / EventBridge SDK op. src/ecs-config.js is
// partially mocked: runtimeSecrets is stubbed, ecsCluster (pure) stays real.
// src/v2/aws.js (composeTaskDefinition / isEcsAppContainer / ecsServiceRegExp)
// and src/v2/env.js run for real, so the compose semantics are exercised end to
// end.
vi.mock('../src/aws.js', () => ({
  ecsListServices: vi.fn(),
  ecsServiceTaskDefinitions: vi.fn(),
  ecsDescribeTaskDefinition: vi.fn(),
  ecsRegisterTaskDefinition: vi.fn(),
  ecsUpdateService: vi.fn(),
  eventBridgeListRules: vi.fn(),
  eventBridgeListTargets: vi.fn(),
  eventBridgeUpdateTarget: vi.fn()
}))

vi.mock('../src/ecs-config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runtimeSecrets: vi.fn()
}))

import * as aws from '../src/aws.js'
import { runtimeSecrets } from '../src/ecs-config.js'
import { deployEcs } from '../src/v2/deploy-ecs.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'
const IMAGE = `${REGISTRY}/hoax@sha256:new`
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:056154071827:service/prod/hoax-production-web'
const SECRETS = [{ name: 'DATABASE_URL', valueFrom: '/ecs/hoax/prod/DATABASE_URL' }]

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
    aws.ecsDescribeTaskDefinition.mockImplementation(family => Promise.resolve(familyLatest(family)))
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
    aws.ecsDescribeTaskDefinition.mockImplementation(family => Promise.resolve(familyLatest(family)))
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
