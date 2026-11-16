import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock @actions/core exactly as the other v2 action tests do: `inputs` backs
// getInput, and setOutput/info/notice/warning are spies.
const { setOutputMock, infoMock, noticeMock, warningMock, inputs } = vi.hoisted(() => ({
  setOutputMock: vi.fn(),
  infoMock: vi.fn(),
  noticeMock: vi.fn(),
  warningMock: vi.fn(),
  inputs: {}
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  setOutput: setOutputMock,
  info: infoMock,
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
  infoMock.mockReset()
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

  it('diff truncated at 300 files, and no merge base to compare the directory from → unsafe with the truncation reason', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `other/${i}.ts`, status: 'added' }))
    const fetchMock = vi.fn(async () => compareFiles(files))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unsafe')
    // The truncation reason, then why the directory could not be compared
    // instead. The would-be safe verdict's explanatory reason must not ride
    // along under an unsafe verdict.
    expect(reasons()).toEqual([
      'diff truncated at 300 files — classify manually',
      'could not compare the migrations directory instead: the compare named no merge base'
    ])
    // No read after the compare: there was nothing to start the trees from.
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

// Promote hands the reasons output to later steps in environment variables,
// and Linux will not start a process with one environment string over
// 131,072 bytes. So the output keeps at most 20 reasons of at most 500
// characters, and the step log gets the whole list.
describe('classify-rollback-safety: the reasons output stays small', () => {
  const MORE = (n) => `and ${n} more reasons, listed in this step's log`
  const logged = () => infoMock.mock.calls.map(([text]) => text).join('\n').split('\n')

  // An added file in a format the classifier can't read: one reason each,
  // and no content read.
  const unsupported = (count) => Array.from({ length: count }, (_, i) =>
    ({ filename: `drizzle/${String(i).padStart(4, '0')}_seed.js`, status: 'added' }))
  const reasonFor = ({ filename }) => `${filename}: unsupported migration format (only .sql and Rails .rb are classified)`

  it('20 reasons → all of them, whole, and the same list in the log', async () => {
    const files = unsupported(20)
    vi.stubGlobal('fetch', vi.fn(async () => compareFiles(files)))
    await run()
    expect(verdict()).toBe('unsafe')
    expect(reasons()).toEqual(files.map(reasonFor))
    expect(logged()).toEqual(['rollback safety reasons (20):', ...files.map((f) => `- ${reasonFor(f)}`)])
  })

  it('21 reasons → the first 19, then a count of the other 2', async () => {
    const files = unsupported(21)
    vi.stubGlobal('fetch', vi.fn(async () => compareFiles(files)))
    await run()
    expect(reasons()).toEqual([...files.slice(0, 19).map(reasonFor), MORE(2)])
    expect(logged()).toEqual(['rollback safety reasons (21):', ...files.map((f) => `- ${reasonFor(f)}`)])
  })

  it('one migration with 5,000 destructive statements → 20 reasons, the first ones shown first', async () => {
    const sql = Array.from({ length: 5000 }, (_, i) => `DROP TABLE t${i};`).join('\n')
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      url.includes('/compare/') ? compareFiles([{ filename: 'drizzle/0002_drop.sql', status: 'added' }]) : rawContent(sql)))
    await run()
    expect(verdict()).toBe('unsafe')
    const shown = reasons()
    expect(shown).toHaveLength(20)
    expect(shown.slice(0, 19)).toEqual(Array(19).fill('drizzle/0002_drop.sql: drops a table; a rollback would not restore it'))
    expect(shown[19]).toBe(MORE(4981))
    expect(Buffer.byteLength(output('reasons'))).toBeLessThan(16 * 1024)
    expect(logged()).toHaveLength(5001)
  })

  // Cut by character, so a cut never leaves half of one behind.
  it('a reason longer than 500 characters is cut to 500, ending in ...', async () => {
    const filename = `drizzle/${'\u{1F600}'.repeat(600)}.js`
    vi.stubGlobal('fetch', vi.fn(async () => compareFiles([{ filename, status: 'added' }])))
    await run()
    const [shown] = reasons()
    expect(Array.from(shown)).toHaveLength(500)
    expect(shown.isWellFormed()).toBe(true)
    expect(shown).toBe(`${Array.from(reasonFor({ filename })).slice(0, 497).join('')}...`)
    // The warning shows it cut too; the log has it whole.
    expect(warningMock.mock.calls[0][0]).toContain(shown)
    expect(warningMock.mock.calls[0][0]).not.toContain(reasonFor({ filename }))
    expect(logged()[1]).toBe(`- ${reasonFor({ filename })}`)
  })

  // One reason a line, and no line a workflow command could start.
  it('logs a reason with a line break in it on one line', async () => {
    const filename = 'drizzle/0001_a\n::warning::b.js'
    vi.stubGlobal('fetch', vi.fn(async () => compareFiles([{ filename, status: 'added' }])))
    await run()
    expect(reasons()).toEqual([reasonFor({ filename })])
    expect(logged()).toEqual(['rollback safety reasons (1):', `- ${reasonFor({ filename: 'drizzle/0001_a ::warning::b.js' })}`])
  })
})

