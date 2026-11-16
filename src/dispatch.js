import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import { GATE_WORKFLOWS, GateUnavailable, gateDispatch, oidcAvailable, parseGateUrl } from './v2/gate-dispatch.js'

// dispatch: a generic cross-repo workflow_dispatch trigger for pipeline v2.
//
// v1's trigger-deploy action baked a hardcoded map of deploy-type -> workflow
// file (and cru-deploy as the only target repo). v2 splits the pipeline into
// discrete workflows (deploy-candidate / promote / rollback), so the dispatcher
// is now fully generic: the caller names the repo, workflow file, ref, and the
// inputs payload. This mirrors src/trigger-deploy.js's octokit call without any
// of its baked-in routing.
//
// The deploy gate (gate-url). An app repo starts the deploy repo's
// deploy-candidate.yml, and build-candidate's failure job starts its
// notify-build-failure.yml, with a token that can dispatch workflows there.
// With gate-url set, those two go through the deploy gate's pipeline route
// instead, with the job's own GitHub OIDC token (src/v2/gate-dispatch.js), so
// the app repo needs no such token. Everything else still uses github-token.
//
// github-token stays as the way back while apps move over, so these are the
// rules when gate-url is set:
//
//   - The job has no OIDC token (no id-token: write): warn and use
//     github-token, or fail when there is none.
//   - The gate refuses (any answer but a 2xx or a 5xx): fail with the gate's
//     code and message. Never fall back: a refusal means the request is not
//     allowed, and the token would only get round that.
//   - The gate cannot be reached, gives no answer in time, answers 5xx or
//     says not_configured: try again with a fresh token, then warn and use
//     github-token, or fail when there is none.
//
// Without gate-url the action does exactly what it did before the input
// existed.

const DEFAULT_REPO = 'CruGlobal/cru-deploy'
const DEFAULT_REF = 'main'

// Parse and validate the `inputs-json` action input. workflow_dispatch inputs
// are a flat map of string keys to scalar values, so the payload must be a JSON
// object (never an array or scalar). An empty/blank value means "no inputs".
export function parseInputsJson (raw) {
  const text = (raw ?? '').trim()
  if (text === '') return {}

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`inputs-json is not valid JSON: ${error.message}`, { cause: error })
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('inputs-json must be a JSON object of workflow inputs')
  }
  return parsed
}

// Split an "owner/name" repo slug into its parts, failing on anything else.
export function parseRepo (repo) {
  const parts = (repo ?? '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repo must be in "owner/name" form, got "${repo}"`)
  }
  return { owner: parts[0], repo: parts[1] }
}

async function dispatchWithToken ({ githubToken, owner, repo, workflow, ref, inputs }) {
  const octokit = getOctokit(githubToken)
  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflow,
    ref,
    inputs
  })

  core.notice(
    `Dispatched ${workflow} on ${owner}/${repo}@${ref}. ` +
    `See https://github.com/${owner}/${repo}/actions/workflows/${workflow}.`
  )
}

// gateOptions are gateDispatch's tries, waits and time limits; the action
// uses the defaults, and tests shorten them.
export async function run (gateOptions) {
  try {
    // Read first: without gate-url, github-token is required as before.
    const gateUrl = core.getInput('gate-url', { required: false })
    const githubToken = core.getInput('github-token', { required: gateUrl.trim() === '' })
    const repoInput = core.getInput('repo', { required: false }) || DEFAULT_REPO
    const workflow = core.getInput('workflow', { required: true })
    const ref = core.getInput('ref', { required: false }) || DEFAULT_REF
    const inputs = parseInputsJson(core.getInput('inputs-json', { required: false }))

    const { owner, repo } = parseRepo(repoInput)
    const gate = parseGateUrl(gateUrl)
    const target = { githubToken, owner, repo, workflow, ref, inputs }

    if (!gate) return await dispatchWithToken(target)

    // The gate starts two workflows, always on the deploy repo's main, and
    // takes no repo or ref. Anything else is not the gate's to start.
    const fallback = (why) => githubToken
      ? `${why}; dispatching ${workflow} on ${owner}/${repo}@${ref} with github-token instead`
      : `${why}, and no github-token was given to use instead`
    if (!GATE_WORKFLOWS.includes(workflow)) {
      const why = `gate-url is set, but the deploy gate starts only ${GATE_WORKFLOWS.join(' and ')}`
      if (!githubToken) throw new Error(fallback(why))
      core.info(fallback(why))
      return await dispatchWithToken(target)
    }
    if (`${owner}/${repo}`.toLowerCase() !== DEFAULT_REPO.toLowerCase() || ref !== DEFAULT_REF) {
      const why = `gate-url is set, but the deploy gate starts ${workflow} on ${DEFAULT_REPO}@${DEFAULT_REF} only`
      if (!githubToken) throw new Error(fallback(why))
      core.warning(fallback(why))
      return await dispatchWithToken(target)
    }

    if (!oidcAvailable()) {
      const why = 'gate-url is set, but this job cannot get a GitHub OIDC token for the deploy gate (it needs permissions: id-token: write)'
      if (!githubToken) throw new Error(fallback(why))
      core.warning(fallback(why))
      return await dispatchWithToken(target)
    }

    let started
    try {
      started = await gateDispatch({ ...gate, workflow, inputs }, gateOptions)
    } catch (error) {
      if (!(error instanceof GateUnavailable)) throw error
      if (!githubToken) throw new Error(fallback(error.message), { cause: error })
      core.warning(fallback(error.message))
      return await dispatchWithToken(target)
    }

    if (started.message) core.info(`the deploy gate says: ${started.message}`)
    core.notice(
      `Dispatched ${workflow} through the deploy gate. ` +
      `See ${started.runUrl || `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`}.`
    )
  } catch (error) {
    core.setFailed(error.message)
  }
}

// Auto-run as the action entrypoint, but stay import-safe under test so specs
// can exercise the exported helpers and drive run() with a mocked octokit.
if (!process.env.VITEST) run()
