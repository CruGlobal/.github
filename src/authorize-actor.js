import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import { AttemptNotAuthorized, currentRunAttempt, markAttemptAuthorized } from './v2/attempt-guard.js'
import { InvalidSignedRequest, parsePublicKeys, verifySignedRequest } from './v2/signed-request.js'

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
// The checks, in order. Only the first two and the last are on by default;
// with no new input set, a run is checked exactly as before they existed.
//   1. The deploy gate (gate-actor-id). Only for an attempt that the gate's
//      own machine account started: the run was first started by the account
//      whose user id is gate-actor-id, and this attempt by that same account
//      (same account as in 2). Such an attempt must carry a valid signed
//      request for this app, action and target (src/v2/signed-request.js),
//      or it is refused here, with no fall through: the gate's account has no
//      other way in, and a gate run that lost its request must not pass some
//      other way. A re-run that a person started is not the gate's attempt, so
//      it skips this check and that person is checked by 2 to 5.
//   2. Allowlisted automation. The run was first started by an account whose
//      numeric user id (github.actor_id) is in trusted-automation-actor-ids,
//      and this attempt was started by that same account. Same account means
//      the same login and the same user id. There is no user id for the
//      account that started this attempt in the run's context, only a login,
//      so the login is looked up to its id. A login that was renamed and then
//      taken by someone else does not match.
//   3. Refused accounts (refused-actor-ids). The account that started this
//      attempt is refused when its user id is listed, even if 4 or 5 would let
//      it through. It does not apply to 1 or 2, which already passed.
//   4. Break-glass (break-glass-team). An active member of that team, in the
//      app repo's org, passes. A pending invitation is not membership.
//   5. Push access. The account that started this attempt must have admin,
//      maintain or write on the app repo. allow-push-access: false turns this
//      off, so only 1, 2 and 4 can pass.
//
// A new input set to something this check cannot read (a gate-actor-id that
// is not a number, a team slug with a slash) is a refusal, not a warning: the
// input was set on purpose, and ignoring it would quietly change who passes.
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

// The new inputs. Each one, set to something this check cannot read, is a
// Refusal: see the header comment.
function parseGateActorId (raw) {
  const value = String(raw ?? '').trim()
  if (value === '' || /^[0-9]+$/.test(value)) return value
  throw new Refusal(`gate-actor-id must be one numeric GitHub user id, not '${value}'`)
}

// A list of accounts to refuse, so an entry that is not a number is not
// skipped as it is for the allowlist: skipping it would let that account in.
function parseRefusedActorIds (raw) {
  const { ids, ignored } = parseActorIds(raw)
  if (ignored.length > 0) {
    throw new Refusal(`refused-actor-ids must hold numeric GitHub user ids only; cannot read ${ignored.map((entry) => `'${entry}'`).join(', ')}`)
  }
  return ids
}

// A team slug in the app repo's org, e.g. "ops-team". "org/team" is refused:
// the org is always the app repo's.
function parseTeamSlug (raw) {
  const value = String(raw ?? '').trim()
  if (value === '' || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) return value
  throw new Refusal(`break-glass-team must be a team slug in the app repo's org, like "ops-team", not '${value}'`)
}

function parseSwitch (raw, name) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new Refusal(`${name} must be "true" or "false", not '${String(raw).trim()}'`)
}

