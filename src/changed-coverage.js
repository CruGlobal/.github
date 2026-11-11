import * as core from '@actions/core'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// changed-coverage: line coverage for the files a pull request changed, read
// from an istanbul json-summary report (jest --coverageReporters=json-summary,
// vitest --coverage.reporter=json-summary). It reports, and fails only when a
// changed file is under min-coverage. The default of 0 never fails, so a repo
// with thin tests can turn this on and ratchet up later, without a global
// threshold that old code would fail.
//
// A changed file the report does not list was never loaded by a test. It is
// shown as not measured and does not fail the check, because the report has
// no way to tell an untested source file from a file that is not code. A repo
// that wants those counted sets collectCoverageFrom (jest) or
// coverage.include (vitest), which puts them in the report at 0%.
//
// The action's entry point is src/entry/changed-coverage.js. This module
// never runs anything on import, so tests can load it.

// Report keys are absolute paths on the runner, or already relative. Both are
// turned into repo-relative paths with forward slashes.
export function toRepoPath (key, workspace) {
  const normalized = String(key).replace(/\\/g, '/')
  const root = String(workspace ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return normalized.replace(/^\.\//, '')
}

export function parseChangedFiles (text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

// Each changed file with its line coverage, or null when the report does not
// list it. Files are kept in the order given.
export function coverageForChanged (summary, changed, workspace) {
  const byPath = new Map()
  for (const [key, value] of Object.entries(summary ?? {})) {
    if (key === 'total') continue
    byPath.set(toRepoPath(key, workspace), value)
  }
  return changed.map((file) => {
    const entry = byPath.get(file)
    const pct = entry?.lines?.pct
    // istanbul writes "Unknown" for a file with no lines to cover.
    return { file, pct: typeof pct === 'number' ? pct : null, measured: entry !== undefined }
  })
}

export function belowMinimum (rows, min) {
  if (min <= 0) return []
  return rows.filter((row) => row.measured && row.pct !== null && row.pct < min)
}

export function renderTable (rows) {
  if (rows.length === 0) return 'No changed files to report.'
  const lines = ['| File | Lines covered |', '| --- | --- |']
  for (const row of rows) {
    const value = !row.measured ? 'not measured' : row.pct === null ? 'no lines' : `${row.pct}%`
    lines.push(`| \`${row.file}\` | ${value} |`)
  }
  return lines.join('\n')
}

export function parseMinimum (raw) {
  const value = String(raw ?? '').trim() || '0'
  const number = Number(value)
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value) || number > 100) {
    throw new Error(`min-coverage must be a number from 0 to 100, got "${value}"`)
  }
  return number
}

export async function run ({ readFile = readFileSync, workspace = process.env.GITHUB_WORKSPACE } = {}) {
  try {
    const summaryPath = core.getInput('summary-file', { required: true })
    const changedPath = core.getInput('changed-files-file', { required: true })
    const min = parseMinimum(core.getInput('min-coverage'))
    const base = path.resolve(workspace ?? '.', core.getInput('working-directory') || '.')

    let summary
    try {
      summary = JSON.parse(readFile(path.resolve(base, summaryPath), 'utf8'))
    } catch (error) {
      throw new Error(`could not read the coverage summary at ${summaryPath} (${error.message}). The coverage command must write an istanbul json-summary report there.`, { cause: error })
    }
    const changed = parseChangedFiles(readFile(path.resolve(base, changedPath), 'utf8'))

    const rows = coverageForChanged(summary, changed, base)
    const low = belowMinimum(rows, min)
    const measured = rows.filter((row) => row.measured).length

    await core.summary
      .addRaw(`## Coverage on changed files\n\n${renderTable(rows)}\n\n${min > 0 ? `Minimum: ${min}%` : 'No minimum set; report only.'}\n`)
      .write()
    core.setOutput('measured-files', String(measured))

    if (low.length > 0) {
      core.setFailed(`Changed files under ${min}% line coverage: ${low.map((row) => `${row.file} (${row.pct}%)`).join(', ')}`)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}
