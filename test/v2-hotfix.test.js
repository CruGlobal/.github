import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  COMMITTER,
  REASONS,
  HotfixRefusal,
  appWorkflowRuns,
  cherryPickSource,
  currentProduction,
  cutHotfix,
  deadlineRequests,
  gitIn,
  hotfixBranch,
  hotfixPromoteCheck,
  normalizeRelease,
  readProductionLedger,
  releaseFromRef,
  releaseKind,
  verifyHotfixRef
} from '../src/v2/hotfix.js'
import { NEWER_RELEASE, PROJECT, RELEASE, fakeLedger, isolateGitConfig, ledgerRow, standardApp } from './support/git-fixture.js'

// The hotfix logic against real git repositories (see support/git-fixture.js):
// cutting the branch the way hotfix.yml does, and the helpers promote and the
// hotfix run's report use. The deployment ledger and the GitHub API are
// stand-ins. build-candidate's check of a hotfix branch is in
// v2-hotfix-guard.test.js; a cut branch is run through it here too.

// Each test builds its own repositories, and a cut runs a few dozen git
// commands, so these tests get more time than the default.
vi.setConfig({ testTimeout: 60000 })
beforeAll(isolateGitConfig)

const fixtures = []
function app (options) {
  const fx = standardApp(options)
  fixtures.push(fx)
  return fx
}
afterAll(() => { for (const fx of fixtures) fx.cleanup() })

const BRANCH = `hotfix/${RELEASE}`
const BRANCH_REF = `refs/heads/${BRANCH}`

// Run cutHotfix from a fresh full-history clone, as hotfix.yml does.
async function cut (fx, { commit = fx.fix, expectedRelease = RELEASE, ledger } = {}) {
  const fake = ledger ?? fakeLedger([ledgerRow(RELEASE, fx.release)])
  const runner = fx.clone()
  const result = await cutHotfix({ git: gitIn(runner), project: PROJECT, commit, expectedRelease, readLedger: fake.readLedger })
  return { result, runner, calls: fake.calls }
}

async function refusal (promise) {
  try {
    await promise
  } catch (error) {
    if (error instanceof HotfixRefusal) return error
    throw error
  }
  throw new Error('expected a refusal, but it passed')
}

// Run build-candidate's check from a fresh clone of the pushed state.
function verify (fx, { ref = BRANCH_REF, sha, rows } = {}) {
  const fake = fakeLedger(rows ?? [ledgerRow(RELEASE, fx.release)])
  const runner = fx.clone()
  const head = sha ?? fx.originGit(['rev-parse', ref])
  return verifyHotfixRef({ git: gitIn(runner), ref, sha: head, defaultBranch: 'main', project: PROJECT, readLedger: fake.readLedger })
}

const show = (fx, rev, file) => fx.originGit(['show', `${rev}:${file}`])
const filesAt = (fx, rev) => fx.originGit(['ls-tree', '-r', '--name-only', rev]).split('\n')

describe('release and ref helpers', () => {
  it.each([
    ['release-2026-10-20-10140', 'release-2026-10-20-10140'],
    ['2026-10-20-10140', 'release-2026-10-20-10140'],
    ['  release-10012 \n', 'release-10012'],
    ['10012', 'release-10012']
  ])('normalizes %j to %s', (value, tag) => {
    expect(normalizeRelease(value)).toBe(tag)
  })

  it.each(['', 'release-', 'release-abc', '2026-10-20-', '10140\nfoo', 'candidate-2026-10-20-10140', 'release-2026-10-20-10140 x'])('refuses %j', (value) => {
    expect(normalizeRelease(value)).toBe('')
  })

  it('names the branch after the release and reads the release back from the ref', () => {
    expect(hotfixBranch(RELEASE)).toBe(BRANCH)
    expect(releaseFromRef(BRANCH_REF)).toBe(RELEASE)
    expect(releaseFromRef('refs/heads/hotfix/release-10012')).toBe('release-10012')
    for (const ref of ['refs/heads/hotfix/foo', 'refs/heads/main', `refs/heads/hotfix/${RELEASE}/x`, `refs/tags/hotfix/${RELEASE}`, 'refs/heads/hotfix/release-2026-10-20-10140\n']) {
      expect(releaseFromRef(ref), ref).toBe('')
    }
    expect(() => hotfixBranch('main')).toThrow(/not a release tag/)
  })

  it('reads the last "(cherry picked from commit X)" line, and only a full sha', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    expect(cherryPickSource(`fix\n\n(cherry picked from commit ${a})\n`)).toBe(a)
    expect(cherryPickSource(`fix\n\n(cherry picked from commit ${a})\n(cherry picked from commit ${b})`)).toBe(b)
    expect(cherryPickSource('fix\n\n(cherry picked from commit abc1234)')).toBe('')
    expect(cherryPickSource(`fix (cherry picked from commit ${a})`)).toBe('')
    expect(cherryPickSource('fix')).toBe('')
  })

  it('reads what production runs now from the newest production row, failing closed', async () => {
    const sha = 'c'.repeat(40)
    const read = (answer) => currentProduction({ readLedger: fakeLedger(answer).readLedger, project: PROJECT, unconfirmed: 'cannot tell' })
    expect(await read([ledgerRow(NEWER_RELEASE, sha), ledgerRow(RELEASE, 'd'.repeat(40))])).toEqual({ revision: NEWER_RELEASE, sha })
    expect(await read([ledgerRow(RELEASE, 'not-a-sha')])).toEqual({ revision: RELEASE, sha: '' })
    // An outage is "try again later", not "production moved".
    await expect(read(new Error('HTTP 503'))).rejects.toMatchObject({ reason: REASONS.ledgerUnavailable, message: 'could not read the deployment ledger for example-app (HTTP 503), so cannot tell' })
    await expect(read([])).rejects.toMatchObject({ reason: REASONS.productionMoved })
    await expect(read([{ Sha: sha }])).rejects.toMatchObject({ reason: REASONS.productionMoved })
  })
})

