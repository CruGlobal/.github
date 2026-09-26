import * as core from '@actions/core'

// The authorized-attempt marker: proof, inside one job, that the
// authorize-actor check passed for the current run attempt.
//
// authorize-actor sets it when it passes. The actions that change production
// or write a record that later counts as trusted (deploy to production, a
// release tag, a production release event) refuse to run without it.
//
// Why the actions check this, and not only the workflow: "Re-run failed jobs"
// and "Re-run job" reuse the reusable workflow file from the run's first
// attempt. A run made before promote and rollback checked every attempt inside
// their production jobs is re-run with that old file, which never checks who
// started the re-run. The old file still loads these actions from the current
// release, so this is where such a re-run can still be stopped.
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
      'This happens when a run made before that check existed is re-run with "Re-run failed jobs" or "Re-run job", ' +
      'because those re-runs reuse the run\'s old workflow file. ' +
      'Use "Re-run all jobs", which loads the current workflow file, or start a new run.'
    )
  }
}
