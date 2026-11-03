import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import { AttemptNotAuthorized, markDeployRunVerified } from './v2/attempt-guard.js'

// verify-deploy-run: before record-deploy puts a deploy on an app's Flightdeck
// timeline, check that the app's own run really asked for it.
//
// record-deploy is dispatched with the org's dispatch token, whose account
// can reach every repository. So who dispatched it proves nothing, and a
// push-access check on that account would always pass. What can be checked is
// the run the dispatch names, read from GitHub's API. It must:
//
//   - exist in the app's repository, with its code from that repository and
//     not a fork;
//   - have `sha` as its head commit;
//   - have been started by a push, a manual dispatch, a schedule or a
//     release, never by a pull request or anything else;
//   - be running, or have finished successfully;
//   - have started its latest attempt recently (MAX_RUN_AGE_MS), so an old
//     run cannot be replayed as a deploy that just happened;
//   - when app-info pins the app's deploy workflow (DeployWorkflow), be a run
//     of that workflow;
//   - for production, have `sha` on the repository's default branch, so only
//     merged code is recorded as live in production.
//
// It cannot prove the run deployed anything. Pinning the deploy workflow is
// what narrows "a healthy recent run of this commit" to "a run of the
// workflow that deploys", which is why an unpinned app gets a warning.
//
// On a pass it marks the job for this attempt and exactly this Flightdeck
// project, app, environment and sha (src/v2/attempt-guard.js). That mark lets
// flightdeck-release-event post a production deploy event for that deploy,
// and nothing more. The release tag is the run's own, deploy-<yyyy-mm-dd>-<n>
// from its creation date and run number, so a second record of one run posts
// the same tag and Flightdeck updates the event it already has.
//
// It fails closed: a missing value, an API error, a request that gets no
// answer in time or a response it does not understand is a refusal. A refusal
// is a warning, not a failed step, because recording a deploy is telemetry and
// the run it reports on has already done its work. Later steps run only when
// the `verified` output is "true".
//
// The action's entry point is src/entry/verify-deploy-run.js, which always
// runs the check. This module never runs anything on import, so tests can
// load it.

export const ENVIRONMENTS = Object.freeze(['staging', 'production'])
export const DEPLOY_EVENTS = Object.freeze(['push', 'workflow_dispatch', 'schedule', 'release'])

// How long after its latest attempt started a run can still record a deploy.
// The app dispatches record-deploy from inside its deploy job, so the check
// normally runs minutes after the attempt started. Six hours leaves room for a
// long deploy and a busy queue, and is far shorter than the 35 days a finished
// run stays readable, which is the window a replay would otherwise have.
export const MAX_RUN_AGE_MS = 6 * 60 * 60 * 1000

const ATTEMPTS = 3
const RETRY_DELAY_MS = 2000
export const REQUEST_TIMEOUT_MS = 10000