describe('readProductionLedger', () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })

  it('reads production rows for the project, newest first', async () => {
    const fetchImpl = vi.fn(async () => ok({ Items: [ledgerRow(RELEASE, 'a'.repeat(40))] }))
    const items = await readProductionLedger({ project: 'example app', limit: 100, fetchImpl })
    expect(items).toHaveLength(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://deploys.cru.org/deployments?project=example%20app&environment=production&limit=100')
  })

  it('retries a 5xx or no answer, and fails closed on anything it cannot read', async () => {
    const sleep = async () => {}
    const flaky = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok({ Items: [] }))
    expect(await readProductionLedger({ project: PROJECT, fetchImpl: flaky, sleep })).toEqual([])
    expect(flaky).toHaveBeenCalledTimes(3)

    await expect(readProductionLedger({ project: PROJECT, fetchImpl: async () => ({ ok: false, status: 403 }), sleep })).rejects.toThrow(/HTTP 403/)
    await expect(readProductionLedger({ project: PROJECT, fetchImpl: async () => ok({ nope: 1 }), sleep })).rejects.toThrow(/no Items array/)
    await expect(readProductionLedger({ project: PROJECT, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }), sleep })).rejects.toThrow(/not JSON/)
    await expect(readProductionLedger({ project: PROJECT, fetchImpl: async () => { throw new Error('down') }, sleep })).rejects.toThrow(/no answer/)
  })
})

