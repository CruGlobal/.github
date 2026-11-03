import { spawn } from 'node:child_process'

// Hotfix builds (pipeline v2).
//
// A hotfix ships on a branch cut from the release production runs now, not
// from the tip of the default branch. The default branch often holds changes
// that are not released yet, and an unreleased migration among them would
// make a hotfix built from its tip unsafe to roll back. The fix always lands
// on the default branch first, through a normal pull request and its checks.
// The hotfix branch only cherry-picks it.
//
// Three callers use this module:
//
//   - hotfix.yml cuts the branch: it checks that production still runs the
//     release the caller named, cherry-picks the fix onto
//     hotfix/<release tag>, and pushes the branch (cutHotfix).
//   - build-candidate.yml refuses to build a hotfix/* branch unless it is one
//     this pipeline could have cut (verifyHotfixRef). Without that check,
//     anyone who can push a branch could put any code on release-candidate by
//     naming the branch hotfix/something.
//   - promote.yml tells a hotfix promote from an ordinary one, so the release
//     event says which it was (releaseKind).
//
// What a valid hotfix branch is, in one rule: it is named
// hotfix/<release tag>, it starts at the commit production ran for that
// release (from the deployment ledger, never from a git tag, which anyone
// with push access can create), and every commit after that one is a clean
// cherry-pick of a single-parent commit on the default branch. "Clean
// cherry-pick" is checked on content, not on the "(cherry picked from commit
// X)" line, which is only text: X must be on the default branch, and applying
// X's change to the commit's parent must give exactly the commit's tree. That
// is the same three-way merge `git cherry-pick` does, so a cherry-pick that
// applied cleanly always passes, even when the code around the change differs
// between the default branch and the release. A patch-id comparison would
// refuse those, because a patch-id covers the context lines too, and it would
// not see a changed binary file or file mode at all.
//
// A merge commit is refused as the fix. Cherry-picking a merge needs a parent
// chosen with -m, and the change it brings is only right when the first
// parent is the default branch's previous tip. When a merge was made the
// other way round, the first parent is the feature branch, and the change
// "relative to parent 1" is everything the default branch gained in the
// meantime, unreleased migrations included: exactly what a hotfix exists to
// leave out. A squash merge or a rebase merge gives single-parent commits,
// and a rebase merge's commits can be hotfixed one run at a time.

export const LEDGER_URL = 'https://deploys.cru.org/deployments'
export const PIPELINE_WORKFLOW = 'pipeline-v2.yml'
export const PIPELINE_PATH = `.github/workflows/${PIPELINE_WORKFLOW}`
export const BRANCH_PREFIX = 'hotfix/'

// How many production rows build-candidate reads to find the release a
// hotfix branch is named after. 100 is the most the ledger API returns. A
// release older than the newest 100 production rows is too old to hotfix.
export const LEDGER_SCAN_LIMIT = 100

// The identity that commits the cherry-picks. The author stays the fix's
// author, as `git cherry-pick` always keeps it.
export const COMMITTER = Object.freeze({
  name: 'github-actions[bot]',
  email: '41898276+github-actions[bot]@users.noreply.github.com'
})

// The fixed reason words a refusal's error is titled with, so automation that
// started a hotfix run can read why from the run's annotations.
export const REASONS = Object.freeze({
  invalidInput: 'invalid_input',
  productionMoved: 'production_moved',
  releaseCommitUnknown: 'release_commit_unknown',
  notOnDefaultBranch: 'not_on_default_branch',
  mergeCommit: 'merge_commit',
  alreadyInRelease: 'already_in_release',
  conflict: 'cherry_pick_conflict',
  branchNotClean: 'branch_not_clean',
  branchMoved: 'branch_moved',
  noPipeline: 'no_pipeline'
})

export class HotfixRefusal extends Error {
  constructor (reason, message) {
    super(message)
    this.name = 'HotfixRefusal'
    this.reason = reason
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/
const RELEASE_SUFFIX = /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}-)?[0-9]+$/
export const RELEASE_TAG = /^release-(?:[0-9]{4}-[0-9]{2}-[0-9]{2}-)?[0-9]+$/
const HOTFIX_REF = /^refs\/heads\/hotfix\/(release-(?:[0-9]{4}-[0-9]{2}-[0-9]{2}-)?[0-9]+)$/
const PICKED_FROM = /^\(cherry picked from commit ([0-9a-f]{40})\)$/

