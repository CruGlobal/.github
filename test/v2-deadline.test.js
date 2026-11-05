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

  // What a caller uses to word a stop: decided when the signal is made, so a
  // timer that fires a moment before the clock reaches the deadline cannot
  // change the answer.
  it('says whether a request\'s limit was cut to what was left of the deadline', () => {
    let clock = 0
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const request = deadlineRequests({ deadlineMs: 30000, timeoutMs: 10000, now: () => clock })
    expect(request.next().cutByDeadline).toBe(false)
    clock = 20000
    // Exactly the request's own limit is left: not cut.
    expect(request.next().cutByDeadline).toBe(false)
    clock = 20001
    const near = request.next()
    expect(near.cutByDeadline).toBe(true)
    expect(near.signal).toBeInstanceOf(AbortSignal)
    expect(timeout.mock.calls).toEqual([[10000], [10000], [9999]])
    clock = 30000
    expect(() => request.next()).toThrow('gave up after 30 seconds')
  })

  // The hotfix checks hand this to octokit as its `request` option, so it
  // stays the signal alone.
  it('gives a plain call the signal alone', () => {
    const options = deadlineRequests({ deadlineMs: 30000, now: () => 0 })()
    expect(Object.keys(options)).toEqual(['signal'])
  })

  it('gives a request ten seconds when the caller names no limit', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    deadlineRequests({ deadlineMs: 30000, now: () => 0 })()
    expect(timeout.mock.calls).toEqual([[10000]])
  })
})
