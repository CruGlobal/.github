import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock @actions/core exactly as the other v2 action tests do: `inputs` backs
// getInput, and setOutput/notice/warning are spies.
const { setOutputMock, noticeMock, warningMock, inputs } = vi.hoisted(() => ({
  setOutputMock: vi.fn(),
  noticeMock: vi.fn(),
  warningMock: vi.fn(),
  inputs: {}
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  setOutput: setOutputMock,
  notice: noticeMock,
  warning: warningMock
}))

import { run, REQUEST_TIMEOUT_MS, DEADLINE_MS } from '../src/classify-rollback-safety.js'

const output = (name) => setOutputMock.mock.calls.find((c) => c[0] === name)?.[1]
const verdict = () => output('verdict')
const reasons = () => JSON.parse(output('reasons'))

// A compare response with `count` .sql files added under drizzle/.
const compareFiles = (files) => ({ ok: true, status: 200, json: async () => ({ files }) })
const rawContent = (text) => ({ ok: true, status: 200, text: async () => text })

beforeEach(() => {
  setOutputMock.mockReset()
  noticeMock.mockReset()
  warningMock.mockReset()
  for (const k of Object.keys(inputs)) delete inputs[k]
  inputs['github-token'] = 'tok'
  inputs.repository = 'CruGlobal/example-app'
  inputs['base-sha'] = 'aaaa'
  inputs['head-sha'] = 'bbbb'
  inputs['migrations-path'] = 'drizzle'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classify-rollback-safety — short-circuits (advisory, never fails)', () => {
  it('empty migrations-path → unclassified without any fetch', async () => {
    inputs['migrations-path'] = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['no migrations path configured'])
    expect(noticeMock).toHaveBeenCalled()
  })

  it('empty base-sha → unclassified (no production baseline)', async () => {
    inputs['base-sha'] = ''
    vi.stubGlobal('fetch', vi.fn())
    await run()
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['no production baseline'])
  })

  it('empty head-sha → unclassified', async () => {
    inputs['head-sha'] = ''
    vi.stubGlobal('fetch', vi.fn())
    await run()
    expect(verdict()).toBe('unclassified')
  })

  it('neither migrations-path nor a Migrations declaration → unclassified', async () => {
    inputs['migrations-path'] = ''
    inputs.migrations = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['no migrations path configured'])
  })
})

// An explicit `Migrations = "none"` on the app's CruApplicationInfo item is the
// module DECLARING the app has no database migrations — the only thing that
// distinguishes it from "has migrations the classifier can't see", which an
// absent MigrationsPath also covers.
describe('classify-rollback-safety — declared no migrations', () => {
  beforeEach(() => {
    inputs['migrations-path'] = ''
    inputs.migrations = 'none'
  })

  it('migrations=none → safe with the declared reason, no compare call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    expect(reasons()).toEqual(['no database migrations'])
    // Short-circuits before any diff work: no compare, no contents fetch.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(noticeMock).toHaveBeenCalled()
    expect(warningMock).not.toHaveBeenCalled()
  })

  it('short-circuits ahead of the baseline checks (first promote is safe too)', async () => {
    inputs['base-sha'] = ''
    inputs['head-sha'] = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    expect(reasons()).toEqual(['no database migrations'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('matches the declaration case-insensitively', async () => {
    inputs.migrations = 'None'
    vi.stubGlobal('fetch', vi.fn())
    await run()
    expect(verdict()).toBe('safe')
  })

  it('any other Migrations value is not a declaration → unclassified', async () => {
    inputs.migrations = 'drizzle'
    vi.stubGlobal('fetch', vi.fn())
    await run()
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['no migrations path configured'])
  })

  // The modules make the two attributes mutually exclusive, so this should never
  // happen; if it does, the real path wins — a declaration must never be able to
  // mask migrations the classifier can actually read.
  it('migrations-path takes precedence over the declaration (destructive stays unsafe)', async () => {
    inputs['migrations-path'] = 'drizzle'
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'drizzle/0002_drop.sql', status: 'added' }])
        : rawContent('DROP TABLE users;'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unsafe')
    expect(reasons()[0]).toMatch(/drizzle\/0002_drop\.sql/)
    // The diff really ran: compare + one contents fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('migrations-path takes precedence even when the diff classifies safe', async () => {
    inputs['migrations-path'] = 'drizzle'
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'drizzle/0001_init.sql', status: 'added' }])
        : rawContent('CREATE TABLE users (id int);'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    // Classified from the diff, NOT declared: a count, not the declaration reason.
    expect(reasons()).toEqual(['1 additive migration'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('classify-rollback-safety — classification', () => {
  it('additive migration → safe (contents fetched at head-sha)', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/compare/')) {
        return compareFiles([{ filename: 'drizzle/0001_init.sql', status: 'added' }])
      }
      return rawContent('CREATE TABLE users (id int);')
    })
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    expect(reasons()).toEqual(['1 additive migration'])
    // compare + one contents fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('ref=bbbb')
  })

  it('destructive migration → unsafe with a warning', async () => {
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'drizzle/0002_drop.sql', status: 'added' }])
        : rawContent('DROP TABLE users;'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unsafe')
    expect(reasons()[0]).toMatch(/drizzle\/0002_drop\.sql/)
    expect(warningMock).toHaveBeenCalled()
  })

  it('fetches and classifies an added Rails .rb migration', async () => {
    inputs['migrations-path'] = 'db/migrate'
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'db/migrate/20260101000000_drop_legacy.rb', status: 'added' }])
        : rawContent('class DropLegacy < ActiveRecord::Migration[7.1]\n  def change\n    drop_table :legacy\n  end\nend\n'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unsafe')
    expect(reasons()[0]).toMatch(/^db\/migrate\/20260101000000_drop_legacy\.rb: `drop_table`/)
    // compare + one contents fetch at head-sha.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('ref=bbbb')
  })

  it('an additive Rails .rb migration is safe', async () => {
    inputs['migrations-path'] = 'db/migrate'
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'db/migrate/20260101000000_add_email.rb', status: 'added' }])
        : rawContent('class AddEmail < ActiveRecord::Migration[7.1]\n  def change\n    add_column :users, :email, :string\n  end\nend\n'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    expect(reasons()).toEqual(['1 additive migration'])
  })

  it('ignores files outside the migrations path (no content fetch)', async () => {
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'src/index.ts', status: 'added' }])
        : rawContent('should not be fetched'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    // A release with commits in range, none of them in the migrations path.
    // The reason must say "no changes", never "additive".
    expect(reasons()).toEqual(['no migration changes in this release'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('diff truncated at 300 files → unsafe with the truncation reason', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `other/${i}.ts`, status: 'added' }))
    const fetchMock = vi.fn(async () => compareFiles(files))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unsafe')
    // ONLY the truncation reason: the would-be safe verdict's explanatory
    // reason must not ride along under an unsafe verdict.
    expect(reasons()).toEqual(['diff truncated at 300 files — classify manually'])
  })

  it('compare API failure → unclassified with the error as reason (exit success)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unclassified')
    expect(reasons()[0]).toMatch(/compare API 404/)
    expect(noticeMock).toHaveBeenCalled()
    expect(warningMock).not.toHaveBeenCalled()
  })
})