// A compare cut off at 300 files no longer means unsafe on its own: the
// migrations directory is compared at the merge base and at the candidate,
// from the git trees API, instead. These tests serve a small repository the
// way GitHub serves it, so each read the action makes is a real lookup.
describe('classify-rollback-safety: a diff cut off at 300 files', () => {
  const COMPARE_CAP = 300
  const TRUNCATED = 'diff truncated at 300 files — classify manually'
  const FROM_TREES = 'diff truncated at 300 files, so the migrations directory was compared at both commits instead'
  const couldNot = (why) => `could not compare the migrations directory instead: ${why}`

  const ADD = 'CREATE TABLE users (id int);'
  const ADD_EMAIL = 'ALTER TABLE users ADD COLUMN email text;'
  const DROP = 'DROP TABLE users;'
  const rails = (body) => `class Example < ActiveRecord::Migration[7.1]\n  def change\n    ${body}\n  end\nend\n`

  const hash = (text) => createHash('sha1').update(text).digest('hex')
  const json = (body) => ({ ok: true, status: 200, json: async () => body })
  const failed = (status) => ({ ok: false, status, json: async () => ({ message: 'error' }) })
  const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

  // Stores the git trees for one commit's files, { path: content } or
  // { path: { content, mode, type } }, in `trees` by sha, and returns the sha
  // of its top-level tree.
  function storeTree (files, trees) {
    const root = new Map()
    for (const [path, value] of Object.entries(files)) {
      const parts = path.split('/')
      let dir = root
      for (const part of parts.slice(0, -1)) {
        if (!dir.has(part)) dir.set(part, new Map())
        dir = dir.get(part)
      }
      dir.set(parts.at(-1), typeof value === 'string' ? { content: value } : value)
    }
    const store = (dir) => {
      const entries = [...dir.keys()].sort().map((name) => {
        const child = dir.get(name)
        return child instanceof Map
          ? { path: name, mode: '040000', type: 'tree', sha: store(child) }
          : { path: name, mode: child.mode ?? '100644', type: child.type ?? 'blob', sha: hash(`blob ${child.content}`) }
      })
      const sha = hash(JSON.stringify(entries))
      trees.set(sha, entries)
      return sha
    }
    return store(root)
  }

  // A recursive listing: every entry below the tree, its path relative to it.
  function listRecursive (sha, trees, prefix = '') {
    return trees.get(sha).flatMap((entry) => {
      const listed = { ...entry, path: prefix + entry.path }
      return entry.type === 'tree' ? [listed, ...listRecursive(entry.sha, trees, `${listed.path}/`)] : [listed]
    })
  }

  // fetch for a repository at `commits` ({ sha: files }) whose compare answers
  // `compare`. `intercept` sees each read first and may answer it itself.
  function fakeGitHub ({ commits, compare, intercept }) {
    const trees = new Map()
    const roots = {}
    for (const [sha, files] of Object.entries(commits)) roots[sha] = storeTree(files, trees)
    return vi.fn(async (url, options) => {
      const answer = intercept?.(url, options)
      if (answer) return answer
      const { pathname, searchParams } = new URL(url)
      if (pathname.includes('/compare/')) return json(compare)
      const tree = pathname.match(/\/git\/trees\/([^/]+)$/)
      if (tree) {
        // A commit sha answers with its top-level tree, as GitHub's does.
        const sha = roots[tree[1]] ?? tree[1]
        if (!trees.has(sha)) return failed(404)
        return json({ sha: tree[1], tree: searchParams.get('recursive') ? listRecursive(sha, trees) : trees.get(sha), truncated: false })
      }
      const content = pathname.match(/\/contents\/(.+)$/)
      if (content) {
        const file = commits[searchParams.get('ref')]?.[decodeURIComponent(content[1])]
        if (file === undefined) return failed(404)
        return rawContent(typeof file === 'string' ? file : file.content)
      }
      throw new Error(`unexpected read ${url}`)
    })
  }

  // A compare cut off at 300 files. `listed` are the migration files it got to
  // before the cap (usually none); the rest are other files. Production is
  // usually an ancestor of the candidate, so the merge base is base-sha.
  const truncatedCompare = (listed = [], mergeBase = 'aaaa') => ({
    merge_base_commit: { sha: mergeBase },
    files: [...listed, ...Array.from({ length: COMPARE_CAP - listed.length }, (_, i) => ({ filename: `src/file${i}.ts`, status: 'modified' }))]
  })

  async function runTruncated (commits, { listed, mergeBase, intercept, ...options } = {}) {
    const fetchMock = fakeGitHub({ commits, compare: truncatedCompare(listed, mergeBase), intercept })
    vi.stubGlobal('fetch', fetchMock)
    await run(options)
    return fetchMock
  }

  const urls = (fetchMock) => fetchMock.mock.calls.map(([url]) => url)
  const contentReads = (fetchMock) => urls(fetchMock).filter((url) => url.includes('/contents/'))
  const listings = (fetchMock) => urls(fetchMock).filter((url) => url.includes('?recursive=1'))

  // One added additive migration on top of one that was there: safe, unless
  // a read fails.
  const oneAdded = {
    aaaa: { 'drizzle/0001_init.sql': ADD },
    bbbb: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_add.sql': ADD_EMAIL }
  }

  describe('classifies from the directory trees', () => {
    it('only additive migrations added → safe, reading only the added files', async () => {
      const before = { 'drizzle/0001_init.sql': ADD, 'drizzle/meta/_journal.json': '{"entries":[1]}', 'src/index.ts': 'a' }
      const fetchMock = await runTruncated({
        aaaa: before,
        bbbb: { ...before, 'drizzle/0002_a.sql': 'CREATE TABLE a (id int);', 'drizzle/0003_b.sql': ADD_EMAIL, 'drizzle/meta/_journal.json': '{"entries":[1,2,3]}', 'src/index.ts': 'b' }
      })
      expect(verdict()).toBe('safe')
      expect(reasons()).toEqual(['2 additive migrations', FROM_TREES])
      expect(noticeMock).toHaveBeenCalled()
      expect(warningMock).not.toHaveBeenCalled()
      expect(contentReads(fetchMock)).toEqual([
        'https://api.github.com/repos/CruGlobal/example-app/contents/drizzle/0002_a.sql?ref=bbbb',
        'https://api.github.com/repos/CruGlobal/example-app/contents/drizzle/0003_b.sql?ref=bbbb'
      ])
    })

    it('an added destructive migration → unsafe, naming it', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_drop.sql': DROP }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toHaveLength(2)
      expect(reasons()[0]).toMatch(/^drizzle\/0002_drop\.sql: /)
      expect(reasons()[1]).toBe(FROM_TREES)
      expect(warningMock).toHaveBeenCalled()
    })

    it('a removed migration → unsafe, history modified', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_add.sql': ADD_EMAIL },
        bbbb: { 'drizzle/0001_init.sql': ADD }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual(['drizzle/0002_add.sql: migration history modified (removed)', FROM_TREES])
    })

    it('a modified migration → unsafe, history modified', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/0001_init.sql': `${ADD}\n${ADD_EMAIL}` }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual(['drizzle/0001_init.sql: migration history modified (modified)', FROM_TREES])
    })

    // A compare calls this `renamed`; the trees see a removed file and an
    // added one. Either way it is unsafe.
    it('a migration moved inside the directory → unsafe', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/archive/0001_init.sql': ADD }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual(['drizzle/0001_init.sql: migration history modified (removed)', FROM_TREES])
    })

    // A compare lists a change of file mode too, so the trees count it.
    it('a migration whose mode alone changed → unsafe', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/0001_init.sql': { content: ADD, mode: '100755' } }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual(['drizzle/0001_init.sql: migration history modified (modified)', FROM_TREES])
    })

    it('an added file in a format it cannot classify → unsafe', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_seed.js': 'module.exports = {}' }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()[0]).toMatch(/^drizzle\/0002_seed\.js: unsupported migration format/)
    })

    // A compare lists an added submodule as an added file, so the trees keep
    // submodule entries too, and it is just as unclassifiable.
    it('an added submodule → unsafe, as in a compare', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/0001_init.sql': ADD, 'drizzle/vendor': { content: 'pointer', mode: '160000', type: 'commit' } }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual(['drizzle/vendor: unsupported migration format (only .sql and Rails .rb are classified)', FROM_TREES])
    })

    // Production on a commit that is not an ancestor of the candidate, a
    // hotfix branch say. The compare diffs from the merge base, so a
    // migration only on production's side is not in it, and the trees must
    // not call it removed either.
    it('diffs from the merge base the compare names, not from base-sha', async () => {
      const shared = { 'drizzle/0001_init.sql': ADD }
      const fetchMock = await runTruncated({
        aaaa: { ...shared, 'drizzle/0002_hotfix.sql': 'CREATE INDEX users_id ON users (id);' },
        mmmm: shared,
        bbbb: { ...shared, 'drizzle/0003_add.sql': ADD_EMAIL }
      }, { mergeBase: 'mmmm' })
      expect(verdict()).toBe('safe')
      expect(reasons()).toEqual(['1 additive migration', FROM_TREES])
      // The compare still asks about base-sha; no tree read does.
      expect(urls(fetchMock)[0]).toContain('/compare/aaaa...bbbb')
      expect(urls(fetchMock).filter((url) => url.includes('/git/trees/aaaa'))).toEqual([])
      expect(urls(fetchMock)[1]).toMatch(/\/git\/trees\/mmmm$/)
    })

    it('the directory unchanged → safe with no migration changes, and no listing read', async () => {
      const migrations = { 'drizzle/0001_init.sql': ADD, 'drizzle/meta/_journal.json': '{}' }
      const fetchMock = await runTruncated({
        aaaa: { ...migrations, 'src/index.ts': 'a' },
        bbbb: { ...migrations, 'src/index.ts': 'b' }
      })
      expect(verdict()).toBe('safe')
      expect(reasons()).toEqual(['no migration changes in this release', FROM_TREES])
      // The compare and one top-level read each side; the drizzle tree shas match.
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(listings(fetchMock)).toEqual([])
    })

    it('a directory of more than 1,000 migrations → read whole, only the added ones fetched', async () => {
      const many = Object.fromEntries(Array.from({ length: 1200 }, (_, i) =>
        [`drizzle/${String(i).padStart(4, '0')}_m.sql`, `CREATE TABLE t${i} (id int);`]))
      const fetchMock = await runTruncated({
        aaaa: many,
        bbbb: { ...many, 'drizzle/1200_a.sql': 'CREATE TABLE a (id int);', 'drizzle/1201_b.sql': ADD_EMAIL }
      })
      expect(verdict()).toBe('safe')
      expect(reasons()).toEqual(['2 additive migrations', FROM_TREES])
      expect(contentReads(fetchMock)).toHaveLength(2)
      // The compare, one top-level read and one listing each side, two files.
      expect(fetchMock).toHaveBeenCalledTimes(7)
    })

    it('a migration the cut-off compare listed is read once, not again for the trees', async () => {
      const fetchMock = await runTruncated(oneAdded, { listed: [{ filename: 'drizzle/0002_add.sql', status: 'added' }] })
      expect(verdict()).toBe('safe')
      expect(reasons()).toEqual(['1 additive migration', FROM_TREES])
      expect(contentReads(fetchMock)).toHaveLength(1)
    })

    // A file moved into the directory from outside it is `renamed` in a
    // compare, which is unsafe, and only `added` in the trees. Whatever the
    // cut-off list found unsafe, the full compare would too, so it stays.
    it('keeps an unsafe finding from the cut-off list that the trees do not see', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD, 'old/0002_moved.sql': ADD_EMAIL },
        bbbb: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_moved.sql': ADD_EMAIL }
      }, { listed: [{ filename: 'drizzle/0002_moved.sql', previous_filename: 'old/0002_moved.sql', status: 'renamed' }] })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual(['drizzle/0002_moved.sql: migration history modified (renamed)', FROM_TREES])
    })
  })

  // The same change set, classified from an untruncated compare and from the
  // trees, gets the same verdict and the same findings. Drizzle rewrites its
  // meta/ journal on every migration, and both ways ignore it.
  const railsBefore = {
    'db/migrate/.keep': '',
    'db/migrate/20260101000000_create_users.rb': rails('create_table :users'),
    'db/migrate/20260102000000_add_name.rb': rails('add_column :users, :name, :string'),
    'db/schema.rb': 'version 1'
  }
  const drizzleBefore = {
    'drizzle/0001_init.sql': ADD,
    'drizzle/meta/_journal.json': '{"entries":[1]}',
    'drizzle/meta/0001_snapshot.json': '{"v":1}'
  }
  it.each([
    {
      name: 'drizzle, an additive migration with its journal and snapshot',
      path: 'drizzle',
      before: drizzleBefore,
      after: { ...drizzleBefore, 'drizzle/0002_email.sql': ADD_EMAIL, 'drizzle/meta/_journal.json': '{"entries":[1,2]}', 'drizzle/meta/0002_snapshot.json': '{"v":2}' },
      compare: [
        { filename: 'drizzle/0002_email.sql', status: 'added' },
        { filename: 'drizzle/meta/0002_snapshot.json', status: 'added' },
        { filename: 'drizzle/meta/_journal.json', status: 'modified' }
      ],
      expected: 'safe'
    },
    {
      name: 'drizzle, a destructive migration with its journal and snapshots',
      path: 'drizzle',
      before: drizzleBefore,
      after: { ...drizzleBefore, 'drizzle/0002_drop.sql': DROP, 'drizzle/meta/_journal.json': '{"entries":[1,2]}', 'drizzle/meta/0001_snapshot.json': '{"v":1.1}', 'drizzle/meta/0002_snapshot.json': '{"v":2}' },
      compare: [
        { filename: 'drizzle/0002_drop.sql', status: 'added' },
        { filename: 'drizzle/meta/0001_snapshot.json', status: 'modified' },
        { filename: 'drizzle/meta/0002_snapshot.json', status: 'added' },
        { filename: 'drizzle/meta/_journal.json', status: 'modified' }
      ],
      expected: 'unsafe'
    },
    {
      name: 'Rails db/migrate, additive migrations, one in a subdirectory',
      path: 'db/migrate',
      before: railsBefore,
      after: {
        ...railsBefore,
        'db/migrate/20260201000000_add_email.rb': rails('add_column :users, :email, :string'),
        'db/migrate/engine/20260202000000_add_index.rb': rails('add_index :users, :email'),
        'db/schema.rb': 'version 2'
      },
      compare: [
        { filename: 'db/migrate/20260201000000_add_email.rb', status: 'added' },
        { filename: 'db/migrate/engine/20260202000000_add_index.rb', status: 'added' },
        { filename: 'db/schema.rb', status: 'modified' }
      ],
      expected: 'safe'
    },
    {
      name: 'Rails db/migrate, a modified, a removed and a destructive migration',
      path: 'db/migrate',
      before: railsBefore,
      after: {
        'db/migrate/.keep': '',
        'db/migrate/20260101000000_create_users.rb': rails('create_table :users do |t|\n      t.string :email\n    end'),
        'db/migrate/20260301000000_drop_name.rb': rails('remove_column :users, :name'),
        'db/schema.rb': 'version 2'
      },
      compare: [
        { filename: 'db/migrate/20260101000000_create_users.rb', status: 'modified' },
        { filename: 'db/migrate/20260102000000_add_name.rb', status: 'removed' },
        { filename: 'db/migrate/20260301000000_drop_name.rb', status: 'added' },
        { filename: 'db/schema.rb', status: 'modified' }
      ],
      expected: 'unsafe'
    }
  ])('$name: the trees give what an untruncated compare does', async ({ path, before, after, compare, expected }) => {
    inputs['migrations-path'] = path
    const commits = { aaaa: before, bbbb: after }
    vi.stubGlobal('fetch', fakeGitHub({
      commits,
      compare: { merge_base_commit: { sha: 'aaaa' }, files: [...compare, { filename: 'src/index.ts', status: 'modified' }] }
    }))
    await run()
    const fromCompare = { verdict: verdict(), reasons: reasons() }
    expect(fromCompare.verdict).toBe(expected)

    setOutputMock.mockReset()
    vi.stubGlobal('fetch', fakeGitHub({ commits, compare: truncatedCompare() }))
    await run()
    expect(verdict()).toBe(fromCompare.verdict)
    expect(reasons()).toEqual([...fromCompare.reasons, FROM_TREES])
  })

  // Whatever stops the directory compare, the answer is the one a cut-off
  // diff always got, unsafe and never unclassified, with the reason why.
  describe('falls back to unsafe when the trees cannot be read', () => {
    it.each([
      ['a tree read that is refused', (url) => url.includes('/git/trees/') ? failed(404) : undefined, 'git trees API 404 for the top level at aaaa'],
      ['a listing that fails', (url) => url.includes('?recursive=1') ? failed(500) : undefined, 'git trees API 500 for drizzle at aaaa'],
      ['a listing cut short', (url) => url.includes('?recursive=1') ? json({ sha: 'x', tree: [], truncated: true }) : undefined, 'git trees API listing was cut short for drizzle at aaaa'],
      ['an answer that is not a listing', (url) => url.includes('/git/trees/') ? json({ message: 'hm' }) : undefined, 'git trees API gave no listing for the top level at aaaa'],
      ['a listed file with no sha', (url) => url.includes('?recursive=1') ? json({ tree: [{ path: '0001_init.sql', type: 'blob' }], truncated: false }) : undefined, 'git trees API listed an entry with no path, type or sha for drizzle at aaaa'],
      ['a migration file read that fails', (url) => url.includes('/contents/') ? failed(500) : undefined, 'contents API 500 for drizzle/0002_add.sql']
    ])('%s', async (_name, intercept, why) => {
      await runTruncated(oneAdded, { intercept })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot(why)])
      expect(warningMock).toHaveBeenCalled()
    })

    it('a tree read that never answers', async () => {
      await runTruncated(oneAdded, {
        intercept: (url, options) => url.includes('/git/trees/') ? neverAnswers(url, options) : undefined,
        timeoutMs: 20
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('git trees API did not answer in time for the top level at aaaa')])
    })

    it('no directory at the candidate', async () => {
      await runTruncated({ aaaa: { 'drizzle/0001_init.sql': ADD }, bbbb: { 'db/0001_init.sql': ADD } })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('there is no drizzle directory at bbbb')])
    })

    // An app's first migrations look the same in the trees as a directory
    // moved or renamed into the path, whose files a compare calls `renamed`.
    // Neither is called safe.
    it.each([
      ['the first migrations', 'drizzle', { 'package.json': '{}' }],
      ['a directory moved into the path', 'db/migrate', { 'db/migrations/20260101000000_create_users.rb': rails('create_table :users') }],
      ['a directory renamed by case alone', 'db/migrate', { 'DB/migrate/20260101000000_create_users.rb': rails('create_table :users') }]
    ])('no directory at the merge base, %s', async (_name, path, before) => {
      inputs['migrations-path'] = path
      const fetchMock = await runTruncated({
        aaaa: before,
        bbbb: { 'package.json': '{}', [`${path}/20260101000000_create_users.rb`]: rails('create_table :users'), [`${path}/0000_init.sql`]: ADD }
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot(`there is no ${path} directory at aaaa`)])
      // It stops at the merge base: no walk down the candidate, no listing.
      expect(urls(fetchMock).filter((url) => url.includes('/git/trees/bbbb'))).toEqual([])
      expect(listings(fetchMock)).toEqual([])
    })

    // Missing at both commits must not pass for "the same directory at both".
    it('no directory at either commit', async () => {
      await runTruncated({ aaaa: { 'package.json': '{}' }, bbbb: { 'package.json': '{"v":2}' } })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('there is no drizzle directory at aaaa')])
    })

    // An entry the walk can't match must not hide the directory at the merge
    // base: that would make every file at the candidate added, and an edited
    // old migration would pass for a new additive one.
    it.each(['path', 'type', 'sha'])('a walk listing with an entry that has no %s', async (field) => {
      const commits = {
        aaaa: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_add.sql': ADD_EMAIL },
        bbbb: { 'drizzle/0001_init.sql': `-- edited\n${ADD}`, 'drizzle/0002_add.sql': ADD_EMAIL }
      }
      const real = fakeGitHub({ commits, compare: truncatedCompare() })
      vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        const answer = await real(url, options)
        if (!/\/git\/trees\/aaaa$/.test(url)) return answer
        const listing = await answer.json()
        const tree = listing.tree.map((entry) => {
          const copy = { ...entry }
          delete copy[field]
          return copy
        })
        return json({ ...listing, tree })
      }))
      await run()
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('git trees API listed an entry with no path, type or sha for the top level at aaaa')])
    })

    it('a migrations path that is a file, not a directory', async () => {
      await runTruncated({ aaaa: { drizzle: 'not a directory' }, bbbb: oneAdded.bbbb })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('drizzle is not a directory at aaaa')])
    })

    // Why comes second, so the workflows, which show the first two reasons,
    // show it.
    it('says why, then keeps the cut-off list\'s unsafe findings', async () => {
      await runTruncated({
        aaaa: { 'drizzle/0001_init.sql': ADD },
        bbbb: { 'drizzle/0001_init.sql': ADD, 'drizzle/0002_drop.sql': DROP }
      }, {
        listed: [{ filename: 'drizzle/0002_drop.sql', status: 'added' }],
        intercept: (url) => url.includes('/git/trees/') ? failed(500) : undefined
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toHaveLength(3)
      expect(reasons()[0]).toBe(TRUNCATED)
      expect(reasons()[1]).toBe(couldNot('git trees API 500 for the top level at aaaa'))
      expect(reasons()[2]).toMatch(/^drizzle\/0002_drop\.sql: /)
    })

    // The tree side reads at most 300 migration files of its own, so a
    // release that adds more is unsafe before any of them is read.
    it('more added migrations than the trees may read → unsafe, before reading any', async () => {
      const many = Object.fromEntries(Array.from({ length: 301 }, (_, i) =>
        [`drizzle/${String(i).padStart(4, '0')}_m.sql`, `CREATE TABLE t${i} (id int);`]))
      const fetchMock = await runTruncated({ aaaa: { 'drizzle/.keep': '' }, bbbb: { 'drizzle/.keep': '', ...many } })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('301 added migration files to read, more than the 300 allowed')])
      expect(contentReads(fetchMock)).toEqual([])
    })
  })

  // A cut-off release that edits thousands of old migrations, a lint sweep
  // say, has a reason for each. The output must stay far below the 131,072
  // bytes Linux allows one environment string.
  it('3,000 modified migrations and one very long reason → under 16 KB, the full list in the log', async () => {
    const old = Object.fromEntries(Array.from({ length: 3000 }, (_, i) =>
      [`drizzle/${String(i + 1).padStart(4, '0')}_m.sql`, `CREATE TABLE t${i} (id int);`]))
    const edited = Object.fromEntries(Object.entries(old).map(([path, sql]) => [path, `-- lint\n${sql}`]))
    const longName = `drizzle/0000_${'x'.repeat(20000)}.js`
    await runTruncated({ aaaa: old, bbbb: { ...edited, [longName]: 'module.exports = {}' } })
    expect(verdict()).toBe('unsafe')
    const all = [
      `${longName}: unsupported migration format (only .sql and Rails .rb are classified)`,
      ...Object.keys(old).map((path) => `${path}: migration history modified (modified)`),
      FROM_TREES
    ]
    expect(Buffer.byteLength(output('reasons'))).toBeLessThan(16 * 1024)
    const shown = reasons()
    expect(shown).toHaveLength(20)
    expect(shown[0]).toBe(`${all[0].slice(0, 497)}...`)
    expect(shown.slice(1, 19)).toEqual(all.slice(1, 19))
    expect(shown[19]).toBe(`and ${all.length - 19} more reasons, listed in this step's log`)
    // The log has every reason, whole.
    expect(infoMock).toHaveBeenCalledTimes(1)
    expect(infoMock.mock.calls[0][0].split('\n')).toEqual([`rollback safety reasons (${all.length}):`, ...all.map((reason) => `- ${reason}`)])
  })

  describe('time and reads', () => {
    it('reads a bounded set: the compare, a walk down each side, a listing each side, the added files', async () => {
      inputs['migrations-path'] = 'db/migrate'
      const before = { 'db/migrate/20260101000000_create_users.rb': rails('create_table :users'), 'app/models/user.rb': 'a' }
      const fetchMock = await runTruncated({
        aaaa: before,
        bbbb: { ...before, 'db/migrate/20260201000000_add_email.rb': rails('add_column :users, :email, :string'), 'app/models/user.rb': 'b' }
      })
      expect(verdict()).toBe('safe')
      expect(reasons()).toEqual(['1 additive migration', FROM_TREES])
      expect(urls(fetchMock)).toEqual([
        expect.stringMatching(/\/compare\/aaaa\.\.\.bbbb$/),
        expect.stringMatching(/\/git\/trees\/aaaa$/),
        expect.stringMatching(/\/git\/trees\/[0-9a-f]{40}$/),
        expect.stringMatching(/\/git\/trees\/bbbb$/),
        expect.stringMatching(/\/git\/trees\/[0-9a-f]{40}$/),
        expect.stringMatching(/\/git\/trees\/[0-9a-f]{40}\?recursive=1$/),
        expect.stringMatching(/\/git\/trees\/[0-9a-f]{40}\?recursive=1$/),
        expect.stringMatching(/\/contents\/db\/migrate\/20260201000000_add_email\.rb\?ref=bbbb$/)
      ])
      // Every read, the tree reads included, has its own time limit.
      for (const [, options] of fetchMock.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal)
    })

    // The clock moves 20 seconds a read. The compare, the walk down each side
    // and both listings fit in 90 seconds; the added file does not, and is
    // never asked for. Out of time here keeps the cut-off diff's answer.
    it('directory reads that pass the deadline → unsafe, with no read after it', async () => {
      let clock = 0
      const fetchMock = await runTruncated(oneAdded, {
        intercept: () => { clock += 20 * 1000 },
        now: () => clock
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('the GitHub reads ran out of their 90 seconds before the contents API read for drizzle/0002_add.sql')])
      expect(fetchMock).toHaveBeenCalledTimes(5)
    })

    it('a tree read the overall deadline stops says the reads ran out of time', async () => {
      await runTruncated(oneAdded, {
        intercept: (url, options) => url.includes('/git/trees/') ? neverAnswers(url, options) : undefined,
        timeoutMs: 5000,
        deadlineMs: 30
      })
      expect(verdict()).toBe('unsafe')
      expect(reasons()).toEqual([TRUNCATED, couldNot('the GitHub reads ran out of their 0.03 seconds during the git trees API read for the top level at aaaa')])
    })
  })
})
