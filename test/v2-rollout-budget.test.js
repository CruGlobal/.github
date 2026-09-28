import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal()),
  info: vi.fn()
}))

import * as core from '@actions/core'
import {
  ROLLOUT_BUDGET_MS,
  STEP_CAP_MS,
  formatDuration,
  progressLogger,
  rolloutBudget
} from '../src/v2/rollout-budget.js'

const MINUTE = 60 * 1000

// A fake clock: the budget reads it and sleeps on it.
let now
const budget = (options = {}) => rolloutBudget({ now: () => now, sleep: async ms => { now += ms }, stepStartedAt: 0, ...options })

beforeEach(() => {
  now = 0
  core.info.mockReset()
})

describe('rolloutBudget', () => {
  it('lasts 45 minutes from the first update', () => {
    now = 2 * MINUTE
    const b = budget()
    b.start()

    now = 20 * MINUTE
    expect(b.elapsed()).toBe(18 * MINUTE)
    expect(b.remaining()).toBe(ROLLOUT_BUDGET_MS - 18 * MINUTE)
  })

  it('keeps one deadline however often it is started, so the services share it', () => {
    const b = budget()
    b.start()
    now = 30 * MINUTE
    b.start()

    expect(b.remaining()).toBe(15 * MINUTE)
  })

  it('never ends later than 50 minutes after the step started, even after a long migration', () => {
    const b = budget()
    now = 30 * MINUTE
    b.start()

    // 30 + 45 would be 75 minutes into the step.
    expect(STEP_CAP_MS).toBe(50 * MINUTE)
    expect(now + b.remaining()).toBe(STEP_CAP_MS)
  })

  it('keeps a reserve back, and never reports less than nothing', () => {
    const b = budget()
    b.start()

    expect(b.remaining(3 * MINUTE)).toBe(42 * MINUTE)
    now = 44 * MINUTE
    expect(b.remaining(3 * MINUTE)).toBe(0)
    now = 60 * MINUTE
    expect(b.remaining()).toBe(0)
  })

  it('before it starts, reports the time a start now would give', () => {
    const b = budget()
    now = 45 * MINUTE

    expect(b.elapsed()).toBe(0)
    expect(b.remaining()).toBe(5 * MINUTE)
  })

  it('sleeps on the clock it was given', async () => {
    const b = budget()
    await b.sleep(15 * 1000)

    expect(now).toBe(15 * 1000)
  })

  it('by default starts the step clock when the process started', () => {
    const b = rolloutBudget()
    b.start()

    const capped = STEP_CAP_MS - process.uptime() * 1000
    expect(b.remaining()).toBeLessThanOrEqual(Math.min(ROLLOUT_BUDGET_MS, capped) + 1000)
    expect(b.remaining()).toBeGreaterThan(0)
  })
})

describe('progressLogger', () => {
  it('writes the first line, then at most one line per interval', () => {
    const log = progressLogger(budget(), MINUTE)

    for (let poll = 0; poll < 12; poll++) {
      log(`poll ${poll}`)
      now += 15 * 1000
    }

    expect(core.info.mock.calls.map(([line]) => line)).toEqual(['poll 0', 'poll 4', 'poll 8'])
  })
})

describe('formatDuration', () => {
  it('reads as minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s')
    expect(formatDuration(45000)).toBe('45s')
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-5)).toBe('0s')
  })
})