// Promote runs the classifier inside the production lock, so a GitHub read
// that never answers must end, and end as unclassified, like any other error.
describe('classify-rollback-safety: time limits', () => {
  // A request that never answers, until its signal gives up on it.
  const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const added = (...names) => compareFiles(names.map((filename) => ({ filename, status: 'added' })))

  it('gives each read a signal, 20 seconds by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const fetchMock = vi.fn(async (url) =>
        url.includes('/compare/') ? added('drizzle/0001_init.sql') : rawContent('CREATE TABLE users (id int);'))
      vi.stubGlobal('fetch', fetchMock)
      await run()
      expect(verdict()).toBe('safe')
      expect(REQUEST_TIMEOUT_MS).toBe(20 * 1000)
      expect(DEADLINE_MS).toBe(90 * 1000)
      expect(timeout.mock.calls).toEqual([[REQUEST_TIMEOUT_MS], [REQUEST_TIMEOUT_MS]])
      for (const [, options] of fetchMock.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal)
    } finally {
      timeout.mockRestore()
    }
  })

  it('a compare that never answers → unclassified, saying so', async () => {
    vi.stubGlobal('fetch', vi.fn(neverAnswers))
    await run({ timeoutMs: 20 })
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['compare API did not answer in time for CruGlobal/example-app aaaa...bbbb'])
    expect(noticeMock).toHaveBeenCalled()
    expect(warningMock).not.toHaveBeenCalled()
  })

  it('a compare whose body never arrives → unclassified', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, { signal }) => ({ ok: true, status: 200, json: () => neverAnswers(url, { signal }) })))
    await run({ timeoutMs: 20 })
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['compare API did not answer in time for CruGlobal/example-app aaaa...bbbb'])
  })

  it('a migration file read that never answers → unclassified, naming the file', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) =>
      url.includes('/compare/') ? added('drizzle/0001_init.sql') : neverAnswers(url, options)))
    await run({ timeoutMs: 20 })
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['contents API did not answer in time for drizzle/0001_init.sql'])
  })

  // Each read answers inside its own limit, but together they take longer
  // than the deadline. The clock moves 40 seconds a read: the compare and two
  // files fit in 90 seconds, the third file does not, and is never asked for.
  it('reads that together pass the deadline → unclassified, with no read after it', async () => {
    let clock = 0
    const fetchMock = vi.fn(async (url) => {
      clock += 40 * 1000
      return url.includes('/compare/')
        ? added('drizzle/0001_a.sql', 'drizzle/0002_b.sql', 'drizzle/0003_c.sql')
        : rawContent('CREATE TABLE users (id int);')
    })
    vi.stubGlobal('fetch', fetchMock)
    await run({ now: () => clock })
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['the GitHub reads ran out of their 90 seconds before the contents API read for drizzle/0003_c.sql'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // The read gets only what is left of the deadline, so it is the deadline
  // that stops it, and the reason says so rather than blaming the one API.
  it('a read the overall deadline stops → unclassified, saying the reads ran out of time', async () => {
    vi.stubGlobal('fetch', vi.fn(neverAnswers))
    await run({ timeoutMs: 5000, deadlineMs: 30 })
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['the GitHub reads ran out of their 0.03 seconds during the compare API read for CruGlobal/example-app aaaa...bbbb'])
  })

  it('a migration file read the overall deadline stops names the file', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) =>
      url.includes('/compare/') ? added('drizzle/0001_init.sql') : neverAnswers(url, options)))
    await run({ timeoutMs: 5000, deadlineMs: 30 })
    expect(verdict()).toBe('unclassified')
    expect(reasons()).toEqual(['the GitHub reads ran out of their 0.03 seconds during the contents API read for drizzle/0001_init.sql'])
  })

  // A read near the deadline gets only what is left of it.
  it('gives a read no more than what is left of the deadline', async () => {
    let clock = 0
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        clock += 80 * 1000
        return url.includes('/compare/') ? added('drizzle/0001_init.sql') : rawContent('CREATE TABLE users (id int);')
      }))
      await run({ now: () => clock })
      expect(verdict()).toBe('safe')
      expect(timeout.mock.calls).toEqual([[20 * 1000], [10 * 1000]])
    } finally {
      timeout.mockRestore()
    }
  })
})
