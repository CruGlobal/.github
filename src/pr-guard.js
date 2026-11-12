import * as core from '@actions/core'
import * as github from '@actions/github'

// pr-guard: checks a pull request before anyone reads its code.
//
//   1. Links. The description must carry a work item link and a spec link.
//      HTML comments are dropped first, so a template's placeholder text
//      never counts as a link.
//   2. Size. Changed lines (additions plus deletions) past warn-lines get a
//      warning; past fail-lines the check fails unless the PR carries the
//      override label. Lockfiles and other generated files listed in
//      size-ignore are not counted.
//   3. Tier. Each changed path is matched against the one-way-door path list.
//      Any match labels the PR one-way-door, otherwise two-way-door. A PR that
//      touches both is one-way. The list is read from the base branch, never
//      from the PR, so a PR cannot edit the list to change its own label. With
//      no list on the base branch, no tier label is applied.
//
// Every problem found is reported together, so one run shows all of them.
// The action's entry point is src/entry/pr-guard.js. This module never runs
// anything on import, so tests can load it.

export const ONE_WAY = 'one-way-door'
export const TWO_WAY = 'two-way-door'

export const DEFAULT_WORK_ITEM_PATTERN = '\\bwork item\\b[^\\n]*https?://\\S+'
export const DEFAULT_SPEC_PATTERN = '\\bspec\\b[^\\n]*https?://\\S+'
export const DEFAULT_SIZE_IGNORE = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Cargo.lock',
  '/dist/',
  '__snapshots__/'
].join('\n')

