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

import { ssmParameters } from '../src/aws.js'

const param = n => ({ Name: `/ecs/hoax/prod/PARAM_${n}`, Value: `value-${n}` })

beforeEach(() => {
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
