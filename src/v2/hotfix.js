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
// Four callers use this module:
//
//   - hotfix.yml cuts the branch: it checks that production still runs the
//     release the caller named, cherry-picks the fix onto
//     hotfix/<release tag>, and pushes the branch (cutHotfix).
//   - build-candidate.yml refuses to build a hotfix/* branch unless it is one
//     this pipeline could have cut, for the release production runs now
//     (verifyHotfixRef). It is defense in depth for the hotfix path, not a
//     boundary: anyone with write access on an app repo can already build an
//     image from a workflow of their own on any branch, because the build
//     identity trusts every ref of the repo. What it stops is the pipeline's
//     own hotfix path building anything but a live release plus reviewed
//     fixes, by mistake or by a hand-pushed branch.
//   - promote.yml tells a hotfix promote from an ordinary one, so the release
//     event says which it was, and refuses a hotfix candidate that is not for
//     the release production runs now (hotfixPromoteCheck).
//   - deploy-candidate.yml asks the same question as promote, only to say in
//     its Slack message that a candidate is a hotfix and which fixes it adds
//     (candidateKind). It never stops a deploy.
//
// What a valid hotfix branch is, in one rule: it is named
// hotfix/<release tag>, it starts at the commit production ran for that
// release (from the deployment ledger, never from a git tag, which anyone
// with push access can create), and every commit after that one is a clean
// cherry-pick of a single-parent commit on the default branch's first-parent
// history that is not in the release already and changes no workflow file.
// "Clean cherry-pick" is checked on content, not on the "(cherry picked from
// commit X)" line, which is only text: applying X's change to the commit's
// parent must give exactly the commit's tree. That is the same three-way
// merge `git cherry-pick` does, so a cherry-pick that applied cleanly always
// passes, even when the code around the change differs between the default
// branch and the release. A patch-id comparison would refuse those, because a
// patch-id covers the context lines too, and it would not see a changed
// binary file or file mode at all. The merge reads .gitattributes from the
// commit being picked onto, never from the checkout, so the cut and the
// build-candidate check always agree.
//
// "On the default branch" means on its first-parent history: a commit the
// default branch itself was at, after a pull request merged. A commit inside
// a pull request that was merged with a merge commit is reachable from the
// default branch too, but the default branch never had the state it makes
// (a "wip" commit later fixed by "tidy", say), so it is refused. A rebase
// merge puts each of a pull request's commits on the first-parent history, so
// an intermediate commit of a rebase-merged pull request still passes; v2 app
// repos merge with squash only, which is what makes the rule exact.
//
// A merge commit is refused as the fix. Picking it with -m 1 is only right
// when the first parent is the default branch's previous tip, and picking some
// of the commits it brought in ships a state nobody reviewed. A hotfix takes
// the pull request's squash commit.
//
// A fix that changes a file under .github/workflows is refused before any
// push. Pushing one needs the token's workflow scope, and the token is a
// person's, able to write to every app repo; workflow changes are a person's
// to ship by hand.

export const LEDGER_URL = 'https://deploys.cru.org/deployments'
export const PIPELINE_WORKFLOW = 'pipeline-v2.yml'
export const PIPELINE_PATH = `.github/workflows/${PIPELINE_WORKFLOW}`
export const BRANCH_PREFIX = 'hotfix/'
export const WORKFLOWS_DIR = '.github/workflows/'

// How long promote's hotfix check may spend asking GitHub, in all. It runs
// inside the production lock, so it must not hold it for long; past this it
// gives up and the promote goes on as an ordinary one.
export const PROMOTE_CHECK_DEADLINE_MS = 30000

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
  ledgerUnavailable: 'ledger_unavailable',
  productionMoved: 'production_moved',
  releaseCommitUnknown: 'release_commit_unknown',
  notOnDefaultBranch: 'not_on_default_branch',
  mergeCommit: 'merge_commit',
  alreadyInRelease: 'already_in_release',
  workflowChange: 'workflow_change',
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

