import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_ATTEMPTS,
  GRPC_ABORTED,
  GRPC_DEADLINE_EXCEEDED,
  GRPC_UNAVAILABLE,
  GRPC_UNKNOWN,
  isAborted,
  isTransientError,
  retryTransient
} from '../src/grpc-retry.js'

// baseDelayMs 0 keeps the backoff instant; the delay maths is exercised
// separately by the budget assertions below.
const FAST = { baseDelayMs: 0 }

function grpcError (code, message = 'boom') {
  const error = new Error(message)
  error.code = code
  return error
}

// The shape google-gax surfaces for the production flake.
const unavailable = () =>
  grpcError(GRPC_UNAVAILABLE, '14 UNAVAILABLE: The service is currently unavailable.')

describe('isTransientError', () => {
  it('treats UNAVAILABLE as transient', () => {
    expect(isTransientError(unavailable())).toBe(true)
  })

  it('treats DEADLINE_EXCEEDED as transient', () => {
    expect(isTransientError(grpcError(GRPC_DEADLINE_EXCEEDED))).toBe(true)
  })

  it('treats a socket errno wrapped as UNKNOWN as transient', () => {
    expect(isTransientError(grpcError(GRPC_UNKNOWN, 'read ECONNRESET'))).toBe(true)
  })

  it('treats a bare Node socket error as transient', () => {
    expect(isTransientError(grpcError('ETIMEDOUT'))).toBe(true)
  })

  it('follows the cause chain for a socket errno', () => {
    const error = new Error('request failed')
    error.cause = grpcError('ECONNRESET')
    expect(isTransientError(error)).toBe(true)
  })

  it('does not treat an UNKNOWN without a socket errno as transient', () => {
    expect(isTransientError(grpcError(GRPC_UNKNOWN, 'something else'))).toBe(false)
  })

  it('does not treat a real API answer as transient', () => {
    expect(isTransientError(grpcError(5, 'NOT_FOUND'))).toBe(false)
    expect(isTransientError(grpcError(7, 'PERMISSION_DENIED'))).toBe(false)
    expect(isTransientError(grpcError(GRPC_ABORTED))).toBe(false)
  })

  it('does not treat a plain error as transient', () => {
    expect(isTransientError(new Error('runtime-project is required'))).toBe(false)
    expect(isTransientError(null)).toBe(false)
  })
})

describe('isAborted', () => {
  it('recognises ABORTED', () => {
    expect(isAborted(grpcError(GRPC_ABORTED))).toBe(true)
    expect(isAborted(unavailable())).toBe(false)
    expect(isAborted(undefined)).toBe(false)
  })
})

describe('retryTransient', () => {
  it('returns the value once a transient failure clears', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue('deployed')

    await expect(retryTransient('updateService svc', fn, FAST)).resolves.toBe('deployed')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('passes the 1-based attempt number to the thunk', async () => {
    const attempts = []
    const fn = vi.fn(async attempt => {
      attempts.push(attempt)
      if (attempt < 3) throw unavailable()
      return 'ok'
    })

    await retryTransient('updateService svc', fn, FAST)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('propagates a non-transient error from the first attempt', async () => {
    const error = grpcError(7, 'PERMISSION_DENIED: nope')
    const fn = vi.fn().mockRejectedValue(error)

    await expect(retryTransient('updateService svc', fn, FAST)).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('propagates the last error after exhausting the attempts', async () => {
    const last = unavailable()
    const fn = vi.fn()
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValue(last)

    await expect(retryTransient('updateService svc', fn, FAST)).rejects.toBe(last)
    expect(fn).toHaveBeenCalledTimes(DEFAULT_ATTEMPTS)
  })

  it('honors an explicit attempt count', async () => {
    const fn = vi.fn().mockRejectedValue(unavailable())

    await expect(
      retryTransient('updateService svc', fn, { ...FAST, attempts: 2 })
    ).rejects.toThrow('UNAVAILABLE')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('warns visibly on every retry so a rescued run says so', async () => {
    const warnings = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(line => {
      warnings.push(String(line))
      return true
    })
    try {
      const fn = vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValue('ok')
      await retryTransient('updateService svc', fn, FAST)
    } finally {
      spy.mockRestore()
    }

    const warning = warnings.find(line => line.startsWith('::warning'))
    expect(warning).toBeDefined()
    expect(warning).toContain('updateService svc')
    expect(warning).toContain('retrying after UNAVAILABLE (attempt 1/5)')
  })

  it('caps the total time spent sleeping', async () => {
    const fn = vi.fn().mockRejectedValue(unavailable())
    const started = Date.now()

    await expect(
      retryTransient('updateService svc', fn, { baseDelayMs: 10000, maxTotalDelayMs: 30 })
    ).rejects.toThrow('UNAVAILABLE')

    // 4 backoffs of 5-10s each, clipped to a 30ms budget.
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fn).toHaveBeenCalledTimes(DEFAULT_ATTEMPTS)
  })
})
