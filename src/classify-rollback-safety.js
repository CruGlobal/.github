import * as core from '@actions/core'
import { classifyMigrationFiles } from './v2/rollback-safety'
import { deadlineRequests } from './v2/deadline'

// classify-rollback-safety: advisory EXPAND/CONTRACT classification of the
// migrations added between the release currently in production (base-sha) and
// the promoted candidate (head-sha). Plain `.sql` and Rails `.rb` migrations are
// classified; anything else is reported as an unsupported format (unsafe).
//
// ADVISORY ONLY. This action NEVER fails the caller — every path, including
// every error, resolves to a `verdict` output of safe | unsafe | unclassified
// and exits successfully. The promote workflow records the verdict in the
// deployments ledger + Slack; rollback reads it back as a warning.

const GITHUB_API = 'https://api.github.com'
// The GitHub compare API returns at most 300 files; beyond that the migration
// set can't be trusted to be complete.
const COMPARE_FILE_CAP = 300
const TRUNCATED_REASON = 'diff truncated at 300 files — classify manually'

// A big release can touch 300 files with only a few additive migrations among
// them. Calling every such release unsafe took away auto-rollback, and
// refused promotes under require-rollback-safe, for no reason in the schema.
// So when the compare is cut off, the migrations directory is compared on its
// own instead: its tree at the merge base and at the candidate, from the git
// trees API, diffed by path and blob. That list is complete however many
// other files the release touched, and it goes through the same classifier as
// the compare's list. If it can't be read for any reason, the answer is the
// one a cut-off diff always got: unsafe.
//
// So that one big release can't spend the token's rate limit, the tree side
// reads at most 300 migration files, on top of any the cut-off compare's own
// list already read, and every read on both sides shares DEADLINE_MS.
const MAX_TREE_FILE_READS = COMPARE_FILE_CAP
const TREES_REASON = 'diff truncated at 300 files, so the migrations directory was compared at both commits instead'

// Promote runs this inside the production lock, so a GitHub API that never
// answers must not hold that lock, and every other promote and rollback of
// the app, until the job's time limit. Each read gets REQUEST_TIMEOUT_MS to
// answer, body included, and all of them together get DEADLINE_MS, the
// directory reads of a cut-off diff included. Running out of time is an error
// like any other: the verdict is unclassified, which refuses the promote only
// when the app set require-rollback-safe. The one exception is the directory
// reads: they only try to improve on the unsafe answer a cut-off diff already
// has, so running out of time there leaves that answer. The step's own limit
// in promote.yml is a backstop past DEADLINE_MS.
export const REQUEST_TIMEOUT_MS = 20 * 1000
export const DEADLINE_MS = 90 * 1000

// Promote hands the reasons output to later steps in environment variables,
// and Linux will not start a process with any one environment string longer
// than 131,072 bytes. A release that changes thousands of migrations, or one
// migration with thousands of destructive statements, has a reason for each,
// and every step given that output would then fail to start, on every retry.
// So the output keeps at most MAX_REASONS reasons: past that, the first
// MAX_REASONS - 1 and one more saying how many were left out. Each is cut to
// MAX_REASON_LENGTH characters. The full list goes to the step log first. The
// workflows show only the first one or two, so classify puts the most useful
// ones first.
//
// That bounds the output at 20 reasons of 500 characters. JSON writes one
// character in at most 6 bytes (a \u escape), so even the worst case is about
// 60 KB, under half the limit. Plain text comes to about 10 KB.
const MAX_REASONS = 20
const MAX_REASON_LENGTH = 500

function ghHeaders (token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cru-pipeline-v2'
  }
}

function timedOut (error) {
  const names = [error?.name, error?.cause?.name]
  return names.includes('TimeoutError') || names.includes('AbortError')
}

// One GET, its body read with `read`, inside the time `limits` leave for it.
// `api` and `subject` make up the error, as in "compare API 404 for ...".
//
// A read that is stopped says which limit stopped it. Near the end, a read
// gets only what is left of the overall deadline, so one that never answers
// can be stopped by the deadline rather than by its own 20 seconds. The
// reason then says the GitHub reads as a whole ran out of time, which is what
// a person needs to know: the classifier gave up, not one slow API. Which
// limit applies is known when the read starts (cutByDeadline), so the wording
// does not depend on reading the clock after the stop.
async function githubGet ({ url, accept, token, limits, api, subject, read }) {
  const { request, deadlineMs } = limits
  const outOfTime = (when) => `the GitHub reads ran out of their ${deadlineMs / 1000} seconds ${when} the ${api} read ${subject}`
  let signal, cutByDeadline
  try {
    ({ signal, cutByDeadline } = request.next())
  } catch (error) {
    throw new Error(outOfTime('before'), { cause: error })
  }
  try {
    const res = await fetch(url, { headers: ghHeaders(token, accept), signal })
    if (!res.ok) throw new Error(`${api} ${res.status} ${subject}`)
    return await read(res)
  } catch (error) {
    if (!timedOut(error)) throw error
    if (cutByDeadline) throw new Error(outOfTime('during'), { cause: error })
    throw new Error(`${api} did not answer in time ${subject}`, { cause: error })
  }
}

