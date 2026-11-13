import { describe, it, expect, beforeEach, vi } from 'vitest'

const { inputs, failedMock, warningMock, noticeMock, outputMock, summaryText } = vi.hoisted(() => ({
  inputs: {},
  failedMock: vi.fn(),
  warningMock: vi.fn(),
  noticeMock: vi.fn(),
  outputMock: vi.fn(),
  summaryText: { value: '' }
}))

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  setFailed: failedMock,
  warning: warningMock,
  notice: noticeMock,
  setOutput: outputMock,
  info: vi.fn(),
  summary: {
    addRaw (text) { summaryText.value += text; return this },
    write: async () => {}
  }
}))

vi.mock('@actions/github', () => ({ context: {}, getOctokit: () => { throw new Error('use the injected octokit') } }))

import {
  globToRegExp, parsePathList, parseCodeowners, isOwned, classifyTier, checkLinks, countChangedLines, sizeVerdict,
  stripHtmlComments, compilePattern, parseCount, parseBoolean, run,
  DEFAULT_WORK_ITEM_PATTERN, DEFAULT_SPEC_PATTERN, DEFAULT_SIZE_IGNORE, ONE_WAY, TWO_WAY
} from '../src/pr-guard.js'

const matches = (pattern, file) => globToRegExp(pattern).test(file)

describe('globToRegExp', () => {
  it('matches a bare name at any depth', () => {
    expect(matches('yarn.lock', 'yarn.lock')).toBe(true)
    expect(matches('yarn.lock', 'packages/app/yarn.lock')).toBe(true)
    expect(matches('yarn.lock', 'yarn.lock.bak')).toBe(false)
  })

  it('anchors a pattern with a leading or middle slash to the root', () => {
    expect(matches('/src/payments', 'src/payments/charge.ts')).toBe(true)
    expect(matches('src/payments/', 'src/payments/charge.ts')).toBe(true)
    expect(matches('src/payments/', 'lib/src/payments/charge.ts')).toBe(false)
  })

  it('treats a folder name as everything under it', () => {
    expect(matches('migrations/', 'db/migrations/001.sql')).toBe(true)
    expect(matches('migrations', 'db/migrations/001.sql')).toBe(true)
    expect(matches('migrations/', 'db/migrations.md')).toBe(false)
  })

  it('keeps * inside one folder and lets ** cross folders', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('/src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(matches('src/**/auth*.ts', 'src/a/b/auth-token.ts')).toBe(true)
    expect(matches('src/**/auth*.ts', 'src/auth.ts')).toBe(true)
    expect(matches('**/secrets/**', 'config/secrets/prod.json')).toBe(true)
  })

  it('escapes regex characters in names', () => {
    expect(matches('a+b(c).js', 'a+b(c).js')).toBe(true)
    expect(matches('a.js', 'abjs')).toBe(false)
  })

  it('matches one character with ?', () => {
    expect(matches('v?.yml', 'v2.yml')).toBe(true)
    expect(matches('v?.yml', 'v22.yml')).toBe(false)
  })

  it('reads a trailing * as files directly in the folder for CODEOWNERS only', () => {
    const owners = (pattern, file) => globToRegExp(pattern, { codeowners: true }).test(file)
    expect(owners('docs/*', 'docs/a.md')).toBe(true)
    expect(owners('docs/*', 'docs/deep/a.md')).toBe(false)
    expect(owners('docs/**', 'docs/deep/a.md')).toBe(true)
    expect(owners('docs/', 'docs/deep/a.md')).toBe(true)
    expect(matches('docs/*', 'docs/deep/a.md')).toBe(true)
    expect(owners('config*', 'config/settings.yml')).toBe(true)
  })
})

describe('parsePathList', () => {
  it('skips blanks and comments', () => {
    expect(parsePathList('# header\n\nsrc/payments/  # money\r\n  auth/\n#x')).toEqual(['src/payments/', 'auth/'])
  })
})

describe('parseCodeowners', () => {
  it('takes the first word as the path and notes whether it has owners', () => {
    const text = '# owners\n/src/payments/  @example-org/payments  # money\n/src/payments/fixtures/\ndocs/my\\ file.md dev@example.com\n'
    expect(parseCodeowners(text)).toEqual([
      { pattern: '/src/payments/', owned: true },
      { pattern: '/src/payments/fixtures/', owned: false },
      { pattern: 'docs/my file.md', owned: true }
    ])
  })

  it('skips catch-all default-owner lines', () => {
    const text = '* @a\n** @a\n/** @a\n**/* @a\n/auth/ @example-org/security'
    expect(parseCodeowners(text)).toEqual([{ pattern: '/auth/', owned: true }])
  })

  it('reads \\# as a # in a path', () => {
    expect(parseCodeowners('\\#notes @a')).toEqual([{ pattern: '#notes', owned: true }])
  })
})

