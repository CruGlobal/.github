import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PIPELINE_PATH, REASONS, HotfixRefusal, gitIn, verifyHotfixRef } from '../src/v2/hotfix.js'
import { GitFixture, NEWER_RELEASE, PIPELINE, PROJECT, RELEASE, fakeLedger, isolateGitConfig, ledgerRow, standardApp } from './support/git-fixture.js'

// build-candidate's check of a hotfix ref, against real git repositories
// (see support/git-fixture.js): a branch this pipeline could have cut, for
// the release production runs now, passes; anything else the hotfix path
// could be made to build is refused. The deployment ledger is a stand-in.
// Cutting the branch is tested in v2-hotfix.test.js.

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
// full-history checkout would see it. `prepare` runs in that clone first.
function verify (fx, { ref = BRANCH_REF, sha, rows, ledger, prepare } = {}) {
  const fake = ledger ?? fakeLedger(rows ?? [ledgerRow(RELEASE, fx.release)])
  const runner = fx.clone()
  if (prepare) prepare(runner)
  const head = sha ?? fx.originGit(['rev-parse', ref])
  return verifyHotfixRef({ git: gitIn(runner), ref, sha: head, defaultBranch: 'main', project: PROJECT, readLedger: fake.readLedger })
}

// A hotfix branch pushed by hand, as fx.git does in the dev clone.
function handBranch (fx, build) {
  fx.git(['checkout', '--quiet', '-b', 'hand', fx.release])
  build()
  fx.push(`hand:${BRANCH_REF}`)
}

// A repository with no history yet, for the cases standardApp cannot make.
function emptyApp () {
  const fx = new GitFixture()
  fixtures.push(fx)
  return fx
}

