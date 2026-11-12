import { describe, it, expect, beforeEach, vi } from 'vitest'

const { inputs, failedMock, outputMock, summaryText } = vi.hoisted(() => ({
  inputs: {},
  failedMock: vi.fn(),
  outputMock: vi.fn(),
  summaryText: { value: '' }
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  setFailed: failedMock,
  setOutput: outputMock,
  info: vi.fn(),
  summary: {
    addRaw (text) { summaryText.value += text; return this },
    write: async () => {}
  }
}))

import { toRepoPath, parseChangedFiles, coverageForChanged, belowMinimum, renderTable, parseMinimum, run } from '../src/changed-coverage.js'

const WORKSPACE = '/home/runner/work/example-app/example-app'
const summary = {
  total: { lines: { pct: 50 } },
  [`${WORKSPACE}/src/a.ts`]: { lines: { pct: 90 } },
  [`${WORKSPACE}/src/b.ts`]: { lines: { pct: 40 } },
  'src/empty.ts': { lines: { pct: 'Unknown' } }
}

describe('toRepoPath', () => {
  it('makes report keys repo-relative', () => {
    expect(toRepoPath(`${WORKSPACE}/src/a.ts`, WORKSPACE)).toBe('src/a.ts')
    expect(toRepoPath(`${WORKSPACE}/src/a.ts`, `${WORKSPACE}/`)).toBe('src/a.ts')
    expect(toRepoPath('./src/a.ts', WORKSPACE)).toBe('src/a.ts')
    expect(toRepoPath('C:\\w\\app\\src\\a.ts', 'C:\\w\\app')).toBe('src/a.ts')
    expect(toRepoPath('/elsewhere/a.ts', WORKSPACE)).toBe('/elsewhere/a.ts')
  })
})

describe('coverageForChanged', () => {
  it('pairs each changed file with its coverage, keeping order', () => {
    const rows = coverageForChanged(summary, ['src/b.ts', 'README.md', 'src/a.ts', 'src/empty.ts'], WORKSPACE)
    expect(rows).toEqual([
      { file: 'src/b.ts', pct: 40, measured: true },
      { file: 'README.md', pct: null, measured: false },
      { file: 'src/a.ts', pct: 90, measured: true },
      { file: 'src/empty.ts', pct: null, measured: true }
    ])
  })
})

describe('belowMinimum', () => {
  const rows = coverageForChanged(summary, ['src/a.ts', 'src/b.ts', 'README.md', 'src/empty.ts'], WORKSPACE)
  it('never fails at 0 and skips files it cannot measure', () => {
    expect(belowMinimum(rows, 0)).toEqual([])
    expect(belowMinimum(rows, 80).map((row) => row.file)).toEqual(['src/b.ts'])
  })
})

describe('renderTable', () => {
  it('shows every row', () => {
    const table = renderTable(coverageForChanged(summary, ['src/a.ts', 'README.md', 'src/empty.ts'], WORKSPACE))
    expect(table).toContain('| `src/a.ts` | 90% |')
    expect(table).toContain('| `README.md` | not measured |')
    expect(table).toContain('| `src/empty.ts` | no lines |')
    expect(renderTable([])).toBe('No changed files to report.')
  })
})

describe('parseMinimum', () => {
  it('accepts 0 to 100 and refuses anything else', () => {
    expect(parseMinimum('')).toBe(0)
    expect(parseMinimum('80.5')).toBe(80.5)
    expect(() => parseMinimum('101')).toThrow(/0 to 100/)
    expect(() => parseMinimum('-1')).toThrow(/0 to 100/)
    expect(() => parseMinimum('eighty')).toThrow(/0 to 100/)
  })
})

describe('parseChangedFiles', () => {
  it('splits lines and drops blanks', () => {
    expect(parseChangedFiles('a\r\n\n b \n')).toEqual(['a', 'b'])
  })
})

describe('run', () => {
  let files
  const readFile = (file) => {
    if (!(file in files)) throw new Error('ENOENT')
    return files[file]
  }

  beforeEach(() => {
    for (const key of Object.keys(inputs)) delete inputs[key]
    inputs['summary-file'] = 'coverage/coverage-summary.json'
    inputs['changed-files-file'] = 'changed.txt'
    failedMock.mockReset()
    outputMock.mockReset()
    summaryText.value = ''
    files = {
      [`${WORKSPACE}/coverage/coverage-summary.json`]: JSON.stringify(summary),
      [`${WORKSPACE}/changed.txt`]: 'src/a.ts\nsrc/b.ts\n'
    }
  })

  it('reports only by default', async () => {
    await run({ readFile, workspace: WORKSPACE })
    expect(failedMock).not.toHaveBeenCalled()
    expect(outputMock).toHaveBeenCalledWith('measured-files', '2')
    expect(summaryText.value).toContain('No minimum set')
  })

  it('fails with the files under the minimum', async () => {
    inputs['min-coverage'] = '80'
    await run({ readFile, workspace: WORKSPACE })
    expect(failedMock).toHaveBeenCalledWith('Changed files under 80% line coverage: src/b.ts (40%)')
  })

  it('explains a missing report', async () => {
    delete files[`${WORKSPACE}/coverage/coverage-summary.json`]
    await run({ readFile, workspace: WORKSPACE })
    expect(failedMock).toHaveBeenCalledWith(expect.stringContaining('must write an istanbul json-summary report'))
  })
})
