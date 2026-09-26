import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'
import { checkActionBundles, readRuns } from '../.github/scripts/check-action-bundles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, '.github/scripts/check-action-bundles.mjs')

// A throwaway repo root: { 'actions/x/action.yml': '...', 'dist/x.js': '' }
let fixture
function repo (files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true })
    writeFileSync(path.join(fixture, file), content)
  }
  return fixture
}
const nodeAction = (main, extra = '') => `name: X\ndescription: x\nruns:\n  using: 'node24'\n  main: '${main}'\n${extra}`

beforeEach(() => { fixture = mkdtempSync(path.join(tmpdir(), 'bundles-')) })
afterEach(() => rmSync(fixture, { recursive: true, force: true }))

describe('readRuns', () => {
  it('reads the same runs keys as a YAML parser for every action in this repo', () => {
    const actions = readdirSync(path.join(root, 'actions'))
    expect(actions.length).toBeGreaterThan(10)
    for (const name of actions) {
      const text = readFileSync(path.join(root, 'actions', name, 'action.yml'), 'utf8')
      const parsed = yaml.load(text).runs
      const read = readRuns(text)
      for (const key of ['using', 'main', 'pre', 'post']) {
        expect(read[key], `${name} runs.${key}`).toBe(parsed[key] === undefined ? undefined : String(parsed[key]))
      }
    }
  })

  it('handles quotes, comments and nested blocks', () => {
    const text = [
      'name: x',
      '# runs: not this one',
      'runs:',
      '  using: "node24"   # runtime',
      "  pre: '../../dist/it''s.js'",
      '  post: ../../dist/post.js',
      '  steps:',
      '    - main: not-a-runs-key',
      'outputs: {}'
    ].join('\n')
    expect(readRuns(text)).toEqual({ using: 'node24', pre: "../../dist/it's.js", post: '../../dist/post.js', steps: '' })
  })
})

describe('checkActionBundles', () => {
  it('passes when every named file exists', () => {
    const { problems, checked } = checkActionBundles(repo({
      'actions/a/action.yml': nodeAction('../../dist/a.js', "  pre: '../../dist/a-pre.js'\n  post: '../../dist/a-post.js'\n"),
      'dist/a.js': '', 'dist/a-pre.js': '', 'dist/a-post.js': '',
      'actions/c/action.yml': 'name: C\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n'
    }))
    expect(problems).toEqual([])
    expect(checked).toHaveLength(3)
  })

  it('flags a missing bundle, naming the action and the file', () => {
    const { problems } = checkActionBundles(repo({
      'actions/a/action.yml': nodeAction('../../dist/a.js'), 'dist/a.js': '',
      'actions/b/action.yml': nodeAction('../../dist/b.js')
    }))
    expect(problems).toEqual(['actions/b/action.yml runs.main (../../dist/b.js) needs dist/b.js, which does not exist at this commit'])
  })

  it('flags a missing pre or post file', () => {
    const { problems } = checkActionBundles(repo({
      'actions/a/action.yml': nodeAction('../../dist/a.js', "  post: '../../dist/a-post.js'\n"), 'dist/a.js': ''
    }))
    expect(problems).toEqual([expect.stringContaining('runs.post (../../dist/a-post.js) needs dist/a-post.js')])
  })

  it.each([
    ['a node action with no main', 'name: A\nruns:\n  using: node24\n', /names no runs.main/],
    ['an action.yml it cannot read', 'name: A\nruns: { using: node24, main: ../../dist/a.js }\n', /no runs.using/],
    ['a file outside the repo', nodeAction('../../../outside.js'), /points outside the repo/],
    ['a directory instead of a file', nodeAction('../../dist'), /does not exist at this commit/]
  ])('flags %s', (_label, actionYml, pattern) => {
    const { problems } = checkActionBundles(repo({ 'actions/a/action.yml': actionYml, 'dist/.keep': '' }))
    expect(problems).toEqual([expect.stringMatching(pattern)])
  })

  it('flags an action folder with no action.yml, and a repo with no actions', () => {
    expect(checkActionBundles(repo({ 'actions/a/README.md': 'x' })).problems).toEqual(['actions/a has no action.yml'])
    rmSync(path.join(fixture, 'actions'), { recursive: true })
    expect(checkActionBundles(fixture).problems).toEqual(['no actions found under actions/'])
  })
})

describe('check-action-bundles script', () => {
  const runScript = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })

  it('exits 0 when every file exists', () => {
    const result = runScript(repo({ 'actions/a/action.yml': nodeAction('../../dist/a.js'), 'dist/a.js': '' }))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("every action's files exist (1 checked)")
  })

  it('exits 1 with an ::error:: line when a bundle is missing', () => {
    const result = runScript(repo({ 'actions/a/action.yml': nodeAction('../../dist/a.js') }))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::actions/a/action.yml runs.main (../../dist/a.js) needs dist/a.js')
    expect(result.stdout).toContain('not safe to move the release tags onto this commit')
  })
})
