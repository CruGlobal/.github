import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for the ECS service/task-def reads, and the ECR SDK for the
// tag/digest lookups. src/v2/aws.js, src/v2/env.js and src/ecs-config.js run for
// real (ecsCluster is pure; the ECR helpers hit the mocked SDK).
vi.mock('../src/aws.js', () => ({
  ecsListServices: vi.fn(),
  ecsDescribeServices: vi.fn(),
  ecsDescribeTaskDefinition: vi.fn()
}))

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: class { send (command) { return sendMock(command) } },
  DescribeImagesCommand: class { constructor (input) { this.kind = 'DescribeImages'; this.input = input } },
  BatchGetImageCommand: class { constructor (input) { this.kind = 'BatchGetImage'; this.input = input } },
  PutImageCommand: class { constructor (input) { this.kind = 'PutImage'; this.input = input } },
  ImageAlreadyExistsException: class extends Error {}
}))

import * as aws from '../src/aws.js'
import { resolveEcs } from '../src/v2/resolve-ecs.js'
import { TagNotFoundError } from '../src/v2/errors.js'
import { ecsDeployment, ecsService, taskDefinitionArn } from './support/fake-ecs.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'

beforeEach(() => {
  aws.ecsListServices.mockReset()
  aws.ecsDescribeServices.mockReset()
  aws.ecsDescribeTaskDefinition.mockReset()
  sendMock.mockReset()
})

describe('resolveEcs mode=tag', () => {
  it('resolves an ECR tag to a digest reference + its tags', async () => {
    sendMock.mockResolvedValue({
      imageDetails: [{ imageDigest: 'sha256:aaa', imageTags: ['candidate-10012', 'sha-abc'] }]
    })

    const result = await resolveEcs({ mode: 'tag', projectName: 'hoax', tag: 'candidate-10012' })

    expect(result).toEqual({
      image: `${REGISTRY}/hoax@sha256:aaa`,
      digest: 'sha256:aaa',
      tags: ['candidate-10012', 'sha-abc']
    })
    expect(aws.ecsListServices).not.toHaveBeenCalled()
  })

  it('throws TagNotFoundError when ECR has no image with the tag', async () => {
    sendMock.mockResolvedValue({ imageDetails: [] })

    const attempt = resolveEcs({ mode: 'tag', projectName: 'hoax', tag: 'sha-nope' })

    await expect(attempt).rejects.toBeInstanceOf(TagNotFoundError)
    await expect(attempt).rejects.toThrow('Tag "sha-nope" not found in ECR repository hoax')
  })
})

// What each service's deployments run, in the shapes DescribeServices and
// DescribeTaskDefinition return. `environment` takes one entry per service:
// { name, deployments: [{ status, rolloutState, image, runningCount, ... }] },
// and builds a task definition per deployment running that image.
const APP = 'example-app'
const OLD = `${REGISTRY}/example-app@sha256:old`
const NEW = `${REGISTRY}/example-app@sha256:new`
const NEXT_STEPS = 'Nothing was resolved, so a deploy to this environment goes ahead and a promote from it stops ' +
  'here. To promote, re-run deploy-candidate for the candidate, then promote.'

function environment (list, cluster = 'stage') {
  const definitions = {}
  let id = 0
  const services = list.map(({ name, deployments, desiredCount = 1 }) => ecsService({
    cluster,
    name,
    desiredCount,
    deployments: deployments.map(({ image, sidecarFirst, ...fields }) => {
      const taskDefinition = taskDefinitionArn(name, ++id)
      const app = { name: 'app', image }
      const sidecar = { name: 'log_router', image: 'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable' }
      definitions[taskDefinition] = { taskDefinitionArn: taskDefinition, containerDefinitions: sidecarFirst ? [sidecar, app] : [app, sidecar] }
      const deployment = ecsDeployment({ id: `ecs-svc/${id}`, taskDefinition, desiredCount, ...fields })
      // A field given as undefined is one AWS leaves out.
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete deployment[key]
      return deployment
    })
  }))
  aws.ecsListServices.mockResolvedValue(services.map(service => service.serviceArn))
  aws.ecsDescribeServices.mockResolvedValue(services)
  aws.ecsDescribeTaskDefinition.mockImplementation(async arn => ({ taskDefinition: definitions[arn] }))
}

const settled = image => ({ image })
const resolve = () => resolveEcs({ mode: 'environment', projectName: APP, environment: 'release-candidate' })
const tagsFor = tags => sendMock.mockResolvedValue({ imageDetails: [{ imageTags: tags }] })

