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
// services do, so nothing leaves the machine. sleep is replaced too, by one
// that records how long the step asked to wait and returns at once.

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
# and records the flags each ledger read was given. A GitHub commit
# comparison is answered from FAKE_GH_COMPARE, the same as the fake gh, and a
# read of the branches whose head is a commit from FAKE_GH_HEADS. The path and
# flags of each GitHub read are recorded too. A GitHub App call (finding the
# App's installation on a repo, minting an installation token, revoking one)
# is answered from FAKE_GH_APP_*, the way curl answers with --fail-with-body,
# -o and -w, and recorded with its method, path, data, flags and headers, the
# headers it read from standard input (-H @-) among them. Each FAKE_GH_APP_*
# status may be a comma-separated list, one status per try of that call, the
# last one repeated for every try after it.
args="$*"; url=""; data=""; method=GET; writeout=""; output=""; fail=""; headers=()
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--data) data="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -H)
      if [ "$2" = @- ]; then
        while IFS= read -r line; do headers+=("$line"); done
      else
        headers+=("$2")
      fi
      shift 2 ;;
    -w|--write-out) writeout="$2"; shift 2 ;;
    -o|--output) output="$2"; shift 2 ;;
    --fail-with-body) fail=body; shift ;;
    --max-time|--connect-timeout|--retry|--retry-delay|--retry-max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