// A path pattern in the style of .gitignore and CODEOWNERS:
//   - "*" matches within one folder, "**" matches across folders, "?" one
//     character.
//   - A pattern with no "/" except a trailing one matches at any depth.
//   - A leading "/" anchors to the repo root, as does any "/" in the middle.
//   - A trailing "/" matches everything under that folder.
//   - A pattern that names a folder without a trailing "/" also matches
//     everything under it, as it does in CODEOWNERS.
export function globToRegExp (pattern) {
  let p = String(pattern).trim()
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  const anchored = p.startsWith('/') || p.includes('/')
  if (p.startsWith('/')) p = p.slice(1)

  let source = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // "**/" matches zero or more folders; a trailing "**" matches the rest.
        if (p[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  const prefix = anchored ? '^' : '^(?:.*/)?'
  return new RegExp(`${prefix}${source}(?:/.*)?$`)
}

// One pattern per line. Blank lines and lines starting with "#" are skipped,
// as is anything after " #" on a line.
export function parsePathList (text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

export function matchesAny (file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file))
}

// The tier for a set of changed paths, with the paths that made it one-way.
export function classifyTier (files, patterns) {
  const matched = files.filter((file) => matchesAny(file, patterns))
  return { tier: matched.length > 0 ? ONE_WAY : TWO_WAY, matched }
}

export function stripHtmlComments (text) {
  return String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
}

// A bad pattern is the caller's mistake, so it fails the check with a message
// that names the input, rather than passing every PR.
export function compilePattern (source, inputName) {
  try {
    return new RegExp(source, 'im')
  } catch (error) {
    throw new Error(`${inputName} is not a valid regular expression: ${error.message}`, { cause: error })
  }
}

export function checkLinks (body, { workItem, spec, requireWorkItem = true, requireSpec = true }) {
  const text = stripHtmlComments(body)
  const missing = []
  if (requireWorkItem && !workItem.test(text)) missing.push('work item link')
  if (requireSpec && !spec.test(text)) missing.push('spec link')
  return missing
}

// Each changed file as { filename, previous_filename, additions, deletions },
// the shape the pulls.listFiles API returns. A file counts by where it ends up,
// so moving a file out of an ignored folder still counts its lines.
export function countChangedLines (files, ignorePatterns) {
  let lines = 0
  for (const file of files) {
    if (matchesAny(file.filename, ignorePatterns)) continue
    lines += (file.additions ?? 0) + (file.deletions ?? 0)
  }
  return lines
}

export function sizeVerdict (lines, { warnLines, failLines, overridden }) {
  if (lines > failLines) return overridden ? 'overridden' : 'fail'
  if (lines > warnLines) return 'warn'
  return 'ok'
}

// Inputs that must be whole numbers. Anything else fails the check by name.
export function parseCount (raw, inputName) {
  const value = String(raw ?? '').trim()
  if (!/^[0-9]+$/.test(value)) throw new Error(`${inputName} must be a whole number, got "${value}"`)
  return Number(value)
}

export function parseBoolean (raw, inputName) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${inputName} must be true or false, got "${value}"`)
}

// The path list on the base branch, or null when there is none.
async function readBasePathList (octokit, { owner, repo, ref, path }) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
    if (Array.isArray(data) || data.type !== 'file') {
      throw new Error(`tier-paths-file ${path} is not a file on the base branch`)
    }
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

// Labels are set last and best effort: a PR from a fork gets a read-only
// token, so a failure to label is a warning, not a failed check.
async function applyTierLabel (octokit, { owner, repo, number, tier, current }) {
  const other = tier === ONE_WAY ? TWO_WAY : ONE_WAY
  try {
    if (current.includes(other)) {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: number, name: other })
    }
    if (!current.includes(tier)) {
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [tier] })
    }
  } catch (error) {
    core.warning(`could not set the ${tier} label (${error.message}). A pull request from a fork cannot be labeled by this workflow; add it by hand.`)
  }
}

function readInputs () {
  return {
    token: core.getInput('github-token', { required: true }),
    workItem: compilePattern(core.getInput('work-item-pattern') || DEFAULT_WORK_ITEM_PATTERN, 'work-item-pattern'),
    spec: compilePattern(core.getInput('spec-pattern') || DEFAULT_SPEC_PATTERN, 'spec-pattern'),
    requireWorkItem: parseBoolean(core.getInput('require-work-item') || 'true', 'require-work-item'),
    requireSpec: parseBoolean(core.getInput('require-spec') || 'true', 'require-spec'),
    warnLines: parseCount(core.getInput('warn-lines') || '300', 'warn-lines'),
    failLines: parseCount(core.getInput('fail-lines') || '800', 'fail-lines'),
    overrideLabel: core.getInput('size-override-label') || 'size-override',
    sizeIgnore: parsePathList(core.getInput('size-ignore') || DEFAULT_SIZE_IGNORE),
    tierPathsFile: core.getInput('tier-paths-file') || '.github/one-way-door-paths',
    applyLabels: parseBoolean(core.getInput('apply-tier-label') || 'true', 'apply-tier-label')
  }
}

export async function run ({ context = github.context, getOctokit = github.getOctokit } = {}) {
  try {
    const pr = context.payload.pull_request
    if (!pr) throw new Error('pr-guard only runs on pull_request or pull_request_target events')
    const inputs = readInputs()
    const octokit = getOctokit(inputs.token)
    const { owner, repo } = context.repo
    const number = pr.number

    // Read the PR fresh: the event payload is from when the run was queued,
    // and a label or an edit to the description may have landed since.
    const { data: live } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
    const labels = (live.labels ?? []).map((label) => label.name)
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 })
    // The files API stops at 3000 files. A path past that could be one-way, so
    // a pull request this big is refused rather than labeled from part of it.
    if (live.changed_files > files.length) {
      throw new Error(`this pull request changes ${live.changed_files} files, but GitHub lists only the first ${files.length}, so its size and tier cannot be checked. Split it up.`)
    }

    const problems = []
    const summary = []

    const missing = checkLinks(live.body, inputs)
    if (missing.length > 0) problems.push(`The description is missing a ${missing.join(' and a ')}.`)
    summary.push(`**Links:** ${missing.length > 0 ? `missing ${missing.join(', ')}` : 'ok'}`)

    const lines = countChangedLines(files, inputs.sizeIgnore)
    const size = sizeVerdict(lines, {
      warnLines: inputs.warnLines,
      failLines: inputs.failLines,
      overridden: labels.includes(inputs.overrideLabel)
    })
    if (size === 'fail') {
      problems.push(`${lines} changed lines is over the limit of ${inputs.failLines}. Split the pull request, or add the ${inputs.overrideLabel} label if it cannot be split.`)
    } else if (size === 'warn') {
      core.warning(`${lines} changed lines is over ${inputs.warnLines}. Smaller pull requests are easier to check.`)
    } else if (size === 'overridden') {
      core.notice(`${lines} changed lines is over ${inputs.failLines}, allowed by the ${inputs.overrideLabel} label.`)
    }
    summary.push(`**Size:** ${lines} changed lines (${size})`)

    const listText = await readBasePathList(octokit, { owner, repo, ref: pr.base.sha, path: inputs.tierPathsFile })
    if (listText === null) {
      core.notice(`No ${inputs.tierPathsFile} on the base branch, so no tier label was set.`)
      summary.push(`**Tier:** not set (no ${inputs.tierPathsFile} on the base branch)`)
    } else {
      const changedPaths = files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean))
      const { tier, matched } = classifyTier(changedPaths, parsePathList(listText))
      core.setOutput('tier', tier)
      summary.push(`**Tier:** ${tier}`)
      if (matched.length > 0) summary.push(`One-way-door paths touched:\n\n${matched.map((file) => `- \`${file}\``).join('\n')}`)
      if (inputs.applyLabels) await applyTierLabel(octokit, { owner, repo, number, tier, current: labels })
    }

    core.setOutput('changed-lines', String(lines))
    core.info(summary.join('\n'))
    await core.summary.addRaw(`## PR guard\n\n${summary.join('\n\n')}\n`).write()

    if (problems.length > 0) core.setFailed(problems.join('\n'))
  } catch (error) {
    core.setFailed(error.message)
  }
}