// What production runs now: the newest production row's Revision and Sha, as
// promote's stale-promote guard reads it. Promote and rollback both write a
// row with the release's Revision and the commit its image was built from.
// Fails closed. A ledger that cannot be read is ledger_unavailable ("try
// again later"); a ledger that answers but cannot say what production runs is
// production_moved. `unconfirmed` finishes the sentence of either refusal.
export async function currentProduction ({ readLedger, project, unconfirmed, ledgerOptions = {} }) {
  let items
  try {
    items = await readLedger({ project, limit: 1, ...ledgerOptions })
  } catch (error) {
    throw new HotfixRefusal(REASONS.ledgerUnavailable, `could not read the deployment ledger for ${project} (${error.message}), so ${unconfirmed}`)
  }
  if (items.length === 0) {
    throw new HotfixRefusal(REASONS.productionMoved, `the deployment ledger has no production rows for ${project}, so ${unconfirmed}`)
  }
  const revision = typeof items[0]?.Revision === 'string' ? items[0].Revision : ''
  if (!revision) {
    throw new HotfixRefusal(REASONS.productionMoved, `the newest production row in the deployment ledger for ${project} has no Revision, so ${unconfirmed}`)
  }
  return { revision, sha: rowSha(items[0]) }
}

// Production must still be running `expected`. Fails closed: no answer is a
// refusal, not a pass. Returns the release and its commit.
export async function confirmLiveRelease ({ readLedger, project, expected, when = 'refusing to cut a hotfix' }) {
  const unconfirmed = `cannot confirm production is still running ${expected}; ${when}. Nothing was pushed`
  const { revision: current, sha } = await currentProduction({ readLedger, project, unconfirmed })
  if (normalizeRelease(current) !== expected) {
    const bare = expected.slice('release-'.length)
    if (/^[0-9]+$/.test(bare) && current.endsWith(`-${bare}`)) {
      throw new HotfixRefusal(REASONS.productionMoved, `expected-release '${expected}' is a bare build number, but production's release tag is dated (${current}); pass the full tag. ${capitalize(when)}. Nothing was pushed`)
    }
    throw new HotfixRefusal(REASONS.productionMoved, `production is now running ${current}, not ${expected}, so this hotfix was asked for against a release that is no longer live; ${when}. Nothing was pushed. Start a new hotfix for ${current} if the fix is still needed`)
  }
  return { release: expected, sha }
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1)

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

// git reads .gitattributes (merge drivers among them) from the checkout
// unless told otherwise, and the checkout is whatever commit the job checked
// out: the branch head in build-candidate, the default branch in the hotfix
// run. Pinning the attributes to the commit being picked onto makes the cut's
// pre-check, its cherry-pick and build-candidate's check all merge the same
// way. --attr-source needs git 2.40, the same as merge-tree --merge-base. The
// newer attr.tree setting is not used as a fallback: a git too old for
// --attr-source ignores an unknown setting silently, which would leave the
// attributes unpinned without saying so.
export const attrSource = (onto) => `--attr-source=${onto}`

function refuseOldGit (result, what) {
  if (result.code === 129 || /unknown option/i.test(result.stderr)) {
    throw new Error(`${what} needs git 2.40 or later (for --attr-source and merge-tree --merge-base), and this runner's git refused the command (${result.stderr.trim().split('\n')[0]}); refusing rather than checking with the checkout's .gitattributes`)
  }
}

