import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

// dispatch: a generic cross-repo workflow_dispatch trigger for pipeline v2.
//
// v1's trigger-deploy action baked a hardcoded map of deploy-type -> workflow
// file (and cru-deploy as the only target repo). v2 splits the pipeline into
// discrete workflows (deploy-candidate / promote / rollback), so the dispatcher
// is now fully generic: the caller names the repo, workflow file, ref, and the
// inputs payload. This mirrors src/trigger-deploy.js's octokit call without any
// of its baked-in routing.

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

export async function run () {
  try {
    const githubToken = core.getInput('github-token', { required: true })
    const repoInput = core.getInput('repo', { required: false }) || 'CruGlobal/cru-deploy'
    const workflow = core.getInput('workflow', { required: true })
    const ref = core.getInput('ref', { required: false }) || 'main'
    const inputs = parseInputsJson(core.getInput('inputs-json', { required: false }))

    const { owner, repo } = parseRepo(repoInput)

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
  } catch (error) {
    core.setFailed(error.message)
  }
}

// Auto-run as the action entrypoint, but stay import-safe under test so specs
// can exercise the exported helpers and drive run() with a mocked octokit.
if (!process.env.VITEST) run()
