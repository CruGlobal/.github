import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Real git repositories for the hotfix tests: a bare "origin" standing in for
// the app repo on GitHub, a "dev" clone that writes its history, and fresh
// clones standing in for a runner's full-history checkout. Nothing leaves the
// machine.
//
// The runner side runs with no global or system git config, like a fresh CI
// runner: no user identity, no signing, no aliases. Call isolateGitConfig()
// once per test file; it points this worker's git at an empty config file.

const AUTHOR = { name: 'Example Dev', email: 'dev@example.org' }

let emptyConfig = null
export function isolateGitConfig () {
  if (!emptyConfig) {
    const dir = mkdtempSync(path.join(tmpdir(), 'git-config-'))
    emptyConfig = path.join(dir, 'gitconfig')
    writeFileSync(emptyConfig, '')
  }
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
}

function devEnv (when) {
  const date = `2026-10-${String(when).padStart(2, '0')}T12:00:00Z`
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  }
}

export const PIPELINE = [
  'name: Pipeline v2',
  'on:',
  '  workflow_dispatch:',
  'jobs:',
  '  build:',
  '    uses: CruGlobal/.github/.github/workflows/build-candidate.yml@v2',
  ''
].join('\n')

// app.js: twelve numbered lines, so tests can change one line and leave the
// ones around it alone (or change a line near it, to vary the context).
export const APP_LINES = Array.from({ length: 12 }, (_, i) => `const line${i + 1} = ${i + 1}`)

export class GitFixture {
  constructor () {
    this.root = mkdtempSync(path.join(tmpdir(), 'hotfix-fixture-'))
    this.origin = path.join(this.root, 'origin.git')
    this.dev = path.join(this.root, 'dev')
    this.clock = 1
    this.clones = 0
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', this.origin])
    execFileSync('git', ['clone', '--quiet', this.origin, this.dev], { stdio: 'ignore' })
    this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }

  // Run git in `cwd` (the dev clone by default) as the developer.
  git (args, cwd = this.dev) {
    return execFileSync('git', args, { cwd, env: devEnv(this.clock++), encoding: 'utf8' }).trim()
  }

  write (file, content) {
    const full = path.join(this.dev, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  remove (file) {
    this.git(['rm', '--quiet', file])
  }

  // Write the files, commit them on the current branch, return the sha.
  commit (message, files = {}) {
    for (const [file, content] of Object.entries(files)) this.write(file, content)
    this.git(['add', '--all'])
    this.git(['commit', '--quiet', '--allow-empty', '-m', message])
    return this.git(['rev-parse', 'HEAD'])
  }

  // app.js with some lines replaced: { 5: 'const line5 = 55' }.
  appWith (changes) {
    return APP_LINES.map((line, i) => changes[i + 1] ?? line).join('\n') + '\n'
  }

  push (...refspecs) {
    this.git(['push', '--quiet', 'origin', ...refspecs])
  }

  // A fresh full-history clone, like actions/checkout with fetch-depth 0.
  clone () {
    const dir = path.join(this.root, `runner-${++this.clones}`)
    execFileSync('git', ['clone', '--quiet', this.origin, dir], { stdio: 'ignore' })
    return dir
  }

  // What the origin has: { 'refs/heads/main': sha, ... }.
  refs () {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: this.origin, encoding: 'utf8' }).trim()
    return Object.fromEntries(out.split('\n').filter(Boolean).map((line) => line.split(' ')))
  }

  // Run git against the origin (to read the pushed branch).
  originGit (args) {
    return execFileSync('git', args, { cwd: this.origin, encoding: 'utf8' }).trim()
  }

  cleanup () {
    rmSync(this.root, { recursive: true, force: true })
  }
}

// The usual app: a release in production, then unreleased work on main
// (including a migration a hotfix must not ship), then the fix.
//
//   initial -> release (B, live) -> unreleased migration -> nearby change -> fix (X)
//
// The "nearby change" edits app.js two lines above the line the fix edits, so
// the fix's diff on main has different context lines than the same change has
// on the release. A cherry-pick still applies cleanly.
export function standardApp ({ pipeline = PIPELINE } = {}) {
  const fx = new GitFixture()
  const files = { 'app.js': fx.appWith({}), 'db/migrate/001_create_items.sql': 'CREATE TABLE items (id int);\n' }
  if (pipeline !== null) files['.github/workflows/pipeline-v2.yml'] = pipeline
  fx.initial = fx.commit('initial', files)
  fx.release = fx.commit('feature: items list', { 'app.js': fx.appWith({ 3: 'const line3 = 33' }) })
  fx.unreleased = fx.commit('drop a column', { 'db/migrate/002_drop_name.sql': 'ALTER TABLE items DROP COLUMN name;\n' })
  fx.nearby = fx.commit('rename a constant', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66' }) })
  fx.fix = fx.commit('fix: line 8 is off by one', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1' }) })
  fx.push('main')
  return fx
}

export const RELEASE = 'release-2026-10-20-10140'
export const NEWER_RELEASE = 'release-2026-10-22-10150'
export const PROJECT = 'example-app'

export const ledgerRow = (revision, sha, extra = {}) => ({ Project: PROJECT, Environment: 'production', Action: 'promote', Revision: revision, Sha: sha, ...extra })

// A readLedger stand-in: answers each call with the next entry of `answers`
// (the last one repeats). An Error entry is thrown. `calls` records each call.
export function fakeLedger (...answers) {
  const calls = []
  const readLedger = async (args) => {
    calls.push(args)
    const answer = answers[Math.min(calls.length, answers.length) - 1]
    if (answer instanceof Error) throw answer
    if (typeof answer === 'function') return answer(args)
    return answer
  }
  return { readLedger, calls }
}