describe('isOwned', () => {
  const rules = parseCodeowners('/src/payments/ @example-org/payments\n/src/payments/fixtures/\n*.md @example-org/docs')

  it('lets the last matching line decide, as GitHub does', () => {
    expect(isOwned('src/payments/charge.ts', rules)).toBe(true)
    expect(isOwned('src/payments/fixtures/card.json', rules)).toBe(false)
    expect(isOwned('src/payments/fixtures/README.md', rules)).toBe(true)
  })

  it('is not owned when no line matches', () => {
    expect(isOwned('src/other.ts', rules)).toBe(false)
    expect(isOwned('src/other.ts', [])).toBe(false)
  })
})

describe('classifyTier', () => {
  const rules = parseCodeowners('/src/payments/ @example-org/payments')

  it('is one-way when any path is owned', () => {
    expect(classifyTier(['README.md', 'src/payments/x.ts'], rules)).toEqual({ tier: ONE_WAY, matched: ['src/payments/x.ts'] })
  })

  it('is two-way when nothing is owned or there are no rules', () => {
    expect(classifyTier(['README.md'], rules).tier).toBe(TWO_WAY)
    expect(classifyTier(['README.md'], []).tier).toBe(TWO_WAY)
  })
})

describe('checkLinks', () => {
  const patterns = {
    workItem: compilePattern(DEFAULT_WORK_ITEM_PATTERN, 'w'),
    spec: compilePattern(DEFAULT_SPEC_PATTERN, 's')
  }

  it('passes with both links', () => {
    const body = 'Work item: https://tracker.example.com/browse/APP-1\n**Spec:** https://docs.example.com/spec'
    expect(checkLinks(body, patterns)).toEqual([])
  })

  it('reports each missing link', () => {
    expect(checkLinks('', patterns)).toEqual(['work item link', 'spec link'])
    expect(checkLinks(null, patterns)).toEqual(['work item link', 'spec link'])
    expect(checkLinks('Work item: https://x.example.com/1', patterns)).toEqual(['spec link'])
  })

  it('needs the whole word', () => {
    expect(checkLinks('Work item: https://x.example.com/1\nInspected https://x.example.com/s', patterns)).toEqual(['spec link'])
  })

  it('needs a URL, not just the label', () => {
    expect(checkLinks('Work item: TBD\nSpec: n/a', patterns)).toEqual(['work item link', 'spec link'])
  })

  it('ignores links inside HTML comments, including an unclosed one', () => {
    const body = '<!-- Work item: https://x.example.com/1 -->\nSpec: https://x.example.com/s\n<!-- Work item: https://x.example.com/2'
    expect(checkLinks(body, patterns)).toEqual(['work item link'])
  })

  it('does not require what is turned off', () => {
    expect(checkLinks('', { ...patterns, requireWorkItem: false, requireSpec: false })).toEqual([])
  })
})

describe('stripHtmlComments', () => {
  it('drops comments and keeps the rest', () => {
    expect(stripHtmlComments('a<!-- b -->c<!-- d\ne -->f')).toBe('acf')
  })
})

describe('countChangedLines', () => {
  const ignore = parsePathList(DEFAULT_SIZE_IGNORE)

  it('adds additions and deletions outside the ignore list', () => {
    const files = [
      { filename: 'src/a.ts', additions: 10, deletions: 5 },
      { filename: 'yarn.lock', additions: 900, deletions: 900 },
      { filename: 'dist/index.js', additions: 400, deletions: 0 },
      { filename: 'src/dist/real.js', additions: 2, deletions: 0 },
      { filename: 'src/__snapshots__/a.snap', additions: 50, deletions: 0 },
      { filename: 'src/b.ts' }
    ]
    expect(countChangedLines(files, ignore)).toBe(17)
  })

  it('counts a file by where it ends up', () => {
    expect(countChangedLines([{ filename: 'src/x.js', previous_filename: 'dist/x.js', additions: 3, deletions: 0 }], ignore)).toBe(3)
    expect(countChangedLines([{ filename: 'dist/x.js', previous_filename: 'src/x.js', additions: 3, deletions: 0 }], ignore)).toBe(0)
  })
})

