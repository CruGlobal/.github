import { describe, it, expect, afterEach, vi } from 'vitest'
import { deadlineRequests } from '../src/v2/deadline.js'

// The helper the hotfix checks and the rollback-safety classifier share: one
// deadline for a series of requests. Its own module, so the classifier does
// not bundle the hotfix code.

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deadlineRequests', () => {
  it('gives each request its own limit, or what is left of the deadline when that is less', () => {
    let clock = 0
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const request = deadlineRequests({ deadlineMs: 30000, timeoutMs: 10000, now: () => clock })
    expect(request().signal).toBeInstanceOf(AbortSignal)
    clock = 25000
    request()
    expect(timeout.mock.calls).toEqual([[10000], [5000]])
  })

  it('refuses a request started after the deadline', () => {
    let clock = 0
    const request = deadlineRequests({ deadlineMs: 30000, now: () => clock })
    clock = 30000
    expect(() => request()).toThrow('gave up after 30 seconds')
  })

  it('says when the deadline has passed', () => {
    let clock = 0
    const request = deadlineRequests({ deadlineMs: 30000, now: () => clock })
    expect(request.expired()).toBe(false)
    clock = 29999
    expect(request.expired()).toBe(false)
    clock = 30000
    expect(request.expired()).toBe(true)
  })

  it('gives a request ten seconds when the caller names no limit', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    deadlineRequests({ deadlineMs: 30000, now: () => 0 })()
    expect(timeout.mock.calls).toEqual([[10000]])
  })
})