describe('cutHotfix', () => {
  it('cuts hotfix/<release> from the live release, cherry-picks only the fix with -x, and pushes it', async () => {
    const fx = app()
    const before = fx.refs()
    const { result, calls } = await cut(fx)

    expect(result).toMatchObject({ release: RELEASE, branch: BRANCH, base: fx.release, commit: fx.fix, pushed: true, alreadyApplied: false, defaultBranch: 'main', warnings: [] })
    // The only change on the remote is the new branch: main and everything
    // else are exactly as they were.
    expect(fx.refs()).toEqual({ ...before, [BRANCH_REF]: result.head })
    // One commit on top of the release: the fix.
    expect(fx.originGit(['rev-list', '--parents', '-n', '1', result.head]).split(' ')).toEqual([result.head, fx.release])
    const message = fx.originGit(['log', '-1', '--format=%B', result.head])
    expect(message).toContain('fix: line 8 is off by one')
    expect(message).toContain(`(cherry picked from commit ${fx.fix})`)
    expect(fx.originGit(['log', '-1', '--format=%an <%ae>|%cn <%ce>', result.head])).toBe(`Example Dev <dev@example.org>|${COMMITTER.name} <${COMMITTER.email}>`)
    // The fix is in; main's unreleased work is not.
    expect(show(fx, result.head, 'app.js')).toContain('const line8 = 8 + 1')
    expect(show(fx, result.head, 'app.js')).toContain('const line6 = 6\n')
    expect(filesAt(fx, result.head)).not.toContain('db/migrate/002_drop_name.sql')
    // Production was checked at the start and again right before the push.
    expect(calls).toEqual([{ project: PROJECT, limit: 1 }, { project: PROJECT, limit: 1 }])
  })

  it('cuts a branch that build-candidate accepts', async () => {
    const fx = app()
    const { result } = await cut(fx)
    const verified = await verify(fx)
    expect(verified).toEqual({ release: RELEASE, base: fx.release, commits: [{ sha: result.head, source: fx.fix }] })
  })

  it('accepts a short sha and the release without its prefix', async () => {
    const fx = app()
    const { result } = await cut(fx, { commit: fx.fix.slice(0, 10).toUpperCase(), expectedRelease: ` ${RELEASE.slice('release-'.length)} ` })
    expect(result).toMatchObject({ branch: BRANCH, commit: fx.fix, pushed: true })
  })

  it('pushes nothing on a re-run: the fix is already on the branch', async () => {
    const fx = app()
    const first = await cut(fx)
    const after = fx.refs()
    const again = await cut(fx)
    expect(again.result).toMatchObject({ pushed: false, alreadyApplied: true, head: first.result.head, appliedAs: first.result.head })
    expect(fx.refs()).toEqual(after)
    // Nothing to push, so production is read only once.
    expect(again.calls).toHaveLength(1)
  })

  it('adds a second fix for the same release on top of the first', async () => {
    const fx = app()
    const first = await cut(fx)
    const second = fx.commit('fix: line 11 too', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 11 + 1' }) })
    fx.push('main')
    const { result } = await cut(fx, { commit: second })
    expect(result).toMatchObject({ pushed: true, alreadyApplied: false })
    expect(fx.originGit(['rev-parse', `${result.head}^`])).toBe(first.result.head)
    expect(show(fx, result.head, 'app.js')).toMatch(/line8 = 8 \+ 1[\s\S]*line11 = 11 \+ 1/)
    const verified = await verify(fx)
    expect(verified.commits.map((c) => c.source)).toEqual([fx.fix, second])
  })

  it('stops on a conflict and pushes nothing, leaving the checkout as it was', async () => {
    const fx = app()
    // Line 6 differs between main and the release, so this change cannot apply.
    const conflicting = fx.commit('fix: line 6', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 666', 8: 'const line8 = 8 + 1' }) })
    fx.push('main')
    const before = fx.refs()
    const runner = fx.clone()
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runner, encoding: 'utf8' })
    const error = await refusal(cutHotfix({ git: gitIn(runner), project: PROJECT, commit: conflicting, expectedRelease: RELEASE, readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger }))
    expect(error.reason).toBe(REASONS.conflict)
    expect(error.message).toMatch(/conflicts in app\.js/)
    expect(error.message).toMatch(/Nothing was pushed/)
    expect(fx.refs()).toEqual(before)
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runner, encoding: 'utf8' })).toBe(headBefore)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: runner, encoding: 'utf8' })).toBe('')
  })

  it('refuses a stale expected-release and pushes nothing', async () => {
    const fx = app()
    const before = fx.refs()
    const ledger = fakeLedger([ledgerRow(NEWER_RELEASE, fx.fix), ledgerRow(RELEASE, fx.release)])
    const error = await refusal(cut(fx, { ledger }))
    expect(error.reason).toBe(REASONS.productionMoved)
    expect(error.message).toBe(`production is now running ${NEWER_RELEASE}, not ${RELEASE}, so this hotfix was asked for against a release that is no longer live; refusing to cut a hotfix. Nothing was pushed. Start a new hotfix for ${NEWER_RELEASE} if the fix is still needed`)
    expect(fx.refs()).toEqual(before)
  })

  it('refuses a bare build number against a dated release, with the fix in the message', async () => {
    const fx = app()
    const error = await refusal(cut(fx, { expectedRelease: '10140' }))
    expect(error.reason).toBe(REASONS.productionMoved)
    expect(error.message).toMatch(/is a bare build number, but production's release tag is dated \(release-2026-10-20-10140\); pass the full tag/)
  })

  it('refuses when production moves between the check and the push, and pushes nothing', async () => {
    const fx = app()
    const before = fx.refs()
    const ledger = fakeLedger([ledgerRow(RELEASE, fx.release)], [ledgerRow(NEWER_RELEASE, fx.fix), ledgerRow(RELEASE, fx.release)])
    const error = await refusal(cut(fx, { ledger }))
    expect(error.reason).toBe(REASONS.productionMoved)
    expect(error.message).toMatch(/production is now running release-2026-10-22-10150, not release-2026-10-20-10140.*refusing to push the hotfix branch\. Nothing was pushed/)
    expect(ledger.calls).toHaveLength(2)
    expect(fx.refs()).toEqual(before)
  })

  it.each([
    ['an unreadable ledger', new Error('the deployment ledger answered HTTP 503'), REASONS.ledgerUnavailable, /could not read the deployment ledger for example-app \(the deployment ledger answered HTTP 503\), so cannot confirm production is still running/],
    ['no production rows', [], REASONS.productionMoved, /the deployment ledger has no production rows for example-app/],
    ['a row with no Revision', [{ Sha: 'a'.repeat(40) }], REASONS.productionMoved, /has no Revision/]
  ])('fails closed on %s', async (_label, answer, reason, message) => {
    const fx = app()
    const before = fx.refs()
    const error = await refusal(cut(fx, { ledger: fakeLedger(answer) }))
    expect(error.reason).toBe(reason)
    expect(error.message).toMatch(message)
    expect(fx.refs()).toEqual(before)
  })

  it('refuses as ledger_unavailable when the ledger goes away right before the push', async () => {
    const fx = app()
    const before = fx.refs()
    const error = await refusal(cut(fx, { ledger: fakeLedger([ledgerRow(RELEASE, fx.release)], new Error('no answer from the deployment ledger')) }))
    expect(error.reason).toBe(REASONS.ledgerUnavailable)
    expect(error.message).toMatch(/refusing to push the hotfix branch\. Nothing was pushed/)
    expect(fx.refs()).toEqual(before)
  })

  it('refuses when the ledger names no commit for the live release', async () => {
    const fx = app()
    const error = await refusal(cut(fx, { ledger: fakeLedger([ledgerRow(RELEASE, undefined)]) }))
    expect(error.reason).toBe(REASONS.releaseCommitUnknown)
  })

  it('refuses a commit that is not on the default branch', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'feature', fx.release])
    const feature = fx.commit('unreviewed', { 'app.js': fx.appWith({ 8: 'const line8 = 800' }) })
    fx.push('feature')
    const error = await refusal(cut(fx, { commit: feature }))
    expect(error.reason).toBe(REASONS.notOnDefaultBranch)
    expect(error.message).toMatch(/is not on main\. A fix lands on main first/)
    expect(fx.refs()[BRANCH_REF]).toBeUndefined()
  })

  it('reads a short sha as a commit, never as a branch named like one', async () => {
    const fx = app()
    // A branch whose name is hex, pointing at main's unreleased migration.
    fx.push(`${fx.unreleased}:refs/heads/deadbeefcafe`)
    const error = await refusal(cut(fx, { commit: 'deadbeefcafe' }))
    expect(error.reason).toBe(REASONS.notOnDefaultBranch)
    expect(error.message).toMatch(/commit deadbeefcafe is not in the app repo/)
  })

  it('refuses a commit the repo does not have', async () => {
    const fx = app()
    const error = await refusal(cut(fx, { commit: 'deadbeefdeadbeef' }))
    expect(error.reason).toBe(REASONS.notOnDefaultBranch)
    expect(error.message).toMatch(/is not in the app repo/)
  })

  it('refuses a merge commit', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'feature', fx.fix])
    fx.commit('fix: line 11', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.git(['checkout', '--quiet', 'main'])
    fx.git(['merge', '--quiet', '--no-ff', '-m', 'Merge pull request from feature', 'feature'])
    const merge = fx.git(['rev-parse', 'HEAD'])
    fx.push('main')
    const error = await refusal(cut(fx, { commit: merge }))
    expect(error.reason).toBe(REASONS.mergeCommit)
    expect(error.message).toMatch(/is a merge commit\. A hotfix needs the pull request's squash commit: picking a merge, or some of the commits it brought in, would ship code nobody reviewed as a whole\. Merge the fix with squash \(the repo's squash-only merge setting does this\)/)
    expect(error.message).not.toMatch(/one hotfix per commit/)
  })

  it('refuses a commit main reached only inside a merged pull request', async () => {
    const fx = app()
    // "wip" breaks line 11 and "tidy" fixes it; main was only ever at the merge.
    fx.git(['checkout', '--quiet', '-b', 'pr', fx.fix])
    const wip = fx.commit('wip', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = BROKEN' }) })
    fx.commit('tidy', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.git(['checkout', '--quiet', 'main'])
    fx.git(['merge', '--quiet', '--no-ff', '-m', 'Merge pull request', 'pr'])
    fx.push('main')
    const before = fx.refs()
    const error = await refusal(cut(fx, { commit: wip }))
    expect(error.reason).toBe(REASONS.notOnDefaultBranch)
    expect(error.message).toMatch(/is on main only inside a pull request that was merged with a merge commit, so main never had exactly the code it makes\. Hotfix the pull request's squash commit instead/)
    expect(fx.refs()).toEqual(before)
  })

  it('refuses a fix that changes a workflow file, before anything is pushed', async () => {
    const fx = app()
    const ci = fx.commit('fix: ci and line 11', { '.github/workflows/ci.yml': 'on: push\n', 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.push('main')
    const before = fx.refs()
    const error = await refusal(cut(fx, { commit: ci }))
    expect(error.reason).toBe(REASONS.workflowChange)
    expect(error.message).toMatch(/changes \.github\/workflows\/ci\.yml\. A hotfix never changes a workflow file.*a person ships it by hand/)
    expect(fx.refs()).toEqual(before)
  })

  it('checks the pick with the release\'s .gitattributes, not the checkout\'s', async () => {
    const fx = app()
    // This fix conflicts with the release on line 6. A union merge driver in
    // the runner's checkout would make it merge cleanly, so the pre-check and
    // the cherry-pick would disagree with build-candidate's check.
    const conflicting = fx.commit('fix: line 6', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 666', 8: 'const line8 = 8 + 1' }) })
    fx.push('main')
    const runner = fx.clone()
    writeFileSync(path.join(runner, '.gitattributes'), 'app.js merge=union\n')
    const before = fx.refs()
    const error = await refusal(cutHotfix({ git: gitIn(runner), project: PROJECT, commit: conflicting, expectedRelease: RELEASE, readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger }))
    expect(error.reason).toBe(REASONS.conflict)
    expect(fx.refs()).toEqual(before)
  })

  it('refuses a commit that is already in the live release', async () => {
    const fx = app()
    const error = await refusal(cut(fx, { commit: fx.initial }))
    expect(error.reason).toBe(REASONS.alreadyInRelease)
  })

  it('refuses a fix whose change is already in the release', async () => {
    const fx = app()
    // The same change as the release commit's, made again on main after a revert.
    fx.commit('revert line 3', { 'app.js': fx.appWith({ 6: 'const line6 = 66', 8: 'const line8 = 8 + 1' }) })
    const again = fx.commit('line 3 again', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1' }) })
    fx.push('main')
    const error = await refusal(cut(fx, { commit: again }))
    expect(error.reason).toBe(REASONS.alreadyInRelease)
    expect(error.message).toMatch(/changes nothing/)
  })

  it('refuses to add to a hotfix branch that holds someone else\'s commit, and leaves it alone', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    fx.commit('quick tweak', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 12: 'const line12 = 0' }) })
    fx.push(`hand:${BRANCH_REF}`)
    const before = fx.refs()
    const error = await refusal(cut(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
    expect(error.message).toMatch(/already exists and is not a branch this workflow would cut: .* is not a cherry-pick/)
    expect(error.message).toMatch(/left as it is, and nothing was pushed/)
    expect(fx.refs()).toEqual(before)
  })

  it('adds to a hotfix branch that holds a cherry-pick someone made by hand', async () => {
    const fx = app()
    const other = fx.commit('fix: line 11', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.push('main')
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    fx.git(['cherry-pick', '-x', other])
    fx.push(`hand:${BRANCH_REF}`)
    const { result } = await cut(fx)
    expect(result.pushed).toBe(true)
    expect((await verify(fx)).commits.map((c) => c.source)).toEqual([other, fx.fix])
  })

  it('refuses an existing hotfix branch cut from main instead of the release', async () => {
    const fx = app()
    fx.push(`${fx.nearby}:${BRANCH_REF}`)
    const error = await refusal(cut(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
    // main's unreleased commits are on it, and none of them is a cherry-pick.
    expect(error.message).toContain(`${fx.unreleased.slice(0, 12)} is not a cherry-pick`)
  })

  it('refuses an existing hotfix branch that does not start at the release', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'old', fx.initial])
    fx.git(['cherry-pick', '-x', fx.fix])
    fx.push(`old:${BRANCH_REF}`)
    const error = await refusal(cut(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
    expect(error.message).toMatch(/does not start at .*, the commit of the release it is named after/)
  })

  it('refuses as branch_moved when the branch changes during the run, and keeps the other change', async () => {
    const fx = app()
    const other = fx.commit('fix: line 11', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.push('main')
    let raced = ''
    // Someone pushes a cherry-pick to the branch between the run's first read
    // and its push.
    const ledger = fakeLedger([ledgerRow(RELEASE, fx.release)], () => {
      fx.git(['checkout', '--quiet', '-b', 'racer', fx.release])
      fx.git(['cherry-pick', '-x', other])
      raced = fx.git(['rev-parse', 'HEAD'])
      fx.push(`racer:${BRANCH_REF}`)
      return [ledgerRow(RELEASE, fx.release)]
    })
    const error = await refusal(cut(fx, { ledger }))
    expect(error.reason).toBe(REASONS.branchMoved)
    expect(fx.refs()[BRANCH_REF]).toBe(raced)
  })

  it('says what the token needs when a ruleset refuses the push', async () => {
    const fx = app()
    writeFileSync(path.join(fx.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "error: GH013: Repository rule violations found for refs/heads/hotfix/x." >&2\nexit 1\n')
    chmodSync(path.join(fx.origin, 'hooks', 'pre-receive'), 0o755)
    const before = fx.refs()
    await expect(cut(fx)).rejects.toThrow(/authz-token needs contents: write on the app repo, and no ruleset may block creating or updating hotfix\/\* branches\. Nothing was pushed/)
    expect(fx.refs()).toEqual(before)
  })

  it.each([
    ['release-abc', 'invalid expected-release'],
    ['10140\nrelease-1', 'invalid expected-release'],
    ['', 'invalid expected-release']
  ])('refuses expected-release %j without reading anything', async (expectedRelease, message) => {
    const fx = app()
    const ledger = fakeLedger(new Error('must not be read'))
    const error = await refusal(cut(fx, { expectedRelease, ledger }))
    expect(error.reason).toBe(REASONS.invalidInput)
    expect(error.message).toContain(message)
    expect(error.message).not.toMatch(/\n/)
    expect(ledger.calls).toEqual([])
  })

  it.each(['main', 'HEAD~1', 'abc', 'a'.repeat(41), '--all'])('refuses commit %j without reading anything', async (commit) => {
    const fx = app()
    const ledger = fakeLedger(new Error('must not be read'))
    const error = await refusal(cut(fx, { commit, ledger }))
    expect(error.reason).toBe(REASONS.invalidInput)
    expect(ledger.calls).toEqual([])
  })

  it('refuses before the push when the release has no pipeline-v2.yml', async () => {
    const fx = app({ pipeline: null })
    const before = fx.refs()
    const error = await refusal(cut(fx))
    expect(error.reason).toBe(REASONS.noPipeline)
    expect(fx.refs()).toEqual(before)
  })

  it('warns when the app pins an older build-candidate, and still pushes', async () => {
    const fx = app({ pipeline: 'on:\n  workflow_dispatch:\njobs:\n  build:\n    uses: CruGlobal/.github/.github/workflows/build-candidate.yml@v2.10.0\n' })
    const { result } = await cut(fx)
    expect(result.pushed).toBe(true)
    expect(result.warnings).toEqual([expect.stringMatching(/calls build-candidate\.yml@v2\.10\.0\. A build-candidate release older than the one that added hotfix builds refuses hotfix branches/)])
  })
})

describe('releaseKind (promote)', () => {
  const SHA = 'a'.repeat(40)
  const MAIN_TIP = 'b'.repeat(40)
  const HOTFIX_TIP = 'c'.repeat(40)

  function octokit ({ compare = {}, refs = [] } = {}) {
    return {
      rest: {
        repos: {
          get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
          getBranch: vi.fn(async () => ({ data: { commit: { sha: MAIN_TIP } } })),
          compareCommitsWithBasehead: vi.fn(async ({ basehead }) => {
            if (!(basehead in compare)) throw Object.assign(new Error('Not Found'), { status: 404 })
            return { data: { status: compare[basehead] } }
          })
        },
        git: { listMatchingRefs: vi.fn(async () => ({ data: refs })) }
      }
    }
  }
  const ref = (name, sha) => ({ ref: `refs/heads/${name}`, object: { type: 'commit', sha } })

  it.each(['behind', 'identical'])('is deploy when the commit is on the default branch (%s)', async (status) => {
    const api = octokit({ compare: { [`${MAIN_TIP}...${SHA}`]: status } })
    expect(await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })).toMatchObject({ kind: 'deploy' })
    expect(api.rest.git.listMatchingRefs).not.toHaveBeenCalled()
  })

  it('is hotfix when the commit is on a hotfix branch and not on the default branch', async () => {
    const api = octokit({
      compare: { [`${MAIN_TIP}...${SHA}`]: 'diverged', [`${HOTFIX_TIP}...${SHA}`]: 'behind' },
      refs: [ref('hotfix/release-2026-10-01-10100', 'd'.repeat(40)), ref(BRANCH, HOTFIX_TIP)]
    })
    api.rest.repos.compareCommitsWithBasehead.mockImplementation(async ({ basehead }) => ({
      data: { status: { [`${MAIN_TIP}...${SHA}`]: 'diverged', [`${HOTFIX_TIP}...${SHA}`]: 'behind' }[basehead] ?? 'diverged' }
    }))
    const kind = await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })
    expect(kind).toMatchObject({ kind: 'hotfix', branch: BRANCH })
    expect(api.rest.git.listMatchingRefs).toHaveBeenCalledWith(expect.objectContaining({ owner: 'example-org', repo: 'example-app', ref: 'heads/hotfix/' }))
  })

  it('is hotfix when the commit is a hotfix branch\'s tip', async () => {
    const api = octokit({ compare: { [`${MAIN_TIP}...${SHA}`]: 'ahead' }, refs: [ref(BRANCH, SHA)] })
    expect(await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })).toMatchObject({ kind: 'hotfix', branch: BRANCH })
  })

  it('is deploy when the commit is on neither', async () => {
    const api = octokit({ compare: { [`${MAIN_TIP}...${SHA}`]: 'diverged', [`${HOTFIX_TIP}...${SHA}`]: 'diverged' }, refs: [ref(BRANCH, HOTFIX_TIP)] })
    expect(await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })).toMatchObject({ kind: 'deploy' })
  })

  it('is deploy without asking GitHub when the image names no commit', async () => {
    const api = octokit()
    expect(await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: '' })).toMatchObject({ kind: 'deploy' })
    expect(api.rest.repos.get).not.toHaveBeenCalled()
  })

  it('throws on an API error, for the caller to treat as deploy', async () => {
    const api = octokit()
    await expect(releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })).rejects.toThrow(/Not Found/)
  })

  it('ignores hotfix/* branches that are not named after a release', async () => {
    const api = octokit({ compare: { [`${MAIN_TIP}...${SHA}`]: 'diverged' }, refs: [ref('hotfix/urgent', SHA), ref('hotfix/Release-1', SHA)] })
    expect(await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })).toMatchObject({ kind: 'deploy' })
  })

  it('gives up at one deadline for all its requests, so a slow GitHub cannot hold the production lock', async () => {
    // A clock that moves 12 seconds with every look: the third request
    // would start after the 30-second deadline.
    let clock = 0
    const now = () => { clock += 12000; return clock }
    const branches = Array.from({ length: 50 }, (_, i) => ref(`hotfix/release-2026-10-${String(i + 1).padStart(2, '0')}-1${i}`, 'e'.repeat(40)))
    const api = octokit({ compare: { [`${MAIN_TIP}...${SHA}`]: 'diverged', [`${'e'.repeat(40)}...${SHA}`]: 'diverged' }, refs: branches })
    await expect(releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA, request: deadlineRequests({ deadlineMs: 30000, now }) })).rejects.toThrow(/gave up after 30 seconds/)
    expect(api.rest.repos.compareCommitsWithBasehead.mock.calls.length).toBeLessThan(3)
  })
})

