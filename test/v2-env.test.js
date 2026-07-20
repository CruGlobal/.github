import { describe, it, expect } from 'vitest'
import { environmentNickname, V2_ENVIRONMENTS } from '../src/v2/env.js'

describe('v2 environmentNickname', () => {
  it.each([
    ['production', 'prod'],
    ['release-candidate', 'stage'],
    ['preview', 'lab']
  ])('maps long name %s -> nickname %s', (environment, expected) => {
    expect(environmentNickname(environment)).toBe(expected)
  })

  it('throws on an unknown long name', () => {
    expect(() => environmentNickname('staging')).toThrow(/Unknown v2 environment/)
  })

  it('exposes the mapping table', () => {
    expect(V2_ENVIRONMENTS).toEqual({
      production: 'prod',
      'release-candidate': 'stage',
      preview: 'lab'
    })
  })
})
