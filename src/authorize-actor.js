import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import { AttemptNotAuthorized, currentRunAttempt, markAttemptAuthorized } from './v2/attempt-guard.js'
import { InvalidSignedRequest, RequestIdTaken, parsePublicKeys, verifySignedRequest } from './v2/signed-request.js'

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
// The checks, in order. Only the allowlist and push access are on by default;
// with no new input set, a run is checked exactly as before the others
// existed.
//   1. The deploy gate (gate-actor-id). Only for an attempt that the gate's
//      own machine account started: the run was first started by the account
//      whose user id is gate-actor-id, and this attempt by that same account
//      (same account as in 3). Such an attempt must carry a valid signed
//      request for this app, action and target (src/v2/signed-request.js),
//      whose one-time request id this run attempt can claim, or it is refused
//      here, with no fall through: the gate's account has no other way in,
//      and a gate run that lost its request must not pass some other way. A
//      re-run that a person started is not the gate's attempt, so it skips
//      this check and that person is checked by 2 to 5.
//   2. Refused accounts (refused-actor-ids). The account that started this
//      attempt is refused when its user id is listed, even if 3, 4 or 5 would
//      let it through. Only the gate comes before it, because the gate's own
//      attempt never gets this far: it passes or is refused in 1.
//   3. Allowlisted automation. The run was first started by an account whose
//      numeric user id (github.actor_id) is in trusted-automation-actor-ids,
//      and this attempt was started by that same account. Same account means
//      the same login and the same user id. There is no user id for the
//      account that started this attempt in the run's context, only a login,
//      so the login is looked up to its id. A login that was renamed and then
//      taken by someone else does not match. The gate's account may not be on
//      this list: it must never pass without a signed request.
//   4. Break-glass (break-glass-team, as "org/team-slug"). An active member of
//      that team passes. A pending invitation is not membership, and a team
//      with child teams is refused, because GitHub counts the members of a
//      child team as members of its parent.
//   5. Push access. The account that started this attempt must have admin,
//      maintain or write on the app repo. allow-push-access: false turns this
//      off, so only 1, 3 and 4 can pass.
//
// A new input set to something this check cannot read (a gate-actor-id that
// is not a number, a break-glass-team without its org) is a refusal, not a
// warning: the input was set on purpose, and ignoring it would quietly change
// who passes.
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

// How long past its expiry a signed request may still pass, and only for the
// run attempt that claimed its one-time id while it was fresh. A production
// job waits for the production lock while another change to the same app
// runs, which can take longer than the request's five minutes. Two hours
// covers a long wait behind a slow deploy. A job that waited longer than that
// is better started again from the gate, with a fresh request, than shipped
// on an approval that old. Two clocks apply it, counted from different
// points: this check counts two hours from the request's exp, by the
// runner's clock, and the request id store counts two hours from the time it
// recorded the claim, by its own clock. A request must pass both.
export const HELD_REQUEST_MAX_SECONDS_PAST_EXPIRY = 2 * 60 * 60

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

// GitHub allows letters, digits, ".", "_" and "-" in an owner or a repo name,
// and no owner starts with a dot. The parts go into API paths, where "." or
// ".." would point the request at a different route, so those are refused.
// Nothing stricter than GitHub, since every caller passes through here.
const REPO_PART = /^[A-Za-z0-9._-]+$/

// Split an "owner/name" repo slug into its parts, refusing anything else.
export function parseRepo (repository, what = 'the app repo') {
  const parts = String(repository ?? '').trim().split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Refusal(`${what} "${repository ?? ''}" is not in owner/name form`)
  }
  const [owner, repo] = parts
  if (!REPO_PART.test(owner) || owner.startsWith('.') || !REPO_PART.test(repo) || repo === '.' || repo === '..') {
    throw new Refusal(`${what} "${owner}/${repo}" is not a name GitHub allows (letters, digits, ".", "_" and "-" only; an owner cannot start with "." and a name cannot be "." or "..")`)
  }
  return { owner, repo }
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

