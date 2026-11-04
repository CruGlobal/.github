import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  CANDIDATE_LEDGER_TIMEOUT_MS,
  COMMITTER,
  REASONS,
  HotfixRefusal,
  appWorkflowRuns,
  candidateKind,
  cherryPickSource,
  commitSubject,
  currentProduction,
  cutHotfix,
  deadlineRequests,
  escapeMrkdwn,
  fixesLine,
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

  it('is deploy when the commit is on neither, and says it is on no branch', async () => {
    const api = octokit({ compare: { [`${MAIN_TIP}...${SHA}`]: 'diverged', [`${HOTFIX_TIP}...${SHA}`]: 'diverged' }, refs: [ref(BRANCH, HOTFIX_TIP)] })
    expect(await releaseKind({ octokit: api, repository: 'example-org/example-app', sha: SHA })).toMatchObject({ kind: 'deploy', offBranch: true })
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

  // GitHub: the promoted commit is on hotfix/<release> and not on main (or,
  // with `branches: []`, on no branch at all). `fromLive` is what comparing
  // production's commit with it says.
  function github ({ release = RELEASE, fromLive = 'diverged', fails = false, branches } = {}) {
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
        git: { listMatchingRefs: vi.fn(async () => ({ data: branches ?? [{ ref: `refs/heads/hotfix/${release}`, object: { type: 'commit', sha: SHA } }] })) }
      }
    }
  }
  const check = (octokit, ledger, options = {}) => hotfixPromoteCheck({ octokit, repository, sha: SHA, project: PROJECT, readLedger: ledger.readLedger, ...options })

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

  it('stops a hotfix promote as ledger_unavailable when the ledger cannot be read', async () => {
    const result = await check(github(), fakeLedger(new Error('the deployment ledger answered HTTP 503')))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'ledger_unavailable' })
    expect(result.checkWhy).toMatch(/could not read the deployment ledger for example-app \(the deployment ledger answered HTTP 503\).*Try again once the deployment ledger answers/)
  })

  it('stops a hotfix promote when the ledger names no commit for the live release', async () => {
    const result = await check(github(), fakeLedger([ledgerRow(NEWER_RELEASE, undefined)]))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'unconfirmed' })
    expect(result.checkWhy).toMatch(/names no commit for release-2026-10-22-10150/)
  })

  it('skips the check, and says deploy, when GitHub cannot tell whether it is a hotfix', async () => {
    const ledger = fakeLedger(new Error('must not be read'))
    const result = await check(github({ fails: true }), ledger)
    expect(result).toMatchObject({ kind: 'deploy', check: 'skipped' })
    expect(result.warning).toMatch(/could not tell whether this promote is a hotfix \(Bad gateway\), so it goes on as an ordinary promote/)
    expect(ledger.calls).toEqual([])
  })

  it('stops a confirmed hotfix when GitHub cannot say whether it builds on production', async () => {
    const result = await check(github({ fromLive: new Error('timeout') }), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]))
    expect(result).toMatchObject({ kind: 'hotfix', check: 'unconfirmed' })
    expect(result.checkWhy).toMatch(/GitHub did not answer whether aaaaaaaaaaaa builds on release-2026-10-22-10150.*refusing to promote it/)
    expect(result.warning).toMatch(/GitHub did not answer/)
  })

  it('gives the forward check its own timeout: a slow ledger cannot use up the deadline and let a stale hotfix through', async () => {
    // The reads that find the hotfix share a 300 ms deadline, and the ledger
    // answers after 400 ms with a newer release.
    const slowLedger = fakeLedger(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return [ledgerRow(NEWER_RELEASE, LIVE_SHA)]
    })
    const result = await check(github(), slowLedger, { request: deadlineRequests({ deadlineMs: 300 }) })
    expect(result).toMatchObject({ kind: 'hotfix', check: 'stale' })
  })

  describe('a commit on no branch the pipeline builds from (its hotfix branch was deleted)', () => {
    it('passes when it builds on what production runs', async () => {
      const result = await check(github({ branches: [], fromLive: 'ahead' }), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
      expect(result).toMatchObject({ kind: 'deploy', offBranch: true, check: 'live' })
    })

    it.each(['behind', 'diverged'])('refuses it when GitHub says %s', async (fromLive) => {
      const result = await check(github({ branches: [], fromLive }), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
      expect(result).toMatchObject({ kind: 'deploy', check: 'stale' })
      expect(result.checkWhy).toMatch(/is not on the default branch or on any hotfix branch \(its hotfix branch may have been deleted\), but production now runs release-2026-10-20-10140, which it does not build on/)
    })

    it('skips the check, with a warning, only when GitHub cannot answer', async () => {
      const result = await check(github({ branches: [], fromLive: new Error('timeout') }), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
      expect(result).toMatchObject({ kind: 'deploy', check: 'skipped' })
      expect(result.warning).toMatch(/so this promote goes on without the check/)
    })

    it('stops it when the ledger cannot be read', async () => {
      const result = await check(github({ branches: [] }), fakeLedger(new Error('no answer')))
      expect(result).toMatchObject({ kind: 'deploy', check: 'ledger_unavailable' })
    })
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

describe('the stage message\'s fixes line', () => {
  it('escapes the three characters Slack reads as markup, & first', () => {
    expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    expect(escapeMrkdwn('&lt;')).toBe('&amp;lt;')
    expect(escapeMrkdwn(undefined)).toBe('')
  })

  it('takes the first line of a commit message, trimmed, and cuts a long one', () => {
    expect(commitSubject('  Fix the login redirect  \n\nLonger body\n(cherry picked from commit abc)')).toBe('Fix the login redirect')
    expect(commitSubject('Windows line end\r\nbody')).toBe('Windows line end')
    expect(commitSubject('')).toBe('(no commit message)')
    expect(commitSubject(null)).toBe('(no commit message)')
    const cut = commitSubject('x'.repeat(250))
    expect(cut).toHaveLength(100)
    expect(cut.endsWith('...')).toBe(true)
  })

  it('cuts by code points, so an emoji at the cut is kept whole', () => {
    // 106 code points; a cut by UTF-16 units would split the first emoji.
    const cut = commitSubject(`${'x'.repeat(96)}${'\u{1F600}'.repeat(10)}`)
    expect(cut).toBe(`${'x'.repeat(96)}\u{1F600}...`)
    expect(cut.isWellFormed()).toBe(true)
    expect(Array.from(cut)).toHaveLength(100)
    // A subject that fits is never cut, whatever its length in UTF-16 units.
    const fits = `${'x'.repeat(90)}${'\u{1F600}'.repeat(10)}`
    expect(commitSubject(fits)).toBe(fits)
  })

  it.each([
    ['NEL', '\u0085'], ['LINE SEPARATOR', '\u2028'], ['PARAGRAPH SEPARATOR', '\u2029'],
    ['LRE', '\u202a'], ['RLE', '\u202b'], ['PDF', '\u202c'], ['LRO', '\u202d'], ['RLO', '\u202e'],
    ['LRI', '\u2066'], ['RLI', '\u2067'], ['FSI', '\u2068'], ['PDI', '\u2069'],
    ['LRM', '\u200e'], ['RLM', '\u200f'], ['ALM', '\u061c'],
    ['NUL', '\u0000'], ['TAB', '\t'], ['ESC', '\u001b'], ['DEL', '\u007f']
  ])('turns %s into a space, so a subject cannot fake a line break or reorder its text', (_name, char) => {
    expect(commitSubject(`Fix A${char}Fix B`)).toBe('Fix A Fix B')
  })

  it('keeps an emoji joined with a zero-width joiner whole', () => {
    expect(commitSubject('\u{1F469}‍\u{1F4BB} Fix the build')).toBe('\u{1F469}‍\u{1F4BB} Fix the build')
  })

  it.each([
    [['Fix A'], 1, 'The live release plus 1 fix: Fix A'],
    [['Fix A', 'Fix B'], 2, 'The live release plus 2 fixes: Fix A; Fix B'],
    [['Fix A', 'Fix B', 'Fix C'], 3, 'The live release plus 3 fixes: Fix A; Fix B; Fix C'],
    [['Fix A', 'Fix B', 'Fix C', 'Fix D'], 4, 'The live release plus 4 fixes: Fix A; Fix B; Fix C; and 1 more'],
    [['Fix A', 'Fix B', 'Fix C', 'Fix D', 'Fix E'], 5, 'The live release plus 5 fixes: Fix A; Fix B; Fix C; and 2 more'],
    // GitHub sends at most one page of commits; the count is the total.
    [['Fix A', 'Fix B', 'Fix C'], 120, 'The live release plus 120 fixes: Fix A; Fix B; Fix C; and 117 more']
  ])('names up to three fixes, then how many more (%j, %i)', (subjects, count, line) => {
    expect(fixesLine(subjects, count)).toBe(line)
  })

  it('is empty when there is no fix to name', () => {
    expect(fixesLine([], 0)).toBe('')
    expect(fixesLine([])).toBe('')
    expect(fixesLine(['Fix A'], Number.NaN)).toBe('')
  })

  it('leaves nothing in a hostile subject that Slack would read as a link, a mention or a channel call', () => {
    const line = fixesLine(['<!channel> look <https://evil.example.test|the fix> & <@U0123> <#C0123>'])
    expect(line).toBe('The live release plus 1 fix: &lt;!channel&gt; look &lt;https://evil.example.test|the fix&gt; &amp; &lt;@U0123&gt; &lt;#C0123&gt;')
    expect(line).not.toMatch(/[<>]/)
    // A subject cut to length never ends in half an escape.
    const long = fixesLine([`${'x'.repeat(95)}<!here>`])
    expect(long).not.toMatch(/[<>]/)
    expect(long).toMatch(/x{95}&lt;!\.\.\.$/)
    // A line separator cannot push markup onto a line of its own.
    expect(fixesLine(['Fix A\u2028<!here>'])).toBe('The live release plus 1 fix: Fix A &lt;!here&gt;')
  })
})

describe('candidateKind (deploy-candidate\'s Slack label)', () => {
  const SHA = 'a'.repeat(40)
  const MAIN_TIP = 'b'.repeat(40)
  const LIVE_SHA = 'c'.repeat(40)
  const repository = 'example-org/example-app'
  const commit = (message) => ({ commit: { message } })

  // GitHub: the candidate's commit is on hotfix/<release> and not on main,
  // unless `onMain`. `fromLive` is the compare from production's commit.
  function github ({ onMain = false, fromLive = { status: 'ahead', total_commits: 1, commits: [commit('Fix the login redirect\n\n(cherry picked from commit 1234)')] }, fails = false } = {}) {
    return {
      rest: {
        repos: {
          get: vi.fn(async () => { if (fails) throw new Error('Bad credentials'); return { data: { default_branch: 'main' } } }),
          getBranch: vi.fn(async () => ({ data: { commit: { sha: MAIN_TIP } } })),
          compareCommitsWithBasehead: vi.fn(async ({ basehead }) => {
            if (basehead === `${MAIN_TIP}...${SHA}`) return { data: { status: onMain ? 'behind' : 'diverged' } }
            if (basehead === `${LIVE_SHA}...${SHA}`) {
              if (fromLive instanceof Error) throw fromLive
              return { data: fromLive }
            }
            throw new Error(`unexpected compare ${basehead}`)
          })
        },
        git: { listMatchingRefs: vi.fn(async () => ({ data: [{ ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha: SHA } }] })) }
      }
    }
  }
  const label = (octokit, ledger, options = {}) => candidateKind({ octokit, repository, sha: SHA, project: PROJECT, readLedger: ledger.readLedger, ...options })

  it('names a hotfix, the release it fixes, and the fix it adds to the live release', async () => {
    const api = github()
    const ledger = fakeLedger([ledgerRow(RELEASE, LIVE_SHA)])
    const result = await label(api, ledger)
    expect(result).toMatchObject({ kind: 'hotfix', branch: BRANCH, release: RELEASE, fixes: 'The live release plus 1 fix: Fix the login redirect' })
    // One quick ledger read, never the three tries promote's guards make.
    expect(ledger.calls).toEqual([{ project: PROJECT, limit: 1, attempts: 1, timeoutMs: CANDIDATE_LEDGER_TIMEOUT_MS }])
    expect(api.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({ basehead: `${LIVE_SHA}...${SHA}`, per_page: 100 }))
  })

  it('counts every fix and lists the first three, oldest first as GitHub sends them', async () => {
    const commits = ['Fix A', 'Fix B', 'Fix C', 'Fix D'].map(commit)
    const result = await label(github({ fromLive: { status: 'ahead', total_commits: 4, commits } }), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
    expect(result.fixes).toBe('The live release plus 4 fixes: Fix A; Fix B; Fix C; and 1 more')
  })

  it('is deploy for a commit on the default branch, without reading the ledger', async () => {
    const ledger = fakeLedger(new Error('must not be read'))
    expect(await label(github({ onMain: true }), ledger)).toMatchObject({ kind: 'deploy', fixes: '' })
    expect(ledger.calls).toEqual([])
  })

  it('throws when GitHub cannot tell, for the caller to post the ordinary message', async () => {
    await expect(label(github({ fails: true }), fakeLedger(new Error('must not be read')))).rejects.toThrow(/Bad credentials/)
  })

  it('gives up at its own deadline, so a slow GitHub cannot hold the deploy job', async () => {
    let clock = 0
    const now = () => { clock += 15000; return clock }
    await expect(label(github(), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]), { request: deadlineRequests({ deadlineMs: 20000, now }) })).rejects.toThrow(/gave up after 20 seconds/)
  })

  // Once GitHub has said hotfix, the message says hotfix. What can still go
  // wrong only costs the line naming the fixes.
  it.each([
    ['the ledger cannot be read', {}, fakeLedger(new Error('the deployment ledger answered HTTP 503')), /could not read the deployment ledger/],
    ['production runs another release', {}, fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]), /production now runs release-2026-10-22-10150, not release-2026-10-20-10140/],
    ['the ledger names no commit', {}, fakeLedger([ledgerRow(RELEASE, undefined)]), /names no commit/],
    ['the candidate does not build on production', { fromLive: { status: 'diverged', total_commits: 2, commits: [] } }, fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]), /GitHub says diverged/],
    ['GitHub does not list the commits', { fromLive: new Error('timeout') }, fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]), /did not list the commits after cccccccccccc \(timeout\)/]
  ])('still says hotfix, without the fixes, when %s', async (_why, options, ledger, fixesWhy) => {
    const result = await label(github(options), ledger)
    expect(result).toMatchObject({ kind: 'hotfix', release: RELEASE, fixes: '' })
    expect(result.fixesWhy).toMatch(fixesWhy)
  })

  it('escapes a hostile subject', async () => {
    const result = await label(github({ fromLive: { status: 'ahead', total_commits: 1, commits: [commit('<!channel> <https://evil.example.test|fix>')] } }), fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
    expect(result.fixes).toBe('The live release plus 1 fix: &lt;!channel&gt; &lt;https://evil.example.test|fix&gt;')
  })

  it('says deploy in its own words, without asking GitHub, when the image names no commit', async () => {
    const api = github()
    const result = await label(api, fakeLedger(new Error('must not be read')), { sha: '' })
    expect(result).toMatchObject({ kind: 'deploy', why: 'the candidate image has no sha- tag naming its commit, so it cannot be a hotfix build', promotable: '' })
    expect(api.rest.repos.get).not.toHaveBeenCalled()
  })

  describe('whether promote would take it', () => {
    it('is yes for a hotfix of the release production runs, without another compare', async () => {
      const api = github()
      const result = await label(api, fakeLedger([ledgerRow(RELEASE, LIVE_SHA)]))
      expect(result).toMatchObject({ promotable: 'yes', productionRelease: RELEASE })
      // The default-branch compare, then the one that lists the fixes.
      expect(api.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledTimes(2)
    })

    it('is no, naming the release production runs, when production moved to one it does not build on', async () => {
      const result = await label(github({ fromLive: { status: 'diverged' } }), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]))
      expect(result).toMatchObject({ kind: 'hotfix', promotable: 'no', productionRelease: NEWER_RELEASE, fixes: '' })
      expect(result.promotableWhy).toMatch(/production now runs release-2026-10-22-10150, which it does not build on/)
    })

    it('is yes when production moved forward along the same line', async () => {
      expect(await label(github({ fromLive: { status: 'ahead' } }), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)])))
        .toMatchObject({ promotable: 'yes', productionRelease: NEWER_RELEASE })
      expect(await label(github(), fakeLedger([ledgerRow(NEWER_RELEASE, SHA)])))
        .toMatchObject({ promotable: 'yes', productionRelease: NEWER_RELEASE })
    })

    // promote refuses this every time: the ledger names no commit for the
    // release production runs, so nothing can show the hotfix builds on it.
    it('is no, naming the release production runs, when the ledger names no commit for that other release', async () => {
      const api = github()
      const result = await label(api, fakeLedger([ledgerRow(NEWER_RELEASE, undefined)]))
      expect(result).toMatchObject({ kind: 'hotfix', promotable: 'no', productionRelease: NEWER_RELEASE, fixes: '' })
      expect(result.promotableWhy).toMatch(/the deployment ledger names no commit for release-2026-10-22-10150, the release production runs/)
      // Nothing to compare against: only the default-branch compare ran.
      expect(api.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledTimes(1)
    })

    it('is yes when the ledger names no commit for the hotfix\'s own release, as promote lets that through', async () => {
      expect(await label(github(), fakeLedger([ledgerRow(RELEASE, undefined)])))
        .toMatchObject({ kind: 'hotfix', promotable: 'yes', productionRelease: RELEASE, fixes: '' })
    })

    // Each of these could clear by the time someone promotes.
    it.each([
      ['the ledger cannot be read', {}, fakeLedger(new Error('no answer')), ''],
      ['GitHub does not answer the forward compare', { fromLive: new Error('timeout') }, fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]), NEWER_RELEASE]
    ])('is unknown when %s', async (_why, options, ledger, productionRelease) => {
      expect(await label(github(options), ledger)).toMatchObject({ kind: 'hotfix', promotable: 'unknown', productionRelease })
    })

    it('runs out with the label\'s deadline, and is then unknown, not no', async () => {
      // The default-branch reads use up the deadline; the forward compare
      // starts after it.
      let clock = 0
      const now = () => { clock += 4000; return clock }
      const result = await label(github({ fromLive: { status: 'diverged' } }), fakeLedger([ledgerRow(NEWER_RELEASE, LIVE_SHA)]), { request: deadlineRequests({ deadlineMs: 20000, now }) })
      expect(result).toMatchObject({ kind: 'hotfix', promotable: 'unknown' })
      expect(result.promotableWhy).toMatch(/gave up after 20 seconds/)
    })

    // One copy of promote's logic: for every case, the label says yes when
    // promote's check passes, no when promote refuses it whatever happens
    // first, and unknown only when promote's answer could still change.
    it.each([
      ['for the release production runs', {}, [ledgerRow(RELEASE, LIVE_SHA)], 'live', 'yes'],
      ['for the release production runs, with no commit in the ledger', {}, [ledgerRow(RELEASE, undefined)], 'live', 'yes'],
      ['production moved, not built on', { fromLive: { status: 'diverged' } }, [ledgerRow(NEWER_RELEASE, LIVE_SHA)], 'stale', 'no'],
      ['production moved, behind it', { fromLive: { status: 'behind' } }, [ledgerRow(NEWER_RELEASE, LIVE_SHA)], 'stale', 'no'],
      ['production moved forward along it', { fromLive: { status: 'ahead' } }, [ledgerRow(NEWER_RELEASE, LIVE_SHA)], 'live', 'yes'],
      ['production runs it already', {}, [ledgerRow(NEWER_RELEASE, SHA)], 'live', 'yes'],
      ['production moved, with no commit in the ledger', {}, [ledgerRow(NEWER_RELEASE, undefined)], 'unconfirmed', 'no'],
      ['no answer to the forward compare', { fromLive: new Error('timeout') }, [ledgerRow(NEWER_RELEASE, LIVE_SHA)], 'unconfirmed', 'unknown'],
      ['no ledger', {}, new Error('no answer'), 'ledger_unavailable', 'unknown']
    ])('agrees with promote when %s', async (_why, options, rows, check, promotable) => {
      const promote = await hotfixPromoteCheck({ octokit: github(options), repository, sha: SHA, project: PROJECT, readLedger: fakeLedger(rows).readLedger })
      expect(promote.check).toBe(check)
      expect((await label(github(options), fakeLedger(rows))).promotable).toBe(promotable)
    })
  })
})