// The tree `git cherry-pick` would make by applying `commit` (whose parent is
// `parent`) onto `onto`: a three-way merge with the commit's parent as the
// base, using `onto`'s .gitattributes. Nothing in the working tree or the
// index changes. `clean` is false when the merge has conflicts, and
// `conflicts` lists the files.
export async function pickTree (git, { parent, commit, onto }) {
  const result = await git([attrSource(onto), 'merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${parent}`, onto, commit])
  const lines = result.stdout.split('\n').filter(Boolean)
  if (result.code === 0) return { clean: true, tree: lines[0] ?? '', conflicts: [] }
  if (result.code === 1) return { clean: false, tree: lines[0] ?? '', conflicts: lines.slice(1) }
  refuseOldGit(result, 'checking a cherry-pick')
  must(result, `applying ${short(commit)} to ${short(onto)} (git merge-tree)`)
}

// The commits the default branch itself has been at: its first-parent
// history (see the note at the top of the file).
async function firstParentHistory (git, ref) {
  const result = must(await git(['rev-list', '--first-parent', ref]), `listing ${ref}'s first-parent history`)
  return new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
}

// The workflow files a single-parent commit changes, against its parent. -z
// keeps every path raw: a quoted path would not start with the directory.
async function workflowFilesChanged (git, sha, parent) {
  const result = must(await git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--no-commit-id', parent, sha]), `listing the files ${short(sha)} changes`)
  return result.stdout.split('\0').filter((file) => file.startsWith(WORKFLOWS_DIR))
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
// single-parent commit on the default branch's first-parent history, not
// already in `base`, and changing no workflow file (see the note at the top
// of the file). Returns [{ sha, source }], oldest first. Throws a
// HotfixRefusal naming the first commit that is not: already_in_release or
// workflow_change for those two, branch_not_clean for the rest.
export async function verifyHotfixCommits ({ git, base, head, defaultRef }) {
  const refuse = (message, reason = REASONS.branchNotClean) => { throw new HotfixRefusal(reason, message) }
  if (!(await isAncestor(git, base, head))) {
    refuse(`it does not start at ${short(base)}, the commit of the release it is named after`)
  }
  let mainline = null
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
    if (!mainline) mainline = await firstParentHistory(git, defaultRef)
    if (!mainline.has(source)) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which is not on the default branch's first-parent history`)
    }
    if (await isAncestor(git, source, base)) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which is already in the release the branch starts at`, REASONS.alreadyInRelease)
    }
    const sourceParents = await parentsOf(git, source)
    if (sourceParents.length !== 1) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which is ${sourceParents.length ? 'a merge commit' : 'a root commit'}`)
    }
    const workflows = await workflowFilesChanged(git, source, sourceParents[0])
    if (workflows.length > 0) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, which changes ${workflows.join(', ')}; a hotfix never changes a workflow file`, REASONS.workflowChange)
    }
    // A commit that changes nothing ships nothing new. The cut never makes
    // one (it refuses a pick that changes nothing), and the tree check below
    // would pass it when the source's change is already in the code.
    const tree = await treeOf(git, sha)
    if (tree === await treeOf(git, parents[0])) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, but it changes nothing: that change is already in the code it was picked onto`, REASONS.alreadyInRelease)
    }
    const pick = await pickTree(git, { parent: sourceParents[0], commit: source, onto: parents[0] })
    if (!pick.clean || pick.tree !== tree) {
      refuse(`${short(sha)} says it was cherry-picked from ${short(source)}, but its change is not exactly ${short(source)}'s change`)
    }
    verified.push({ sha, source })
  }
  return verified
}