describe('hotfixPromoteCheck (promote, before the deploy)', () => {
  const SHA = 'a'.repeat(40)
  const MAIN_TIP = 'b'.repeat(40)
  const LIVE_SHA = 'c'.repeat(40)
  const repository = 'example-org/example-app'

  // GitHub: the promoted commit is on hotfix/<release> and not on main.
  // `fromLive` is what comparing production's commit with it says.
  function github ({ release = RELEASE, fromLive = 'diverged', fails = false } = {}) {
    return {
      rest: {
        repos: {
          get: vi.fn(async () => { if (fails) throw new Error('Bad gateway'); return { data: { default_branch: 'main' } } }),
          getBranch: vi.fn(async () => ({ data: { commit: { sha: MAIN_TIP } } })),
          compareCommitsWithBasehead: vi.fn(async ({ basehead }) => {
            if (basehead === `${MAIN_TIP}...${SHA}`) return { data: { status: 'diverged' } }
            if (basehead === `${LIVE_SHA}...${SHA}`) {
              if (fromLive instanceof Error) throw fromLive
              return { data: { status: fromLive } }
            }
            throw new Error(`unexpected compare ${basehead}`)
          })
        },
        git: { listMatchingRefs: vi.fn(async () => ({ data: [{ ref: `refs/heads/hotfix/${release}`, object: { type: 'commit', sha: SHA } }] })) }
      }
    }
  }
  const check = (octokit, ledger) => hotfixPromoteCheck({ octokit, repository, sha: SHA, project: PROJECT, readLedger: ledger.readLedger })

  it('passes a hotfix for the release production runs', async () => {
    const result = await check(github(), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
    expect(result).toMatchObject({ kind: 'hotfix', branch: BRANCH, release: RELEASE, check: 'live' })
  })

  it('refuses a hotfix for a release production no longer runs, saying what to do', async () => {
    const result = await check(github(), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'stale' })
    expect(result.checkWhy).toBe(`${SHA.slice(0, 12)} is a hotfix for ${RELEASE} (from ${BRANCH}), but production now runs ${NEWER_RELEASE}, which it does not build on. Promoting it would take production backwards, and the rollback-safety check would not see what that undoes; refusing to promote it. Nothing in production was changed. Cut a new hotfix against ${NEWER_RELEASE}, the release production runs now`)
  })

  it('passes a hotfix that builds on what production runs (production moved forward along the branch)', async () => {
    const result = await check(github({ fromLive: 'ahead' }), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'live' })
  })

  it('passes when production already runs this commit, without asking GitHub again', async () => {
    const api = github()
    const result = await check(api, fakeLedger([ledgerRow(NEWER_RELEASE, SHA)]))
    expect(result).toMatchObject({ check: 'live' })
    expect(api.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledTimes(1)
  })

  it('stops a hotfix promote when the ledger cannot say what production runs', async () => {
    const result = await check(github(), fakeLedger(new Error('the deployment ledger answered HTTP 503')))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'unconfirmed' })
    expect(result.checkWhy).toMatch(/could not read the deployment ledger for example-app \(the deployment ledger answered HTTP 503\).*Try again once the deployment ledger answers/)
  })

  it('skips the check, and says deploy, when GitHub cannot answer', async () => {
    const ledger = fakeLedger(new Error('must not be read'))
    const result = await check(github({ fails: true }), ledger)
    expect(result).toMatchObject({ kind: 'deploy', check: 'skipped', failed: true })
    expect(ledger.calls).toEqual([])
  })

  it('skips the check when GitHub cannot say whether the hotfix builds on production', async () => {
    const result = await check(github({ fromLive: new Error('timeout') }), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'skipped', failed: true })
  })

  it('does not read the ledger for an ordinary promote', async () => {
    const api = github()
    api.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { status: 'behind' } })
    const ledger = fakeLedger(new Error('must not be read'))
    expect(await check(api, ledger)).toMatchObject({ kind: 'deploy', check: 'skipped' })
    expect(ledger.calls).toEqual([])
  })
})

