import * as core from '@actions/core'

// The authorized-attempt marker: proof, inside one job, that the
// authorize-actor check passed for the current run attempt.
//
// authorize-actor sets it when it passes. The actions that change production
// or write a record that later counts as trusted (deploy to production, a
// release tag, a production release event) refuse to run without it.
//
// Why the actions check this, and not only the workflow: a run keeps the
// reusable workflow file it started with. "Re-run failed jobs" and "Re-run
// job" reuse the file from the run's first attempt, and a run that was already
// queued or running when a release went out keeps its older file too. A file
// from before promote and rollback checked every attempt inside their
// production jobs never checks who started the attempt. It still loads these
// actions from the current release, so this is where such a run can still be
// stopped.
//
// The marker lives in the job's environment, so it does not carry over to
// another job, and it names the attempt it was set for. A value from another
// attempt does not count. The caller of a reusable workflow cannot set it: its
// env is not passed to the called workflow.
export const AUTHORIZED_ATTEMPT_MARKER = 'CRU_V2_AUTHORIZED_ATTEMPT'

// The verified-deploy-run marker: proof, inside one job, that verify-deploy-run
// checked the app's own run for this run attempt, and for which deploy.
//
// It is narrower than the authorized-attempt marker on purpose. That one says
// an account allowed to change production started this attempt, and deploy,
// tag-image and release events accept it. This one says only that a recent,
// healthy run in the app's own repository had this commit as its head, on the
// default branch for production. So the one thing it unlocks is a release
// event of kind deploy, for the Flightdeck project, app, environment and commit
// it names (src/flightdeck-release-event.js). The deploy and tag-image actions
// never read it, and no existing workflow sets it.
export const VERIFIED_DEPLOY_RUN_MARKER = 'CRU_V2_VERIFIED_DEPLOY_RUN'

export class AttemptNotAuthorized extends Error {}

// The marker's value names the attempt and every part of the deploy it was set
// for, so a value set for one of them never counts for another. A JSON array,
// so no part can borrow a separator from its neighbour. The parts are compared
// exactly, as they will be posted, so each must already be in its final form.
const DEPLOY_PARTS = ['project', 'app', 'environment', 'sha']

function deployRunMarkerValue (attempt, deploy) {
  const parts = DEPLOY_PARTS.map((key) => deploy?.[key])
  if (parts.some((part) => typeof part !== 'string' || part === '' || part !== part.trim())) return ''
  return JSON.stringify([attempt, ...parts])
}

// The current run attempt from the runner, or '' when it is missing or not a
// whole number above zero.
export function currentRunAttempt (env = process.env) {
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? '').trim()
  return /^[1-9][0-9]*$/.test(attempt) ? attempt : ''
}

// Called by authorize-actor after it passes. Later steps in the same job see
// the marker in their environment.
export function markAttemptAuthorized (env = process.env) {
  const attempt = currentRunAttempt(env)
  if (!attempt) {
    throw new AttemptNotAuthorized('the runner did not give a run attempt number (GITHUB_RUN_ATTEMPT), so this attempt cannot be marked as checked')
  }
  core.exportVariable(AUTHORIZED_ATTEMPT_MARKER, attempt)
  return attempt
}

// Called by verify-deploy-run after it passes, for the deploy it checked: the
// Flightdeck project, the app, the environment and the commit. Later steps in
// the same job see the marker in their environment.
export function markDeployRunVerified (deploy, env = process.env) {
  const attempt = currentRunAttempt(env)
  if (!attempt) {
    throw new AttemptNotAuthorized('the runner did not give a run attempt number (GITHUB_RUN_ATTEMPT), so this attempt cannot be marked as checked')
  }
  const value = deployRunMarkerValue(attempt, deploy)
  if (!value) {
    throw new AttemptNotAuthorized(`a verified deploy needs a project, an app, an environment and a sha, each without surrounding spaces (got ${JSON.stringify(deploy ?? {})})`)
  }
  core.exportVariable(VERIFIED_DEPLOY_RUN_MARKER, value)
  return attempt
}

// True only when verify-deploy-run passed earlier in this job, for this run
// attempt, and for exactly this project, app, environment and commit. Anything
// missing is false, never an error, so a caller falls back to the stricter
// check.
export function deployRunVerifiedFor (deploy, env = process.env) {
  const attempt = currentRunAttempt(env)
  const marker = String(env[VERIFIED_DEPLOY_RUN_MARKER] ?? '')
  const value = attempt ? deployRunMarkerValue(attempt, deploy) : ''
  return value !== '' && marker === value
}

// Throws unless the marker names the current run attempt. `what` says what is
// being refused, e.g. "deploy to production".
export function assertAttemptAuthorized (what, env = process.env) {
  const attempt = currentRunAttempt(env)
  const marker = String(env[AUTHORIZED_ATTEMPT_MARKER] ?? '').trim()
  let why = ''
  if (!attempt) {
    why = 'the runner did not give a run attempt number (GITHUB_RUN_ATTEMPT)'
  } else if (!marker) {
    why = `no authorize-actor check passed earlier in this job for this run attempt (attempt ${attempt})`
  } else if (marker !== attempt) {
    why = `the authorize-actor check in this job passed for attempt ${marker}, not for this attempt (attempt ${attempt})`
  }
  if (why) {
    throw new AttemptNotAuthorized(
      `refusing to ${what}: ${why}. ` +
      'A production change needs the account that started this run attempt to be checked first, in the same job. ' +
      'This happens with a run that started on an older release of this workflow: ' +
      'a re-run with "Re-run failed jobs" or "Re-run job", which reuse the run\'s old workflow file, ' +
      'or a run that was already queued or running when the release went out. ' +
      'Use "Re-run all jobs", which loads the current workflow file, or start a new run.'
    )
  }
}