// Decide whether this attempt may go ahead. Returns how it passed ('gate',
// 'automation', 'break-glass' or 'push-access') or throws a Refusal saying
// why not.
export async function authorize ({
  octokit,
  repository,
  operation,
  actor,
  actorId,
  triggeringActor,
  runAttempt,
  trustedActorIds,
  gateActorId,
  signedRequest,
  gatePublicKeys,
  gateIssuer,
  gateAudience,
  expectedApp,
  expectedAction,
  expectedTarget,
  refusedActorIds,
  breakGlassTeam,
  allowPushAccess,
  claimRequestId,
  now = Date.now,
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

  let gateId, refusedIds, team, pushAccessCounts
  try {
    gateId = parseGateActorId(gateActorId)
    refusedIds = parseRefusedActorIds(refusedActorIds)
    team = parseTeamSlug(breakGlassTeam)
    pushAccessCounts = parseSwitch(allowPushAccess, 'allow-push-access')
  } catch (error) {
    if (error instanceof Refusal) throw new Refusal(`${error.message}; refusing to ${operation} ${appRepo}`)
    throw error
  }

  const { ids, ignored } = parseActorIds(trustedActorIds)
  for (const entry of ignored) {
    core.warning(`ignoring trusted-automation-actor-ids entry '${entry}' (not a numeric user id)`)
  }

  // The gate, the allowlist and the refused list may each need the user id of
  // the login that started this attempt. Ask GitHub once.
  let lookup
  async function triggeringUserId (cannot) {
    let user
    try {
      if (!lookup) {
        lookup = withRetry(`Looking up the user id of ${triggeringActor}`,
          (request) => octokit.rest.users.getByUsername({ username: triggeringActor, request }), retry)
      }
      user = await lookup
    } catch (error) {
      throw new Refusal(`could not look up the user id of ${triggeringActor} (${describeError(error, timeoutMs)}), so ${triggeringActor}, the account that started ${thisAttempt}, ${cannot}; refusing to ${operation} ${appRepo}`)
    }
    const id = user?.data?.id
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new Refusal(`the user lookup for ${triggeringActor} returned no user id, so ${triggeringActor}, the account that started ${thisAttempt}, ${cannot}; refusing to ${operation} ${appRepo}`)
    }
    return String(id)
  }

  // What was tried, for a refusal that names every way in. Only listed when
  // one of the new inputs is set, so a refusal reads as it always has.
  const tried = []
  const listTried = Boolean(gateId || team || !pushAccessCounts)

  // The gate's attempt either passes here or is refused here.
  async function passAsGate () {
    const why = `${triggeringActor}, the deploy gate's account, started ${thisAttempt}, so it needs a valid signed request`
    let verified
    try {
      verified = verifySignedRequest(signedRequest, {
        keys: String(gatePublicKeys ?? '').trim() === '' ? [] : parsePublicKeys(gatePublicKeys),
        issuer: gateIssuer,
        audience: gateAudience,
        expected: { app: expectedApp, action: expectedAction, target: expectedTarget },
        now: now()
      })
    } catch (error) {
      if (error instanceof InvalidSignedRequest) throw new Refusal(`${why}, and ${error.message}; refusing to ${operation} ${appRepo}`)
      throw error
    }
    const { claims, kid } = verified

    // ONE-TIME IDS: NOT DONE YET. A valid request can still be presented again
    // until it expires, because nothing records its jti yet. The record needs
    // a table that does not exist yet; when it does, run() passes a
    // claimRequestId that records the jti and throws when it is already taken.
    // "Taken" has to mean taken by another run, not by this one: lookup and
    // every production job of the same run check the same request, and so
    // does a re-run that the gate's account starts.
    if (claimRequestId) {
      try {
        await claimRequestId(claims)
      } catch (error) {
        throw new Refusal(`${why}, and its request id ${claims.jti} could not be claimed for this run (${describeError(error, timeoutMs)}); refusing to ${operation} ${appRepo}`)
      }
    }

    core.notice(`${triggeringActor}, the deploy gate's account, started ${thisAttempt} with a signed request from ${claims.sub} to ${claims.action} ${claims.app} at ${claims.target} (request id ${claims.jti}${kid ? `, key ${kid}` : ''}), so the other checks on ${appRepo} do not apply`)
    return 'gate'
  }

  // 1. The deploy gate.
  if (gateId && actorId === gateId) {
    if (triggeringActor === actor) {
      const id = await triggeringUserId('cannot be matched to the deploy gate\'s account')
      if (id === gateId) return passAsGate()
      core.warning(`the login ${triggeringActor} started ${thisAttempt}, but that login now belongs to user id ${id}, not the deploy gate's user id ${gateId} that started the run, so no signed request is used and ${triggeringActor} is checked like any other account`)
    } else {
      core.notice(`this run was first started by the deploy gate's account ${actor}, but ${thisAttempt} was started by ${triggeringActor}, so no signed request is used and ${triggeringActor} is checked like any other account`)
    }
  } else if (String(signedRequest ?? '').trim() !== '') {
    core.notice(`a signed request was given, but ${thisAttempt} was not started by the deploy gate's account${gateId ? '' : ' (no gate-actor-id is set)'}, so it is not used`)
  }
  if (gateId) tried.push('the deploy gate (this attempt was not started by its account)')

  // 2. Allowlisted automation.
  if (actorId && ids.includes(actorId)) {
    if (triggeringActor === actor) {
      const id = await triggeringUserId('cannot be matched to the automation allowlist')
      if (id === actorId) {
        core.notice(`${triggeringActor} (user id ${actorId}) is an allowlisted automation account and started ${thisAttempt} itself, so the push-access check on ${appRepo} does not apply`)
        return 'automation'
      }
      core.warning(`the login ${triggeringActor} started ${thisAttempt}, but that login now belongs to user id ${id}, not the allowlisted user id ${actorId} that started the run, so ${triggeringActor}'s own access on ${appRepo} is checked`)
    } else {
      core.notice(`this run was first started by allowlisted automation account ${actor}, but ${thisAttempt} was started by ${triggeringActor}, so ${triggeringActor}'s own access on ${appRepo} is checked`)
    }
    tried.push('the automation allowlist (this attempt was not started by the allowlisted account)')
  }

  // 3. Refused accounts.
  if (refusedIds.length > 0) {
    const id = await triggeringUserId('cannot be checked against refused-actor-ids')
    if (refusedIds.includes(id)) {
      throw new Refusal(`${triggeringActor} (user id ${id}) is in refused-actor-ids, so it may not ${operation} ${appRepo} by break-glass or push access. The account checked is ${triggeringActor}, the one that started ${thisAttempt}${startedBy}.`)
    }
  }

  // 4. Break-glass.
  if (team) {
    let membership = null
    try {
      membership = await withRetry(`Reading the membership of ${triggeringActor} in the break-glass team ${owner}/${team}`,
        (request) => octokit.rest.teams.getMembershipForUserInOrg({ org: owner, team_slug: team, username: triggeringActor, request }), retry)
    } catch (error) {
      // GitHub answers 404 for "not a member". It answers the same when the
      // team does not exist or the token cannot see it, so the message says
      // so: a typo in the slug looks like nobody being on the team.
      if (error?.status !== 404) {
        throw new Refusal(`could not read the membership of ${triggeringActor} in the break-glass team ${owner}/${team} (${describeError(error, timeoutMs)}), so ${triggeringActor}, the account that started ${thisAttempt}, cannot be checked; refusing to ${operation} ${appRepo}`)
      }
    }
    const state = membership?.data?.state
    if (state === 'active') {
      core.notice(`${triggeringActor} is an active member of the break-glass team ${owner}/${team} and started ${thisAttempt}${startedBy}, so it may ${operation} ${appRepo}`)
      return 'break-glass'
    }
    const why = membership
      ? `membership state: ${typeof state === 'string' && state ? state : 'unknown'}`
      : 'GitHub answered 404: not a member, or the team does not exist or this token cannot see it'
    core.info(`${triggeringActor} is not an active member of the break-glass team ${owner}/${team} (${why})`)
    tried.push(`the break-glass team ${owner}/${team} (${why})`)
  }

  // 5. Push access.
  if (!pushAccessCounts) {
    throw new Refusal(`${triggeringActor} is not authorized to ${operation} ${appRepo}: push access does not count for this run (allow-push-access is false). The account checked is ${triggeringActor}, the one that started ${thisAttempt}${startedBy}. Tried: ${tried.length ? tried.join('; ') : 'nothing else is configured'}.`)
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
    tried.push(`push access on ${appRepo} (permission: ${permission})`)
    throw new Refusal(`${triggeringActor} is not authorized to ${operation} ${appRepo} (permission: ${permission}). Requires admin, write, or maintain. The account checked is ${triggeringActor}, the one that started ${thisAttempt}${startedBy}.${listTried ? ` Tried: ${tried.join('; ')}.` : ''}`)
  }
  return 'push-access'
}