export class Refusal extends Error {}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Retry only what may pass on a second try: a server error, a request that
// never got an answer, or one that ran out of time. A 4xx is an answer.
async function withRetry (label, call, { sleep, timeoutMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call({ signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const retryable = error?.status === undefined || error.status >= 500
      if (!retryable || attempt >= ATTEMPTS) throw error
      core.info(`${label} failed (${describeError(error, timeoutMs)}); trying again (${attempt + 1}/${ATTEMPTS})`)
      await sleep(RETRY_DELAY_MS * attempt)
    }
  }
}

export function describeError (error, timeoutMs = REQUEST_TIMEOUT_MS) {
  const names = [error?.name, error?.cause?.name]
  if (names.includes('TimeoutError') || names.includes('AbortError')) {
    return `no answer within ${timeoutMs / 1000} seconds`
  }
  if (error?.status !== undefined) return `HTTP ${error.status}: ${error.message}`
  return error?.message || String(error)
}

// The inputs, checked and in the form the rest of the check compares and the
// mark names. Any value that is not what it should be is a refusal before any
// API call.
export function parseRequest ({ repository, runId, sha, environment, project, app, deployWorkflow }) {
  const parts = String(repository ?? '').trim().split('/')
  if (parts.length !== 2 || !/^[A-Za-z0-9-]+$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(parts[1])) {
    throw new Refusal(`the app repository "${repository ?? ''}" is not in owner/name form`)
  }
  const id = String(runId ?? '').trim()
  if (!/^[1-9][0-9]{0,19}$/.test(id)) {
    throw new Refusal(`the run id "${runId ?? ''}" is not a GitHub Actions run id`)
  }
  const commit = String(sha ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Refusal(`the sha "${sha ?? ''}" is not a full 40-character commit sha`)
  }
  const env = String(environment ?? '').trim().toLowerCase()
  if (!ENVIRONMENTS.includes(env)) {
    throw new Refusal(`the environment "${environment ?? ''}" is not ${ENVIRONMENTS.join(' or ')}`)
  }
  const flightdeckProject = String(project ?? '').trim()
  if (!/^[A-Z0-9]{1,10}$/.test(flightdeckProject)) {
    throw new Refusal(`the Flightdeck project "${project ?? ''}" is not a project identifier`)
  }
  const appName = String(app ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(appName)) {
    throw new Refusal(`the app "${app ?? ''}" is not a project name app-info can hold`)
  }
  const workflow = String(deployWorkflow ?? '').trim()
  if (workflow !== '' && !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(workflow)) {
    throw new Refusal(`the deploy workflow "${deployWorkflow}" in app-info is not a path under .github/workflows/`)
  }
  return {
    owner: parts[0],
    repo: parts[1],
    repository: `${parts[0]}/${parts[1]}`,
    runId: id,
    sha: commit,
    environment: env,
    project: flightdeckProject,
    app: appName,
    deployWorkflow: workflow
  }
}

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// The run's workflow file. GitHub can add "@<ref>" to the path; the file is
// what is compared.
const workflowPath = (path) => String(path ?? '').split('@')[0]

// Check the run. Returns what record-deploy reports about it, or throws a
// Refusal saying why not.
export async function verifyDeployRun ({
  octokit, repository, runId, sha, environment, project, app, deployWorkflow,
  now = Date.now(), sleep = sleepFor, timeoutMs = REQUEST_TIMEOUT_MS
}) {
  const request = parseRequest({ repository, runId, sha, environment, project, app, deployWorkflow })
  const { owner, repo } = request
  const repoName = request.repository
  const retry = { sleep, timeoutMs }
  const theRun = `run ${request.runId}`

  let run
  try {
    run = (await withRetry(`Reading ${theRun} of ${repoName}`,
      (options) => octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: request.runId, request: options }), retry))?.data
  } catch (error) {
    if (error?.status === 404) {
      throw new Refusal(`there is no ${theRun} in ${repoName}, or the token cannot read it`)
    }
    throw new Refusal(`could not read ${theRun} of ${repoName} (${describeError(error, timeoutMs)})`)
  }
  if (!run || typeof run !== 'object') {
    throw new Refusal(`reading ${theRun} of ${repoName} returned no run`)
  }

  if (!sameRepo(run.repository?.full_name, repoName)) {
    throw new Refusal(`${theRun} belongs to ${run.repository?.full_name || 'no repository'}, not to ${repoName}`)
  }
  if (!sameRepo(run.head_repository?.full_name, repoName)) {
    throw new Refusal(`${theRun} ran code from ${run.head_repository?.full_name || 'an unknown repository'}, not from ${repoName} itself`)
  }
  if (!DEPLOY_EVENTS.includes(run.event)) {
    const kind = String(run.event ?? '').startsWith('pull_request') ? 'a pull request' : `a "${run.event ?? 'unknown'}" event`
    throw new Refusal(`${theRun} of ${repoName} was started by ${kind}; only a push, a manual dispatch (workflow_dispatch), a schedule or a release can record a deploy`)
  }
  const head = String(run.head_sha ?? '').toLowerCase()
  if (head !== request.sha) {
    throw new Refusal(`${theRun} of ${repoName} ran commit ${head || 'unknown'}, not ${request.sha}`)
  }

  const finished = run.status === 'completed'
  if (!(run.status === 'in_progress' || (finished && run.conclusion === 'success'))) {
    const state = finished ? `finished with conclusion ${run.conclusion ?? 'none'}` : `is ${run.status ?? 'in an unknown state'}`
    throw new Refusal(`${theRun} of ${repoName} ${state}; only a run that is still going, or one that finished successfully, can record a deploy`)
  }

  const startedAt = Date.parse(run.run_started_at)
  if (Number.isNaN(startedAt)) {
    throw new Refusal(`GitHub did not say when ${theRun} of ${repoName} started its latest attempt`)
  }
  if (now - startedAt > MAX_RUN_AGE_MS) {
    throw new Refusal(`${theRun} of ${repoName} started its latest attempt at ${run.run_started_at}, more than ${MAX_RUN_AGE_MS / 3600000} hours ago; only a recent run can record a deploy`)
  }

  const path = workflowPath(run.path)
  if (request.deployWorkflow && path !== request.deployWorkflow) {
    throw new Refusal(`${theRun} of ${repoName} is a run of ${path || 'an unknown workflow'}, not of ${request.deployWorkflow}, the deploy workflow app-info names`)
  }

  const { releaseTag, buildNumber } = releaseOf(run, theRun, repoName)

  let defaultBranch = ''
  if (request.environment === 'production') {
    defaultBranch = await readDefaultBranch({ octokit, owner, repo, repoName, retry, timeoutMs })
    await assertOnDefaultBranch({ octokit, owner, repo, repoName, sha: request.sha, defaultBranch, retry, timeoutMs })
  }

  return {
    ...request,
    actor: run.triggering_actor?.login || run.actor?.login || '',
    runUrl: runUrlOf(run),
    // A run that has finished says when. One still running is the run that
    // is deploying, so the event is stamped with the time of the post.
    deployedAt: finished && typeof run.updated_at === 'string' ? run.updated_at : '',
    event: run.event,
    workflowPath: path,
    pinned: request.deployWorkflow !== '',
    releaseTag,
    buildNumber,
    defaultBranch
  }
}