export const short = (sha) => String(sha ?? '').slice(0, 12)

// A value from a workflow input can hold a line break. Everything that echoes
// one keeps it on one line, so the rest cannot read as a workflow command.
export const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ')

// Same rules as promote's and rollback's release guards: surrounding
// whitespace is trimmed and the release- prefix is optional. Returns the full
// tag, or '' when the value is not a release tag.
export function normalizeRelease (value) {
  const trimmed = String(value ?? '').trim()
  const suffix = trimmed.startsWith('release-') ? trimmed.slice('release-'.length) : trimmed
  return RELEASE_SUFFIX.test(suffix) ? `release-${suffix}` : ''
}

export function hotfixBranch (release) {
  if (!RELEASE_TAG.test(String(release ?? ''))) {
    throw new Error(`'${oneLine(release)}' is not a release tag, so there is no hotfix branch for it`)
  }
  return `${BRANCH_PREFIX}${release}`
}

// The release a hotfix ref is named after, or '' when the ref is not
// refs/heads/hotfix/<release tag>.
export function releaseFromRef (ref) {
  const match = String(ref ?? '').match(HOTFIX_REF)
  return match ? match[1] : ''
}

// The commit a "(cherry picked from commit X)" line names. `git cherry-pick
// -x` adds the line at the end, and a cherry-pick of a cherry-pick adds a
// second one, so the last line wins. '' when there is none.
export function cherryPickSource (message) {
  let source = ''
  for (const line of String(message ?? '').split('\n')) {
    const match = line.trim().match(PICKED_FROM)
    if (match) source = match[1]
  }
  return source
}

// --- Deployment ledger -------------------------------------------------------

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Newest-first production rows from the deployment ledger, the same public
// read promote's stale-promote guard makes. Throws on anything but a JSON
// answer with an Items array, so every caller fails closed. Retries what may
// pass on a second try: no answer, a timeout, a 429 or a 5xx.
export async function readProductionLedger ({
  project,
  limit = 1,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  attempts = 3,
  sleep = sleepFor
}) {
  const url = `${LEDGER_URL}?project=${encodeURIComponent(project)}&environment=production&limit=${limit}`
  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if (attempt >= attempts) throw new Error(`no answer from the deployment ledger (${error?.message ?? error})`, { cause: error })
      await sleep(2000 * attempt)
      continue
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= attempts) throw new Error(`the deployment ledger answered HTTP ${response.status}`)
      await sleep(2000 * attempt)
      continue
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error('the deployment ledger returned an answer that is not JSON')
    }
    if (!Array.isArray(body?.Items)) throw new Error('the deployment ledger returned an answer with no Items array')
    return body.Items
  }
}

const rowSha = (row) => (typeof row?.Sha === 'string' && FULL_SHA.test(row.Sha.trim()) ? row.Sha.trim() : '')

// Production must still be running `expected`: the newest production row's
// Revision, exactly as promote's stale-promote guard reads it. Fails closed:
// no answer is a refusal, not a pass. Returns the release and its commit.
export async function confirmLiveRelease ({ readLedger, project, expected, when = 'refusing to cut a hotfix' }) {
  const unconfirmed = `cannot confirm production is still running ${expected}; ${when}. Nothing was pushed`
  let items
  try {
    items = await readLedger({ project, limit: 1 })
  } catch (error) {
    throw new HotfixRefusal(REASONS.productionMoved, `could not read the deployment ledger for ${project} (${error.message}), so ${unconfirmed}`)
  }
  if (items.length === 0) {
    throw new HotfixRefusal(REASONS.productionMoved, `the deployment ledger has no production rows for ${project}, so ${unconfirmed}`)
  }
  const current = typeof items[0]?.Revision === 'string' ? items[0].Revision : ''
  if (!current) {
    throw new HotfixRefusal(REASONS.productionMoved, `the newest production row in the deployment ledger for ${project} has no Revision, so ${unconfirmed}`)
  }
  if (normalizeRelease(current) !== expected) {
    const bare = expected.slice('release-'.length)
    if (/^[0-9]+$/.test(bare) && current.endsWith(`-${bare}`)) {
      throw new HotfixRefusal(REASONS.productionMoved, `expected-release '${expected}' is a bare build number, but production's release tag is dated (${current}); pass the full tag. ${capitalize(when)}. Nothing was pushed`)
    }
    throw new HotfixRefusal(REASONS.productionMoved, `production is now running ${current}, not ${expected}, so this hotfix was asked for against a release that is no longer live; ${when}. Nothing was pushed. Start a new hotfix for ${current} if the fix is still needed`)
  }
  return { release: expected, sha: rowSha(items[0]) }
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1)

