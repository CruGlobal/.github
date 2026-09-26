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

export class AttemptNotAuthorized extends Error {}

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