// What build-candidate's guard checks for a build on a hotfix ref (see the
// note at the top of the file). `sha` is the commit the build would build.
// The branch must be for the release production runs NOW, not just one it
// ran once: a hotfix of an older release would take production backwards
// when promoted, and promote's rollback-safety check would not see it (its
// diff starts at the merge base, the old release). And it must hold at least
// one fix: a branch at the release itself would only deploy that release
// again, around rollback's checks. Returns { release, base, commits }, or
// throws a HotfixRefusal saying why the ref is not a hotfix branch this
// pipeline can build.
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
  const live = await currentProduction({ readLedger, project, unconfirmed: `${release}, the release this branch is named after, cannot be confirmed as the one production runs` })
  if (normalizeRelease(live.revision) !== release) {
    throw new HotfixRefusal(REASONS.productionMoved, `production now runs ${live.revision}, not ${release}, the release this branch is named after. A hotfix builds only for the release production runs now, or promoting it would take production backwards; cut a new hotfix for ${live.revision}`)
  }
  if (!live.sha) {
    throw new HotfixRefusal(REASONS.releaseCommitUnknown, `the deployment ledger names no commit for ${release}, the release production runs, so the branch's start cannot be checked`)
  }
  const base = live.sha
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
  if (commits.length === 0) {
    throw new HotfixRefusal(REASONS.alreadyInRelease, `it holds no fix: it is ${release} itself, which production already runs. To deploy a release again, use rollback`)
  }
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
  // The same attributes pickTree used, so the pick merges the way the check did.
  const result = await git([attrSource(onto), 'cherry-pick', '-x', commit], { env })
  if (result.code !== 0) {
    await git(['cherry-pick', '--abort'])
    refuseOldGit(result, 'cherry-picking the fix')
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
  // The token is the one thing the app repo can say no to here, and git's
  // own message does not say which permission is missing. (A fix that changes
  // a workflow file never gets this far: the cut refuses it.)
  if (/permission .* denied|error: 403|returned error: 403|not allowed to push|protected branch|rule violations?/i.test(output)) {
    throw new Error(`the app repo refused the push of ${branch} (${output.trim().split('\n').slice(-2).join(' ')}). authz-token needs contents: write on the app repo, and no ruleset may block creating or updating hotfix/* branches. Nothing was pushed`)
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
  if (!(await firstParentHistory(git, defaultRef)).has(fix)) {
    throw new HotfixRefusal(REASONS.notOnDefaultBranch, `commit ${short(fix)} is on ${defaultBranch} only inside a pull request that was merged with a merge commit, so ${defaultBranch} never had exactly the code it makes. Hotfix the pull request's squash commit instead; refusing to cut a hotfix. Nothing was pushed`)
  }
  const fixParents = await parentsOf(git, fix)
  if (fixParents.length > 1) {
    throw new HotfixRefusal(REASONS.mergeCommit, `commit ${short(fix)} is a merge commit. A hotfix needs the pull request's squash commit: picking a merge, or some of the commits it brought in, would ship code nobody reviewed as a whole. Merge the fix with squash (the repo's squash-only merge setting does this), then hotfix that commit; refusing to cut a hotfix. Nothing was pushed`)
  }
  if (fixParents.length === 0) {
    throw new HotfixRefusal(REASONS.invalidInput, `commit ${short(fix)} is the repository's first commit, so it is not a fix to cherry-pick; refusing to cut a hotfix. Nothing was pushed`)
  }
  const workflows = await workflowFilesChanged(git, fix, fixParents[0])
  if (workflows.length > 0) {
    throw new HotfixRefusal(REASONS.workflowChange, `commit ${short(fix)} changes ${workflows.join(', ')}. A hotfix never changes a workflow file: pushing one needs more access than this workflow's token should have, so a person ships it by hand; refusing to cut a hotfix. Nothing was pushed`)
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

// One overall deadline for a series of requests. Each request gets what is
// left of it (at most `timeoutMs`), and a request started after it throws, so
// the series as a whole cannot outlast the deadline by more than a moment.
export function deadlineRequests ({ deadlineMs = PROMOTE_CHECK_DEADLINE_MS, timeoutMs = 10000, now = Date.now } = {}) {
  const end = now() + deadlineMs
  return () => {
    const left = end - now()
    if (left <= 0) throw new Error(`gave up after ${deadlineMs / 1000} seconds`)
    return { signal: AbortSignal.timeout(Math.min(timeoutMs, left)) }
  }
}

// Is `sha` reachable from `tip`? The compare API's status says so: "behind"
// means `sha` is an ancestor of `tip`, "identical" that it is `tip`.
async function contains (octokit, { owner, repo, tip, sha, request }) {
  if (tip === sha) return true
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${tip}...${sha}`, per_page: 1, request: request() })
  return data?.status === 'behind' || data?.status === 'identical'
}

// Was the promoted commit built from a hotfix branch? It was when the commit
// is not on the app repo's default branch but is on a hotfix/<release tag>
// branch. When the commit is on more than one hotfix branch, the newest-named
// one wins. A commit on neither is labeled an ordinary deploy, and offBranch
// says so: build-candidate builds only those two kinds of ref, so such a
// commit is most likely a hotfix whose branch was deleted after the build.
// Every request shares one deadline (`request`, from deadlineRequests).
// Returns { kind: 'hotfix' | 'deploy', why, branch, release, offBranch }.
// Throws on an API error or the deadline; the caller treats that as a
// deploy.
export async function releaseKind ({ octokit, repository, sha, request = deadlineRequests() }) {
  const commit = String(sha ?? '').trim()
  if (!FULL_SHA.test(commit)) {
    return { kind: 'deploy', why: 'the promoted image names no commit, so it cannot be a hotfix build' }
  }
  const { owner, repo } = parseRepo(repository)
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
    .filter((ref) => ref?.object?.type === 'commit' && releaseFromRef(ref.ref))
    .sort((a, b) => b.ref.localeCompare(a.ref))
    .slice(0, NEWEST_HOTFIX_BRANCHES)
  for (const ref of branches) {
    if (await contains(octokit, { owner, repo, tip: ref.object.sha, sha: commit, request })) {
      const name = ref.ref.replace(/^refs\/heads\//, '')
      return { kind: 'hotfix', why: `${short(commit)} is on ${name}, not on ${defaultBranch}`, branch: name, release: releaseFromRef(ref.ref) }
    }
  }
  return { kind: 'deploy', why: `${short(commit)} is not on ${defaultBranch} or on any hotfix branch`, offBranch: true }
}

// promote's hotfix check, made before anything in production changes. A
// hotfix candidate is promoted only while it is for the release production
// runs now, or while it moves production forward from there.
//
// Why promote checks this at all: a hotfix of release A that is built, then
// sits on release-candidate while release B is promoted, would take
// production from B back to A plus the fix. The rollback-safety classifier
// would not catch it, since it diffs from the merge base (A) and sees only
// the fix, so a migration in B would go unnoticed. build-candidate already
// refuses to build a hotfix of a release production no longer runs; this
// stops one built before production moved.
//
// The same forward check runs for a commit that is on neither the default
// branch nor any hotfix branch: that is a hotfix whose branch was deleted
// after the build, as far as the pipeline can tell. What this cannot see is a
// hotfix branch merged back into the default branch with a merge commit: its
// commits are then on the default branch, so they are labeled deploy and not
// checked.
//
// Returns { kind, why, branch, release, check, checkWhy, warning }. check is:
//   live                the commit is for the release production runs, or
//                       production already runs it, or it builds on what
//                       production runs (production moves forward);
//   stale               it does not build on what production runs; the
//                       promote must stop (stale_hotfix);
//   unconfirmed         a confirmed hotfix whose forward check GitHub could
//                       not answer, or whose live release the ledger names no
//                       commit for; the promote must stop (stale_hotfix);
//   ledger_unavailable  the deployment ledger could not be read, so what
//                       production runs is unknown; the promote must stop;
//   skipped             an ordinary promote, or GitHub could not tell
//                       whether it is a hotfix in time. The promote goes on
//                       exactly as it would have before this check.
// `warning` is set when GitHub did not answer something. Never throws.
//
// The forward-check compare gets its own timeout rather than what is left of
// the shared deadline. The ledger read before it can take most of that
// deadline, and a compare that then gave up must not let a confirmed hotfix
// through.
export async function hotfixPromoteCheck ({ octokit, repository, sha, project, readLedger, request = deadlineRequests(), compareTimeoutMs = 10000 }) {
  let kind
  try {
    kind = await releaseKind({ octokit, repository, sha, request })
  } catch (error) {
    const why = `could not tell whether this promote is a hotfix (${error.message})`
    return { kind: 'deploy', why, check: 'skipped', checkWhy: 'GitHub did not answer, so this promote is treated as an ordinary one', warning: `${why}, so it goes on as an ordinary promote` }
  }
  if (kind.kind !== 'hotfix' && !kind.offBranch) return { ...kind, check: 'skipped', checkWhy: 'not a hotfix' }

  const commit = String(sha).trim()
  const what = promotedCommit(kind, commit)

  let live
  try {
    live = await currentProduction({ readLedger, project, unconfirmed: 'what production runs is unknown', ledgerOptions: { attempts: 2, timeoutMs: 10000 } })
  } catch (error) {
    if (error instanceof HotfixRefusal && error.reason === REASONS.ledgerUnavailable) {
      return { ...kind, check: 'ledger_unavailable', checkWhy: `${what}, but ${error.message}; ${PROMOTE_REFUSAL}. Try again once the deployment ledger answers` }
    }
    return { ...kind, check: 'unconfirmed', checkWhy: `${what}, but ${error.message}; ${PROMOTE_REFUSAL}` }
  }
  const compareRequest = () => ({ signal: AbortSignal.timeout(compareTimeoutMs) })
  return { ...kind, ...(await forwardCheck({ octokit, repository, commit, kind, live, compareRequest })) }
}

const PROMOTE_REFUSAL = 'refusing to promote it. Nothing in production was changed'

// What promote's refusals say the promoted commit is.
function promotedCommit (kind, commit) {
  return kind.kind === 'hotfix'
    ? `${short(commit)} is a hotfix for ${kind.release} (from ${kind.branch})`
    : `${short(commit)} is not on the default branch or on any hotfix branch (its hotfix branch may have been deleted)`
}

// The rest of promote's hotfix check, once the ledger has said what
// production runs (`live`): is `commit` for that release, or does it move
// production forward from it? deploy-candidate's label asks the same thing,
// so its stage message can say when promote would refuse the hotfix. One
// copy keeps the two from ever disagreeing. `compareRequest` gives the
// compare its signal: its own timeout in promote (see hotfixPromoteCheck),
// the label's deadline in deploy-candidate. Returns { check, checkWhy,
// warning }, check being live, stale, unconfirmed or skipped (see
// hotfixPromoteCheck). Never throws.
export async function forwardCheck ({ octokit, repository, commit, kind, live, compareRequest }) {
  const hotfix = kind.kind === 'hotfix'
  const what = promotedCommit(kind, commit)
  if (hotfix && normalizeRelease(live.revision) === kind.release) {
    return { check: 'live', checkWhy: `${short(commit)} is a hotfix for ${kind.release}, the release production runs` }
  }
  if (live.sha === commit) {
    return { check: 'live', checkWhy: `production already runs ${short(commit)}` }
  }
  if (!live.sha) {
    return { check: 'unconfirmed', checkWhy: `${what}, but the deployment ledger names no commit for ${live.revision}, the release production runs, so it cannot be checked that this moves production forward; ${PROMOTE_REFUSAL}` }
  }

  let status
  try {
    const { owner, repo } = parseRepo(repository)
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${live.sha}...${commit}`, per_page: 1, request: compareRequest() })
    status = data?.status
  } catch (error) {
    const unanswered = `GitHub did not answer whether ${short(commit)} builds on ${live.revision}, the release production runs (${error.message})`
    if (hotfix) {
      return { check: 'unconfirmed', checkWhy: `${what}, but ${unanswered}; ${PROMOTE_REFUSAL}. Try again`, warning: unanswered }
    }
    return { check: 'skipped', checkWhy: `${unanswered}, so the check is skipped`, warning: `${unanswered}, so this promote goes on without the check` }
  }
  if (status === 'ahead' || status === 'identical') {
    return { check: 'live', checkWhy: `${short(commit)} builds on ${live.revision}, the release production runs, so promoting it moves production forward` }
  }
  return {
    check: 'stale',
    checkWhy: `${what}, but production now runs ${live.revision}, which it does not build on. Promoting it would take production backwards, and the rollback-safety check would not see what that undoes; ${PROMOTE_REFUSAL}. Cut a new hotfix against ${live.revision}, the release production runs now`
  }
}

