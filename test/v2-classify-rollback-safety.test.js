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

import { run } from '../src/classify-rollback-safety.js'

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
  inputs.repository = 'CruGlobal/hoax'
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
    expect(reasons()).toEqual([])
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

  it('ignores files outside the migrations path (no content fetch)', async () => {
    const fetchMock = vi.fn(async (url) =>
      url.includes('/compare/')
        ? compareFiles([{ filename: 'src/index.ts', status: 'added' }])
        : rawContent('should not be fetched'))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('safe')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('diff truncated at 300 files → unsafe with the truncation reason', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `other/${i}.ts`, status: 'added' }))
    const fetchMock = vi.fn(async () => compareFiles(files))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    expect(verdict()).toBe('unsafe')
    expect(reasons()).toContain('diff truncated at 300 files — classify manually')
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