// Fail the step with `message`. With a title, the error annotation carries it,
// so automation that started the run can read a fixed reason word instead of
// parsing the message. This is what core.setFailed does, plus the title.
function refuse (message, title) {
  if (!title) {
    core.setFailed(message)
    return
  }
  process.exitCode = core.ExitCode.Failure
  core.error(message, { title })
}

export async function run ({ env = process.env, sleep, timeoutMs } = {}) {
  const refusalTitle = core.getInput('refusal-title').trim()
  try {
    const operation = core.getInput('operation')
    const token = core.getInput('github-token')
    if (!token) {
      throw new Refusal(`no github-token was given, so the account that started this run attempt cannot be checked; refusing to ${operation || 'change production'}`)
    }
    const passedAs = await authorize({
      octokit: getOctokit(token),
      repository: core.getInput('repository'),
      operation,
      actor: env.GITHUB_ACTOR,
      actorId: env.GITHUB_ACTOR_ID,
      triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      trustedActorIds: core.getInput('trusted-automation-actor-ids'),
      gateActorId: core.getInput('gate-actor-id'),
      signedRequest: core.getInput('signed-request'),
      gatePublicKeys: core.getInput('gate-public-keys'),
      gateIssuer: core.getInput('gate-issuer'),
      gateAudience: core.getInput('gate-audience'),
      expectedApp: core.getInput('expected-app'),
      expectedAction: core.getInput('expected-action'),
      expectedTarget: core.getInput('expected-target'),
      refusedActorIds: core.getInput('refused-actor-ids'),
      breakGlassTeam: core.getInput('break-glass-team'),
      allowPushAccess: core.getInput('allow-push-access'),
      // TODO(one-time ids): pass a claimRequestId here once the table that
      // records request ids exists. See the note in authorize().
      sleep,
      timeoutMs
    })
    // Only a pass reaches here. Later steps in this job can now see that this
    // attempt was checked, and how: a workflow can ask more of an automation
    // account than of a person.
    markAttemptAuthorized(env)
    core.setOutput('passed-as', passedAs)
  } catch (error) {
    // Anything that is not a pass is a refusal, including a bug in this code.
    refuse(error instanceof Refusal || error instanceof AttemptNotAuthorized
      ? error.message
      : `could not check the account that started this run attempt (${describeError(error, timeoutMs ?? REQUEST_TIMEOUT_MS)}); refusing to go ahead`,
    refusalTitle)
  }
}
