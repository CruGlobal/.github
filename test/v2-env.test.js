import { describe, it, expect } from 'vitest'
import { environmentNickname, legacyEnvironment, V2_ENVIRONMENTS, V2_LEGACY_ENVIRONMENTS } from '../src/v2/env.js'

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

describe('v2 legacyEnvironment', () => {
  it.each([
    ['production', 'production'],
    ['release-candidate', 'staging'],
    ['preview', 'lab']
  ])('maps long name %s -> legacy long name %s', (environment, expected) => {
    expect(legacyEnvironment(environment)).toBe(expected)
  })

  it('throws on an unknown long name', () => {
    expect(() => legacyEnvironment('staging')).toThrow(/Unknown v2 environment/)
  })

  it('exposes the mapping table', () => {
    expect(V2_LEGACY_ENVIRONMENTS).toEqual({
      production: 'production',
      'release-candidate': 'staging',
      preview: 'lab'
    })
  })
})
