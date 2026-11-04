import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { GitFixture, NEWER_RELEASE, PIPELINE, PROJECT, RELEASE, fakeLedger, isolateGitConfig, ledgerRow, standardApp } from './support/git-fixture.js'

// The hotfix action's four modes, through run(): which inputs each reads,
// what it outputs, and how it fails. @actions/core and @actions/github are
// mocked; git runs for real against the fixtures in support/git-fixture.js.

const { core, inputs, outputs, summary, octokit } = vi.hoisted(() => {
  const summary = { text: '', addRaw: null, write: null }
  summary.addRaw = (text) => { summary.text += text; return summary }
  summary.write = async () => summary
  return {
    core: { notice: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), setFailed: vi.fn(), exportVariable: vi.fn() },
    inputs: {},
    outputs: {},
    summary,
    octokit: { current: null }
  }
})

vi.mock('@actions/core', () => ({
  getInput: (name) => inputs[name] ?? '',
  setOutput: (name, value) => { outputs[name] = value },
  notice: core.notice,
  warning: core.warning,
  info: core.info,
  error: core.error,
  setFailed: core.setFailed,
  exportVariable: core.exportVariable,
  summary,
  ExitCode: { Success: 0, Failure: 1 }
}))

vi.mock('@actions/github', () => ({
  getOctokit: () => octokit.current
}))

import { run, buildRefusal } from '../src/hotfix.js'
import { AUTHORIZED_ATTEMPT_MARKER } from '../src/v2/attempt-guard.js'

vi.setConfig({ testTimeout: 60000 })
beforeAll(isolateGitConfig)

const fixtures = []
afterAll(() => { for (const fx of fixtures) fx.cleanup() })
function app () {
  const fx = standardApp()
  fixtures.push(fx)
  return fx
}

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
  for (const key of Object.keys(outputs)) delete outputs[key]
  summary.text = ''
  octokit.current = null
})
afterEach(() => { process.exitCode = undefined })

const errors = () => core.error.mock.calls.map(([message, props]) => ({ message, title: props?.title }))
const authorized = { GITHUB_RUN_ATTEMPT: '1', [AUTHORIZED_ATTEMPT_MARKER]: '1' }

