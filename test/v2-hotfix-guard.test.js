import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { REASONS, HotfixRefusal, gitIn, verifyHotfixRef } from '../src/v2/hotfix.js'
import { NEWER_RELEASE, PROJECT, RELEASE, fakeLedger, isolateGitConfig, ledgerRow, standardApp } from './support/git-fixture.js'

// build-candidate's check of a hotfix/* ref, against real git repositories
// (see support/git-fixture.js): a branch this pipeline could have cut passes,
// and a hand-pushed branch that could put other code on release-candidate is
// refused. The deployment ledger is a stand-in. Cutting the branch is tested
// in v2-hotfix.test.js.

vi.setConfig({ testTimeout: 60000 })
beforeAll(isolateGitConfig)

const fixtures = []
function app (options) {
  const fx = standardApp(options)
  fixtures.push(fx)
  return fx
}
afterAll(() => { for (const fx of fixtures) fx.cleanup() })

const BRANCH_REF = `refs/heads/hotfix/${RELEASE}`

async function refusal (promise) {
  try {
    await promise
  } catch (error) {
    if (error instanceof HotfixRefusal) return error
    throw error
  }
  throw new Error('expected a refusal, but it passed')
}

// Run the check from a fresh clone of the pushed state, as build-candidate's
// full-history checkout would see it.
function verify (fx, { ref = BRANCH_REF, sha, rows } = {}) {
  const fake = fakeLedger(rows ?? [ledgerRow(RELEASE, fx.release)])
  const runner = fx.clone()
  const head = sha ?? fx.originGit(['rev-parse', ref])
  return verifyHotfixRef({ git: gitIn(runner), ref, sha: head, defaultBranch: 'main', project: PROJECT, readLedger: fake.readLedger })
}

