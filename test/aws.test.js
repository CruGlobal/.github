import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the SSM SDK so ssmParameters runs its real pagination and batched
// tag-fetch logic against canned pages, while the client tracks how many
// ListTagsForResource calls are in flight at once.
const { ssmState } = vi.hoisted(() => ({
  ssmState: { pages: [], inFlight: 0, maxInFlight: 0, tagCalls: [] }
}))
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    async send (command) {
      ssmState.inFlight++
      ssmState.maxInFlight = Math.max(ssmState.maxInFlight, ssmState.inFlight)
      await new Promise(resolve => setTimeout(resolve, 2))
      ssmState.inFlight--
      ssmState.tagCalls.push(command.input.ResourceId)
      return { TagList: [{ Key: 'param_type', Value: 'RUNTIME' }] }
    }
  },
  paginateGetParametersByPath: async function * () {
    for (const page of ssmState.pages) yield page
  },
  ListTagsForResourceCommand: class { constructor (input) { this.input = input } }
}))

// The ECS client, recording each command with the client's config and the
// options it was sent with.
const { ecsState } = vi.hoisted(() => ({ ecsState: { sent: [], answer: () => ({}) } }))
vi.mock('@aws-sdk/client-ecs', async importOriginal => ({
  ...(await importOriginal()),
  ECSClient: class {
    constructor (config) { this.config = config }
    async send (command, options) {
      ecsState.sent.push({ command, options, config: this.config })
      return ecsState.answer(command)
    }
  }
}))

import {
  ECS_QUICK_READ_TIMEOUT_MS,
  ecsDescribeService,
  ecsDescribeServices,
  ecsUpdateService,
  isPermanentAwsError,
  ssmParameters
} from '../src/aws.js'

const param = n => ({ Name: `/ecs/hoax/prod/PARAM_${n}`, Value: `value-${n}` })

beforeEach(() => {
  ecsState.sent = []
  ecsState.answer = () => ({})
  ssmState.pages = []
  ssmState.inFlight = 0
  ssmState.maxInFlight = 0
  ssmState.tagCalls = []
})

describe('ssmParameters', () => {
  it('returns every parameter across pages, in order, with tags reduced to an object', async () => {
    const params = Array.from({ length: 12 }, (_, i) => param(i))
    ssmState.pages = [{ Parameters: params.slice(0, 10) }, { Parameters: params.slice(10) }]

    const result = await ssmParameters('/ecs/hoax/prod/')

    expect(result).toHaveLength(12)
    expect(result.map(p => p.name)).toEqual(params.map(p => p.Name))
    expect(result[0]).toEqual({
      name: '/ecs/hoax/prod/PARAM_0',
      value: 'value-0',
      tags: { param_type: 'RUNTIME' }
    })
  })

  it('fetches tags for every parameter with at most 5 calls in flight', async () => {
    ssmState.pages = [{ Parameters: Array.from({ length: 12 }, (_, i) => param(i)) }]

    await ssmParameters('/ecs/hoax/prod/')

    expect(ssmState.tagCalls).toHaveLength(12)
    expect(ssmState.maxInFlight).toBeLessThanOrEqual(5)
    expect(ssmState.maxInFlight).toBeGreaterThan(1)
  })

  it('returns an empty list when the path has no parameters', async () => {
    ssmState.pages = [{ Parameters: [] }]

    expect(await ssmParameters('/ecs/nonexistent/prod/')).toEqual([])
    expect(ssmState.tagCalls).toHaveLength(0)
  })
})

// How an AWS SDK error reaches a caller: its name, and the HTTP status in
// $metadata when there was a response at all.
const awsError = (name, status) => Object.assign(new Error(name), {
  name,
  ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } })
})

describe('isPermanentAwsError', () => {
  it.each([
    ['AccessDeniedException', 403],
    ['ResourceNotFoundException', 404],
    ['InvalidParameterValueException', 400]
  ])('calls a %s (%i) permanent', (name, status) => {
    expect(isPermanentAwsError(awsError(name, status))).toBe(true)
  })

  it.each([
    ['a 429', 'TooManyRequestsException', 429],
    ['a ThrottlingException sent as a 400', 'ThrottlingException', 400],
    ['a TooManyRequestsException sent as a 400', 'TooManyRequestsException', 400],
    ['a RequestLimitExceeded sent as a 400', 'RequestLimitExceeded', 400],
    ['a 5xx', 'ServiceException', 500],
    ['a network error, with no status', 'TimeoutError', undefined]
  ])('lets %s pass', (_, name, status) => {
    expect(isPermanentAwsError(awsError(name, status))).toBe(false)
  })

  it('lets anything with no AWS shape pass', () => {
    expect(isPermanentAwsError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false)
    expect(isPermanentAwsError(undefined)).toBe(false)
  })
})

describe('the ECS calls a rollout makes', () => {
  const arns = count => Array.from({ length: count }, (_, i) => `arn:aws:ecs:us-east-1:000000000000:service/prod/example-${i}`)

  it('describes services ten at a time, the most DescribeServices takes', async () => {
    ecsState.answer = command => ({ services: command.input.services.map(serviceArn => ({ serviceArn })) })

    const services = await ecsDescribeServices(arns(23), 'prod')

    expect(ecsState.sent.map(({ command }) => command.input.services.length)).toEqual([10, 10, 3])
    expect(services.map(service => service.serviceArn)).toEqual(arns(23))
  })

  it('reads one service quickly in one attempt, under a time limit', async () => {
    ecsState.answer = () => ({ services: [{ serviceArn: 'arn:one' }] })

    await expect(ecsDescribeService('arn:one', 'prod', { quick: true })).resolves.toEqual({ serviceArn: 'arn:one' })

    const [{ command, options, config }] = ecsState.sent
    expect(command.input).toEqual({ cluster: 'prod', services: ['arn:one'] })
    expect(config.maxAttempts).toBe(1)
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(ECS_QUICK_READ_TIMEOUT_MS).toBe(20 * 1000)
  })

  it('answers null for a service ECS reports missing', async () => {
    ecsState.answer = () => ({ services: [], failures: [{ arn: 'arn:gone', reason: 'MISSING' }] })

    await expect(ecsDescribeService('arn:gone', 'prod', { quick: true })).resolves.toBeNull()
  })

  it('bounds an update by the time it is given, and returns the service with its deployments', async () => {
    const service = { serviceArn: 'arn:one', deployments: [{ id: 'ecs-svc/2', status: 'PRIMARY' }] }
    ecsState.answer = () => ({ service })

    await expect(ecsUpdateService('arn:one', 'prod', 'arn:td:2', { timeoutMs: 30 * 1000 })).resolves.toBe(service)
    await ecsUpdateService('arn:one', 'prod', 'arn:td:2')

    expect(ecsState.sent[0].command.input).toEqual({ service: 'arn:one', cluster: 'prod', taskDefinition: 'arn:td:2' })
    expect(ecsState.sent[0].options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(ecsState.sent[1].options).toBeUndefined()
  })
})
