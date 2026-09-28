// Check that every action in actions/ can run at this commit: each file an
// action.yml names in runs.main, runs.pre or runs.post must exist.
//
// release-please.yml runs this on the release commit before it moves the
// v<major> and v<major>.<minor> tags. dist/ is committed by build-dist.yml
// after a merge, so a release can land on a commit where a new or changed
// action has no bundle yet (a race with build-dist, or a build that failed or
// did not run). Moving the tags onto that commit would break every caller of
// that action at once. This check stops the tag move instead.
//
// Usage: node .github/scripts/check-action-bundles.mjs [repo root]
// Exits 1 and prints an ::error:: line for each problem.
//
// It reads action.yml without a YAML library, so it runs on a plain `node`
// with no `npm ci`. It only needs the top-level keys of the `runs:` block,
// which in this repo are simple `key: value` lines. Anything it cannot read
// counts as a problem, never as a pass.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENTRY_KEYS = ['main', 'pre', 'post']

function unquote (value) {
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  if (/^".*"$/.test(value)) return value.slice(1, -1)
  return value
}

// The top-level keys of the `runs:` block, as strings. Nested blocks (such as
// a composite action's steps) are skipped.
export function readRuns (text) {
  const runs = {}
  let inRuns = false
  let indent = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue
    const lead = raw.length - raw.trimStart().length
    if (lead === 0) {
      inRuns = /^runs:\s*(#.*)?$/.test(raw)
      indent = null
      continue
    }
    if (!inRuns) continue
    if (indent === null) indent = lead
    if (lead !== indent) continue
    const match = raw.trim().replace(/\s+#.*$/, '').match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) runs[match[1]] = unquote(match[2].trim())
  }
  return runs
}

export function checkActionBundles (root) {
  const actionsDir = path.join(root, 'actions')
  const problems = []
  const checked = []
  const names = existsSync(actionsDir)
    ? readdirSync(actionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : []
  if (names.length === 0) problems.push('no actions found under actions/')

  for (const name of names) {
    const dir = path.join(actionsDir, name)
    const file = ['action.yml', 'action.yaml'].map((f) => path.join(dir, f)).find((f) => existsSync(f))
    if (!file) {
      problems.push(`actions/${name} has no action.yml`)
      continue
    }
    const where = path.relative(root, file)
    const runs = readRuns(readFileSync(file, 'utf8'))
    const using = runs.using ?? ''
    if (!using) {
      problems.push(`${where} has no runs.using that this check can read`)
      continue
    }
    if (/^node[0-9]+$/.test(using) && !runs.main) {
      problems.push(`${where} runs on ${using} but names no runs.main`)
    }
    const targets = ENTRY_KEYS.filter((key) => runs[key]).map((key) => [`runs.${key}`, runs[key]])
    if (using === 'docker' && runs.image && !runs.image.startsWith('docker://')) {
      targets.push(['runs.image', runs.image])
    }
    for (const [key, value] of targets) {
      const target = path.resolve(dir, value)
      const relative = path.relative(root, target)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        problems.push(`${where} ${key} (${value}) points outside the repo`)
      } else if (!existsSync(target) || !statSync(target).isFile()) {
        problems.push(`${where} ${key} (${value}) needs ${relative}, which does not exist at this commit`)
      } else {
        checked.push(`${where} ${key} -> ${relative}`)
      }
    }
  }
  return { checked, problems }
}

function main () {
  const root = path.resolve(process.argv[2] ?? process.cwd())
  const { checked, problems } = checkActionBundles(root)
  for (const line of checked) console.log(`ok: ${line}`)
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`)
    console.log(`::error::${problems.length} action file problem(s); not safe to move the release tags onto this commit`)
    process.exitCode = 1
    return
  }
  console.log(`every action's files exist (${checked.length} checked)`)
}

// Run when called as a script; stay quiet when a test imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