describe('mode verify (build-candidate)', () => {
  it('passes a branch this pipeline cut, and says so', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    fx.git(['cherry-pick', '-x', fx.fix])
    fx.push(`hand:refs/heads/hotfix/${RELEASE}`)
    Object.assign(inputs, { mode: 'verify', 'project-name': PROJECT, path: fx.clone(), ref: `refs/heads/hotfix/${RELEASE}`, sha: fx.originGit(['rev-parse', `hotfix/${RELEASE}`]), 'default-branch': 'main' })
    await run({ readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger })
    expect(errors()).toEqual([])
    expect(process.exitCode).toBeUndefined()
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('every commit after it is a clean cherry-pick of a main commit'), { title: 'Hotfix build' })
  })

  it('passes a branch a person pushed by hand whose cherry-pick changes a workflow file', async () => {
    const fx = app()
    const ci = fx.commit('ci: tweak', { '.github/workflows/ci.yml': 'on: push\n' })
    fx.push('main')
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    fx.git(['cherry-pick', '-x', ci])
    fx.push(`hand:refs/heads/hotfix/${RELEASE}`)
    Object.assign(inputs, { mode: 'verify', 'project-name': PROJECT, path: fx.clone(), ref: `refs/heads/hotfix/${RELEASE}`, sha: fx.originGit(['rev-parse', `hotfix/${RELEASE}`]), 'default-branch': 'main' })
    await run({ readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger })
    expect(errors()).toEqual([])
    expect(process.exitCode).toBeUndefined()
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining(`(from ${ci.slice(0, 12)})`), { title: 'Hotfix build' })
  })

  it('refuses a hand-pushed branch with today\'s default-branch refusal, plus the reason', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    fx.commit('quick fix', { 'app.js': 'anything\n' })
    fx.push(`hand:refs/heads/hotfix/${RELEASE}`)
    Object.assign(inputs, { mode: 'verify', 'project-name': PROJECT, path: fx.clone(), ref: `refs/heads/hotfix/${RELEASE}`, sha: fx.originGit(['rev-parse', `hotfix/${RELEASE}`]), 'default-branch': 'main' })
    await run({ readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger })
    expect(process.exitCode).toBe(1)
    const [error] = errors()
    expect(error.title).toBe('Build Candidate')
    expect(error.message).toMatch(new RegExp(`^candidates build from the default branch only -- refs/heads/hotfix/${RELEASE} is not refs/heads/main, and it is not a hotfix branch this pipeline can build: [0-9a-f]{12} is not a cherry-pick: .*\\. Merge the change to main, then dispatch, or cut the hotfix branch with the hotfix workflow\\.$`))
  })

  it('fails closed when the check itself breaks', async () => {
    Object.assign(inputs, { mode: 'verify', 'project-name': PROJECT, path: '/nonexistent/hotfix-check', ref: `refs/heads/hotfix/${RELEASE}`, sha: 'a'.repeat(40), 'default-branch': 'main' })
    await run({ readLedger: fakeLedger([ledgerRow(RELEASE, 'b'.repeat(40))]).readLedger })
    expect(process.exitCode).toBe(1)
    expect(errors()[0]).toMatchObject({ title: 'Build Candidate', message: expect.stringMatching(/^candidates build from the default branch only -- .*the check could not finish/) })
  })

  it('ends a merge-driver refusal with the way past it, not the usual advice', async () => {
    // The release merges every file with union, and a person picked a
    // workflow fix onto it by hand.
    const fx = new GitFixture()
    fixtures.push(fx)
    const CI = '.github/workflows/ci.yml'
    fx.commit('initial', { 'app.js': 'a\n', '.github/workflows/pipeline-v2.yml': PIPELINE, [CI]: 'on: pull_request\n', '.gitattributes': '* merge=union\n' })
    fx.release = fx.commit('feature', { 'app.js': 'b\n' })
    const ci = fx.commit('ci: run on push', { [CI]: 'on: push\n' })
    fx.push('main')
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    fx.git(['cherry-pick', '-x', ci])
    fx.push(`hand:refs/heads/hotfix/${RELEASE}`)
    Object.assign(inputs, { mode: 'verify', 'project-name': PROJECT, path: fx.clone(), ref: `refs/heads/hotfix/${RELEASE}`, sha: fx.originGit(['rev-parse', `hotfix/${RELEASE}`]), 'default-branch': 'main' })
    await run({ readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger })
    expect(process.exitCode).toBe(1)
    const [error] = errors()
    expect(error.title).toBe('Build Candidate')
    expect(error.message).toMatch(new RegExp(`^candidates build from the default branch only -- refs/heads/hotfix/${RELEASE} is not refs/heads/main, and it is not a hotfix branch this pipeline can build: [0-9a-f]{12} says it was cherry-picked from ${ci.slice(0, 12)} and changes a workflow file, but the \\.gitattributes of the commit it was picked onto \\([0-9a-f]{12}\\) give \\.github/workflows/ci\\.yml \\(merge attribute: union\\)\\. `))
    expect(error.message.endsWith("To build it, move the branch back to the commit that pick was made on, land a commit on main that gives workflow files git's own merge (for example a `.github/workflows/** merge` line after the line that sets the driver), cut that commit onto the branch with the hotfix workflow, then cherry-pick the fix onto it again by hand.")).toBe(true)
    expect(error.message).not.toContain('or cut the hotfix branch with the hotfix workflow')
  })

  it('keeps the usual advice on every other refusal', () => {
    expect(buildRefusal({ ref: 'refs/heads/hotfix/release-1', defaultBranch: 'main', why: 'x', reason: 'branch_not_clean' })).toMatch(/\. Merge the change to main, then dispatch, or cut the hotfix branch with the hotfix workflow\.$/)
  })

  it('keeps the refusal on one line whatever the ref holds', () => {
    expect(buildRefusal({ ref: 'refs/heads/hotfix/x\n::error::y', defaultBranch: 'main', why: 'a\nb' })).not.toMatch(/\n/)
  })
})