// The commit production ran for `release`, from the production rows given.
// Promote and rollback both write a row with the release's Revision and the
// commit its image was built from. Every row for one release must agree.
export function releaseCommitFromLedger (items, release) {
  const rows = items.filter((row) => row?.Revision === release)
  if (rows.length === 0) {
    throw new Error(`production has not run ${release}: it is not among the newest ${items.length} production rows in the deployment ledger`)
  }
  const shas = [...new Set(rows.map(rowSha).filter(Boolean))]
  if (shas.length === 0) throw new Error(`the deployment ledger's rows for ${release} name no commit`)
  if (shas.length > 1) throw new Error(`the deployment ledger's rows for ${release} name more than one commit (${shas.map(short).join(', ')})`)
  return shas[0]
}

// --- git ---------------------------------------------------------------------

// A git runner for the repository at `cwd`. Each call resolves to
// { code, stdout, stderr } and never throws on a non-zero exit: the caller
// decides what an exit code means. LC_ALL=C keeps git's messages parseable,
// and GIT_TERMINAL_PROMPT=0 makes a missing credential fail instead of wait.
export function gitIn (cwd) {
  return function git (args, { env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }
}

function must (result, what) {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
    throw new Error(`${what} failed (git exit ${result.code}${detail ? `: ${detail}` : ''})`)
  }
  return result
}

async function hasCommit (git, sha) {
  return (await git(['cat-file', '-e', `${sha}^{commit}`])).code === 0
}

// The commit a full ref name points at, or '' when there is no such ref.
async function resolveCommit (git, rev) {
  const result = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  return result.code === 0 ? result.stdout.trim() : ''
}

// The one commit whose sha starts with `prefix` (7 to 40 hex characters), or
// '' when there is none or more than one. Only object names count: a branch
// or tag whose name happens to look like hex never stands in for the commit.
async function resolveCommitSha (git, prefix) {
  if (prefix.length === 40) return (await hasCommit(git, prefix)) ? prefix : ''
  const result = await git(['rev-parse', `--disambiguate=${prefix}`])
  if (result.code !== 0) return ''
  const commits = []
  for (const sha of result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const type = await git(['cat-file', '-t', sha])
    if (type.code === 0 && type.stdout.trim() === 'commit') commits.push(sha)
  }
  return commits.length === 1 ? commits[0] : ''
}

// Fetch a commit by sha when the clone does not have it yet. GitHub serves a
// commit by sha even when no branch points at it any more.
async function ensureCommit (git, sha) {
  if (await hasCommit(git, sha)) return true
  await git(['fetch', '--no-tags', '--quiet', 'origin', sha])
  return hasCommit(git, sha)
}

async function isAncestor (git, ancestor, descendant) {
  const result = await git(['merge-base', '--is-ancestor', ancestor, descendant])
  if (result.code === 0) return true
  if (result.code === 1) return false
  must(result, `checking whether ${short(ancestor)} is in ${short(descendant)}`)
}

async function parentsOf (git, sha) {
  const result = must(await git(['rev-list', '--parents', '--max-count=1', sha]), `reading the parents of ${short(sha)}`)
  return result.stdout.trim().split(/\s+/).slice(1)
}