describe('verifyHotfixRef (build-candidate\'s check)', () => {
  // A hotfix branch pushed by hand, as fx.git does in the dev clone.
  function handBranch (fx, build) {
    fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
    build()
    fx.push(`hand:${BRANCH_REF}`)
  }

  it('accepts a clean cherry-pick even though the code around the change differs from main', async () => {
    const fx = app()
    handBranch(fx, () => fx.git(['cherry-pick', '-x', fx.fix]))
    const head = fx.originGit(['rev-parse', BRANCH_REF])
    const verified = await verify(fx)
    expect(verified.commits).toEqual([{ sha: head, source: fx.fix }])
    // The reason the check compares trees, not patch-ids: the context lines
    // differ, so the patch-ids do too, though the pick is exactly the fix.
    const patchId = (sha) => execFileSync('sh', ['-c', `git diff-tree -p ${sha} | git patch-id --stable`], { cwd: fx.origin, encoding: 'utf8' }).split(' ')[0]
    expect(patchId(head)).not.toBe(patchId(fx.fix))
  })

  it('accepts a branch with no commits yet (the release itself)', async () => {
    const fx = app()
    fx.push(`${fx.release}:${BRANCH_REF}`)
    expect(await verify(fx)).toEqual({ release: RELEASE, base: fx.release, commits: [] })
  })

  it('refuses a hand-pushed commit that is not a cherry-pick', async () => {
    const fx = app()
    handBranch(fx, () => fx.commit('quick fix', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 8: 'const line8 = 9' }) }))
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
    expect(error.message).toMatch(/is not a cherry-pick: its message has no "\(cherry picked from commit \.\.\.\)" line/)
  })

  it('refuses a forged cherry-pick line: the text names the fix, the change is different', async () => {
    const fx = app()
    handBranch(fx, () => fx.commit(`fix: line 8 is off by one\n\n(cherry picked from commit ${fx.fix})`, {
      'app.js': fx.appWith({ 3: 'const line3 = 33', 8: 'const line8 = 8 + 1' }),
      'backdoor.js': 'run(anything)\n'
    }))
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
    expect(error.message).toMatch(/but its change is not exactly .*'s change/)
  })

  it('refuses a cherry-pick of a commit that is not on the default branch', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'feature', fx.release])
    const feature = fx.commit('unreviewed', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 8: 'const line8 = 800' }) })
    fx.push('feature')
    handBranch(fx, () => fx.git(['cherry-pick', '-x', feature]))
    const error = await refusal(verify(fx))
    expect(error.message).toMatch(/which is not on the default branch/)
  })

  it('refuses a branch cut from main\'s tip: the unreleased commits on it are not cherry-picks', async () => {
    const fx = app()
    fx.push(`${fx.fix}:${BRANCH_REF}`)
    const error = await refusal(verify(fx))
    expect(error.message).toBe(`${fx.unreleased.slice(0, 12)} is not a cherry-pick: its message has no "(cherry picked from commit ...)" line`)
  })

  it('refuses a branch that does not start at the release', async () => {
    const fx = app()
    fx.git(['checkout', '--quiet', '-b', 'old', fx.initial])
    fx.git(['cherry-pick', '-x', fx.fix])
    fx.push(`old:${BRANCH_REF}`)
    const error = await refusal(verify(fx))
    expect(error.message).toMatch(/does not start at/)
  })

  it('refuses main merged into the hotfix branch', async () => {
    const fx = app()
    handBranch(fx, () => {
      fx.git(['cherry-pick', '-x', fx.fix])
      fx.git(['merge', '--quiet', '--no-ff', '-X', 'theirs', '-m', 'merge main', 'main'])
    })
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
  })

  it('refuses a merge commit even when both sides are clean cherry-picks', async () => {
    const fx = app()
    const other = fx.commit('fix: line 11', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.push('main')
    fx.git(['checkout', '--quiet', '-b', 'side', fx.release])
    fx.git(['cherry-pick', '-x', other])
    handBranch(fx, () => {
      fx.git(['cherry-pick', '-x', fx.fix])
      fx.git(['merge', '--quiet', '--no-ff', '-m', 'merge side', 'side'])
    })
    const error = await refusal(verify(fx))
    expect(error.message).toMatch(/is a merge commit; a hotfix branch holds only cherry-picks/)
  })

  it('refuses a ref that is not named after a release', async () => {
    const fx = app()
    fx.push(`${fx.release}:refs/heads/hotfix/urgent`)
    const error = await refusal(verify(fx, { ref: 'refs/heads/hotfix/urgent' }))
    expect(error.message).toMatch(/is not named hotfix\/release-/)
  })

  it.each([
    ['a release production never ran', () => [ledgerRow(NEWER_RELEASE, 'a'.repeat(40))], /production has not run release-2026-10-20-10140/],
    ['ledger rows that disagree', (fx) => [ledgerRow(RELEASE, fx.release), ledgerRow(RELEASE, fx.fix)], /more than one commit/],
    ['an unreadable ledger', () => new Error('no answer from the deployment ledger'), /no answer from the deployment ledger/]
  ])('refuses %s', async (_label, answer, message) => {
    const fx = app()
    handBranch(fx, () => fx.git(['cherry-pick', '-x', fx.fix]))
    const fake = fakeLedger(answer(fx))
    const runner = fx.clone()
    const error = await refusal(verifyHotfixRef({ git: gitIn(runner), ref: BRANCH_REF, sha: fx.originGit(['rev-parse', BRANCH_REF]), defaultBranch: 'main', project: PROJECT, readLedger: fake.readLedger }))
    expect(error.reason).toBe(REASONS.releaseCommitUnknown)
    expect(error.message).toMatch(message)
    expect(fake.calls).toEqual([{ project: PROJECT, limit: 100 }])
  })

  it('does not trust a git tag: a release tag on any other commit changes nothing', async () => {
    const fx = app()
    // Someone makes a commit off to the side, tags it with the release name,
    // and names a hotfix branch after it. The ledger says where the release is.
    fx.git(['checkout', '--quiet', '-b', 'side', fx.initial])
    const side = fx.commit('anything', { 'backdoor.js': 'run(anything)\n' })
    fx.git(['tag', RELEASE, side])
    fx.push(`refs/tags/${RELEASE}`, `${side}:${BRANCH_REF}`)
    const error = await refusal(verify(fx))
    expect(error.message).toMatch(/does not start at/)
  })

  it('refuses a commit to build that is not a full sha, before reading the ledger', async () => {
    const fake = fakeLedger(new Error('must not be read'))
    const error = await refusal(verifyHotfixRef({ git: gitIn('.'), ref: BRANCH_REF, sha: 'abc123', defaultBranch: 'main', project: PROJECT, readLedger: fake.readLedger }))
    expect(error.reason).toBe(REASONS.invalidInput)
    expect(fake.calls).toEqual([])
  })
})
