import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as yaml from 'js-yaml'

// Helpers for tests that read the real workflow files and run one step the
// way the runner would: `${{ }}` expressions filled in from a context the
// test gives, then the step's `run:` script under bash. curl, gh and aws are
// replaced by fakes that record what the step sends and answer like the real
// services do, so nothing leaves the machine.

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const loadYaml = (file) => yaml.load(readFileSync(path.join(root, file), 'utf8'))

// Every workflow and every action in the repo, as repo-relative paths.
export function workflowAndActionFiles () {
  const workflowDir = '.github/workflows'
  const files = readdirSync(path.join(root, workflowDir))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `${workflowDir}/${name}`)
  for (const entry of readdirSync(path.join(root, 'actions'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of ['action.yml', 'action.yaml']) {
      if (existsSync(path.join(root, 'actions', entry.name, name))) files.push(`actions/${entry.name}/${name}`)
    }
  }
  return files
}

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
# Fake curl: records the Slack payload, answers ledger reads from FAKE_LEDGER,
# and records the flags each ledger read was given.
args="$*"; url=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--data) data="$2"; shift 2 ;;
    -H|-X|--max-time|--connect-timeout|--retry|--retry-delay|--retry-max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://slack.com/*) printf '%s' "$data" > "$FAKE_OUT/slack.json"; echo '{"ok":true}' ;;
  https://deploys.cru.org/deployments*)
    printf '%s\\n' "$args" >> "$FAKE_OUT/ledger-calls"
    if [ -n "$FAKE_LEDGER_TIMES_OUT" ]; then echo "curl: (28) Operation timed out after 20000 milliseconds with 0 bytes received" >&2; exit 28; fi
    if [ -n "$FAKE_LEDGER_FAILS" ]; then echo "curl: (22) The requested URL returned error: 503" >&2; exit 22; fi
    printf '%s' "$FAKE_LEDGER" ;;
  *) echo "fake curl: unexpected url $url" >&2; exit 22 ;;
esac
`

const FAKE_AWS = `#!/bin/bash
# Fake aws: records the table and item a dynamodb put-item writes (the ledger
# row), and answers every other call (the app-info get-item) with FAKE_AWS.
# With FAKE_AWS_BY_ENVIRONMENT set, a get-item is answered by the Environment
# in its --key instead, so a step that reads two rows gets two answers.
if [ "$1" = dynamodb ] && [ "$2" = put-item ]; then
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --table-name) printf '%s' "$2" > "$FAKE_OUT/put-item-table"; shift 2 ;;
      --item) printf '%s' "$2" > "$FAKE_OUT/put-item.json"; shift 2 ;;
      *) shift ;;
    esac
  done
  exit 0
fi
if [ "$1" = dynamodb ] && [ "$2" = get-item ] && [ -n "$FAKE_AWS_BY_ENVIRONMENT" ]; then
  key=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --key) key="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  environment=$(printf '%s' "$key" | jq -r '.Environment.S')
  answer=$(printf '%s' "$FAKE_AWS_BY_ENVIRONMENT" | jq -c --arg e "$environment" '.[$e] // {}')
  if [ "$answer" = '"FAIL"' ]; then
    echo "An error occurred (AccessDeniedException) when calling the GetItem operation" >&2
    exit 254
  fi
  printf '%s' "$answer"
  exit 0
fi
printf '%s' "$FAKE_AWS"
`

const FAKE_GH = `#!/bin/bash
# Fake gh: answers a commit comparison read from FAKE_GH_COMPARE (failing like
# gh does on an HTTP error when FAKE_GH_COMPARE_FAILS is set), and records the
# release body a step sends on stdin.
if [ "$1" = api ] && [[ "$2" == */compare/* ]]; then
  printf '%s' "$2" > "$FAKE_OUT/gh-compare-path"
  if [ -n "$FAKE_GH_COMPARE_FAILS" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
  printf '%s' "$FAKE_GH_COMPARE"
  exit 0
fi
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

// The table and item a put-item wrote, or null when the step wrote none. A
// put-item missing either flag is a broken step, so it fails by name here
// rather than as a missing file.
function readPutItem (out) {
  const table = path.join(out, 'put-item-table')
  const item = path.join(out, 'put-item.json')
  if (!existsSync(table) && !existsSync(item)) return null
  if (!existsSync(table)) throw new Error('the step ran dynamodb put-item with --item but no --table-name')
  if (!existsSync(item)) throw new Error('the step ran dynamodb put-item with --table-name but no --item')
  return { table: readFileSync(table, 'utf8'), item: readJson(item) }
}

// The key=value lines a step wrote to $GITHUB_OUTPUT or $GITHUB_ENV.
function readOutputs (file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
}

// Run one `run:` step. `context` resolves every expression in the job env,
// the step env and the script. `ledger` is what a deploys.cru.org read
// answers (an object is sent as JSON, a string as it is), `ledgerFails` makes
// that read fail the way curl -f does on an HTTP error, `ledgerTimesOut`
// makes it fail the way curl does when it runs out of time (exit 28), and
// `aws` is what an aws call prints. `awsByEnvironment`, when given, answers
// each app-info get-item by its key's Environment instead (a missing one
// answers {}, and "FAIL" makes that read fail the way the aws CLI does on a
// refusal). `ghCompare` is what a `gh api .../compare/...` read answers, and
// `ghCompareFails` makes it fail. Resolves to the exit status, the output,
// the step's outputs, the variables it set for later steps ($GITHUB_ENV),
// what was sent to Slack and to the GitHub releases API, the path a
// comparison asked for, the table and item a DynamoDB put-item wrote (each
// null when nothing was), and the arguments of each ledger read
// (`ledgerCalls`, one string per read).
export async function runShellStep ({ job, step }, { context, ledger = { Items: [] }, ledgerFails = false, ledgerTimesOut = false, aws = {}, awsByEnvironment = null, ghCompare = {}, ghCompareFails = false, runnerEnv = {} }) {
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
      GITHUB_ENV: path.join(out, 'github-env'),
      FAKE_OUT: out,
      FAKE_LEDGER: typeof ledger === 'string' ? ledger : JSON.stringify(ledger),
      FAKE_LEDGER_FAILS: ledgerFails ? '1' : '',
      FAKE_LEDGER_TIMES_OUT: ledgerTimesOut ? '1' : '',
      FAKE_AWS: JSON.stringify(aws),
      FAKE_AWS_BY_ENVIRONMENT: awsByEnvironment ? JSON.stringify(awsByEnvironment) : '',
      FAKE_GH_COMPARE: JSON.stringify(ghCompare),
      FAKE_GH_COMPARE_FAILS: ghCompareFails ? '1' : ''
    }
    const result = await spawnBash(script, env)
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: readOutputs(path.join(out, 'github-output')),
      env: readOutputs(path.join(out, 'github-env')),
      slack: readJson(path.join(out, 'slack.json')),
      release: readJson(path.join(out, 'release.json')),
      comparePath: existsSync(path.join(out, 'gh-compare-path')) ? readFileSync(path.join(out, 'gh-compare-path'), 'utf8') : null,
      putItem: readPutItem(out),
      ledgerCalls: existsSync(path.join(out, 'ledger-calls')) ? readFileSync(path.join(out, 'ledger-calls'), 'utf8').split('\n').filter(Boolean) : []
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