async function messageOf (git, sha) {
  return must(await git(['log', '-1', '--format=%B', sha]), `reading the message of ${short(sha)}`).stdout
}

async function treeOf (git, sha) {
  return must(await git(['rev-parse', `${sha}^{tree}`]), `reading the tree of ${short(sha)}`).stdout.trim()
}

// The tree `git cherry-pick` would make by applying `commit` (whose parent is
// `parent`) onto `onto`: a three-way merge with the commit's parent as the
// base. Nothing in the working tree or the index changes. `clean` is false
// when the merge has conflicts, and `conflicts` lists the files.
export async function pickTree (git, { parent, commit, onto }) {
  const result = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${parent}`, onto, commit])
  const lines = result.stdout.split('\n').filter(Boolean)
  if (result.code === 0) return { clean: true, tree: lines[0] ?? '', conflicts: [] }
  if (result.code === 1) return { clean: false, tree: lines[0] ?? '', conflicts: lines.slice(1) }
  must(result, `applying ${short(commit)} to ${short(onto)} (git merge-tree, which needs git 2.40 or later)`)
}

// The commits in base..head, oldest first, each with its parents.
async function rangeCommits (git, base, head) {
  const result = must(await git(['rev-list', '--reverse', '--topo-order', '--parents', `${base}..${head}`]), `listing the commits after ${short(base)}`)
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, ...parents] = line.trim().split(/\s+/)
    return { sha, parents }
  })
}

// The repository's default branch, as the remote reports it.
async function defaultBranchOf (git) {
  const result = must(await git(['ls-remote', '--symref', 'origin', 'HEAD']), 'reading the default branch')
  const match = result.stdout.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)
  if (!match) throw new Error('the remote did not say which branch is its default')
  return match[1]
}

// The commit a remote branch points at, or '' when there is no such branch.
async function remoteBranchTip (git, branch) {
  const ref = `refs/heads/${branch}`
  const result = must(await git(['ls-remote', '--heads', 'origin', ref]), `reading ${branch}`)
  const line = result.stdout.split('\n').find((entry) => entry.endsWith(`\t${ref}`))
  return line ? line.split('\t')[0] : ''
}

// Check every commit after `base` up to `head` is a clean cherry-pick of a
// single-parent commit on the default branch (see the note at the top of the
// file). Returns [{ sha, source }], oldest first. Throws a HotfixRefusal
// (branch_not_clean) naming the first commit that is not.
export async function verifyHotfixCommits ({ git, base, head, defaultRef }) {
  const refuse = (message) => { throw new HotfixRefusal(REASONS.branchNotClean, message) }
  if (!(await isAncestor(git, base, head))) {
    refuse(`it does not start at ${short(base)}, the commit of the release it is named after`)
  }
  const verified = []
  for (const { sha, parents } of await rangeCommits(git, base, head)) {
    if (parents.length !== 1) {
      refuse(`${short(sha)} is a merge commit; a hotfix branch holds only cherry-picks`)
    }
    const source = cherryPickSource(await messageOf(git, sha))
    if (!source) {
      refuse(`${short(sha)} is not a cherry-pick: its message has no "(cherry picked from commit ...)" line`)
    }
    if (!(await hasCommit(git, source))) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which is not in the repository`)
    }
    if (!(await isAncestor(git, source, defaultRef))) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which is not on the default branch`)
    }
    const sourceParents = await parentsOf(git, source)
    if (sourceParents.length !== 1) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which is ${sourceParents.length ? 'a merge commit' : 'a root commit'}`)
    }
    const pick = await pickTree(git, { parent: sourceParents[0], commit: source, onto: parents[0] })
    if (!pick.clean || pick.tree !== await treeOf(git, sha)) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, but its change is not exactly ${short(source)}'s change`)
    }
    verified.push({ sha, source })
  }
  return verified
}