// --- deploy-candidate's Slack label ------------------------------------------

// How long deploy-candidate's hotfix label may spend asking GitHub, in all.
// The label only changes a Slack message, so it gives up fast, and the
// message is then the ordinary one. The ledger read has its own, shorter
// limit (CANDIDATE_LEDGER_TIMEOUT_MS), so the whole check stays under half a
// minute.
export const CANDIDATE_LABEL_DEADLINE_MS = 20000
export const CANDIDATE_LEDGER_TIMEOUT_MS = 5000

// The stage message names at most this many fixes, then says how many more.
export const LISTED_FIXES = 3
const SUBJECT_LENGTH = 100

// Slack reads &, < and > as markup: <url|text> is a link, <@U123> a mention
// and <!channel> calls everyone in the channel. A commit subject is text that
// anyone who can merge to the app repo wrote, so all three are always escaped.
// That leaves nothing in a subject that can start a link or a mention.
export const escapeMrkdwn = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Characters a subject could use to look like more than one line (the
// control characters, U+0085, U+2028 and U+2029) or to show its text in an
// order other than the one it is in (the bidi controls). Each becomes a
// space, so what a reader sees is what the commit says. Matching control
// characters is the point here, so the lint rule against it is off.
// eslint-disable-next-line no-control-regex
const MISLEADING = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

// A commit message's first line, trimmed and cut to a length that keeps the
// message short. Cut before escaping, so an escape is never cut in half, and
// by code points, so an emoji at the cut is never left in half either.
export function commitSubject (message) {
  const subject = String(message ?? '').split(/\r?\n|\r/)[0].replace(MISLEADING, ' ').trim()
  if (!subject) return '(no commit message)'
  const chars = Array.from(subject)
  return chars.length > SUBJECT_LENGTH ? `${chars.slice(0, SUBJECT_LENGTH - 3).join('').trimEnd()}...` : subject
}

// "The live release plus 2 fixes: A; B", naming at most LISTED_FIXES
// subjects and then "and N more". `count` is how many fixes there are, which
// can be more than the subjects GitHub sent. Escaped for Slack mrkdwn. ''
// when there is no fix to name.
export function fixesLine (subjects, count = subjects.length) {
  if (!Number.isInteger(count) || count < 1) return ''
  const listed = subjects.slice(0, Math.min(LISTED_FIXES, count)).map((subject) => escapeMrkdwn(commitSubject(subject)))
  if (listed.length === 0) return ''
  const more = count - listed.length
  return `The live release plus ${count} ${count === 1 ? 'fix' : 'fixes'}: ${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

// deploy-candidate's label for its Slack message: is this candidate a hotfix,
// which fixes does it add to the live release, and would promote take it?
// Whether it is a hotfix is releaseKind's answer, and whether promote would
// take it is forwardCheck's: the same answers promote gets. Throws when
// GitHub cannot tell in time whether it is a hotfix; the caller then posts
// the ordinary message.
//
// `promotable` is yes when promote's check would pass, and no when promote
// would refuse it whatever happens before the promote: production has moved
// to another release that this hotfix does not build on, or that the ledger
// names no commit for. It is unknown when the reason could clear by then:
// the ledger did not answer, GitHub did not answer the compare, or the
// deadline ran out. Only no changes the message, so anything unsure keeps
// the usual request to promote. '' when it is not a hotfix.
//
// The fixes are the commits between the commit production runs (from the
// deployment ledger, the same place build-candidate checked the branch
// against) and the candidate. They are listed only while production still
// runs the release the hotfix is for. When it does not, or anything after the
// hotfix is confirmed fails, `fixes` is '' and the message still says hotfix,
// without the list. The default branch is not a stand-in for the base: when
// production runs an earlier hotfix, the default branch would count that
// hotfix's fixes as new ones too.
//
// Returns { kind, why, branch, release, fixes, fixesWhy, promotable,
// promotableWhy, productionRelease }. productionRelease is the release the
// ledger says production runs, '' when the ledger was not read.
export async function candidateKind ({ octokit, repository, sha, project, readLedger, request = deadlineRequests({ deadlineMs: CANDIDATE_LABEL_DEADLINE_MS }), ledgerTimeoutMs = CANDIDATE_LEDGER_TIMEOUT_MS }) {
  const notHotfix = { fixes: '', fixesWhy: 'not a hotfix', promotable: '', promotableWhy: 'not a hotfix', productionRelease: '' }
  const commit = String(sha ?? '').trim()
  if (!FULL_SHA.test(commit)) {
    return { kind: 'deploy', why: 'the candidate image has no sha- tag naming its commit, so it cannot be a hotfix build', ...notHotfix }
  }
  const kind = await releaseKind({ octokit, repository, sha: commit, request })
  if (kind.kind !== 'hotfix') return { ...kind, ...notHotfix }
  let live
  try {
    live = await currentProduction({ readLedger, project, unconfirmed: 'the fixes cannot be listed', ledgerOptions: { attempts: 1, timeoutMs: ledgerTimeoutMs } })
  } catch (error) {
    return { ...kind, fixes: '', fixesWhy: error.message, promotable: 'unknown', promotableWhy: error.message, productionRelease: '' }
  }
  // The same deadline as the rest of the label, not promote's own compare
  // timeout: a label that does not finish in time only keeps the usual line.
  const forward = await forwardCheck({ octokit, repository, commit, kind, live, compareRequest: request })
  // forwardCheck says unconfirmed for two reasons. With no commit in the
  // ledger for the release production runs (never this hotfix's own release,
  // which forwardCheck passes first), promote refuses it every time, so that
  // is no. A compare GitHub did not answer may work at promote time, so that
  // stays unknown.
  const certain = forward.check === 'stale' || (forward.check === 'unconfirmed' && !live.sha)
  const promotable = forward.check === 'live' ? 'yes' : certain ? 'no' : 'unknown'
  const label = { ...kind, promotable, promotableWhy: forward.checkWhy, productionRelease: live.revision }
  if (normalizeRelease(live.revision) !== kind.release) {
    return { ...label, fixes: '', fixesWhy: `production now runs ${live.revision}, not ${kind.release}, so the fixes are not listed` }
  }
  if (!live.sha) {
    return { ...label, fixes: '', fixesWhy: `the deployment ledger names no commit for ${live.revision}, so the fixes cannot be listed` }
  }
  try {
    const { owner, repo } = parseRepo(repository)
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${live.sha}...${commit}`, per_page: 100, request: request() })
    if (data?.status !== 'ahead') {
      return { ...label, fixes: '', fixesWhy: `${short(commit)} does not build on ${short(live.sha)}, the commit production runs (GitHub says ${data?.status}), so the fixes are not listed` }
    }
    const commits = Array.isArray(data.commits) ? data.commits : []
    const count = Number.isInteger(data.total_commits) ? data.total_commits : commits.length
    const fixes = fixesLine(commits.map((entry) => entry?.commit?.message), count)
    return { ...label, fixes, fixesWhy: fixes ? `${count} commit(s) after ${short(live.sha)}` : 'GitHub listed no commits' }
  } catch (error) {
    return { ...label, fixes: '', fixesWhy: `GitHub did not list the commits after ${short(live.sha)} (${error.message})` }
  }
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
