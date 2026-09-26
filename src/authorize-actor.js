import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import { AttemptNotAuthorized, currentRunAttempt, markAttemptAuthorized } from './v2/attempt-guard.js'

// authorize-actor: refuse a production change unless the account that started
// THIS run attempt is allowed to make it (pipeline v2 promote and rollback).
//
// The account checked is the one that started this attempt
// (github.triggering_actor), not github.actor. On a re-run, github.actor stays
// the account that started the first attempt, and the re-run runs with that
// account's rights. So the person who pressed re-run is the one whose access
// counts.
//
// Both workflows run this in `lookup` and again as the first step of every job
// that changes production. "Re-run failed jobs" re-runs only the failed jobs
// and reuses the result of a `lookup` that passed in an earlier attempt, so a
// check in `lookup` alone would never see who started the re-run.
//
// A run passes in one of two ways:
//   1. Allowlisted automation. The run was first started by an account whose
//      numeric user id (github.actor_id) is in trusted-automation-actor-ids,
//      and this attempt was started by that same account. Same account means
//      the same login and the same user id. There is no user id for the
//      account that started this attempt in the run's context, only a login,
//      so the login is looked up to its id. A login that was renamed and then
//      taken by someone else does not match.
//   2. Push access. Otherwise the account that started this attempt must have
//      admin, maintain or write on the app repo.
//
// On a pass it sets the authorized-attempt marker for the rest of the job
// (src/v2/attempt-guard.js). The deploy, tag-image and release-event actions
// refuse production work without it.
//
// It fails closed: a missing value, an API error, a request that gets no
// answer in time or a response it does not understand is a refusal, never a
// pass.
//
// The accounts come from the runner's own GITHUB_ACTOR, GITHUB_ACTOR_ID and
// GITHUB_TRIGGERING_ACTOR, not from inputs, so a caller cannot pass the wrong
// one by mistake.
//
// The action's entry point is src/entry/authorize-actor.js, which always runs
// the check. This module never runs anything on import, so tests can load it.

export const ALLOWED_PERMISSIONS = ['admin', 'maintain', 'write']
const ATTEMPTS = 3
const RETRY_DELAY_MS = 2000
// Each request gets this long to answer. With the retries, one lookup gives up
// after about 36 seconds at most, so a GitHub API that hangs cannot hold the
// production lock for long.
export const REQUEST_TIMEOUT_MS = 10000

class Refusal extends Error {}

// Whole entries only, compared later as exact strings, so 12 never matches
// 123. Commas or newlines separate entries. Surrounding whitespace and blank
// entries are skipped. Anything else that is not a plain number is returned
// in `ignored` so the caller can warn about it; it never matches.
export function parseActorIds (raw) {
  const ids = []
  const ignored = []
  for (const entry of String(raw ?? '').split(/[,\n]/)) {
    const value = entry.trim()
    if (value === '') continue
    if (/^[0-9]+$/.test(value)) ids.push(value)
    else ignored.push(value)
  }
  return { ids, ignored }
}

// Split an "owner/name" repo slug into its parts, refusing anything else.
export function parseRepo (repository) {
  const parts = String(repository ?? '').trim().split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Refusal(`the app repo "${repository ?? ''}" is not in owner/name form`)
  }
  return { owner: parts[0], repo: parts[1] }
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Retry only what may pass on a second try: a server error, a request that
// never got an answer, or one that ran out of time. A 4xx is an answer, so it
// is never retried. Each try gets its own timeout.
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

function describeError (error, timeoutMs) {
  const names = [error?.name, error?.cause?.name]
  if (names.includes('TimeoutError') || names.includes('AbortError')) {
    return `no answer within ${timeoutMs / 1000} seconds`
  }
  if (error?.status !== undefined) return `HTTP ${error.status}: ${error.message}`
  return error?.message || String(error)
}