describe('appWorkflowRuns (the hotfix run\'s CI report)', () => {
  const run = (path, name, event = 'push') => ({ path, name, event, status: 'completed', conclusion: 'success', html_url: `https://github.example.test/${name}` })

  it('lists the app\'s own runs for the commit, leaving out the pipeline build', async () => {
    const listWorkflowRunsForRepo = vi.fn(async () => ({ data: { workflow_runs: [run('.github/workflows/pipeline-v2.yml', 'Pipeline v2', 'workflow_dispatch'), run('.github/workflows/ci.yml', 'CI')] } }))
    const runs = await appWorkflowRuns({ octokit: { rest: { actions: { listWorkflowRunsForRepo } } }, repository: 'example-org/example-app', sha: 'a'.repeat(40) })
    expect(runs).toEqual([{ name: 'CI', event: 'push', status: 'completed', conclusion: 'success', url: 'https://github.example.test/CI' }])
    expect(listWorkflowRunsForRepo).toHaveBeenCalledWith(expect.objectContaining({ owner: 'example-org', repo: 'example-app', head_sha: 'a'.repeat(40) }))
  })

  it('waits for runs to show up after a push, and gives up with none', async () => {
    const sleep = vi.fn(async () => {})
    const listWorkflowRunsForRepo = vi.fn()
      .mockResolvedValueOnce({ data: { workflow_runs: [] } })
      .mockResolvedValueOnce({ data: { workflow_runs: [run('.github/workflows/ci.yml', 'CI')] } })
    const api = { rest: { actions: { listWorkflowRunsForRepo } } }
    expect(await appWorkflowRuns({ octokit: api, repository: 'example-org/example-app', sha: 'a'.repeat(40), attempts: 4, sleep })).toHaveLength(1)
    expect(sleep).toHaveBeenCalledTimes(1)

    const none = vi.fn(async () => ({ data: { workflow_runs: [run('.github/workflows/pipeline-v2.yml', 'Pipeline v2')] } }))
    expect(await appWorkflowRuns({ octokit: { rest: { actions: { listWorkflowRunsForRepo: none } } }, repository: 'example-org/example-app', sha: 'a'.repeat(40), attempts: 3, sleep })).toEqual([])
    expect(none).toHaveBeenCalledTimes(3)
  })
})