describe('resolveEcs mode=environment', () => {
  it('returns the digest ref a COMPLETED PRIMARY deployment serves (normalized), and its tags, skipping sidecars', async () => {
    environment([{ name: 'example-app-stage-web-abcd', deployments: [{ image: OLD, sidecarFirst: true }] }])
    sendMock.mockImplementation(command => {
      // ecrTagsForDigest: DescribeImages by digest
      expect(command.input.imageIds).toEqual([{ imageDigest: 'sha256:old' }])
      return Promise.resolve({ imageDetails: [{ imageTags: ['candidate-10013', 'release-4'] }] })
    })

    await expect(resolve()).resolves.toEqual({
      image: `${REGISTRY}/example-app@sha256:old`,
      digest: 'sha256:old',
      tags: ['candidate-10013', 'release-4']
    })
    // release-candidate -> nickname stage -> cluster stage
    expect(aws.ecsListServices).toHaveBeenCalledWith(expect.any(RegExp), 'stage')
  })

  it('returns the one image every service serves', async () => {
    environment([
      { name: 'example-app-stage-web-abcd', deployments: [settled(NEW)] },
      { name: 'example-app-stage-worker-efgh', deployments: [settled(NEW)] }
    ])
    tagsFor(['candidate-10014'])

    await expect(resolve()).resolves.toMatchObject({ digest: 'sha256:new', tags: ['candidate-10014'] })
  })

  it('counts a service scaled to zero by the release its COMPLETED deployment would run', async () => {
    environment([{ name: 'example-app-stage-web-abcd', desiredCount: 0, deployments: [settled(NEW)] }])
    tagsFor([])

    await expect(resolve()).resolves.toMatchObject({ digest: 'sha256:new' })
  })

  it('throws while a rollout is in progress, saying what each deployment runs', async () => {
    environment([{
      name: 'example-app-stage-web-abcd',
      deployments: [
        { image: NEW, rolloutState: 'IN_PROGRESS', runningCount: 0, pendingCount: 1 },
        { image: OLD, status: 'ACTIVE' }
      ]
    }])

    await expect(resolve()).rejects.toThrow(
      'No single app image is serving for example-app in cluster "stage": example-app-stage-web-abcd is in the ' +
      'middle of a rollout, or its last one failed: deployment ecs-svc/1 (PRIMARY, rolloutState IN_PROGRESS) runs ' +
      `${NEW} with 0 of 1 tasks, deployment ecs-svc/2 (ACTIVE, rolloutState COMPLETED) runs ${OLD} with 1 of 1 ` +
      `tasks. ${NEXT_STEPS}`
    )
  })

  it('throws while the circuit breaker rolls a failed deployment back, though the service already names the old one', async () => {
    // The breaker made the deployment from before PRIMARY again, with its old
    // id, and ours reads FAILED until it drains.
    environment([{
      name: 'example-app-stage-web-abcd',
      deployments: [
        { image: OLD, rolloutState: 'IN_PROGRESS' },
        { image: NEW, status: 'ACTIVE', rolloutState: 'FAILED', runningCount: 0, failedTasks: 3 }
      ]
    }])

    await expect(resolve()).rejects.toThrow(/in the middle of a rollout, or its last one failed: .*\(ACTIVE, rolloutState FAILED\)/)
  })

  it('throws when the only deployment FAILED, with nothing to roll back to', async () => {
    environment([{ name: 'example-app-stage-web-abcd', deployments: [{ image: NEW, rolloutState: 'FAILED', runningCount: 0 }] }])

    await expect(resolve()).rejects.toThrow(/No single app image is serving .*\(PRIMARY, rolloutState FAILED\)/)
  })

  it('throws while tasks of an earlier deployment still run beside a COMPLETED one', async () => {
    environment([{
      name: 'example-app-stage-web-abcd',
      deployments: [settled(NEW), { image: OLD, status: 'ACTIVE', runningCount: 1 }]
    }])

    await expect(resolve()).rejects.toThrow(/No single app image is serving/)
  })

  it('throws when the services serve different images', async () => {
    environment([
      { name: 'example-app-stage-web-abcd', deployments: [settled(NEW)] },
      { name: 'example-app-stage-worker-efgh', deployments: [settled(OLD)] }
    ])

    await expect(resolve()).rejects.toThrow(
      'The ECS services for example-app in cluster "stage" do not all serve one app image ' +
      `(example-app-stage-web-abcd serves ${NEW}; example-app-stage-worker-efgh serves ${OLD}). ${NEXT_STEPS}`
    )
  })

  it('throws when a service is still on the scratch placeholder beside one that serves the app image', async () => {
    // A service added after the candidate was deployed: the candidate never ran
    // there, however its first deployment went.
    environment([
      { name: 'example-app-stage-web-abcd', deployments: [settled(NEW)] },
      { name: 'example-app-stage-worker-efgh', deployments: [{ image: 'scratch', rolloutState: 'FAILED', runningCount: 0 }] }
    ])

    await expect(resolve()).rejects.toThrow(
      'The ECS services for example-app in cluster "stage" do not all serve one app image ' +
      `(example-app-stage-web-abcd serves ${NEW}; example-app-stage-worker-efgh still runs the scratch placeholder ` +
      `(deployment ecs-svc/2), so it has never been deployed). ${NEXT_STEPS}`
    )
  })

  it('names the placeholder too when another service is mid-rollout', async () => {
    environment([
      { name: 'example-app-stage-web-abcd', deployments: [{ image: NEW, rolloutState: 'IN_PROGRESS', runningCount: 0 }, { image: OLD, status: 'ACTIVE' }] },
      { name: 'example-app-stage-worker-efgh', deployments: [settled('scratch')] }
    ])

    const error = await resolve().catch(thrown => thrown)

    expect(error.message).toMatch(/^No single app image is serving for example-app in cluster "stage": example-app-stage-web-abcd is in the middle of a rollout/)
    expect(error.message).toContain('example-app-stage-worker-efgh still runs the scratch placeholder (deployment ecs-svc/3), so it has never been deployed.')
    expect(error.message.endsWith(NEXT_STEPS)).toBe(true)
  })

  it('leaves out a matched service that runs no app container at all', async () => {
    environment([
      { name: 'example-app-stage-web-abcd', deployments: [settled(NEW)] },
      { name: 'example-app-stage-proxy-ijkl', deployments: [settled('public.ecr.aws/nginx/nginx:stable')] }
    ])
    tagsFor([])

    await expect(resolve()).resolves.toMatchObject({ digest: 'sha256:new' })
  })

  it('takes a lone deployment with no rolloutState as serving, as AWS reports a Classic Load Balancer service', async () => {
    environment([{ name: 'example-app-stage-web-abcd', deployments: [{ image: NEW, rolloutState: undefined, rolloutStateReason: undefined }] }])
    tagsFor([])

    await expect(resolve()).resolves.toMatchObject({ digest: 'sha256:new' })
  })

  it('resolves the tag when the running image is a tag ref', async () => {
    environment([{ name: 'example-app-stage-web-abcd', deployments: [settled(`${REGISTRY}/example-app:staging-101`)] }])
    sendMock.mockImplementation(command => {
      expect(command.input.imageIds).toEqual([{ imageTag: 'staging-101' }])
      return Promise.resolve({ imageDetails: [{ imageDigest: 'sha256:bbb', imageTags: ['candidate-10014'] }] })
    })

    await expect(resolve()).resolves.toEqual({
      image: `${REGISTRY}/example-app@sha256:bbb`,
      digest: 'sha256:bbb',
      tags: ['candidate-10014']
    })
  })

  it('throws when no matching services exist', async () => {
    aws.ecsListServices.mockResolvedValue([])
    await expect(
      resolveEcs({ mode: 'environment', projectName: APP, environment: 'production' })
    ).rejects.toThrow(/No ECS services matching/)
  })

  it('throws when only a scratch placeholder is present (never deployed)', async () => {
    environment([{ name: 'example-app-stage-web-abcd', deployments: [settled('scratch')] }])
    await expect(resolve()).rejects.toThrow(/Could not find a running app container/)
  })

  it('does not blame the placeholder when no matched service runs a container from the app\'s repository', async () => {
    environment([
      { name: 'example-app-stage-proxy-ijkl', deployments: [settled('public.ecr.aws/nginx/nginx:stable')] }
    ])

    await expect(resolve()).rejects.toThrow(
      'Could not find a running app container image for example-app in cluster "stage" (no matching service runs ' +
      'a container from the example-app repository)'
    )
  })

  it('keeps the "nothing serving" error when every service is still on the placeholder', async () => {
    environment([
      { name: 'example-app-stage-web-abcd', deployments: [settled('scratch')] },
      { name: 'example-app-stage-worker-efgh', deployments: [{ image: 'scratch', rolloutState: 'FAILED', runningCount: 0 }] }
    ])

    await expect(resolve()).rejects.toThrow(
      'Could not find a running app container image for example-app in cluster "stage" (a service still on the ' +
      'scratch placeholder has never been deployed)'
    )
  })
})

describe('resolveEcs invalid mode', () => {
  it('throws on an unknown mode', async () => {
    await expect(resolveEcs({ mode: 'nope', projectName: 'hoax' })).rejects.toThrow(/Unknown resolve mode/)
  })
})
