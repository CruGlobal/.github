import * as core from '@actions/core'
import { classifyMigrationFiles } from './v2/rollback-safety'

// classify-rollback-safety: advisory EXPAND/CONTRACT classification of the SQL
// migrations added between the release currently in production (base-sha) and
// the promoted candidate (head-sha).
//
// ADVISORY ONLY. This action NEVER fails the caller — every path, including
// every error, resolves to a `verdict` output of safe | unsafe | unclassified
// and exits successfully. The promote workflow records the verdict in the
// deployments ledger + Slack; rollback reads it back as a warning.

const GITHUB_API = 'https://api.github.com'
// The GitHub compare API returns at most 300 files; beyond that the migration
// set can't be trusted to be complete.
const COMPARE_FILE_CAP = 300

function ghHeaders (token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cru-pipeline-v2'
  }
}

async function fetchCompare (repository, baseSha, headSha, token) {
  const url = `${GITHUB_API}/repos/${repository}/compare/${baseSha}...${headSha}`
  const res = await fetch(url, { headers: ghHeaders(token, 'application/vnd.github+json') })
  if (!res.ok) throw new Error(`compare API ${res.status} for ${repository} ${baseSha}...${headSha}`)
  return res.json()
}

async function fetchContent (repository, path, ref, token) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const url = `${GITHUB_API}/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`
  // The raw media type returns the file body verbatim (the compare `patch` is
  // not reliable for full content).
  const res = await fetch(url, { headers: ghHeaders(token, 'application/vnd.github.raw+json') })
  if (!res.ok) throw new Error(`contents API ${res.status} for ${path}`)
  return res.text()
}

// Normalise a migrations path to a directory prefix ("drizzle" -> "drizzle/").
function pathPrefix (migrationsPath) {
  return migrationsPath.replace(/^\.\//, '').replace(/\/+$/, '') + '/'
}

async function classify ({ token, repository, baseSha, headSha, migrationsPath }) {
  const compare = await fetchCompare(repository, baseSha, headSha, token)
  const files = compare.files ?? []

  const truncated = files.length >= COMPARE_FILE_CAP
  const prefix = pathPrefix(migrationsPath)
  const inPath = files.filter((f) => (f.filename ?? '').startsWith(prefix))

  const enriched = []
  for (const f of inPath) {
    const path = f.filename
    const status = f.status
    // Only added .sql files need their full content fetched for statement-level
    // classification; everything else is decided from path + status alone.
    let content
    if (status === 'added' && /\.sql$/i.test(path) && !/(^|\/)meta\//.test(path)) {
      content = await fetchContent(repository, path, headSha, token)
    }
    enriched.push({ path, status, content })
  }

  const { verdict, reasons } = classifyMigrationFiles(enriched)
  if (truncated) {
    return { verdict: 'unsafe', reasons: ['diff truncated at 300 files — classify manually', ...reasons] }
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

export async function run () {
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

    const { verdict, reasons } = await classify({ token, repository, baseSha, headSha, migrationsPath })
    return finish(verdict, reasons)
  } catch (error) {
    // ANY failure (API error, bad shas) is advisory-safe: report unclassified
    // with the error as the reason and exit successfully.
    return finish('unclassified', [error.message])
  }
}

// Auto-run as the action entrypoint, but stay import-safe under test.
if (!process.env.VITEST) run()