describe('mode cut (hotfix.yml)', () => {
  it('refuses unless authorize-actor passed earlier in this job, before reading anything', async () => {
    const ledger = fakeLedger(new Error('must not be read'))
    Object.assign(inputs, { mode: 'cut', 'project-name': PROJECT, path: '/nonexistent', commit: 'a'.repeat(40), 'expected-release': RELEASE })
    await run({ env: { GITHUB_RUN_ATTEMPT: '1' }, readLedger: ledger.readLedger })
    expect(process.exitCode).toBe(1)
    expect(errors()).toEqual([{ title: 'actor_not_allowed', message: expect.stringMatching(/^refusing to push a hotfix branch: no authorize-actor check passed earlier in this job/) }])
    expect(ledger.calls).toEqual([])
  })

  it('cuts and pushes the branch, sets its outputs and writes the summary', async () => {
    const fx = app()
    Object.assign(inputs, { mode: 'cut', 'project-name': PROJECT, path: fx.clone(), commit: fx.fix, 'expected-release': RELEASE })
    await run({ env: authorized, readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger })
    expect(errors()).toEqual([])
    expect(core.setFailed).not.toHaveBeenCalled()
    const head = fx.originGit(['rev-parse', `hotfix/${RELEASE}`])
    expect(outputs).toEqual({
      release: RELEASE,
      branch: `hotfix/${RELEASE}`,
      'base-sha': fx.release,
      'commit-sha': fx.fix,
      'head-sha': head,
      pushed: 'true',
      'already-applied': 'false'
    })
    expect(summary.text).toContain(`## Hotfix for ${RELEASE}`)
    expect(summary.text).toContain(`Pushed \`hotfix/${RELEASE}\` at \`${head.slice(0, 12)}\``)
  })

  it('says a re-run found a cherry-pick of the fix on the branch, not that the fix is still there', async () => {
    const fx = app()
    const readLedger = fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger
    Object.assign(inputs, { mode: 'cut', 'project-name': PROJECT, path: fx.clone(), commit: fx.fix, 'expected-release': RELEASE })
    await run({ env: authorized, readLedger })
    const head = fx.originGit(['rev-parse', `hotfix/${RELEASE}`])
    summary.text = ''
    core.notice.mockReset()
    Object.assign(inputs, { path: fx.clone() })
    await run({ env: authorized, readLedger })
    expect(errors()).toEqual([])
    expect(outputs).toMatchObject({ pushed: 'false', 'already-applied': 'true' })
    expect(core.notice).toHaveBeenCalledWith(`hotfix/${RELEASE} already has a cherry-pick of ${fx.fix.slice(0, 12)} (${head.slice(0, 12)}), so nothing new was pushed. The build is dispatched again; it reuses the candidate when this commit was already built`, { title: 'Hotfix branch' })
    expect(summary.text).toContain(`- \`hotfix/${RELEASE}\` already has a cherry-pick of this fix (\`${head.slice(0, 12)}\`). Nothing new was pushed.`)
  })

  it('titles a refusal with its reason word and sets no outputs', async () => {
    const fx = app()
    Object.assign(inputs, { mode: 'cut', 'project-name': PROJECT, path: fx.clone(), commit: fx.fix, 'expected-release': RELEASE })
    await run({ env: authorized, readLedger: fakeLedger([ledgerRow(NEWER_RELEASE, fx.fix)]).readLedger })
    expect(process.exitCode).toBe(1)
    expect(errors()).toEqual([{ title: 'production_moved', message: expect.stringMatching(/^production is now running release-2026-10-22-10150/) }])
    expect(outputs).toEqual({})
  })
})