// Give `call` a signal that aborts after timeoutMs, and stop waiting for it
// then, whether or not it listens. AbortSignal.timeout is not used here: its
// timer does not keep Node running, so a call that waits on nothing would let
// the process end, with the step passed and no refusal written, before the
// time ran out. This timer keeps the process up until one or the other.
class TimeLimitReached extends Error {
  constructor (timeoutMs) {
    super(`no answer within ${timeoutMs / 1000} seconds`)
    this.name = 'TimeoutError'
  }
}

async function withTimeLimit (call, timeoutMs) {
  const controller = new AbortController()
  let timer
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new TimeLimitReached(timeoutMs))
      reject(controller.signal.reason)
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), timedOut])
  } finally {
    clearTimeout(timer)
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

// "org/team-slug", the way GitHub itself names a team. The org is named here
// rather than taken from the app repo's owner, which comes from app-info data:
// an owner of "..", for one, would turn the membership URL into a different
// GitHub route. An org name is letters, digits and hyphens, not starting with
// a hyphen. A slug starts with a letter or digit, so it is never "." or "..".
const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const TEAM_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
function parseTeam (raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return null
  const parts = value.split('/')
  if (parts.length === 2 && ORG_NAME.test(parts[0]) && TEAM_SLUG.test(parts[1])) {
    return { org: parts[0], slug: parts[1], name: value }
  }
  throw new Refusal(`break-glass-team must be a team as "org/team-slug", like "example-org/ops-team", not '${value}'`)
}

function parseSwitch (raw, name) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new Refusal(`${name} must be "true" or "false", not '${String(raw).trim()}'`)
}

// A store's error is never shown, since its text may hold a connection string.
// Only its name is, when that is a plain identifier.
const errorName = (error) => (typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : '')