# The status for this try of the GitHub App call named $1, from the list $2.
try_status () {
  local n statuses
  IFS=, read -ra statuses <<< "$2"
  n=$(cat "$FAKE_OUT/app-tries-$1" 2>/dev/null || echo 0)
  echo $((n + 1)) > "$FAKE_OUT/app-tries-$1"
  [ "$n" -lt "\${#statuses[@]}" ] || n=$((\${#statuses[@]} - 1))
  printf '%s' "\${statuses[$n]}"
}
# Answer a GitHub App call with status $1 and body $2. Status 000 is no
# answer at all, the way curl fails when it runs out of time.
app_call () {
  local code=$1 answer=$2
  printf '%s\\n' "\${headers[@]}" | jq -R -s -c --arg method "$method" --arg path "$path" --arg data "$data" --arg args "$args" \\
    '{method: $method, path: $path, data: $data, args: $args, headers: (split("\\n") | map(select(length > 0)))}' >> "$FAKE_OUT/github-app-calls"
  if [ "$code" = 000 ]; then
    [ -z "$writeout" ] || printf '%b' "$(printf '%s' "$writeout" | sed 's/%{http_code}/000/g')"
    echo "curl: (28) Operation timed out after 30000 milliseconds with 0 bytes received" >&2
    exit 28
  fi
  if [ -z "$output" ]; then printf '%s' "$answer"; elif [ "$output" != /dev/null ]; then printf '%s' "$answer" > "$output"; fi
  [ -z "$writeout" ] || printf '%b' "$(printf '%s' "$writeout" | sed "s/%{http_code}/$code/g")"
  if [ "$code" -ge 400 ] && [ -n "$fail" ]; then echo "curl: (22) The requested URL returned error: $code" >&2; exit 22; fi
  exit 0
}
case "$url" in
  https://api.github.com/repos/*/installation)
    path="\${url#https://api.github.com/}"
    app_call "$(try_status installation "\${FAKE_GH_APP_INSTALLATION_STATUS:-200}")" "$FAKE_GH_APP_INSTALLATION" ;;
  https://api.github.com/app/installations/*/access_tokens)
    path="\${url#https://api.github.com/}"
    app_call "$(try_status token "\${FAKE_GH_APP_TOKEN_STATUS:-201}")" "$FAKE_GH_APP_TOKEN" ;;
  https://api.github.com/installation/token)
    path="\${url#https://api.github.com/}"
    app_call "$(try_status revoke "\${FAKE_GH_APP_REVOKE_STATUS:-204}")" '' ;;
  https://slack.com/*) printf '%s' "$data" > "$FAKE_OUT/slack.json"; echo '{"ok":true}' ;;
  https://deploys.cru.org/deployments*)
    printf '%s\\n' "$args" >> "$FAKE_OUT/ledger-calls"
    if [ -n "$FAKE_LEDGER_TIMES_OUT" ]; then echo "curl: (28) Operation timed out after 20000 milliseconds with 0 bytes received" >&2; exit 28; fi
    if [ -n "$FAKE_LEDGER_FAILS" ]; then echo "curl: (22) The requested URL returned error: 503" >&2; exit 22; fi
    printf '%s' "$FAKE_LEDGER" ;;
  https://api.github.com/repos/*/compare/*)
    printf '%s\\n' "$args" >> "$FAKE_OUT/github-calls"
    path="\${url#https://api.github.com/}"
    printf '%s' "\${path%%\\?*}" > "$FAKE_OUT/gh-compare-path"
    if [ -n "$FAKE_GH_COMPARE_TIMES_OUT" ]; then echo "curl: (28) Operation timed out after 20000 milliseconds with 0 bytes received" >&2; exit 28; fi
    if [ -n "$FAKE_GH_COMPARE_FAILS" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
    printf '%s' "$FAKE_GH_COMPARE" ;;
  https://api.github.com/repos/*/commits/*/branches-where-head)
    printf '%s\\n' "$args" >> "$FAKE_OUT/github-calls"
    printf '%s' "\${url#https://api.github.com/}" > "$FAKE_OUT/gh-heads-path"
    if [ -n "$FAKE_GH_HEADS_TIMES_OUT" ]; then echo "curl: (28) Operation timed out after 20000 milliseconds with 0 bytes received" >&2; exit 28; fi
    if [ -n "$FAKE_GH_HEADS_FAILS" ]; then echo "curl: (22) The requested URL returned error: 422" >&2; exit 22; fi
    printf '%s' "$FAKE_GH_HEADS" ;;
  *) echo "fake curl: unexpected url $url" >&2; exit 22 ;;
esac
`

const FAKE_SLEEP = `#!/bin/bash
# Fake sleep: records how long the step asked to wait, and does not wait.
printf '%s\\n' "$*" >> "$FAKE_OUT/sleeps"
`

const FAKE_AWS = `#!/bin/bash
# Fake aws: records the table and item a dynamodb put-item writes (the ledger
# row), and answers every other call (the app-info get-item) with FAKE_AWS.
# With FAKE_AWS_BY_ENVIRONMENT set, a get-item is answered by the Environment
# in its --key instead, so a step that reads two rows gets two answers. A
# secretsmanager get-secret-value records its arguments and the AWS keys it
# was run with, and prints FAKE_AWS_SECRET, or fails the way the aws CLI
# does on a refusal when FAKE_AWS_SECRET_FAILS is set.
if [ "$1" = secretsmanager ] && [ "$2" = get-secret-value ]; then
  printf '%s' "$*" > "$FAKE_OUT/secret-call"
  printf '%s|%s|%s' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" > "$FAKE_OUT/secret-call-keys"
  if [ -n "$FAKE_AWS_SECRET_FAILS" ]; then
    echo "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: not authorized" >&2
    exit 254
  fi
  printf '%s\n' "$FAKE_AWS_SECRET"
  exit 0
fi
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
# release body a step sends on stdin. With FAKE_GH_EXISTING_RELEASE set, the
# release already exists: creating it answers 422 already_exists the way gh
# does (the error body on stdout, exit 1), reading it by tag answers that
# value ("FAIL" fails the read like a 404), and an update is recorded.
if [ "$1" = api ] && [[ "$2" == */compare/* ]]; then
  printf '%s' "$2" > "$FAKE_OUT/gh-compare-path"
  if [ -n "$FAKE_GH_COMPARE_FAILS" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
  printf '%s' "$FAKE_GH_COMPARE"
  exit 0
fi
if [ "$1" = api ] && [[ "$2" == */releases/tags/* ]]; then
  printf '%s' "$2" > "$FAKE_OUT/gh-release-read-path"
  if [ "$FAKE_GH_EXISTING_RELEASE" = FAIL ]; then echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
  printf '%s' "$FAKE_GH_EXISTING_RELEASE"
  exit 0
fi
if [[ " $* " != *" --input - "* ]] && { [ "$2" = -X ] || [[ "$2" == */releases ]]; }; then
  echo "fake gh: a release write must send its body with --input -" >&2; exit 2
fi
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = PATCH ]; then
  printf '%s' "$4" > "$FAKE_OUT/gh-release-update-path"
  cat > "$FAKE_OUT/release-update.json"
  if [ -n "$FAKE_GH_UPDATE_FAILS" ]; then echo '{"message":"Resource not accessible by integration","status":"403"}'; echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; fi
  echo '{"html_url":"https://github.example.test/release"}'
  exit 0
fi
cat > "$FAKE_OUT/release.json"
if [ -n "$FAKE_GH_EXISTING_RELEASE" ]; then
  echo '{"message":"Validation Failed","errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}],"status":"422"}'
  echo "gh: Validation Failed (HTTP 422)" >&2
  exit 1
fi
echo '{"html_url":"https://github.example.test/release"}'
`

// What a fake answers with: an object as JSON, a string as it is.
const asBody = (value) => typeof value === 'string' ? value : JSON.stringify(value)

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
  for (const [name, body] of Object.entries({ curl: FAKE_CURL, gh: FAKE_GH, aws: FAKE_AWS, sleep: FAKE_SLEEP })) {
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

// The key=value lines a step wrote to $GITHUB_OUTPUT or $GITHUB_ENV, and the
// values it wrote over several lines as name<<DELIMITER ... DELIMITER, the
// way the runner reads both.
function readOutputs (file) {
  if (!existsSync(file)) return {}
  const lines = readFileSync(file, 'utf8').split('\n')
  const outputs = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const many = line.match(/^([^=]+)<<(.+)$/)
    if (many) {
      const end = lines.indexOf(many[2], i + 1)
      if (end < 0) throw new Error(`the step wrote ${many[1]}<<${many[2]} with no closing ${many[2]} line`)
      outputs[many[1]] = lines.slice(i + 1, end).join('\n')
      i = end
      continue
    }
    const at = line.indexOf('=')
    outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return outputs
}

// Run one `run:` step. `context` resolves every expression in the job env,
// the step env and the script. `ledger` is what a deploys.cru.org read
// answers (an object is sent as JSON, a string as it is), `ledgerFails` makes
// that read fail the way curl -f does on an HTTP error, `ledgerTimesOut`
// makes it fail the way curl does when it runs out of time (exit 28), and
// `aws` is what an aws call prints. `awsByEnvironment`, when given, answers
// each app-info get-item by its key's Environment instead (a missing one
// answers {}, and "FAIL" makes that read fail the way the aws CLI does on a
// refusal). `ghCompare` is what a `gh api .../compare/...` read answers (an
// object is sent as JSON, a string as it is), and
// `ghCompareFails` makes it fail; a GitHub compare read made with curl is
// answered the same way, and `ghCompareTimesOut` makes that one fail the way
// curl does when it runs out of time. `ghHeads` is what a curl read of
// `repos/.../commits/<sha>/branches-where-head` answers (by default no
// branch, as for a commit no branch points at; an object is sent as JSON, a
// string as it is), and `ghHeadsFails` and `ghHeadsTimesOut` make it fail the
// same two ways. `ghExistingRelease`, when given, is the release that already
// has the tag (an object, or "FAIL" for a read that fails), and
// `ghUpdateFails` makes updating it fail. `awsSecret` is what an aws
// secretsmanager get-secret-value prints, and `awsSecretFails` makes it fail.
// `githubApp` answers the GitHub App calls made with curl: `installation`
// and `token` are the bodies of the installation lookup and of minting a
// token (an object is sent as JSON, a string as it is), and
// `installationStatus`, `tokenStatus` and `revokeStatus` their HTTP statuses
// (by default 200, 201 and 204; "000" is no answer), or an array of them, one
// per try of that call, the last one repeated for every try after it.
// Resolves to the exit status, the output, the step's outputs, the variables
// it set for later steps ($GITHUB_ENV), what was sent to Slack and to the GitHub releases API
// (`release` for a new one; `releaseReadPath`, `releaseUpdatePath` and
// `releaseUpdate` for one that already exists), the path a comparison asked
// for, the path a branch-heads read asked for (`headsPath`), the table and
// item a DynamoDB put-item wrote (each null when nothing was), and the
// arguments of each ledger read (`ledgerCalls`, one string per read) and of
// each GitHub read made with curl (`githubCalls`, in the order made), and a
// secret read's arguments (`secretCall`) and the AWS keys it was run with
// (`secretCallKeys`, as "access key|secret key|session token"), each null
// when there was none, and each GitHub App call (`githubAppCalls`, in the
// order made, as { method, path, data, args, headers }), and how long the
// step asked sleep to wait each time it did (`sleeps`, as strings, in order).
export async function runShellStep ({ job, step }, { context, ledger = { Items: [] }, ledgerFails = false, ledgerTimesOut = false, aws = {}, awsByEnvironment = null, awsSecret = '', awsSecretFails = false, githubApp = {}, ghCompare = {}, ghCompareFails = false, ghCompareTimesOut = false, ghHeads = [], ghHeadsFails = false, ghHeadsTimesOut = false, ghExistingRelease = null, ghUpdateFails = false, runnerEnv = {} }) {
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
      FAKE_AWS_SECRET: awsSecret,
      FAKE_AWS_SECRET_FAILS: awsSecretFails ? '1' : '',
      FAKE_GH_APP_INSTALLATION: asBody(githubApp.installation ?? {}),
      FAKE_GH_APP_INSTALLATION_STATUS: String(githubApp.installationStatus ?? ''),
      FAKE_GH_APP_TOKEN: asBody(githubApp.token ?? {}),
      FAKE_GH_APP_TOKEN_STATUS: String(githubApp.tokenStatus ?? ''),
      FAKE_GH_APP_REVOKE_STATUS: String(githubApp.revokeStatus ?? ''),
      FAKE_GH_COMPARE: typeof ghCompare === 'string' ? ghCompare : JSON.stringify(ghCompare),
      FAKE_GH_COMPARE_FAILS: ghCompareFails ? '1' : '',
      FAKE_GH_COMPARE_TIMES_OUT: ghCompareTimesOut ? '1' : '',
      FAKE_GH_HEADS: typeof ghHeads === 'string' ? ghHeads : JSON.stringify(ghHeads),
      FAKE_GH_HEADS_FAILS: ghHeadsFails ? '1' : '',
      FAKE_GH_HEADS_TIMES_OUT: ghHeadsTimesOut ? '1' : '',
      FAKE_GH_EXISTING_RELEASE: ghExistingRelease === null ? '' : typeof ghExistingRelease === 'string' ? ghExistingRelease : JSON.stringify(ghExistingRelease),
      FAKE_GH_UPDATE_FAILS: ghUpdateFails ? '1' : ''
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
      releaseReadPath: existsSync(path.join(out, 'gh-release-read-path')) ? readFileSync(path.join(out, 'gh-release-read-path'), 'utf8') : null,
      releaseUpdate: readJson(path.join(out, 'release-update.json')),
      releaseUpdatePath: existsSync(path.join(out, 'gh-release-update-path')) ? readFileSync(path.join(out, 'gh-release-update-path'), 'utf8') : null,
      comparePath: existsSync(path.join(out, 'gh-compare-path')) ? readFileSync(path.join(out, 'gh-compare-path'), 'utf8') : null,
      headsPath: existsSync(path.join(out, 'gh-heads-path')) ? readFileSync(path.join(out, 'gh-heads-path'), 'utf8') : null,
      putItem: readPutItem(out),
      ledgerCalls: existsSync(path.join(out, 'ledger-calls')) ? readFileSync(path.join(out, 'ledger-calls'), 'utf8').split('\n').filter(Boolean) : [],
      githubCalls: existsSync(path.join(out, 'github-calls')) ? readFileSync(path.join(out, 'github-calls'), 'utf8').split('\n').filter(Boolean) : [],
      secretCall: existsSync(path.join(out, 'secret-call')) ? readFileSync(path.join(out, 'secret-call'), 'utf8') : null,
      secretCallKeys: existsSync(path.join(out, 'secret-call-keys')) ? readFileSync(path.join(out, 'secret-call-keys'), 'utf8') : null,
      githubAppCalls: existsSync(path.join(out, 'github-app-calls')) ? readFileSync(path.join(out, 'github-app-calls'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
      sleeps: existsSync(path.join(out, 'sleeps')) ? readFileSync(path.join(out, 'sleeps'), 'utf8').split('\n').filter(Boolean) : []
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
