import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'

// Helpers for tests that read the real workflow files and run one step the
// way the runner would: `${{ }}` expressions filled in from a context the
// test gives, then the step's `run:` script under bash. curl, gh and aws are
// replaced by fakes that record what the step sends and answer like the real
// services do, so nothing leaves the machine.

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const loadYaml = (file) => yaml.load(readFileSync(path.join(root, file), 'utf8'))

export function findStep (workflow, jobId, name) {
  const job = workflow.jobs[jobId]
  if (!job) throw new Error(`no job ${jobId}`)
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step "${name}" in job ${jobId}`)
  return { job, step }
}

// Stand-in for the runner: resolve the expressions a step uses. An
// expression the test did not supply is an error, so a step that starts
// reading something new fails loudly instead of seeing an empty string.
export function resolveExpressions (value, context) {
  return String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    if (!(expr in context)) throw new Error(`test does not know how to resolve ${expr}`)
    return context[expr]
  })
}

const FAKE_CURL = `#!/bin/bash
# Fake curl: records the Slack payload, answers ledger reads from FAKE_LEDGER.
url=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--data) data="$2"; shift 2 ;;
    -H|-X|--max-time|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://slack.com/*) printf '%s' "$data" > "$FAKE_OUT/slack.json"; echo '{"ok":true}' ;;
  https://deploys.cru.org/deployments*) printf '%s' "$FAKE_LEDGER" ;;
  *) echo "fake curl: unexpected url $url" >&2; exit 22 ;;
esac
`

const FAKE_AWS = `#!/bin/bash
# Fake aws: answers every call (the app-info get-item) with FAKE_AWS.
printf '%s' "$FAKE_AWS"
`

const FAKE_GH = `#!/bin/bash
# Fake gh: records the release body a step sends on stdin.
cat > "$FAKE_OUT/release.json"
echo '{"html_url":"https://github.example.test/release"}'
`

function readJson (file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

// The fakes are written once and reused: some systems scan every new
// executable before its first run, which made a fresh pair per step slow.
// Call removeFakes() from afterAll.
let fakeBin = null
function fakes () {
  if (fakeBin) return fakeBin
  fakeBin = mkdtempSync(path.join(tmpdir(), 'workflow-fakes-'))
  for (const [name, body] of Object.entries({ curl: FAKE_CURL, gh: FAKE_GH, aws: FAKE_AWS })) {
    writeFileSync(path.join(fakeBin, name), body)
    chmodSync(path.join(fakeBin, name), 0o755)
  }
  return fakeBin
}

export function removeFakes () {
  if (fakeBin) rmSync(fakeBin, { recursive: true, force: true })
  fakeBin = null
}

function spawnBash (script, env) {
  return new Promise((resolve, reject) => {
    // No `shell:` on these steps, so the runner uses `bash -e {0}`.
    const child = spawn('bash', ['--noprofile', '--norc', '-e', script], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// The key=value lines a step wrote to $GITHUB_OUTPUT.
function readOutputs (file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
}

// Run one `run:` step. `context` resolves every expression in the job env,
// the step env and the script. `ledger` is what a deploys.cru.org read
// answers, and `aws` what an aws call prints. Resolves to the exit status,
// the output, the step's outputs, and what was sent to Slack and to the
// GitHub releases API (null when nothing was).
export async function runShellStep ({ job, step }, { context, ledger = { Items: [] }, aws = {}, runnerEnv = {} }) {
  const bin = fakes()
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-step-'))
  try {
    const out = path.join(dir, 'out')
    mkdirSync(out)
    const script = path.join(dir, 'step.sh')
    writeFileSync(script, resolveExpressions(step.run, context))
    const resolveEnv = (env) => Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, resolveExpressions(value, context)]))
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'example-org/deploy-wrappers',
      GITHUB_RUN_ID: '9001',
      GITHUB_RUN_ATTEMPT: '1',
      ...runnerEnv,
      ...resolveEnv(job.env),
      ...resolveEnv(step.env),
      GITHUB_OUTPUT: path.join(out, 'github-output'),
      FAKE_OUT: out,
      FAKE_LEDGER: JSON.stringify(ledger),
      FAKE_AWS: JSON.stringify(aws)
    }
    const result = await spawnBash(script, env)
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: readOutputs(path.join(out, 'github-output')),
      slack: readJson(path.join(out, 'slack.json')),
      release: readJson(path.join(out, 'release.json'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