// Decide whether this attempt may go ahead. Returns how it passed ('gate',
// 'automation', 'break-glass' or 'push-access') or throws a Refusal saying
// why not.
//
// workflowRepository and runId name the run this check is part of (the
// runner's GITHUB_REPOSITORY and GITHUB_RUN_ID), as opposed to `repository`,
// the app repo it changes. Only the gate needs them.
export async function authorize ({
  octokit,
  repository,
  operation,
  actor,
  actorId,
  triggeringActor,
  runAttempt,
  workflowRepository,
  runId,
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
    team = parseTeam(breakGlassTeam)
    pushAccessCounts = parseSwitch(allowPushAccess, 'allow-push-access')
  } catch (error) {
    if (error instanceof Refusal) throw new Refusal(`${error.message}; refusing to ${operation} ${appRepo}`)
    throw error
  }

  const { ids, ignored } = parseActorIds(trustedActorIds)
  for (const entry of ignored) {
    core.warning(`ignoring trusted-automation-actor-ids entry '${entry}' (not a numeric user id)`)
  }
  if (gateId && ids.includes(gateId)) {
    throw new Refusal(`gate-actor-id ${gateId} is also in trusted-automation-actor-ids. The deploy gate's account may pass only with a signed request, never as plain automation, so take it off the allowlist; refusing to ${operation} ${appRepo}`)
  }

  // The gate, the refused list and the allowlist may each need the user id of
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
    const refusal = (reason) => new Refusal(`${why}, and ${reason}; refusing to ${operation} ${appRepo}`)

    // An expired request is let through verification here, and stopped below
    // unless this run attempt claimed its id while it was fresh.
    let verified
    try {
      verified = verifySignedRequest(signedRequest, {
        keys: String(gatePublicKeys ?? '').trim() === '' ? [] : parsePublicKeys(gatePublicKeys),
        issuer: gateIssuer,
        audience: gateAudience,
        expected: { app: expectedApp, action: expectedAction, target: expectedTarget },
        now: now(),
        allowExpired: true
      })
    } catch (error) {
      if (error instanceof InvalidSignedRequest) throw refusal(error.message)
      throw error
    }
    const { claims, expired, secondsPastExpiry, kid, keyNumber, keyCount } = verified

    if (expired && secondsPastExpiry > HELD_REQUEST_MAX_SECONDS_PAST_EXPIRY) {
      throw refusal(`the signed request expired ${secondsPastExpiry} seconds ago, more than the ${HELD_REQUEST_MAX_SECONDS_PAST_EXPIRY / 3600} hours a run attempt may keep using a request it claimed while it was fresh`)
    }

    // Without a store, nothing stops one request from being used twice, so
    // signed requests are not accepted at all.
    if (typeof claimRequestId !== 'function') {
      throw refusal('the one-time request id store is not set up, so signed requests cannot be used yet')
    }

    // The run this check is part of, which the request id is claimed for.
    let workflowRepo
    try {
      const parsed = parseRepo(workflowRepository, 'the repository this workflow runs in (GITHUB_REPOSITORY)')
      workflowRepo = `${parsed.owner}/${parsed.repo}`
    } catch (error) {
      if (error instanceof Refusal) throw refusal(`${error.message}, so its request id cannot be claimed for this run`)
      throw error
    }
    const id = String(runId ?? '').trim()
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw refusal(`the runner did not give a run id (GITHUB_RUN_ID is "${runId ?? ''}"), so its request id cannot be claimed for this run`)
    }

    // ONE-TIME REQUEST IDS. A signed request may change production for one run
    // only. lookup and every production job of the run check the same request,
    // and a production job may wait more than five minutes for the production
    // lock, so a later job can find the request expired. The rule: the first
    // check of a run (lookup, before any lock) needs a fresh request, and a
    // later check may use an expired one only if this same run attempt claimed
    // its id while it was fresh.
    //
    // claimRequestId({ claims, expired, run: { repository, id, attempt },
    // signal }) resolves 'claimed' or 'held', or throws. `run` is this
    // workflow's repository, run id and attempt, all strings. The store behind
    // it is not built yet; this is the contract it is built against.
    //
    // "The same run" means the same (repository, run id). A run's attempt
    // numbers only go up, so an id only ever moves to a higher attempt.
    //   - Fresh (expired is false): if nothing holds the jti, record it for
    //     (repository, id, attempt) and answer 'claimed'. If this run attempt
    //     holds it, answer 'held'. If the same run holds it at a lower
    //     attempt, move it to this attempt, with a new claim time, and answer
    //     'held'. Otherwise (another run, or a higher attempt of this one),
    //     throw RequestIdTaken.
    //   - The store's own clock decides "fresh" too. Refuse a create or a move
    //     once the store's clock is past claims.exp plus 60 seconds of skew
    //     (and a small allowance of its own), by throwing an error named for
    //     the reason, such as RequestExpired. Do not trust `expired` alone: a
    //     move starts a new two-hour window, and a runner whose clock is
    //     behind must not be able to start one with an old request.
    //   - Expired: never write. Answer 'held' only if this exact run attempt
    //     holds the jti and claimed it no more than two hours ago by the
    //     store's own clock. Otherwise throw RequestIdTaken: the id is not this
    //     attempt's to use.
    //   - Keep each record at least two hours after its latest claim. Deleting
    //     it sooner would let another run claim a request that is still fresh,
    //     and would turn away this attempt's later jobs. A lazy expiry that
    //     deletes it some time after that is fine.
    //   - Every write is conditional (create only if absent, move only from
    //     the record just read), so two runs racing for one id cannot both
    //     win.
    //   - Only the deploy workflows can write. The role that writes trusts only
    //     the deploy reusable workflows, through the OIDC job_workflow_ref
    //     claim, never a role that any workflow in the repository can assume.
    //   - The record is keyed on the jti claim alone, never on the request's
    //     text: an ECDSA signature and its high-S twin both verify, so one
    //     request can arrive as two strings.
    //   - Throw the RequestIdTaken class exported from src/v2/signed-request.js.
    //     An error that only has the same name is treated as the store failing.
    //   - Throw any other error when the store cannot answer. Its text is never
    //     shown, since it may hold a connection string; only its name is.
    //   - Stop when `signal` aborts, and give the store client its own request
    //     timeouts as well. This check stops waiting when the signal aborts,
    //     but a socket the client leaves open keeps Node running, and with it
    //     the step, inside the production lock.
    //
    // Why the attempt, and not just the run: "Re-run failed jobs" keeps the
    // earlier attempt's lookup result and runs only the production jobs, with
    // the old request. Bound to the run alone, anyone holding the gate App's
    // GitHub credentials could start that re-run days later, and the
    // production job would accept the old, expired request and ship its old
    // target again. Bound to the attempt, an id moves to a new attempt only
    // with a fresh request, and only the gate can make one of those.
    let answer
    try {
      answer = await withTimeLimit((signal) => claimRequestId({
        claims,
        expired,
        run: { repository: workflowRepo, id, attempt },
        signal
      }), timeoutMs)
    } catch (error) {
      if (error instanceof RequestIdTaken) {
        throw refusal(expired
          ? `the signed request expired ${secondsPastExpiry} seconds ago, which is allowed only for the run attempt that claimed its request id ${claims.jti} while it was fresh, and the one-time request id store says ${thisAttempt} is not that attempt`
          : `its request id ${claims.jti} was already claimed by another run`)
      }
      const detail = error instanceof TimeLimitReached ? error.message : errorName(error)
      throw refusal(`the one-time request id store could not be reached or answered${detail ? ` (${detail})` : ''}`)
    }
    const accepted = expired ? ['held'] : ['claimed', 'held']
    if (!accepted.includes(answer)) {
      throw refusal(expired && answer === 'claimed'
        ? `the signed request expired ${secondsPastExpiry} seconds ago, and the one-time request id store answered 'claimed' for it, which it must never do for an expired request`
        : `the one-time request id store gave an answer this check does not know (only ${accepted.map((value) => `'${value}'`).join(' or ')} passes ${expired ? 'an expired' : 'a fresh'} request)`)
    }

    const held = answer === 'claimed' ? 'claimed for this run attempt' : 'already held by this run attempt'
    const age = expired ? `, expired ${secondsPastExpiry} seconds ago` : ''
    core.notice(`${triggeringActor}, the deploy gate's account, started ${thisAttempt} with a signed request from ${claims.sub} to ${claims.action} ${claims.app} at ${claims.target} (request id ${claims.jti}, ${held}${age}; verified with key ${keyNumber} of ${keyCount}${kid ? `, kid ${kid}` : ''}), so the other checks on ${appRepo} do not apply`)
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

  // 2. Refused accounts.
  if (refusedIds.length > 0) {
    const id = await triggeringUserId('cannot be checked against refused-actor-ids')
    if (refusedIds.includes(id)) {
      throw new Refusal(`${triggeringActor} (user id ${id}) is in refused-actor-ids, so it may not ${operation} ${appRepo} as allowlisted automation, by break-glass or by push access. The account checked is ${triggeringActor}, the one that started ${thisAttempt}${startedBy}.`)
    }
  }

  // 3. Allowlisted automation.
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

  // 4. Break-glass.
  if (team) {
    const { org, slug, name } = team
    let membership = null
    try {
      membership = await withRetry(`Reading the membership of ${triggeringActor} in the break-glass team ${name}`,
        (request) => octokit.rest.teams.getMembershipForUserInOrg({ org, team_slug: slug, username: triggeringActor, request }), retry)
    } catch (error) {
      // GitHub answers 404 for "not a member". It answers the same when the
      // team does not exist or the token cannot see it, so a typo in the slug
      // looks like nobody being on the team. That is checked just below. An
      // org owner who is not on the team gets the same 404, so being an owner
      // does not pass break-glass.
      if (error?.status !== 404) {
        throw new Refusal(`could not read the membership of ${triggeringActor} in the break-glass team ${name} (${describeError(error, timeoutMs)}), so ${triggeringActor}, the account that started ${thisAttempt}, cannot be checked; refusing to ${operation} ${appRepo}`)
      }
    }

    if (!membership) {
      // Ask for the team itself, once, so a break-glass setup that cannot work
      // shows on every run, not first in an emergency. Either way the answer
      // stays "not a member".
      try {
        await octokit.rest.teams.getByName({ org, team_slug: slug, request: { signal: AbortSignal.timeout(timeoutMs) } })
      } catch (error) {
        const detail = describeError(error, timeoutMs)
        core.warning(error?.status >= 400 && error.status < 500
          ? `the break-glass team ${name} was not found, or this token cannot see it (${detail}); the token needs read:org. Until that is fixed, nobody can pass by break-glass`
          : `could not check that the break-glass team ${name} exists (${detail})`)
      }
    }

    const state = membership?.data?.state
    if (state === 'active') {
      // GitHub counts the members of a child team as members of its parent,
      // and a child team can have its own maintainers. With child teams, an
      // active membership does not show this account was put on this team
      // itself, so such a team is refused rather than trusted.
      let children
      try {
        children = await withRetry(`Listing the child teams of the break-glass team ${name}`,
          (request) => octokit.rest.teams.listChildInOrg({ org, team_slug: slug, per_page: 1, request }), retry)
      } catch (error) {
        throw new Refusal(`${triggeringActor} is an active member of the break-glass team ${name}, but its child teams could not be listed (${describeError(error, timeoutMs)}), and a member of a child team counts as a member of the team, so this membership cannot be trusted; refusing to ${operation} ${appRepo}`)
      }
      if (!Array.isArray(children?.data)) {
        throw new Refusal(`${triggeringActor} is an active member of the break-glass team ${name}, but listing its child teams did not return a list, so this membership cannot be trusted; refusing to ${operation} ${appRepo}`)
      }
      if (children.data.length > 0) {
        throw new Refusal(`${triggeringActor} is an active member of the break-glass team ${name}, but that team has child teams. GitHub counts the members of a child team as members of the team, so this does not show ${triggeringActor} was put on ${name} itself. Use a break-glass team with no child teams; refusing to ${operation} ${appRepo}`)
      }
      core.notice(`${triggeringActor} is an active member of the break-glass team ${name} and started ${thisAttempt}${startedBy}, so it may ${operation} ${appRepo}`)
      return 'break-glass'
    }
    const why = membership
      ? `membership state: ${typeof state === 'string' && state ? state : 'unknown'}`
      : 'GitHub answered 404: not a member, or the team does not exist or this token cannot see it'
    core.info(`${triggeringActor} is not an active member of the break-glass team ${name} (${why})`)
    tried.push(`the break-glass team ${name} (${why})`)
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

// claimRequestId is for tests only. The entry point passes nothing, so until
// the one-time request id store exists, every attempt the deploy gate's
// account starts is refused (see authorize()).
export async function run ({ env = process.env, sleep, timeoutMs, claimRequestId } = {}) {
  const refusalTitle = core.getInput('refusal-title').trim()
  try {
    const operation = core.getInput('operation')
    const token = core.getInput('github-token')
    if (!token) {
      throw new Refusal(`no github-token was given, so the account that started this run attempt cannot be checked; refusing to ${operation || 'change production'}`)
    }
    // The runner fills in "true" when a caller leaves allow-push-access out,
    // so an empty value means the caller's expression for it came out empty.
    // A switch that guards production must not read that as "allow".
    const allowPushAccess = core.getInput('allow-push-access')
    if (allowPushAccess === '') {
      throw new Refusal(`allow-push-access is empty, which happens only when the expression a caller gave it comes out empty; it must be "true" or "false"; refusing to ${operation || 'change production'}`)
    }
    const passedAs = await authorize({
      octokit: getOctokit(token),
      repository: core.getInput('repository'),
      operation,
      actor: env.GITHUB_ACTOR,
      actorId: env.GITHUB_ACTOR_ID,
      triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      workflowRepository: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
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
      allowPushAccess,
      claimRequestId,
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