describe('sizeVerdict', () => {
  const limits = { warnLines: 300, failLines: 800, overridden: false }
  it('passes at the limits and fails past them', () => {
    expect(sizeVerdict(300, limits)).toBe('ok')
    expect(sizeVerdict(301, limits)).toBe('warn')
    expect(sizeVerdict(800, limits)).toBe('warn')
    expect(sizeVerdict(801, limits)).toBe('fail')
    expect(sizeVerdict(801, { ...limits, overridden: true })).toBe('overridden')
  })
})

describe('input parsing', () => {
  it('refuses what it cannot read, naming the input', () => {
    expect(() => compilePattern('(', 'spec-pattern')).toThrow(/spec-pattern is not a valid regular expression/)
    expect(() => parseCount('3.5', 'warn-lines')).toThrow('warn-lines must be a whole number, got "3.5"')
    expect(() => parseCount('-1', 'fail-lines')).toThrow(/fail-lines/)
    expect(() => parseBoolean('yes', 'require-spec')).toThrow('require-spec must be true or false, got "yes"')
    expect(parseCount(' 12 ', 'x')).toBe(12)
    expect(parseBoolean('FALSE', 'x')).toBe(false)
  })
})

describe('run', () => {
  const goodBody = 'Work item: https://tracker.example.com/browse/APP-1\nSpec: https://docs.example.com/spec'
  let octokit
  let pr
  let files
  let repoFiles

  const context = () => ({
    repo: { owner: 'example-org', repo: 'example-app' },
    payload: { pull_request: { number: 7, base: { sha: 'b'.repeat(40) } } }
  })

  beforeEach(() => {
    for (const key of Object.keys(inputs)) delete inputs[key]
    inputs['github-token'] = 'token'
    failedMock.mockReset()
    warningMock.mockReset()
    noticeMock.mockReset()
    outputMock.mockReset()
    summaryText.value = ''
    pr = { body: goodBody, labels: [] }
    files = [{ filename: 'src/a.ts', additions: 10, deletions: 0 }]
    repoFiles = { '.github/CODEOWNERS': '/src/payments/ @example-org/payments\n' }
    octokit = {
      paginate: vi.fn(async () => files),
      rest: {
        pulls: { get: vi.fn(async () => ({ data: pr })), listFiles: vi.fn() },
        repos: {
          getContent: vi.fn(async ({ path }) => {
            if (!(path in repoFiles)) throw Object.assign(new Error('Not Found'), { status: 404 })
            return { data: { type: 'file', encoding: 'base64', content: Buffer.from(repoFiles[path]).toString('base64') } }
          })
        },
        issues: { addLabels: vi.fn(async () => ({})), removeLabel: vi.fn(async () => ({})) }
      }
    }
  })

  const go = () => run({ context: context(), getOctokit: () => octokit })
  const output = (name) => outputMock.mock.calls.find((call) => call[0] === name)?.[1]

  it('passes a small linked two-way PR and labels it', async () => {
    await go()
    expect(failedMock).not.toHaveBeenCalled()
    expect(output('tier')).toBe(TWO_WAY)
    expect(output('changed-lines')).toBe('10')
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({ owner: 'example-org', repo: 'example-app', issue_number: 7, labels: [TWO_WAY] })
  })

  it('reads CODEOWNERS from the base commit, not the PR', async () => {
    await go()
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({ owner: 'example-org', repo: 'example-app', path: '.github/CODEOWNERS', ref: 'b'.repeat(40) })
    expect(summaryText.value).toContain('from .github/CODEOWNERS')
  })

  it('looks for CODEOWNERS where GitHub does, in order', async () => {
    repoFiles = { 'docs/CODEOWNERS': '/src/a.ts @example-org/core\n' }
    await go()
    expect(octokit.rest.repos.getContent.mock.calls.map(([args]) => args.path)).toEqual(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'])
    expect(output('tier')).toBe(ONE_WAY)
  })

  it('reads only tier-paths-file when it is set', async () => {
    inputs['tier-paths-file'] = '.github/tier-owners'
    repoFiles['.github/tier-owners'] = '/src/a.ts @example-org/core\n'
    await go()
    expect(octokit.rest.repos.getContent.mock.calls.map(([args]) => args.path)).toEqual(['.github/tier-owners'])
    expect(output('tier')).toBe(ONE_WAY)
  })

  it('warns when no line names an owner, as an old-style path list would', async () => {
    repoFiles['.github/CODEOWNERS'] = '/src/payments/\n/infra/\n'
    await go()
    expect(output('tier')).toBe(TWO_WAY)
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('No line in .github/CODEOWNERS names an owner'))
  })

  it('does not count a path whose last matching line has no owner', async () => {
    repoFiles['.github/CODEOWNERS'] = '* @example-org/everyone\n/src/ @example-org/core\n/src/a.ts\n'
    await go()
    expect(output('tier')).toBe(TWO_WAY)
  })

  it('labels a one-way PR, swaps out the old label, and names the paths', async () => {
    pr.labels = [{ name: TWO_WAY }]
    files = [{ filename: 'src/payments/charge.ts', additions: 1, deletions: 1 }]
    await go()
    expect(output('tier')).toBe(ONE_WAY)
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: TWO_WAY }))
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: [ONE_WAY] }))
    expect(summaryText.value).toContain('`src/payments/charge.ts`')
  })

  it('counts a file moved out of a one-way path as one-way', async () => {
    files = [{ filename: 'src/other/charge.ts', previous_filename: 'src/payments/charge.ts', additions: 0, deletions: 0 }]
    await go()
    expect(output('tier')).toBe(ONE_WAY)
  })

  it('sets no tier when the base branch has no CODEOWNERS', async () => {
    repoFiles = {}
    await go()
    expect(failedMock).not.toHaveBeenCalled()
    expect(output('tier')).toBeUndefined()
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled()
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('no tier label'))
  })

  it('fails when CODEOWNERS cannot be read for another reason', async () => {
    octokit.rest.repos.getContent.mockRejectedValue(Object.assign(new Error('Server Error'), { status: 500 }))
    await go()
    expect(failedMock).toHaveBeenCalledWith('Server Error')
  })

  it('fails when CODEOWNERS is too large for the contents API', async () => {
    octokit.rest.repos.getContent.mockResolvedValue({ data: { type: 'file', encoding: 'none', content: '' } })
    await go()
    expect(failedMock).toHaveBeenCalledWith(expect.stringContaining('.github/CODEOWNERS is too large'))
    expect(output('tier')).toBeUndefined()
  })

  it('reports missing links and an oversized PR together', async () => {
    pr.body = 'no links'
    files = [{ filename: 'src/a.ts', additions: 900, deletions: 0 }]
    await go()
    const message = failedMock.mock.calls[0][0]
    expect(message).toContain('missing a work item link and a spec link')
    expect(message).toContain('900 changed lines is over the limit of 800')
  })

  it('lets the override label through and only warns between the limits', async () => {
    pr.labels = [{ name: 'size-override' }]
    files = [{ filename: 'src/a.ts', additions: 900, deletions: 0 }]
    await go()
    expect(failedMock).not.toHaveBeenCalled()
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('allowed by the size-override label'))

    pr.labels = []
    files = [{ filename: 'src/a.ts', additions: 400, deletions: 0 }]
    await go()
    expect(failedMock).not.toHaveBeenCalled()
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('400 changed lines is over 300'))
  })

  it('refuses a pull request bigger than the files API can list', async () => {
    pr.changed_files = 3001
    files = Array.from({ length: 3000 }, (_, i) => ({ filename: `aaa/${i}.txt`, additions: 1, deletions: 0 }))
    await go()
    expect(failedMock).toHaveBeenCalledWith(expect.stringContaining('changes 3001 files, but GitHub lists only the first 3000'))
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled()
  })

  it('warns instead of failing when it cannot label, as on a fork', async () => {
    octokit.rest.issues.addLabels.mockRejectedValue(new Error('Resource not accessible by integration'))
    await go()
    expect(failedMock).not.toHaveBeenCalled()
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('could not set the two-way-door label'))
  })

  it('skips labels when apply-tier-label is false', async () => {
    inputs['apply-tier-label'] = 'false'
    await go()
    expect(output('tier')).toBe(TWO_WAY)
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled()
  })

  it('fails on a bad input before calling GitHub', async () => {
    inputs['fail-lines'] = 'lots'
    await go()
    expect(failedMock).toHaveBeenCalledWith('fail-lines must be a whole number, got "lots"')
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
  })

  it('fails outside a pull request event', async () => {
    await run({ context: { repo: {}, payload: {} }, getOctokit: () => octokit })
    expect(failedMock).toHaveBeenCalledWith(expect.stringContaining('only runs on pull_request'))
  })
})