// Decide whether this attempt may go ahead. Returns how it passed
// ('automation' or 'push-access') or throws a Refusal saying why not.
export async function authorize ({
  octokit,
  repository,
  operation,
  actor,
  actorId,
  triggeringActor,
  runAttempt,
  trustedActorIds,
  sleep = sleepFor,
  timeoutMs = REQUEST_TIMEOUT_MS
}) {
  operation = String(operation ?? '').trim() || 'change production for'
  actor = String(actor ?? '').trim()
  actorId = String(actorId ?? '').trim()
  triggeringActor = String(triggeringActor ?? '').trim()
  const { owner, repo } = parseRepo(repository)
  const appRepo = `${owner}/${repo}`
  const retry = { sleep, timeoutMs }

  if (!triggeringActor) {
    throw new Refusal(`the runner did not say which account started this run attempt (GITHUB_TRIGGERING_ACTOR is empty); refusing to ${operation} ${appRepo}`)
  }
  const attempt = currentRunAttempt({ GITHUB_RUN_ATTEMPT: runAttempt })
  if (!attempt) {
    throw new Refusal(`the runner did not give a run attempt number (GITHUB_RUN_ATTEMPT is "${runAttempt ?? ''}"); refusing to ${operation} ${appRepo}`)
  }
  const thisAttempt = `this run attempt (attempt ${attempt})`
  const startedBy = actor && actor !== triggeringActor
    ? `; the run was first started by ${actor}`
    : ''

  const { ids, ignored } = parseActorIds(trustedActorIds)
  for (const entry of ignored) {
    core.warning(`ignoring trusted-automation-actor-ids entry '${entry}' (not a numeric user id)`)
  }

  if (actorId && ids.includes(actorId)) {
    if (triggeringActor === actor) {
      let user
      try {
        user = await withRetry(`Looking up the user id of ${triggeringActor}`,
          (request) => octokit.rest.users.getByUsername({ username: triggeringActor, request }), retry)
      } catch (error) {
        throw new Refusal(`could not look up the user id of ${triggeringActor} (${describeError(error, timeoutMs)}), so ${triggeringActor}, the account that started ${thisAttempt}, cannot be matched to the automation allowlist; refusing to ${operation} ${appRepo}`)
      }
      const id = user?.data?.id
      if (typeof id !== 'number' && typeof id !== 'string') {
        throw new Refusal(`the user lookup for ${triggeringActor} returned no user id, so ${triggeringActor}, the account that started ${thisAttempt}, cannot be matched to the automation allowlist; refusing to ${operation} ${appRepo}`)
      }
      if (String(id) === actorId) {
        core.notice(`${triggeringActor} (user id ${actorId}) is an allowlisted automation account and started ${thisAttempt} itself, so the push-access check on ${appRepo} does not apply`)
        return 'automation'
      }
      core.warning(`the login ${triggeringActor} started ${thisAttempt}, but that login now belongs to user id ${id}, not the allowlisted user id ${actorId} that started the run, so ${triggeringActor}'s own access on ${appRepo} is checked`)
    } else {
      core.notice(`this run was first started by allowlisted automation account ${actor}, but ${thisAttempt} was started by ${triggeringActor}, so ${triggeringActor}'s own access on ${appRepo} is checked`)
    }
  }

  let response
  try {
    response = await withRetry(`Reading the permission of ${triggeringActor} on ${appRepo}`,
      (request) => octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: triggeringActor, request }), retry)
  } catch (error) {
    throw new Refusal(`could not read the permission of ${triggeringActor} on ${appRepo} (${describeError(error, timeoutMs)}), so ${triggeringActor}, the account that started ${thisAttempt}, cannot be checked; refusing to ${operation} ${appRepo}`)
  }
  const permission = response?.data?.permission
  if (typeof permission !== 'string' || permission === '') {
    throw new Refusal(`the permission lookup for ${triggeringActor} on ${appRepo} did not return a permission, so ${triggeringActor}, the account that started ${thisAttempt}, cannot be checked; refusing to ${operation} ${appRepo}`)
  }
  core.notice(`${triggeringActor} has '${permission}' on ${appRepo}. ${triggeringActor} is the account that started ${thisAttempt}${startedBy}.`)
  if (!ALLOWED_PERMISSIONS.includes(permission)) {
    throw new Refusal(`${triggeringActor} is not authorized to ${operation} ${appRepo} (permission: ${permission}). Requires admin, write, or maintain. The account checked is ${triggeringActor}, the one that started ${thisAttempt}${startedBy}.`)
  }
  return 'push-access'
}

export async function run ({ env = process.env, sleep, timeoutMs } = {}) {
  try {
    const operation = core.getInput('operation')
    const token = core.getInput('github-token')
    if (!token) {
      throw new Refusal(`no github-token was given, so the account that started this run attempt cannot be checked; refusing to ${operation || 'change production'}`)
    }
    await authorize({
      octokit: getOctokit(token),
      repository: core.getInput('repository'),
      operation,
      actor: env.GITHUB_ACTOR,
      actorId: env.GITHUB_ACTOR_ID,
      triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      trustedActorIds: core.getInput('trusted-automation-actor-ids'),
      sleep,
      timeoutMs
    })
    // Only a pass reaches here. Later steps in this job can now see that this
    // attempt was checked.
    markAttemptAuthorized(env)
  } catch (error) {
    // Anything that is not a pass is a refusal, including a bug in this code.
    core.setFailed(error instanceof Refusal || error instanceof AttemptNotAuthorized
      ? error.message
      : `could not check the account that started this run attempt (${describeError(error, timeoutMs ?? REQUEST_TIMEOUT_MS)}); refusing to go ahead`)
  }
}