// deploy-<yyyy-mm-dd>-<run number>, the date the run was created in UTC. Both
// stay the same when the run is re-run or recorded again, so the tag does too.
function releaseOf (run, theRun, repoName) {
  const created = Date.parse(run.created_at)
  const number = String(run.run_number ?? '')
  if (Number.isNaN(created) || !/^[1-9][0-9]*$/.test(number)) {
    throw new Refusal(`GitHub did not give the creation time and run number of ${theRun} of ${repoName}, so the deploy has no release tag`)
  }
  return { releaseTag: `deploy-${new Date(created).toISOString().slice(0, 10)}-${number}`, buildNumber: number }
}

async function readDefaultBranch ({ octokit, owner, repo, repoName, retry, timeoutMs }) {
  let branch
  try {
    branch = (await withRetry(`Reading ${repoName}`,
      (options) => octokit.rest.repos.get({ owner, repo, request: options }), retry))?.data?.default_branch
  } catch (error) {
    throw new Refusal(`could not read the default branch of ${repoName} (${describeError(error, timeoutMs)})`)
  }
  if (typeof branch !== 'string' || branch === '') {
    throw new Refusal(`GitHub did not say what the default branch of ${repoName} is`)
  }
  return branch
}

// The commit is on the default branch when the branch has every commit the
// commit has: comparing the commit (base) with the branch (head) finds the
// branch "ahead" of it, or "identical" to it, and never behind.
async function assertOnDefaultBranch ({ octokit, owner, repo, repoName, sha, defaultBranch, retry, timeoutMs }) {
  let comparison
  try {
    comparison = (await withRetry(`Comparing ${sha} with ${defaultBranch} on ${repoName}`,
      (options) => octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${sha}...${defaultBranch}`, per_page: 1, request: options }), retry))?.data
  } catch (error) {
    throw new Refusal(`could not check that ${sha} is on ${repoName}'s default branch ${defaultBranch} (${describeError(error, timeoutMs)})`)
  }
  const status = comparison?.status
  if (!['ahead', 'identical'].includes(status) || comparison?.behind_by !== 0) {
    throw new Refusal(`${sha} is not on ${repoName}'s default branch ${defaultBranch} (GitHub compares it as ${status || 'unknown'}); a production deploy is recorded only for a commit on the default branch`)
  }
}

// The run's own page, for the attempt GitHub reports, in the form Flightdeck
// accepts for run_url.
function runUrlOf (run) {
  const base = `https://github.com/${run.repository.full_name}/actions/runs/${run.id}`
  const attempt = String(run.run_attempt ?? '')
  return /^[1-9][0-9]*$/.test(attempt) ? `${base}/attempts/${attempt}` : base
}

export async function run ({ env = process.env, sleep, timeoutMs, now } = {}) {
  const ask = {
    repository: core.getInput('repository'),
    runId: core.getInput('run-id'),
    sha: core.getInput('sha'),
    environment: core.getInput('environment'),
    project: core.getInput('project'),
    app: core.getInput('app'),
    deployWorkflow: core.getInput('deploy-workflow')
  }
  try {
    const token = core.getInput('github-token')
    if (!token) {
      throw new Refusal('no github-token was given, so the run cannot be read')
    }
    const verified = await verifyDeployRun({ octokit: getOctokit(token), ...ask, now, sleep, timeoutMs })
    markDeployRunVerified({ project: verified.project, app: verified.app, environment: verified.environment, sha: verified.sha }, env)
    for (const [name, value] of Object.entries({
      verified: 'true',
      sha: verified.sha,
      environment: verified.environment,
      project: verified.project,
      app: verified.app,
      actor: verified.actor,
      'run-url': verified.runUrl,
      'deployed-at': verified.deployedAt,
      'release-tag': verified.releaseTag,
      'build-number': verified.buildNumber
    })) core.setOutput(name, value)
    if (!verified.pinned) {
      core.warning(`app-info names no DeployWorkflow for ${verified.app}, so any recent healthy run of ${verified.sha} in ${verified.repository} can record a deploy; ${verified.workflowPath || 'this run'} was accepted. Set deploy_workflow on the app's app-info module to pin it.`, { title: 'Deploy workflow not pinned' })
    }
    const where = verified.environment === 'production' ? `, on the default branch ${verified.defaultBranch}` : ''
    core.notice(`run ${verified.runId} of ${verified.repository} (${verified.workflowPath || 'unknown workflow'}) is a ${verified.event} run of ${verified.sha}${where}, started by ${verified.actor || 'an unknown account'}`)
  } catch (error) {
    // Anything that is not a pass is a refusal, including a bug in this code.
    const why = error instanceof Refusal || error instanceof AttemptNotAuthorized
      ? error.message
      : `could not check the run (${describeError(error, timeoutMs ?? REQUEST_TIMEOUT_MS)})`
    core.setOutput('verified', 'false')
    core.setOutput('reason', why)
    core.warning(`${why}. The deploy was not recorded.`, { title: 'Deploy not recorded' })
  }
}