// Ten numbered lines, with some replaced: { 5: 'main five' }.
const tenLines = (changes = {}) => Array.from({ length: 10 }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

// A cherry-pick of `source` onto `onto`, made exactly the way the check
// judges one (git's merge with the .gitattributes of the commit it goes onto)
// and committed with a -x line. Throws when that merge conflicts.
function judgedPick (fx, onto, source) {
  const tree = fx.git([`--attr-source=${onto}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${source}^`, onto, source]).split('\n')[0]
  const message = fx.git(['log', '-1', '--format=%B', source])
  return fx.git(['commit-tree', tree, '-p', onto, '-m', `${message}\n\n(cherry picked from commit ${source})`])
}

describe('verifyHotfixRef (build-candidate\'s check)', () => {
  it('accepts a clean cherry-pick even though the code around the change differs from main', async () => {
    const fx = app()
    handBranch(fx, () => fx.git(['cherry-pick', '-x', fx.fix]))
    const head = fx.originGit(['rev-parse', BRANCH_REF])
    const verified = await verify(fx)
    expect(verified).toEqual({ release: RELEASE, base: fx.release, commits: [{ sha: head, source: fx.fix }] })
    // The reason the check compares trees, not patch-ids: the context lines
    // differ, so the patch-ids do too, though the pick is exactly the fix.
    const patchId = (sha) => execFileSync('sh', ['-c', `git diff-tree -p ${sha} | git patch-id --stable`], { cwd: fx.origin, encoding: 'utf8' }).split(' ')[0]
    expect(patchId(head)).not.toBe(patchId(fx.fix))
  })

  it('reads only what production runs now', async () => {
    const fx = app()
    handBranch(fx, () => fx.git(['cherry-pick', '-x', fx.fix]))
    const ledger = fakeLedger([ledgerRow(RELEASE, fx.release)])
    await verify(fx, { ledger })
    expect(ledger.calls).toEqual([{ project: PROJECT, limit: 1 }])
  })

  it('refuses a hotfix of a release production ran once but no longer runs', async () => {
    const fx = app()
    handBranch(fx, () => fx.git(['cherry-pick', '-x', fx.fix]))
    const error = await refusal(verify(fx, { rows: [ledgerRow(NEWER_RELEASE, fx.fix), ledgerRow(RELEASE, fx.release)] }))
    expect(error.reason).toBe(REASONS.productionMoved)
    expect(error.message).toBe(`production now runs ${NEWER_RELEASE}, not ${RELEASE}, the release this branch is named after. A hotfix builds only for the release production runs now, or promoting it would take production backwards; cut a new hotfix for ${NEWER_RELEASE}`)
  })

  it('refuses a branch with no fix on it: it would only deploy the release again, around rollback', async () => {
    const fx = app()
    fx.push(`${fx.release}:${BRANCH_REF}`)
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.alreadyInRelease)
    expect(error.message).toMatch(/holds no fix: it is release-2026-10-20-10140 itself.*use rollback/)
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
    expect(error.message).toMatch(/which is not on the default branch's first-parent history/)
  })

  it('refuses a commit main reached only through a merge: main never had that state', async () => {
    const fx = app()
    // A pull request merged with a merge commit: "wip" breaks line 11,
    // "tidy" fixes it. main itself was only ever at the merge.
    fx.git(['checkout', '--quiet', '-b', 'pr', fx.fix])
    const wip = fx.commit('wip', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = BROKEN' }) })
    fx.commit('tidy', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
    fx.git(['checkout', '--quiet', 'main'])
    fx.git(['merge', '--quiet', '--no-ff', '-m', 'Merge pull request', 'pr'])
    fx.push('main')
    handBranch(fx, () => fx.git(['cherry-pick', '-x', wip]))
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.branchNotClean)
    expect(error.message).toMatch(new RegExp(`cherry-picked from ${wip.slice(0, 12)}, which is not on the default branch's first-parent history`))
  })

  it('refuses a cherry-pick of a commit that is already in the release', async () => {
    const fx = app()
    // An empty "pick" of the release commit itself: its tree matches, which
    // is why the ancestry is checked as well.
    handBranch(fx, () => fx.commit(`again\n\n(cherry picked from commit ${fx.release})`, {}))
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.alreadyInRelease)
    expect(error.message).toMatch(/which is already in the release the branch starts at/)
  })

  it('refuses a commit that changes nothing, even when its source\'s change is already in the code', async () => {
    const fx = app()
    // main reverts line 3 and then makes the release's change again. Picking
    // that onto the release changes nothing, so the tree check alone would
    // pass an empty commit that names it.
    fx.commit('revert line 3', { 'app.js': fx.appWith({ 6: 'const line6 = 66', 8: 'const line8 = 8 + 1' }) })
    const again = fx.commit('line 3 again', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1' }) })
    fx.push('main')
    handBranch(fx, () => fx.commit(`line 3 again\n\n(cherry picked from commit ${again})`, {}))
    const error = await refusal(verify(fx))
    expect(error.reason).toBe(REASONS.alreadyInRelease)
    expect(error.message).toMatch(/but it changes nothing: that change is already in the code it was picked onto/)
  })

  // The hotfix workflow refuses to push a fix that changes a workflow file
  // (its token has no workflow scope), so a person pushes that branch by hand.
  // build-candidate holds such a pick to every other rule, and builds it.
  describe('a cherry-pick that changes a workflow file, pushed by hand', () => {
    // The app's pipeline workflow with one more line, the kind of change a
    // gate fix makes.
    const show = (fx, rev, file) => fx.originGit(['show', `${rev}:${file}`]) + '\n'
    const gated = (fx) => show(fx, fx.release, PIPELINE_PATH).replace('jobs:', 'permissions:\n  contents: read\njobs:')

    it('accepts it when it is exactly a default-branch commit\'s change', async () => {
      const fx = app()
      const ci = fx.commit('ci: tweak', { '.github/workflows/ci.yml': 'on: push\n' })
      fx.push('main')
      handBranch(fx, () => fx.git(['cherry-pick', '-x', ci]))
      const head = fx.originGit(['rev-parse', BRANCH_REF])
      expect(await verify(fx)).toEqual({ release: RELEASE, base: fx.release, commits: [{ sha: head, source: ci }] })
    })

    it('accepts a fix to the app\'s own pipeline workflow, with a code fix picked after it', async () => {
      const fx = app()
      const gate = fx.commit('ci: let the build gate pass a hotfix branch', { [PIPELINE_PATH]: gated(fx) })
      const code = fx.commit('fix: line 11', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 66', 8: 'const line8 = 8 + 1', 11: 'const line11 = 0' }) })
      fx.push('main')
      handBranch(fx, () => {
        fx.git(['cherry-pick', '-x', gate])
        fx.git(['cherry-pick', '-x', code])
      })
      const verified = await verify(fx)
      expect(verified.commits.map((c) => c.source)).toEqual([gate, code])
      // The branch builds with the gate fix in its copy of the pipeline.
      expect(show(fx, BRANCH_REF, PIPELINE_PATH)).toContain('permissions:\n  contents: read\n')
    })

    it('refuses one that names a reviewed workflow change but makes a different one', async () => {
      const fx = app()
      const gate = fx.commit('ci: let the build gate pass a hotfix branch', { [PIPELINE_PATH]: gated(fx) })
      fx.push('main')
      // The message names the reviewed commit; the change also drops the
      // build-candidate call.
      handBranch(fx, () => fx.commit(`ci: let the build gate pass a hotfix branch\n\n(cherry picked from commit ${gate})`, {
        [PIPELINE_PATH]: gated(fx).replace(/ {4}uses: .*\n/, '    runs-on: ubuntu-latest\n')
      }))
      const error = await refusal(verify(fx))
      expect(error.reason).toBe(REASONS.branchNotClean)
      expect(error.message).toMatch(/but its change is not exactly .*'s change/)
    })

    it('refuses one picked from a commit that is not on the default branch', async () => {
      const fx = app()
      fx.git(['checkout', '--quiet', '-b', 'feature', fx.release])
      const unreviewed = fx.commit('ci: unreviewed', { '.github/workflows/ci.yml': 'on: push\n' })
      fx.push('feature')
      handBranch(fx, () => fx.git(['cherry-pick', '-x', unreviewed]))
      const error = await refusal(verify(fx))
      expect(error.reason).toBe(REASONS.branchNotClean)
      expect(error.message).toMatch(/which is not on the default branch's first-parent history/)
    })

    it('refuses one that only applies through a union merge driver an earlier pick brought in', async () => {
      const fx = app()
      // main moves the pipeline's build-candidate line, turns on union merges,
      // then moves the same line again. On the release that last change
      // conflicts; with union it "applies" by keeping both lines.
      const pin = (ref) => show(fx, fx.release, PIPELINE_PATH).replace('build-candidate.yml@v2', `build-candidate.yml@${ref}`)
      fx.commit('ci: pin build-candidate to v2.15', { [PIPELINE_PATH]: pin('v2.15') })
      const union = fx.commit('chore: merge everything with union', { '.gitattributes': '* merge=union\n' })
      const repin = fx.commit('ci: pin build-candidate to v2.16', { [PIPELINE_PATH]: pin('v2.16') })
      fx.push('main')
      handBranch(fx, () => {
        fx.git(['cherry-pick', '-x', union])
        fx.git(['cherry-pick', '-x', repin])
      })
      // The pipeline on the branch is one no reviewed commit ever had.
      expect(show(fx, BRANCH_REF, PIPELINE_PATH)).toMatch(/@v2\n[\s\S]*@v2\.16\n|@v2\.16\n[\s\S]*@v2\n/)
      const error = await refusal(verify(fx))
      expect(error.reason).toBe(REASONS.mergeDriver)
      expect(error.message).toMatch(/and changes a workflow file, but the \.gitattributes of the commit it was picked onto \([0-9a-f]{12}\) give \.github\/workflows\/pipeline-v2\.yml \(merge attribute: union\)\. A workflow file must merge with git's own merge/)
    })

    it('accepts one when .gitattributes name git\'s own merge for the workflow file, whatever they say about other files', async () => {
      const fx = app()
      const attributes = fx.commit('chore: union merges, except workflows', { '.gitattributes': '* merge=union\n.github/workflows/*.yml merge\n' })
      const ci = fx.commit('ci: tweak', { '.github/workflows/ci.yml': 'on: push\n' })
      fx.push('main')
      handBranch(fx, () => {
        fx.git(['cherry-pick', '-x', attributes])
        fx.git(['cherry-pick', '-x', ci])
      })
      expect((await verify(fx)).commits.map((c) => c.source)).toEqual([attributes, ci])
    })

    it('refuses a merge-driver pick even when its source names no workflow file, because a rename lands it on one', async () => {
      const fx = emptyApp()
      const WORKFLOW = '.github/workflows/x.yml'
      // The release has x.yml under workflows, with union merges for workflow
      // files. main moved x.yml out of workflows and then fixed it there. The
      // merge follows the move back onto the release's workflow path, and
      // union makes the conflict on line 5 "apply".
      const initial = fx.commit('initial', { 'app.js': 'a\n', [PIPELINE_PATH]: PIPELINE, [WORKFLOW]: tenLines(), '.gitattributes': '.github/workflows/* merge=union\n' })
      fx.git(['checkout', '--quiet', '-b', 'released', initial])
      fx.release = fx.commit('feature: line 5', { [WORKFLOW]: tenLines({ 5: 'release five' }) })
      fx.git(['checkout', '--quiet', 'main'])
      fx.remove(WORKFLOW)
      fx.commit('move x out of workflows', { 'old/x.yml': tenLines() })
      const fix = fx.commit('fix: x line 5', { 'old/x.yml': tenLines({ 5: 'main five' }) })
      fx.push('main', 'released')
      expect(fx.git(['diff-tree', '-r', '--name-only', '--no-commit-id', `${fix}^`, fix])).toBe('old/x.yml')
      fx.push(`${judgedPick(fx, fx.release, fix)}:${BRANCH_REF}`)
      expect(show(fx, BRANCH_REF, WORKFLOW)).toMatch(/release five\nmain five\n|main five\nrelease five\n/)
      const error = await refusal(verify(fx))
      expect(error.reason).toBe(REASONS.mergeDriver)
      expect(error.message).toContain(`give ${WORKFLOW} (merge attribute: union)`)
    })

    it('finds the .gitattributes file that sets the driver, even through a macro defined at the top level', async () => {
      const fx = emptyApp()
      const CI = '.github/workflows/ci.yml'
      // The top level defines a macro that sets union; .github/.gitattributes
      // uses it. A line in the top-level file would lose to the deeper one,
      // so the way out has to name .github/.gitattributes.
      fx.commit('initial', { 'app.js': 'a\n', [PIPELINE_PATH]: PIPELINE, [CI]: tenLines(), '.gitattributes': '[attr]keepboth merge=union\n', '.github/.gitattributes': 'workflows/*.yml keepboth\n' })
      fx.release = fx.commit('feature', { 'app.js': 'b\n' })
      const ci = fx.commit('ci: line 9', { [CI]: tenLines({ 9: 'main nine' }) })
      fx.push('main')
      handBranch(fx, () => fx.git(['cherry-pick', '-x', ci]))
      const error = await refusal(verify(fx))
      expect(error.reason).toBe(REASONS.mergeDriver)
      expect(error.wayOut).toEqual({ onto: fx.release, source: ci, sources: [{ file: '.github/.gitattributes', line: 'workflows/** merge' }], blocked: [] })
    })

    it('reads the merge attribute from the commit a pick was made on, not from the checkout', async () => {
      const fx = emptyApp()
      const CI = '.github/workflows/ci.yml'
      // Pick 1 turns union on, pick 2 is a workflow fix that applies only
      // through union, pick 3 turns union off again. The branch's head, and
      // the checkout, have no union; the commit pick 2 was made on does.
      fx.commit('initial', { 'app.js': 'a\n', [PIPELINE_PATH]: PIPELINE, [CI]: tenLines() })
      fx.release = fx.commit('feature', { 'app.js': 'b\n' })
      fx.commit('ci: line 5 A', { [CI]: tenLines({ 5: 'main five A' }) })
      const on = fx.commit('chore: union merges', { '.gitattributes': '* merge=union\n' })
      const b = fx.commit('ci: line 5 B', { [CI]: tenLines({ 5: 'main five B' }) })
      fx.remove('.gitattributes')
      const off = fx.commit('Revert "chore: union merges"')
      fx.push('main')
      const pick3 = judgedPick(fx, judgedPick(fx, judgedPick(fx, fx.release, on), b), off)
      fx.push(`${pick3}:${BRANCH_REF}`)
      expect(fx.originGit(['ls-tree', '--name-only', pick3])).not.toContain('.gitattributes')
      const error = await refusal(verify(fx))
      expect(error.reason).toBe(REASONS.mergeDriver)
      expect(error.message).toContain(`give ${CI} (merge attribute: union)`)
    })
  })

  it('merges with the parent commit\'s .gitattributes, not the checkout\'s', async () => {
    const fx = app()
    // A fix that cannot apply to the release: line 6 differs there.
    const conflicting = fx.commit('fix: line 6', { 'app.js': fx.appWith({ 3: 'const line3 = 33', 6: 'const line6 = 666', 8: 'const line8 = 8 + 1' }) })
    fx.push('main')
    // With a union merge driver in the checkout, git would merge it cleanly
    // anyway. Make a commit with that tree and call it a cherry-pick.
    writeFileSync(path.join(fx.dev, '.gitattributes'), 'app.js merge=union\n')
    const unionTree = fx.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${conflicting}^`, fx.release, conflicting])
    expect(unionTree).toMatch(/^[0-9a-f]{40}$/)
    const forged = fx.git(['commit-tree', unionTree, '-p', fx.release, '-m', `fix: line 6\n\n(cherry picked from commit ${conflicting})`])
    fx.push(`${forged}:${BRANCH_REF}`)
    // The build's checkout has the same union driver, uncommitted.
    const error = await refusal(verify(fx, { prepare: (runner) => writeFileSync(path.join(runner, '.gitattributes'), 'app.js merge=union\n') }))
    expect(error.reason).toBe(REASONS.branchNotClean)
    expect(error.message).toMatch(/but its change is not exactly .*'s change/)
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

  it('refuses a ref that is not named after a release', async () => {
    const fx = app()
    fx.push(`${fx.release}:refs/heads/hotfix/urgent`)
    const error = await refusal(verify(fx, { ref: 'refs/heads/hotfix/urgent' }))
    expect(error.message).toMatch(/is not named hotfix\/release-/)
  })

  it.each([
    ['an unreadable ledger', () => new Error('no answer from the deployment ledger'), REASONS.ledgerUnavailable, /could not read the deployment ledger for example-app \(no answer from the deployment ledger\)/],
    ['no production rows', () => [], REASONS.productionMoved, /has no production rows/],
    ['a live release with no commit', () => [ledgerRow(RELEASE, undefined)], REASONS.releaseCommitUnknown, /names no commit for release-2026-10-20-10140/]
  ])('fails closed on %s', async (_label, answer, reason, message) => {
    const fx = app()
    handBranch(fx, () => fx.git(['cherry-pick', '-x', fx.fix]))
    const error = await refusal(verify(fx, { ledger: fakeLedger(answer(fx)) }))
    expect(error.reason).toBe(reason)
    expect(error.message).toMatch(message)
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