// What build-candidate's guard checks for a build on a hotfix ref (see the
// note at the top of the file). `sha` is the commit the build would build.
// Returns { release, base, commits }, or throws a HotfixRefusal saying why
// the ref is not a hotfix branch this pipeline can build.
export async function verifyHotfixRef ({ git, ref, sha, defaultBranch, project, readLedger }) {
  const release = releaseFromRef(ref)
  if (!release) {
    throw new HotfixRefusal(REASONS.branchNotClean, `${oneLine(ref)} is not named hotfix/release-[<yyyy-mm-dd>-]<n>`)
  }
  if (!FULL_SHA.test(String(sha ?? ''))) {
    throw new HotfixRefusal(REASONS.invalidInput, `the commit to build ('${oneLine(sha)}') is not a full commit sha`)
  }
  if (!String(defaultBranch ?? '').trim()) {
    throw new HotfixRefusal(REASONS.invalidInput, 'the default branch is not known, so the cherry-picks cannot be checked against it')
  }
  let base
  try {
    base = releaseCommitFromLedger(await readLedger({ project, limit: LEDGER_SCAN_LIMIT }), release)
  } catch (error) {
    throw new HotfixRefusal(REASONS.releaseCommitUnknown, `the commit production ran for ${release} cannot be confirmed: ${error.message}`)
  }
  const defaultRef = `refs/remotes/origin/${defaultBranch}`
  if (!(await resolveCommit(git, defaultRef))) {
    must(await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${defaultBranch}:${defaultRef}`]), `fetching ${defaultBranch}`)
  }
  if (!(await ensureCommit(git, base))) {
    throw new HotfixRefusal(REASONS.releaseCommitUnknown, `${short(base)}, the commit production ran for ${release}, is not in the repository`)
  }
  if (!(await ensureCommit(git, sha))) {
    throw new HotfixRefusal(REASONS.invalidInput, `${short(sha)}, the commit to build, is not in the repository`)
  }
  const commits = await verifyHotfixCommits({ git, base, head: sha, defaultRef })
  return { release, base, commits }
}

// Read the app's pipeline workflow at `head`, the file the hotfix build is
// dispatched to. A missing file is a refusal, made before anything is pushed:
// there is nothing to dispatch. The rest are warnings, because a text check
// of YAML can be wrong and the build itself says clearly when it refuses.
async function checkPipelineWorkflow (git, head, branch) {
  const result = await git(['show', `${head}:${PIPELINE_PATH}`])
  if (result.code !== 0) {
    throw new HotfixRefusal(REASONS.noPipeline, `${branch} would have no ${PIPELINE_PATH}, so there is no pipeline-v2 workflow to build it with; refusing to cut a hotfix. Nothing was pushed`)
  }
  const text = result.stdout
  const warnings = []
  if (!/\bworkflow_dispatch\b/.test(text)) {
    warnings.push(`${PIPELINE_PATH} on ${branch} has no workflow_dispatch trigger, so dispatching the build will be refused. Dispatch it another way once the app's workflow allows it`)
  }
  const refs = [...text.matchAll(/CruGlobal\/\.github\/\.github\/workflows\/build-candidate\.yml@([^\s'"#]+)/gi)].map((match) => match[1])
  if (refs.length === 0) {
    warnings.push(`${PIPELINE_PATH} on ${branch} does not call CruGlobal/.github's build-candidate.yml, so the build may not make a candidate`)
  }
  for (const ref of new Set(refs)) {
    if (ref !== 'v2' && ref !== 'main') {
      warnings.push(`${PIPELINE_PATH} on ${branch} calls build-candidate.yml@${ref}. A build-candidate release older than the one that added hotfix builds refuses hotfix branches ("candidates build from the default branch only"). Point the app's workflow at @v2 to build hotfixes`)
    }
  }
  return warnings
}

async function cherryPick (git, { onto, commit, committer }) {
  must(await git(['checkout', '--quiet', '--detach', onto]), `checking out ${short(onto)}`)
  const env = { GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email }
  const result = await git(['cherry-pick', '-x', commit], { env })
  if (result.code !== 0) {
    await git(['cherry-pick', '--abort'])
    return ''
  }
  return must(await git(['rev-parse', 'HEAD']), 'reading the cherry-pick').stdout.trim()
}

// Push `head` to the hotfix branch, and nowhere else. A plain push, never
// forced: when the branch moved since it was read, git refuses the push, and
// nothing on the remote changes.
async function pushHotfixBranch (git, { head, branch, defaultBranch }) {
  const destination = `refs/heads/${branch}`
  if (!releaseFromRef(destination) || branch === defaultBranch) {
    throw new Error(`refusing to push to ${destination}: hotfix runs push only to hotfix/<release tag>`)
  }
  const result = await git(['push', '--porcelain', 'origin', `${head}:${destination}`])
  if (result.code === 0) return
  const output = `${result.stdout}\n${result.stderr}`
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\].*(cannot lock ref|reference already exists|incorrect old value)/i.test(output)) {
    throw new HotfixRefusal(REASONS.branchMoved, `${branch} changed on the remote while this run was cutting it, so the push was refused and nothing was pushed. Run the hotfix again`)
  }
  must(result, `pushing ${branch}`)
}

// Cut or extend hotfix/<release> with `commit` and push it (see the note at
// the top of the file). Everything that can refuse runs before the push, so
// a refusal always means nothing was pushed. `readLedger` is called twice:
// once at the start and once right before the push, so a production change
// in between is caught too.
//
// Returns { release, branch, base, commit, head, pushed, alreadyApplied,
// warnings }. A run whose fix is already on the branch (a re-run, or a second
// run for the same fix) pushes nothing and returns alreadyApplied.
export async function cutHotfix ({ git, project, commit, expectedRelease, readLedger, push = true, committer = COMMITTER }) {
  const expected = normalizeRelease(expectedRelease)
  if (!expected) {
    throw new HotfixRefusal(REASONS.invalidInput, `invalid expected-release '${oneLine(expectedRelease)}'; expected 'release-[<yyyy-mm-dd>-]<n>' (the release- prefix is optional). Refusing to cut a hotfix. Nothing was pushed`)
  }
  const wanted = String(commit ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(wanted)) {
    throw new HotfixRefusal(REASONS.invalidInput, `invalid commit '${oneLine(commit)}'; expected the sha (7 to 40 hex characters) of the fix's commit on the default branch. Refusing to cut a hotfix. Nothing was pushed`)
  }

  const live = await confirmLiveRelease({ readLedger, project, expected })
  if (!live.sha) {
    throw new HotfixRefusal(REASONS.releaseCommitUnknown, `the deployment ledger names no commit for ${expected}, the release production runs, so there is nothing to cut a hotfix branch from. Nothing was pushed`)
  }
  const release = live.release
  const base = live.sha
  const branch = hotfixBranch(release)

  const defaultBranch = await defaultBranchOf(git)
  const defaultRef = `refs/remotes/origin/${defaultBranch}`
  const remoteTip = await remoteBranchTip(git, branch)
  const refspecs = [`+refs/heads/${defaultBranch}:${defaultRef}`]
  if (remoteTip) refspecs.push(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)
  must(await git(['fetch', '--no-tags', '--quiet', 'origin', ...refspecs]), `fetching ${defaultBranch}${remoteTip ? ` and ${branch}` : ''}`)
  if (!(await ensureCommit(git, base))) {
    throw new HotfixRefusal(REASONS.releaseCommitUnknown, `${short(base)}, the commit production runs for ${release}, is not in the app repo, so there is nothing to cut a hotfix branch from. Nothing was pushed`)
  }

  const fix = await resolveCommitSha(git, wanted)
  if (!fix) {
    throw new HotfixRefusal(REASONS.notOnDefaultBranch, `commit ${wanted} is not in the app repo (or the short sha matches more than one commit); refusing to cut a hotfix. Nothing was pushed`)
  }
  if (!(await isAncestor(git, fix, defaultRef))) {
    throw new HotfixRefusal(REASONS.notOnDefaultBranch, `commit ${short(fix)} is not on ${defaultBranch}. A fix lands on ${defaultBranch} first, through a pull request and its checks, and the hotfix cherry-picks it from there; refusing to cut a hotfix. Nothing was pushed`)
  }
  if (await isAncestor(git, fix, base)) {
    throw new HotfixRefusal(REASONS.alreadyInRelease, `commit ${short(fix)} is already in ${release}, the release production runs, so there is nothing to hotfix. Nothing was pushed`)
  }
  const fixParents = await parentsOf(git, fix)
  if (fixParents.length > 1) {
    throw new HotfixRefusal(REASONS.mergeCommit, `commit ${short(fix)} is a merge commit. A hotfix cherry-picks single-parent commits only: use the pull request's squash commit, or run one hotfix per commit the merge brought in; refusing to cut a hotfix. Nothing was pushed`)
  }
  if (fixParents.length === 0) {
    throw new HotfixRefusal(REASONS.invalidInput, `commit ${short(fix)} is the repository's first commit, so it is not a fix to cherry-pick; refusing to cut a hotfix. Nothing was pushed`)
  }

  // An existing branch is an earlier fix for the same release that has not
  // been promoted yet. It is only added to when it is still exactly what this
  // workflow would have cut: someone else's extra commit stops the run, and
  // the branch is left for a person to look at.
  let tip = base
  let existing = []
  if (remoteTip) {
    try {
      existing = await verifyHotfixCommits({ git, base, head: remoteTip, defaultRef })
    } catch (error) {
      if (!(error instanceof HotfixRefusal)) throw error
      throw new HotfixRefusal(REASONS.branchNotClean, `${branch} already exists and is not a branch this workflow would cut: ${error.message}. It was left as it is, and nothing was pushed. A person needs to look at it; build-candidate refuses to build it as it is`)
    }
    tip = remoteTip
  }

  const already = existing.find((entry) => entry.source === fix)
  let head = tip
  if (!already) {
    const pick = await pickTree(git, { parent: fixParents[0], commit: fix, onto: tip })
    if (!pick.clean) {
      const files = pick.conflicts.slice(0, 10).join(', ') + (pick.conflicts.length > 10 ? `, and ${pick.conflicts.length - 10} more` : '')
      throw new HotfixRefusal(REASONS.conflict, `cherry-picking ${short(fix)} onto ${remoteTip ? branch : release} conflicts${files ? ` in ${files}` : ''}. The fix needs a version that applies to ${release}: land one on ${defaultBranch} and hotfix that commit instead; refusing to cut a hotfix. Nothing was pushed`)
    }
    if (pick.tree === await treeOf(git, tip)) {
      throw new HotfixRefusal(REASONS.alreadyInRelease, `cherry-picking ${short(fix)} onto ${remoteTip ? branch : release} changes nothing: the code there already has this change. Nothing was pushed`)
    }
    head = await cherryPick(git, { onto: tip, commit: fix, committer })
    if (!head) {
      throw new HotfixRefusal(REASONS.conflict, `git could not cherry-pick ${short(fix)} onto ${remoteTip ? branch : release}; refusing to cut a hotfix. Nothing was pushed`)
    }
    // Belt and braces: the branch about to be pushed must pass the very
    // check build-candidate runs, or the build would be refused after the
    // push.
    try {
      await verifyHotfixCommits({ git, base, head, defaultRef })
    } catch (error) {
      if (!(error instanceof HotfixRefusal)) throw error
      throw new Error(`the cherry-pick of ${short(fix)} does not pass build-candidate's hotfix check (${error.message}); refusing to push it`, { cause: error })
    }
  }

  const warnings = await checkPipelineWorkflow(git, head, branch)

  let pushed = false
  if (!already && push) {
    // Production can change between the first check and here. Check again,
    // as close to the push as possible, so a hotfix for a release that just
    // stopped being live is never pushed. A change after the push is the
    // promote's to catch: an automation promote names the release it expects
    // to replace.
    await confirmLiveRelease({ readLedger, project, expected, when: 'refusing to push the hotfix branch' })
    await pushHotfixBranch(git, { head, branch, defaultBranch })
    pushed = true
  }

  return {
    release,
    branch,
    base,
    commit: fix,
    head,
    pushed,
    alreadyApplied: Boolean(already),
    appliedAs: already ? already.sha : (head === tip ? '' : head),
    defaultBranch,
    warnings
  }
}

// --- GitHub API (promote and the hotfix run's report) ------------------------

export function parseRepo (repository) {
  const parts = String(repository ?? '').trim().split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`the app repo "${oneLine(repository)}" is not in owner/name form`)
  }
  return { owner: parts[0], repo: parts[1] }
}

const NEWEST_HOTFIX_BRANCHES = 50

// Is `sha` reachable from `tip`? The compare API's status says so: "behind"
// means `sha` is an ancestor of `tip`, "identical" that it is `tip`.
async function contains (octokit, { owner, repo, tip, sha, request }) {
  if (tip === sha) return true
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${tip}...${sha}`, per_page: 1, request: request() })
  return data?.status === 'behind' || data?.status === 'identical'
}

// Was the promoted commit built from a hotfix branch? It was when the commit
// is not on the app repo's default branch but is on a hotfix/* branch.
// build-candidate builds only those two kinds of ref, so a commit on neither
// is labeled an ordinary deploy. Returns { kind: 'hotfix' | 'deploy', why,
// branch }. Throws on an API error; the caller treats that as a deploy.
export async function releaseKind ({ octokit, repository, sha, timeoutMs = 10000 }) {
  const commit = String(sha ?? '').trim()
  if (!FULL_SHA.test(commit)) {
    return { kind: 'deploy', why: 'the promoted image names no commit, so it cannot be a hotfix build' }
  }
  const { owner, repo } = parseRepo(repository)
  const request = () => ({ signal: AbortSignal.timeout(timeoutMs) })
  const { data: info } = await octokit.rest.repos.get({ owner, repo, request: request() })
  const defaultBranch = info?.default_branch
  if (!defaultBranch) throw new Error(`GitHub did not say which branch is ${owner}/${repo}'s default`)
  const { data: branch } = await octokit.rest.repos.getBranch({ owner, repo, branch: defaultBranch, request: request() })
  const defaultTip = branch?.commit?.sha
  if (!defaultTip) throw new Error(`GitHub did not say which commit ${defaultBranch} points at`)
  if (await contains(octokit, { owner, repo, tip: defaultTip, sha: commit, request })) {
    return { kind: 'deploy', why: `${short(commit)} is on ${defaultBranch}` }
  }
  const { data: refs } = await octokit.rest.git.listMatchingRefs({ owner, repo, ref: 'heads/hotfix/', per_page: 100, request: request() })
  const branches = (Array.isArray(refs) ? refs : [])
    .filter((ref) => ref?.object?.type === 'commit' && typeof ref.ref === 'string')
    .sort((a, b) => b.ref.localeCompare(a.ref))
    .slice(0, NEWEST_HOTFIX_BRANCHES)
  for (const ref of branches) {
    if (await contains(octokit, { owner, repo, tip: ref.object.sha, sha: commit, request })) {
      const name = ref.ref.replace(/^refs\/heads\//, '')
      return { kind: 'hotfix', why: `${short(commit)} is on ${name}, not on ${defaultBranch}`, branch: name }
    }
  }
  return { kind: 'deploy', why: `${short(commit)} is not on ${defaultBranch} or on any hotfix branch` }
}

// The app's own workflow runs for `sha`, other than the pipeline-v2 build the
// hotfix run dispatches. A push starts its runs within seconds, so a run that
// just pushed waits a little for them to show up. Throws on an API error.
export async function appWorkflowRuns ({ octokit, repository, sha, attempts = 1, delayMs = 15000, sleep = sleepFor, timeoutMs = 10000 }) {
  const { owner, repo } = parseRepo(repository)
  for (let attempt = 1; ; attempt++) {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo, head_sha: sha, per_page: 100, request: { signal: AbortSignal.timeout(timeoutMs) } })
    const runs = (data?.workflow_runs ?? [])
      .filter((run) => String(run?.path ?? '').split('@')[0] !== PIPELINE_PATH)
      .map((run) => ({ name: run.name ?? run.path ?? 'workflow', event: run.event ?? '', status: run.status ?? '', conclusion: run.conclusion ?? '', url: run.html_url ?? '' }))
    if (runs.length > 0 || attempt >= attempts) return runs
    await sleep(delayMs)
  }
}
