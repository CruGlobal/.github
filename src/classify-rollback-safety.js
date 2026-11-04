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

// Promote runs this inside the production lock, so a GitHub API that never
// answers must not hold that lock, and every other promote and rollback of
// the app, until the job's time limit. Each read gets REQUEST_TIMEOUT_MS to
// answer, body included, and all of them together get DEADLINE_MS. Running
// out of time is an error like any other: the verdict is unclassified, which
// refuses the promote only when the app set require-rollback-safe. The step's
// own limit in promote.yml is a backstop past DEADLINE_MS.
export const REQUEST_TIMEOUT_MS = 20 * 1000
export const DEADLINE_MS = 90 * 1000

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
// a person needs to know: the classifier gave up, not one slow API.
async function githubGet ({ url, accept, token, limits, api, subject, read }) {
  const { request, deadlineMs } = limits
  const outOfTime = (when) => `the GitHub reads ran out of their ${deadlineMs / 1000} seconds ${when} the ${api} read ${subject}`
  let signal
  try {
    ({ signal } = request())
  } catch (error) {
    throw new Error(outOfTime('before'), { cause: error })
  }
  try {
    const res = await fetch(url, { headers: ghHeaders(token, accept), signal })
    if (!res.ok) throw new Error(`${api} ${res.status} ${subject}`)
    return await read(res)
  } catch (error) {
    if (!timedOut(error)) throw error
    if (request.expired()) throw new Error(outOfTime('during'), { cause: error })
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

// Normalise a migrations path to a directory prefix ("drizzle" -> "drizzle/").
function pathPrefix (migrationsPath) {
  return migrationsPath.replace(/^\.\//, '').replace(/\/+$/, '') + '/'
}

async function classify ({ token, repository, baseSha, headSha, migrationsPath, limits }) {
  const compare = await fetchCompare(repository, baseSha, headSha, token, limits)
  const files = compare.files ?? []

  const truncated = files.length >= COMPARE_FILE_CAP
  const prefix = pathPrefix(migrationsPath)
  const inPath = files.filter((f) => (f.filename ?? '').startsWith(prefix))

  const enriched = []
  for (const f of inPath) {
    const path = f.filename
    const status = f.status
    // Only added files in a classifiable format (.sql, or a Rails .rb migration)
    // need their full content fetched for statement-level classification;
    // everything else is decided from path + status alone.
    let content
    if (status === 'added' && /\.(sql|rb)$/i.test(path) && !/(^|\/)meta\//.test(path)) {
      content = await fetchContent(repository, path, headSha, token, limits)
    }
    enriched.push({ path, status, content })
  }

  const { verdict, reasons } = classifyMigrationFiles(enriched)
  if (truncated) {
    // Keep only unsafe findings: a safe verdict's explanatory reason ("no
    // migration changes...") would contradict the unsafe verdict this returns.
    return { verdict: 'unsafe', reasons: ['diff truncated at 300 files — classify manually', ...(verdict === 'unsafe' ? reasons : [])] }
  }
  return { verdict, reasons }
}

function finish (verdict, reasons) {
  core.setOutput('verdict', verdict)
  core.setOutput('reasons', JSON.stringify(reasons))
  const summary = reasons.length > 0
    ? `rollback safety: ${verdict} — ${reasons.slice(0, 2).join('; ')}`
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