async function fetchCompare (repository, baseSha, headSha, token, limits) {
  return githubGet({
    url: `${GITHUB_API}/repos/${repository}/compare/${baseSha}...${headSha}`,
    accept: 'application/vnd.github+json',
    token,
    limits,
    api: 'compare API',
    subject: `for ${repository} ${baseSha}...${headSha}`,
    read: (res) => res.json()
  })
}

async function fetchContent (repository, path, ref, token, limits) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return githubGet({
    url: `${GITHUB_API}/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    // The raw media type returns the file body verbatim (the compare `patch`
    // is not reliable for full content).
    accept: 'application/vnd.github.raw+json',
    token,
    limits,
    api: 'contents API',
    subject: `for ${path}`,
    read: (res) => res.text()
  })
}

// One tree listing. `sha` is a commit (its top-level tree) or a tree.
async function fetchTree (repository, sha, recursive, token, limits, subject) {
  const listing = await githubGet({
    url: `${GITHUB_API}/repos/${repository}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`,
    accept: 'application/vnd.github+json',
    token,
    limits,
    api: 'git trees API',
    subject,
    read: (res) => res.json()
  })
  if (!Array.isArray(listing?.tree)) throw new Error(`git trees API gave no listing ${subject}`)
  // A listing too big for one answer comes back cut short. A file missing
  // from it might be one that was removed, so it can't be diffed.
  if (listing.truncated) throw new Error(`git trees API listing was cut short ${subject}`)
  // An entry with no path, type or sha can't be matched or diffed. Skipping
  // it could hide a file, or the migrations directory itself, from one side
  // of the diff, and what is missing on one side reads as added on the other.
  // So one such entry fails the whole read.
  const wellFormed = (e) => typeof e?.path === 'string' && typeof e?.type === 'string' && typeof e?.sha === 'string'
  if (!listing.tree.every(wellFormed)) throw new Error(`git trees API listed an entry with no path, type or sha ${subject}`)
  return listing.tree
}

// The tree sha of the directory `segments` at `commitSha`. It walks down one
// directory at a time, because the one-read "sha:path" form of the trees API
// is not documented, fails for a full commit sha unless the colon is escaped,
// and answers 404 for any miss, so it can't say what was missing. A commit
// with no such directory is an error, never an empty directory (see
// classifyFromTrees), so this always returns a real tree sha.
async function dirTree (repository, commitSha, segments, token, limits) {
  let sha = commitSha
  for (const [i, name] of segments.entries()) {
    const parent = segments.slice(0, i).join('/') || 'the top level'
    const entries = await fetchTree(repository, sha, false, token, limits, `for ${parent} at ${commitSha}`)
    const entry = entries.find((e) => e.path === name)
    if (!entry) throw new Error(`there is no ${segments.join('/')} directory at ${commitSha}`)
    if (entry.type !== 'tree') throw new Error(`${segments.slice(0, i + 1).join('/')} is not a directory at ${commitSha}`)
    sha = entry.sha
  }
  return sha
}

// Every file under the directory tree `treeSha`, keyed by its repo-relative
// path (the prefix plus the path inside the tree), so it reads exactly like a
// compare `filename`. The value is mode and blob sha together, so a change of
// either counts as a change, as it does in a compare. Submodules are kept: a
// compare lists them as files too.
async function dirFiles (repository, treeSha, prefix, commitSha, token, limits) {
  const files = new Map()
  const subject = `for ${prefix.slice(0, -1)} at ${commitSha}`
  for (const entry of await fetchTree(repository, treeSha, true, token, limits, subject)) {
    if (entry.type === 'tree') continue
    files.set(prefix + entry.path, `${entry.mode} ${entry.sha}`)
  }
  return files
}

// The changes between two directory listings, in compare terms. A rename
// shows as removed plus added, which the classifier calls unsafe just as it
// does a compare's `renamed`.
function diffDirs (before, after) {
  const changes = []
  for (const [path, id] of after) {
    if (!before.has(path)) changes.push({ path, status: 'added' })
    else if (before.get(path) !== id) changes.push({ path, status: 'modified' })
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, status: 'removed' })
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// Normalise a migrations path to a directory prefix ("drizzle" -> "drizzle/").
function pathPrefix (migrationsPath) {
  return migrationsPath.replace(/^\.\//, '').replace(/\/+$/, '') + '/'
}

// Only added files in a classifiable format (.sql, or a Rails .rb migration)
// need their full content fetched for statement-level classification;
// everything else is decided from path + status alone.
function needsContent ({ path, status }) {
  return status === 'added' && /\.(sql|rb)$/i.test(path) && !/(^|\/)meta\//.test(path)
}

async function classifyChanges (changes, readContent) {
  const enriched = []
  for (const change of changes) {
    const content = needsContent(change) ? await readContent(change.path) : undefined
    enriched.push({ ...change, content })
  }
  return classifyMigrationFiles(enriched)
}

// Classify the migrations directory from its trees, for a compare that was
// cut off. Any error means it could not, and the caller keeps the cut-off
// diff's unsafe answer.
async function classifyFromTrees ({ repository, compare, headSha, prefix, token, limits, readContent, hasContent }) {
  // The compare diffs from the merge base (base...head), so the trees do too.
  // A plain diff from the production sha would call a migration that is only
  // on production's side (a hotfix branch, say) removed, which the compare
  // never shows. With no merge base named there is nothing safe to start from.
  const mergeBase = compare.merge_base_commit?.sha
  if (typeof mergeBase !== 'string' || !mergeBase) throw new Error('the compare named no merge base')

  const dir = prefix.slice(0, -1)
  const segments = dir.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`cannot walk the migrations path ${dir}`)

  // A directory missing at either commit is a release this can't vouch for,
  // so dirTree throws and the answer stays unsafe. Missing at the candidate
  // is a path set wrong, or migrations moved somewhere this isn't looking.
  // Missing at the merge base is an app's first migrations, or a directory
  // moved or renamed into the path, even by case alone. A compare calls the
  // files of a moved directory `renamed`, which is unsafe, and the trees
  // can't tell that apart from first migrations. Unsafe for first migrations
  // in a release of more than 300 files is the answer they always got.
  const beforeTree = await dirTree(repository, mergeBase, segments, token, limits)
  const afterTree = await dirTree(repository, headSha, segments, token, limits)
  // The same tree sha means nothing in the directory changed. Both are real
  // shas: dirTree throws rather than return nothing for a missing directory.
  if (beforeTree === afterTree) return classifyMigrationFiles([])

  const before = await dirFiles(repository, beforeTree, prefix, mergeBase, token, limits)
  const after = await dirFiles(repository, afterTree, prefix, headSha, token, limits)
  const changes = diffDirs(before, after)

  const toRead = changes.filter((c) => needsContent(c) && !hasContent(c.path)).length
  if (toRead > MAX_TREE_FILE_READS) {
    throw new Error(`${toRead} added migration files to read, more than the ${MAX_TREE_FILE_READS} allowed`)
  }
  return classifyChanges(changes, readContent)
}

async function classify ({ token, repository, baseSha, headSha, migrationsPath, limits }) {
  const compare = await fetchCompare(repository, baseSha, headSha, token, limits)
  const files = compare.files ?? []

  const truncated = files.length >= COMPARE_FILE_CAP
  const prefix = pathPrefix(migrationsPath)
  const inPath = files
    .filter((f) => (f.filename ?? '').startsWith(prefix))
    .map((f) => ({ path: f.filename, status: f.status }))

  // Every file is read at head-sha, so a file the compare's list already read
  // is not read again for the trees.
  const contents = new Map()
  const readContent = async (path) => {
    if (!contents.has(path)) contents.set(path, await fetchContent(repository, path, headSha, token, limits))
    return contents.get(path)
  }

  const { verdict, reasons } = await classifyChanges(inPath, readContent)
  if (!truncated) return { verdict, reasons }

  // Keep only unsafe findings: a safe verdict's explanatory reason ("no
  // migration changes...") would contradict an unsafe verdict. The cut-off
  // list is the start of the full one, so each of its findings is one the
  // full compare would make too. They stay even when the trees read well: a
  // file moved in from outside the directory is `renamed` in a compare, which
  // is unsafe, but only `added` in the trees.
  const listedUnsafe = verdict === 'unsafe' ? reasons : []
  let fromTrees
  try {
    fromTrees = await classifyFromTrees({ repository, compare, headSha, prefix, token, limits, readContent, hasContent: (path) => contents.has(path) })
  } catch (error) {
    // Why the directory could not be compared goes right after the cut-off
    // reason, ahead of the findings: the workflows show the first one or two
    // reasons, and the output keeps only the first few (see finish).
    return { verdict: 'unsafe', reasons: [TRUNCATED_REASON, `could not compare the migrations directory instead: ${error.message}`, ...listedUnsafe] }
  }

  const unsafe = [...new Set([...(fromTrees.verdict === 'unsafe' ? fromTrees.reasons : []), ...listedUnsafe])]
  // The safe reason comes first, as the notifier shows the first one.
  if (unsafe.length === 0) return { verdict: 'safe', reasons: [...fromTrees.reasons, TREES_REASON] }
  return { verdict: 'unsafe', reasons: [...unsafe, TREES_REASON] }
}

// One reason cut to MAX_REASON_LENGTH characters. It counts and cuts by code
// point, so a cut never splits a character in two.
function boundReason (reason) {
  const text = String(reason)
  if (text.length <= MAX_REASON_LENGTH) return text
  const chars = Array.from(text)
  if (chars.length <= MAX_REASON_LENGTH) return text
  return chars.slice(0, MAX_REASON_LENGTH - 3).join('') + '...'
}

function boundReasons (reasons) {
  if (reasons.length <= MAX_REASONS) return reasons.map(boundReason)
  const kept = reasons.slice(0, MAX_REASONS - 1).map(boundReason)
  return [...kept, `and ${reasons.length - kept.length} more reasons, listed in this step's log`]
}

function finish (verdict, reasons) {
  // The whole list goes to the log before the output is cut down, one reason
  // a line after a dash: a line break inside a reason would split it, and a
  // line that starts with :: would be read as a workflow command.
  const lines = reasons.map((reason) => `- ${String(reason).replace(/[\r\n]+/g, ' ')}`)
  core.info([`rollback safety reasons (${reasons.length}):`, ...lines].join('\n'))
  const shown = boundReasons(reasons)
  core.setOutput('verdict', verdict)
  core.setOutput('reasons', JSON.stringify(shown))
  const summary = shown.length > 0
    ? `rollback safety: ${verdict} — ${shown.slice(0, 2).join('; ')}`
    : `rollback safety: ${verdict}`
  if (verdict === 'unsafe') core.warning(summary)
  else core.notice(summary)
  return { verdict, reasons }
}

// The limits are options so tests can shorten them and run a clock of their
// own.
export async function run ({ timeoutMs = REQUEST_TIMEOUT_MS, deadlineMs = DEADLINE_MS, now = Date.now } = {}) {
  try {
    const token = core.getInput('github-token')
    const repository = core.getInput('repository')
    const baseSha = core.getInput('base-sha')
    const headSha = core.getInput('head-sha')
    const migrationsPath = core.getInput('migrations-path')
    const migrations = core.getInput('migrations')

    // An explicit `Migrations = "none"` on the app's CruApplicationInfo item is
    // the app's Terraform module declaring it HAS no database migrations —
    // something an absent MigrationsPath cannot express, since that also covers
    // "has migrations we can't see" (migrations enabled with no path). A
    // declared-none app is trivially rollback-safe: there is no schema change
    // for the previous image to break against.
    //
    // Short-circuits BEFORE any baseline/diff work: no compare API call, no
    // contents fetch, and no dependence on a production baseline existing (a
    // migration-less app's FIRST promote is rollback-safe too).
    //
    // PRECEDENCE: a real migrations path wins. The modules make the two
    // attributes mutually exclusive, so they should never both arrive; if they
    // somehow do, classifying the path is the conservative answer — a
    // declaration must never mask migrations we can actually read.
    if (!migrationsPath && migrations.toLowerCase() === 'none') {
      return finish('safe', ['no database migrations'])
    }

    if (!migrationsPath) return finish('unclassified', ['no migrations path configured'])
    if (!baseSha) return finish('unclassified', ['no production baseline'])
    if (!headSha) return finish('unclassified', ['no candidate sha to classify'])

    // One deadline for every GitHub read below.
    const limits = { request: deadlineRequests({ deadlineMs, timeoutMs, now }), deadlineMs }
    const { verdict, reasons } = await classify({ token, repository, baseSha, headSha, migrationsPath, limits })
    return finish(verdict, reasons)
  } catch (error) {
    // ANY failure (API error, bad shas, a read that ran out of time) is
    // advisory-safe: report unclassified with the error as the reason and exit
    // successfully.
    return finish('unclassified', [error.message])
  }
}

// Auto-run as the action entrypoint, but stay import-safe under test.
if (!process.env.VITEST) run()