describe('mode report (hotfix.yml)', () => {
  const runsApi = (impl) => ({ rest: { actions: { listWorkflowRunsForRepo: vi.fn(impl) } } })
  const reportInputs = (extra = {}) => Object.assign(inputs, { mode: 'report', 'github-token': 'tok', repository: 'example-org/example-app', branch: `hotfix/${RELEASE}`, sha: 'a'.repeat(40), pushed: 'false', 'dispatch-outcome': 'success', ...extra })

  it('says the app\'s own CI ran, with links', async () => {
    octokit.current = runsApi(async () => ({ data: { workflow_runs: [{ path: '.github/workflows/ci.yml', name: 'CI', event: 'push', status: 'in_progress', conclusion: null, html_url: 'https://github.example.test/run/1' }] } }))
    reportInputs()
    await run()
    expect(outputs).toEqual({ 'ci-ran': 'true' })
    expect(summary.text).toContain("The app's own CI ran on `aaaaaaaaaaaa`")
    expect(summary.text).toContain('[CI](https://github.example.test/run/1) (push, in_progress)')
    expect(summary.text).toContain('dispatched `pipeline-v2.yml` on `hotfix/release-2026-10-20-10140`')
  })

  it('says the app\'s own CI did not run, and that this is accepted for now', async () => {
    octokit.current = runsApi(async () => ({ data: { workflow_runs: [] } }))
    reportInputs({ 'dispatch-outcome': 'failure' })
    await run()
    expect(outputs).toEqual({ 'ci-ran': 'false' })
    expect(summary.text).toContain("The app's own CI did not run on `hotfix/release-2026-10-20-10140`")
    expect(summary.text).toContain('accepted for now')
    expect(summary.text).toContain('was not dispatched')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('never fails the run when GitHub cannot answer', async () => {
    octokit.current = runsApi(async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }) })
    reportInputs()
    await run()
    expect(outputs).toEqual({ 'ci-ran': 'unknown' })
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Bad credentials'))
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})

describe('mode release-kind (promote)', () => {
  const SHA = 'a'.repeat(40)
  it('outputs hotfix for a commit on a hotfix branch only', async () => {
    octokit.current = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main' } }),
          getBranch: async () => ({ data: { commit: { sha: 'b'.repeat(40) } } }),
          compareCommitsWithBasehead: async () => ({ data: { status: 'diverged' } })
        },
        git: { listMatchingRefs: async () => ({ data: [{ ref: `refs/heads/hotfix/${RELEASE}`, object: { type: 'commit', sha: SHA } }] }) }
      }
    }
    Object.assign(inputs, { mode: 'release-kind', 'github-token': 'tok', repository: 'example-org/example-app', 'project-name': PROJECT, sha: SHA })
    const ledger = fakeLedger([ledgerRow(RELEASE, 'c'.repeat(40))])
    await run({ readLedger: ledger.readLedger })
    expect(outputs).toEqual({ kind: 'hotfix', branch: `hotfix/${RELEASE}`, release: RELEASE, check: 'live', 'check-why': `aaaaaaaaaaaa is a hotfix for ${RELEASE}, the release production runs` })
    expect(ledger.calls).toEqual([{ project: PROJECT, limit: 1, attempts: 2, timeoutMs: 10000 }])
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('outputs stale for a hotfix of a release production no longer runs, still without failing the step', async () => {
    octokit.current = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main' } }),
          getBranch: async () => ({ data: { commit: { sha: 'b'.repeat(40) } } }),
          compareCommitsWithBasehead: async () => ({ data: { status: 'diverged' } })
        },
        git: { listMatchingRefs: async () => ({ data: [{ ref: `refs/heads/hotfix/${RELEASE}`, object: { type: 'commit', sha: SHA } }] }) }
      }
    }
    Object.assign(inputs, { mode: 'release-kind', 'github-token': 'tok', repository: 'example-org/example-app', 'project-name': PROJECT, sha: SHA })
    await run({ readLedger: fakeLedger([ledgerRow(NEWER_RELEASE, 'c'.repeat(40))]).readLedger })
    expect(outputs).toMatchObject({ kind: 'hotfix', check: 'stale', 'check-why': expect.stringMatching(/production now runs release-2026-10-22-10150/) })
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('warns that a confirmed hotfix will be refused, not that it goes on, when GitHub stops answering', async () => {
    octokit.current = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main' } }),
          getBranch: async () => ({ data: { commit: { sha: 'b'.repeat(40) } } }),
          compareCommitsWithBasehead: async ({ basehead }) => {
            if (basehead.startsWith('c'.repeat(40))) throw new Error('timeout')
            return { data: { status: 'diverged' } }
          }
        },
        git: { listMatchingRefs: async () => ({ data: [{ ref: `refs/heads/hotfix/${RELEASE}`, object: { type: 'commit', sha: SHA } }] }) }
      }
    }
    Object.assign(inputs, { mode: 'release-kind', 'github-token': 'tok', repository: 'example-org/example-app', 'project-name': PROJECT, sha: SHA })
    await run({ readLedger: fakeLedger([ledgerRow(NEWER_RELEASE, 'c'.repeat(40))]).readLedger })
    expect(outputs).toMatchObject({ kind: 'hotfix', check: 'unconfirmed' })
    const [warning] = core.warning.mock.calls[0]
    expect(warning).toMatch(/GitHub did not answer whether aaaaaaaaaaaa builds on release-2026-10-22-10150/)
    expect(warning).not.toMatch(/ordinary promote/)
  })

  it('outputs deploy and skips the check, with a warning, when GitHub cannot answer, and never fails', async () => {
    octokit.current = { rest: { repos: { get: async () => { throw new Error('Not Found') } } } }
    Object.assign(inputs, { mode: 'release-kind', 'github-token': 'tok', repository: 'example-org/example-app', 'project-name': PROJECT, sha: SHA })
    await run({ readLedger: fakeLedger(new Error('must not be read')).readLedger })
    expect(outputs).toEqual({ kind: 'deploy', branch: '', release: '', check: 'skipped', 'check-why': 'GitHub did not answer, so this promote is treated as an ordinary one' })
    expect(core.warning).toHaveBeenCalledWith('could not tell whether this promote is a hotfix (Not Found), so it goes on as an ordinary promote')
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

it('fails on an unknown mode', async () => {
  inputs.mode = 'deploy'
  await run()
  expect(core.setFailed).toHaveBeenCalledWith("unknown mode 'deploy'; expected one of verify, cut, report, release-kind")
})
