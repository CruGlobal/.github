import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'
import {
  isPermanentAwsError,
  isWaiterTimeout,
  lambdaDeleteFunctionVersion,
  lambdaGetAlias,
  lambdaGetFunction,
  lambdaListFunctionNames,
  lambdaListVersions,
  lambdaPublishVersion,
  lambdaUpdateAlias,
  lambdaUpdateFunctionCode,
  lambdaWaitForFunctionUpdated
} from '../aws'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../ecs-config'
import { environmentNickname } from './env'
import { assertDigestRef, parseImageRef } from './image-ref'
import { LIVE_ALIAS, explainAccessDenied, isVersionNumber, readLiveAlias } from './lambda-alias'
import { POLL_INTERVAL_MS, PROGRESS_INTERVAL_MS, formatDuration, progressLogger, rolloutBudget } from './rollout-budget'

// Max seconds the SDK waiter waits for a single function's code update. Past
// it, the deploy keeps polling the function within its rollout budget.
const MAX_WAIT_SECONDS = 300

// What the wait keeps back from the budget for restoring images at the bound,
// and how often the restore of the stalled function is checked on.
export const RESTORE_RESERVE_MS = 2 * 60 * 1000
const RESTORE_POLL_INTERVAL_MS = 5 * 1000

// Deploy a pre-built, digest-pinned image to a target environment's Lambda
// functions.
//
// RATIFIED SELECTION SEMANTICS (v1's, see src/deploy-lambda.js): update every
// `<project>-<nick>*` function that is an Image function AND whose currently
// resolved image is either the app's ECR repo OR the shared `scratch` repo,
// swapping it to the given digest ref. The scratch match is LOAD-BEARING:
// Terraform boots NEW functions on scratch:latest and the deploy is what flips
// them to the real image on their first deploy. Non-image and non-matching
// functions are logged and skipped, exactly as v1 does.
//
// v2 HARDENING over v1: UpdateFunctionCode is async (it returns before the new
// image is live), so after each update we WAIT for the function to finish
// updating. The pilot hit a read-back race where promote/rollback verified the
// digest before the function had actually switched images; deploy must not
// return until every function runs the new image. (v1 slept 5s between updates
// instead of waiting — the wait subsumes that spacing.)
//
// The wait does not end at the SDK waiter's timeout. Lambda finishes a slow
// update on its own, so a step that failed there would skip every record step
// while the release went live anyway. It keeps polling within the deploy's
// rollout budget (./rollout-budget.js). A Failed update still fails at once:
// Lambda keeps that function's previous image, which is safe.
//
// However the deploy ends short after a function was updated (the budget
// running out, a Failed update, an error), the functions it updated are sent
// back to their previous images, so the app stays on the release the records
// name, and the step fails (see stopRollout). A rollback, `stopRolloutOnFailure`
// false, never sends anything back: that would be the release it is rolling
// back from. Nor does a read that fails for good while polling: what the
// update did is then unknown.
//
// A FUNCTION WITH A `live` ALIAS deploys through it (see ./lambda-alias.js for
// why, and for the two rules every step keeps). Once the new image has landed
// on $LATEST, the deploy publishes $LATEST as a version, waits for Lambda to
// make that version runnable, and points the alias at it. The alias moving is
// the moment the function's triggers switch to the new image. Sending such a
// function back moves the alias back to its old version, deletes the version
// this deploy published (so the old one is the newest again), and sends
// $LATEST back to the old version's image. A function without the alias
// deploys exactly as it always has.
//
// A rollback through an alias starts by moving the alias straight back to a
// version that already runs the image (see rollBackAliases), so the triggers
// are back on it within seconds. And once a deploy lands, old versions are
// pruned (see pruneVersions).
//
// Like ECS, Lambda derives everything from the env nickname + naming
// conventions, so runtime-project (a GCP-only input) is ignored here.
//
// Returns { deployedImage, services } (services = updated function names).
//
// `rollout` carries the rollout budget and poll timings; tests use it for a
// fake clock.
export async function deployLambda ({ projectName, environment, image, stopRolloutOnFailure = true }, rollout = {}) {
  assertDigestRef(image) // defensive; the router validates too
  const { budget = rolloutBudget(), ...timing } = rollout

  // DD_VERSION is DELIBERATELY NOT injected for Lambda. A function's env is
  // Terraform-owned — per-tenant config lives there and the aws/lambda/app module
  // does NOT ignore_changes it — so the pipeline must never call
  // UpdateFunctionConfiguration; doing so would fight Terraform and could clobber

  const nickname = environmentNickname(environment)
  const appRepoPrefix = `${ecrRegistry(DEFAULT_ACCOUNT)}/${projectName}@`
  const scratchPrefix = `${ecrRegistry(DEFAULT_ACCOUNT)}/scratch@`
  core.info(`deploying image: ${image} (env ${environment} -> nickname ${nickname})`)

  const functionNames = await lambdaListFunctionNames(projectName, nickname)
  core.info(`functions matching ${projectName}-${nickname}: ${JSON.stringify(functionNames)}`)

  // Read every function first, so a read that fails or an alias that is
  // refused stops the deploy before anything has changed, and a rollback can
  // move every alias before it updates any function.
  const targets = []
  for (const functionName of functionNames) {
    const fn = await lambdaGetFunction(functionName)
    if (fn.Configuration?.PackageType !== 'Image') {
      core.info(`skipping ${functionName} (not an image function)`)
      continue
    }
    const resolved = fn.Code?.ResolvedImageUri ?? ''
    // App image OR scratch: scratch is how a Terraform-booted function that has
    // never been deployed is flipped to the real image on its first deploy.
    if (!resolved.startsWith(appRepoPrefix) && !resolved.startsWith(scratchPrefix)) {
      core.info(`skipping ${functionName} (not using the app or scratch ECR image)`)
      continue
    }
    // Null for a function that deploys to $LATEST, as every function did
    // before aliases.
    const alias = await readLiveAlias(functionName)
    if (alias && alias.image !== resolved) {
      core.warning(
        `${functionName}: $LATEST runs ${resolved}, but version ${alias.version}, which its ${LIVE_ALIAS} alias ` +
        `points at, runs ${alias.image}. The alias's image is the release that is live, so that is the one a ` +
        'send-back restores.'
      )
    }
    if (alias) await warnIfBehind(functionName, alias)
    targets.push({ functionName, resolved, alias, config: fn.Configuration })
  }

  // A rollback moves its aliases back first. Then the functions it did not
  // move go before the ones it did, so a function that can't go back at once
  // isn't left on the other release for longer than it has to be.
  let order = targets
  if (!stopRolloutOnFailure) {
    await rollBackAliases(targets, image)
    order = [...targets.filter(target => !target.rolledBack), ...targets.filter(target => target.rolledBack)]
  }

  const updated = []
  // Every function this deploy sent the new image to, with the image it ran
  // before, so they can be sent back.
  const moved = []
  // A rollback that moved an alias at once but did not finish has left the
  // alias behind the newest version (rule 1), and says so.
  const unfinished = () => targets.filter(target => target.rolledBack && !updated.includes(target.functionName))
  const stop = outcome => stopRollout(moved, outcome, budget, stopRolloutOnFailure, unfinished())
  for (const target of order) {
    const { functionName, resolved } = target
    if (target.aliasUncertain) {
      // Whether the rollback's move of this alias happened is unknown: read it
      // again, so the rest of the rollback starts from where it really is.
      try {
        target.alias = await readLiveAlias(functionName)
      } catch (error) {
        throw await stop({ functionName, error })
      }
      if (target.alias?.version === target.aliasUncertain.to) target.rolledBack = target.aliasUncertain
    }
    const { alias } = target
    budget.start()
    if (budget.remaining(RESTORE_RESERVE_MS) <= 0) throw await stop({ functionName, untouched: true })
    core.info(`updating Lambda function ${functionName} -> ${image}`)
    try {
      await lambdaUpdateFunctionCode(functionName, image)
    } catch (error) {
      // Refused, so this function was not moved.
      throw await stop({ functionName, error })
    }
    // The image to send it back to is the one that was live: the alias's, for
    // a function that has one.
    const entry = { functionName, previousImage: alias ? alias.image : resolved, alias }
    moved.push(entry)
    target.entry = entry
    // Block until the new image is live so a subsequent resolve/verify sees the
    // deployed digest, not the previous one.
    let outcome
    try {
      outcome = await waitForUpdate(functionName, budget, timing)
    } catch (error) {
      // A Failed update keeps this function's previous image, so only the
      // functions before it go back.
      throw await stop({ functionName, error })
    }
    if (outcome.unreadable) {
      throw withCause(new Error([unreadable(outcome), ...unfinished().map(rolledBackBehind)].join(' ')), outcome.error)
    }
    if (!outcome.landed) throw await stop(outcome)
    if (alias) {
      try {
        await goLive(entry, image, budget, timing)
      } catch (error) {
        // The new image landed on this function's $LATEST, so it goes back
        // too, whatever step failed.
        throw await stop({ functionName, error: explainAccessDenied(error), restoreSelf: true })
      }
    }
    updated.push(functionName)
  }

  if (updated.length === 0) {
    throw new Error(
      `No Lambda functions matching ${projectName}-${nickname} use the app or scratch ECR image; nothing deployed`
    )
  }

  // A rollback leaves pruning to the next deploy, so its calls go to getting
  // back and recording it.
  if (stopRolloutOnFailure) {
    for (const entry of moved) {
      if (!entry.alias) continue
      await pruneVersions(entry.functionName, entry.aliasMoved ? entry.published.version : entry.alias.version, budget.sleep)
    }
  }

  return { deployedImage: image, services: updated }
}

// A ROLLBACK THROUGH AN ALIAS goes back at once, before it updates anything:
// each live alias moves to the newest Active version that already runs the
// image being rolled back to. The deploy that follows publishes that image
// again with the function's current config and moves the alias there, which
// puts the alias back on the newest version (rule 1). Until it does, an apply
// could move the alias forward again, to the release being rolled back from.
// A function with no such version rolls back the ordinary way. Pruning keeps
// a version of each recent image for this.
async function rollBackAliases (targets, image) {
  const { digest } = parseImageRef(image)
  for (const target of targets) {
    const { functionName, alias } = target
    if (!alias || parseImageRef(alias.image).digest === digest) continue
    let found
    try {
      found = await newestVersionRunning(functionName, digest)
    } catch (error) {
      core.warning(
        `${functionName}: could not look for a published version that runs ${image} ` +
        `(${explainAccessDenied(error).message}), so it rolls back through a new version.`
      )
      continue
    }
    if (!found) {
      core.info(`${functionName}: no Active published version runs ${image}, so it rolls back through a new version.`)
      continue
    }
    const move = { from: alias.version, fromImage: alias.image, to: found.version }
    let revisionId
    try {
      revisionId = (await lambdaUpdateAlias(functionName, LIVE_ALIAS, found.version, alias.revisionId)).RevisionId
    } catch (error) {
      // A move whose answer was lost: see goLive.
      const current = await aliasState(functionName)
      if (!current) {
        target.aliasUncertain = move
        core.warning(
          `${functionName}: moving the ${LIVE_ALIAS} alias to version ${found.version} failed ` +
          `(${explainAccessDenied(error).message}), and the alias could not be read to see whether it moved. ` +
          'It is read again before this function is rolled back.'
        )
        continue
      }
      if (current.version !== found.version) {
        core.warning(
          `${functionName}: could not move the ${LIVE_ALIAS} alias to version ${found.version} at once ` +
          `(${explainAccessDenied(error).message}), so it rolls back through a new version.`
        )
        continue
      }
      revisionId = current.revisionId
    }
    target.rolledBack = move
    target.alias = { version: found.version, revisionId, image: found.image }
    core.info(
      `${functionName}: moved the ${LIVE_ALIAS} alias from version ${alias.version} back to version ` +
      `${found.version}, which runs ${image}. Next it publishes that image again with the current settings.`
    )
    // The version froze the settings it was published with. Until the
    // republish lands they are the ones that run, for better or worse.
    const changed = settingsChangedSince(target.config, found.configuration)
    if (changed.length > 0) {
      core.warning(
        `${functionName}: version ${found.version} runs with older settings than the function has now ` +
        `(${changed.join(', ')}), until this rollback publishes the image again with today's.`
      )
    }
  }
}

// The settings a version freezes, and how a message names them.
const SETTINGS = [
  ['MemorySize', 'memory'],
  ['Timeout', 'timeout'],
  ['Environment', 'environment variables'],
  ['Role', 'role'],
  ['VpcConfig', 'VPC settings'],
  ['EphemeralStorage', 'ephemeral storage'],
  ['Layers', 'layers']
]

// The names of the settings a version runs with that differ from $LATEST's.
function settingsChangedSince (latest = {}, version = {}) {
  return SETTINGS
    .filter(([key]) => stableJson(latest[key]) !== stableJson(version[key]))
    .map(([, name]) => name)
}

const stableJson = value => JSON.stringify(value ?? null, (key, inner) =>
  inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    : inner)

// Rule 1 says the alias is on the newest version. When it is not, the next
// apply moves it there, whatever that version runs: a rollback that stopped
// after moving the alias back leaves exactly that. Say so before anything
// changes. A deploy that lands puts the alias back on the newest version.
async function warnIfBehind (functionName, alias) {
  let versions
  try {
    versions = await lambdaListVersions(functionName)
  } catch {
    return
  }
  const newest = versions.filter(version => isVersionNumber(version.Version))
    .sort((a, b) => Number(b.Version) - Number(a.Version))[0]
  if (!newest || Number(newest.Version) <= Number(alias.version)) return
  core.warning(
    `${functionName}: its ${LIVE_ALIAS} alias is on version ${alias.version}, but version ${newest.Version} is ` +
    `newer${newest.CodeSha256 ? ` (image sha256:${newest.CodeSha256})` : ''}, so the next Terraform apply would ` +
    'move the alias to it. This deploy puts the alias back on the newest version once it lands.'
  )
}

// The newest published version that runs `digest` and is Active, as
// { version, image }, or null. Only the newest few that run it are checked.
async function newestVersionRunning (functionName, digest) {
  const sha = digest.replace(/^sha256:/, '')
  const candidates = (await lambdaListVersions(functionName))
    .filter(version => version.CodeSha256 === sha && isVersionNumber(version.Version))
    .map(version => version.Version)
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, 3)
  for (const version of candidates) {
    const { Configuration: configuration = {}, Code: code = {} } = await lambdaGetFunction(functionName, version)
    const running = code.ResolvedImageUri ?? ''
    if (configuration.State === 'Active' && parseImageRef(running).digest === digest) {
      return { version, image: running, configuration }
    }
  }
  return null
}

// How many recent images keep a version for a rollback to go back to.
const KEEP_IMAGES = 5
// A bound on one deploy's deletes, and a pause between them: Lambda's
// control-plane rate is shared by every deploy and apply in the account.
const MAX_DELETES = 20
const PRUNE_PAUSE_MS = 200

// Versions pile up: every deploy publishes one, and so does every Terraform
// config change. Once a deploy has landed, keep the newest version of each of
// the last KEEP_IMAGES images the function ran, and delete the rest. Never the
// alias's version, never one newer than it (an apply may have just published
// it), and never one something else holds: Lambda refuses to delete a version
// another alias points at, and that version is skipped. Pruning never fails a
// deploy.
async function pruneVersions (functionName, live, sleep) {
  let versions
  try {
    versions = await lambdaListVersions(functionName)
  } catch (error) {
    core.warning(`${functionName}: could not list its versions to prune old ones (${explainAccessDenied(error).message}).`)
    return
  }

  const images = new Set()
  const old = []
  const newestFirst = versions
    .filter(version => isVersionNumber(version.Version))
    .sort((a, b) => Number(b.Version) - Number(a.Version))
  for (const { Version: version, CodeSha256: sha } of newestFirst) {
    const image = sha || `version ${version}`
    if (Number(version) > Number(live)) continue
    if (version === live || (!images.has(image) && images.size < KEEP_IMAGES)) {
      images.add(image)
      continue
    }
    old.push(version)
  }

  const deleted = []
  for (const [index, version] of old.slice(0, MAX_DELETES).entries()) {
    if (index > 0) await sleep(PRUNE_PAUSE_MS)
    try {
      await lambdaDeleteFunctionVersion(functionName, version)
      deleted.push(version)
    } catch (error) {
      if (error?.name === 'ResourceConflictException') {
        core.info(`${functionName}: kept version ${version} for now (Lambda refused to delete it: ${error.message}).`)
        continue
      }
      core.warning(`${functionName}: stopped pruning at version ${version} (${explainAccessDenied(error).message}).`)
      break
    }
  }
  if (deleted.length > 0) {
    core.info(`${functionName}: deleted old versions ${deleted.join(', ')}, keeping a version of each of the last ${KEEP_IMAGES} images.`)
  }
}

// Put the image that just landed on $LATEST live through the function's alias:
// publish $LATEST as a version, wait until Lambda can run it, then point the
// alias at it. `entry` records what changed, for a send-back. Throws when a
// step fails or the budget runs out; the alias then has not moved.
async function goLive (entry, image, budget, timing) {
  const { functionName, alias } = entry

  // Publish only what this deploy sent. Lambda refuses the publish if the code
  // or the config changed after this read.
  const { Configuration: latest = {}, Code: code = {} } = await lambdaGetFunction(functionName)
  const running = code.ResolvedImageUri ?? ''
  if (parseImageRef(running).digest !== parseImageRef(image).digest) {
    throw new Error(
      `${functionName}: $LATEST runs ${running || 'no image'}, not the image this deploy sent, so it was not ` +
      'published. Something else changed the function during the deploy.'
    )
  }
  const description = versionDescription(image)
  let published
  try {
    published = await lambdaPublishVersion(functionName, {
      codeSha256: latest.CodeSha256,
      revisionId: latest.RevisionId,
      description
    })
  } catch (error) {
    // A publish that failed for a passing reason (a lost answer, a 5xx) may
    // have created a version before the error reached us.
    if (!isPermanentAwsError(error)) entry.publishUncertain = description
    throw error
  }
  const version = published.Version
  if (!isVersionNumber(version)) throw new Error(`Publishing ${functionName} returned version "${version}"`)
  if (version === alias.version) {
    core.info(`${functionName}: $LATEST matches version ${version}, which the ${LIVE_ALIAS} alias is already on.`)
    return
  }
  // When $LATEST already matches the newest version, Lambda publishes nothing
  // and returns that version. Only a version this deploy created may be deleted
  // in a send-back; its own description, and a number above the alias's, tell.
  const created = published.Description === description && Number(version) > Number(alias.version)
  entry.published = { version, created }
  core.info(created
    ? `${functionName}: published version ${version}.`
    : `${functionName}: $LATEST matches version ${version}, which was already published.`)

  await waitForVersion(functionName, version, budget, timing)

  let moved
  try {
    moved = await lambdaUpdateAlias(functionName, LIVE_ALIAS, version, alias.revisionId)
  } catch (error) {
    // A move that worked but whose answer was lost comes back from the SDK's
    // retry as a revision mismatch, so look where the alias is first.
    const current = await aliasState(functionName)
    if (current?.version !== version) throw error
    moved = { RevisionId: current.revisionId }
  }
  entry.aliasMoved = { revisionId: moved.RevisionId }
  core.info(`${functionName}: moved the ${LIVE_ALIAS} alias from version ${alias.version} to version ${version}.`)
}

// Unique to this deploy, so a publish that created a version can be told from
// one that returned an older version.
function versionDescription (image) {
  const run = process.env.GITHUB_RUN_ID
    ? `run ${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? '1'}, `
    : ''
  return `Deployed ${parseImageRef(image).digest} (${run}${randomUUID().slice(0, 8)})`
}

// A published version starts out Pending while Lambda prepares it, and an
// alias must not point at a version Lambda cannot run yet. Wait for Active
// within the budget.
async function waitForVersion (functionName, version, budget, timing) {
  const { pollIntervalMs = POLL_INTERVAL_MS, progressIntervalMs = PROGRESS_INTERVAL_MS } = timing
  const log = progressLogger(budget, progressIntervalMs)
  const publishedAt = budget.now()
  for (;;) {
    let state, reason
    try {
      const { Configuration: configuration = {} } = await lambdaGetFunction(functionName, version)
      state = configuration.State ?? 'unknown'
      reason = configuration.StateReason ?? ''
    } catch (error) {
      if (isPermanentAwsError(error)) throw error
      state = 'unreadable'
      reason = error.message
    }
    if (state === 'Active') return
    // Only a version that was already published, and then went unused for
    // weeks, is Inactive. Lambda only wakes it on an invocation, which fails.
    if (state === 'Inactive') {
      throw new Error(
        `Version ${version} of ${functionName} is Inactive (Lambda reclaimed it after it went unused), so the ` +
        `${LIVE_ALIAS} alias was not moved to it.`
      )
    }
    if (state === 'Failed') {
      throw new Error(`Version ${version} of ${functionName} failed to become active: ${reason || 'Lambda gave no reason'}`)
    }
    const detail = `State ${state}${reason ? `: ${reason}` : ''}`
    const left = budget.remaining(RESTORE_RESERVE_MS)
    if (left <= 0) {
      throw new Error(
        `Version ${version} of ${functionName} was not active ${formatDuration(budget.now() - publishedAt)} after ` +
        `it was published (${detail}), so the ${LIVE_ALIAS} alias was not moved to it.`
      )
    }
    log(
      `${functionName}: waiting for version ${version} to become active (${detail}). ` +
      `Waited ${formatDuration(budget.now() - publishedAt)}, ${formatDuration(left)} left.`
    )
    await budget.sleep(Math.min(pollIntervalMs, left))
  }
}

// Wait for one function's update: the SDK waiter first, as before, then, if it
// gave up on time, polling within the budget. Returns { landed: true }, or what
// stalled when the budget ran out. Throws when the update failed.
async function waitForUpdate (functionName, budget, timing) {
  const sentAt = budget.now()
  const seconds = Math.floor(budget.remaining(RESTORE_RESERVE_MS) / 1000)
  // The waiter refuses a wait no longer than its one-second minimum delay.
  if (seconds > 1) {
    try {
      await lambdaWaitForFunctionUpdated(functionName, Math.min(MAX_WAIT_SECONDS, seconds))
      return { landed: true }
    } catch (error) {
      if (!isWaiterTimeout(error)) throw await waiterFailure(functionName, error)
    }
    core.warning(
      `${functionName} was still updating when the waiter gave up. Lambda finishes an update on its own, so ` +
      `this deploy keeps checking it for up to ${formatDuration(budget.remaining(RESTORE_RESERVE_MS))}.`
    )
  }
  return pollUpdate(functionName, sentAt, budget, timing)
}

async function pollUpdate (functionName, sentAt, budget, timing) {
  const { pollIntervalMs = POLL_INTERVAL_MS, progressIntervalMs = PROGRESS_INTERVAL_MS } = timing
  const log = progressLogger(budget, progressIntervalMs)
  for (;;) {
    const { status, reason, error } = await updateStatus(functionName)
    if (error) return { landed: false, unreadable: true, functionName, error }
    if (status === 'Successful') {
      core.info(`${functionName}: update finished, ${formatDuration(budget.now() - sentAt)} after it was sent.`)
      return { landed: true }
    }
    if (status === 'Failed') throw failedUpdate(functionName, reason)

    const left = budget.remaining(RESTORE_RESERVE_MS)
    if (left <= 0) return { landed: false, stalled: true, functionName, status, reason }
    log(
      `${functionName}: waiting for its update to finish (LastUpdateStatus ${status}${reason ? `: ${reason}` : ''}). ` +
      `Waited ${formatDuration(budget.now() - sentAt)}, ${formatDuration(left)} left.`
    )
    await budget.sleep(Math.min(pollIntervalMs, left))
  }
}

const failedUpdate = (functionName, reason, cause) => withCause(new Error(
  `${functionName} failed to update to the new image, and keeps running its previous one: ` +
  (reason || 'Lambda gave no reason')
), cause)

// The waiter's own error carries its whole result as JSON. When the update
// failed, say so in a line, with Lambda's reason; anything else is thrown as
// it came.
async function waiterFailure (functionName, error) {
  const { status, reason } = await updateStatus(functionName)
  return status === 'Failed' ? failedUpdate(functionName, reason, error) : error
}

// A read that failed for a passing reason says nothing either way, and the
// budget bounds the wait. One that failed for good comes back as `error`.
async function updateStatus (functionName) {
  try {
    const { Configuration: configuration = {} } = await lambdaGetFunction(functionName)
    return { status: configuration.LastUpdateStatus ?? 'unknown', reason: configuration.LastUpdateStatusReason ?? '' }
  } catch (error) {
    if (isPermanentAwsError(error)) return { error }
    return { status: 'unreadable', reason: error.message }
  }
}

// A read that fails for good ends the wait with nothing sent back: what the
// update did is unknown, and sending functions back could take them off a
// release that did land.
const unreadable = ({ functionName, error }) =>
  `${functionName}: could not read the function while waiting for its update (${error.message}). The ` +
  'update\'s state is unknown: its new image may still go live, and nothing would record it. Nothing was ' +
  'sent back, since that could take functions off a release that did land. Check which image each function runs.'

// How a deploy that ended short fails the step, sending functions back first
// where it should. A failure before any function moved is thrown as it came.
//
// At the bound the function that stalled goes back FIRST, and the others only
// once Lambda has taken it: Lambda refuses an update while another is in
// progress (a ResourceConflictException), and that is the likely answer for
// the function still updating. Sending the others back anyway would split the
// app, with the stalled one landing on the new image later. Leaving them is
// the lesser harm: once it finishes, every function runs the new image. Once
// Lambda has taken the stalled one's change, the others go back even if it
// cannot be seen to finish in time: it is on its way back, and so are they.
//
// A stalled function with a live alias is different: its alias has not moved,
// so it keeps the previous release however its $LATEST ends, and the others
// go back without splitting the app.
//
// The function that failed goes back too when its new image had already
// landed (`restoreSelf`): a step after the update failed, such as publishing
// it or moving its alias.
async function stopRollout (moved, outcome, budget, stopRolloutOnFailure, unfinished = []) {
  const others = moved.filter(entry => outcome.restoreSelf || entry.functionName !== outcome.functionName)
  if (outcome.error && others.length === 0 && unfinished.length === 0) return outcome.error
  const lines = [headline(outcome, budget)]
  if (!stopRolloutOnFailure) {
    lines.push(
      'This deploy does not stop a rollout (a rollback), so no function was sent back: that would be the ' +
      'release it is rolling back from.' +
      (outcome.stalled ? ` ${outcome.functionName} may still go live on the new image, and nothing will record it.` : '') +
      ' Check which image each function runs' +
      (moved.some(entry => entry.alias) ? ` (for a function with a ${LIVE_ALIAS} alias, the image of the version it points at).` : '.'),
      ...unfinished.map(rolledBackBehind)
    )
    return withCause(new Error(lines.join(' ')), outcome.error)
  }
  if (outcome.stalled) {
    const stalled = moved.find(entry => entry.functionName === outcome.functionName)
    const restored = await restoreStalled(stalled, budget)
    if (!restored.taken && !stalled.alias) {
      lines.push(restored.message, leftOnNewImage(moved))
      return new Error(lines.join(' '))
    }
    lines.push(restored.message)
    if (!restored.taken) lines.push(stalledBehindAlias(stalled))
  }
  lines.push(...await restoreAll(others))
  return withCause(new Error(lines.join(' ')), outcome.error)
}

function withCause (error, cause) {
  if (cause) error.cause = cause
  return error
}

// Send the stalled function back, and watch it finish within the reserve.
// `taken` says whether Lambda took the change; only a refusal, or a restore
// that itself failed, leaves the function on the new image for sure.
async function restoreStalled ({ functionName, previousImage }, budget) {
  try {
    await lambdaUpdateFunctionCode(functionName, previousImage)
  } catch (error) {
    return { taken: false, message: `Could not send ${functionName} back to ${previousImage} (${error.message}).` }
  }
  const unconfirmed = why => ({
    taken: true,
    message: `${functionName} was sent back to ${previousImage}, but ${why}; Lambda finishes that update on its own.`
  })
  for (;;) {
    const { status, reason, error } = await updateStatus(functionName)
    if (error) return unconfirmed(`it could not be checked on (${error.message})`)
    if (status === 'Successful') return { taken: true, message: `${functionName} is back on ${previousImage}.` }
    if (status === 'Failed') {
      return { taken: false, message: `Sending ${functionName} back to ${previousImage} failed (${reason || 'no reason given'}).` }
    }
    if (budget.remaining() <= 0) return unconfirmed(`that had not finished in time (LastUpdateStatus ${status})`)
    await budget.sleep(Math.min(RESTORE_POLL_INTERVAL_MS, budget.remaining()))
  }
}

// The others need no watching: each finished its own update, so Lambda takes
// the change, and finishes it on its own.
async function restoreAll (entries) {
  const restored = []
  const throughAlias = []
  const problems = []
  for (const entry of entries) {
    const { functionName, previousImage } = entry
    if (entry.alias) {
      const result = await restoreThroughAlias(entry)
      if (result.done) throughAlias.push(result.done)
      problems.push(...result.problems)
      continue
    }
    try {
      await lambdaUpdateFunctionCode(functionName, previousImage)
      restored.push(`${functionName} (${previousImage})`)
    } catch (error) {
      problems.push(
        `Could not restore ${functionName} to ${previousImage} (${error.message}), so it may keep the new image ` +
        `unrecorded. Restore it by hand: ${updateCodeCommand(functionName, previousImage)}`
      )
    }
  }
  const lines = []
  if (restored.length > 0) {
    lines.push(
      'To keep the app on the release that was live before this deploy, the previous image was sent back to ' +
      `${restored.join(', ')}. Lambda finishes that update on its own.`
    )
  }
  return [...lines, ...throughAlias, ...problems]
}

// Send back a function with a live alias, in the order that keeps its triggers
// on the previous release at every step: the alias back to its old version
// (the moment the triggers switch back), then the version this deploy
// published deleted, so the old one is the newest again (rule 1), then $LATEST
// back to the old version's image (rule 2). Returns { done, problems }.
async function restoreThroughAlias (entry) {
  const { functionName, previousImage, alias, published, aliasMoved } = entry
  const steps = []
  const problems = []

  // The alias revision to move it back from, when this deploy moved it.
  let movedFrom = aliasMoved?.revisionId
  if (!movedFrom) {
    const current = await aliasState(functionName)
    if (current && published && current.version === published.version) {
      // This deploy's own move, whose answer never arrived.
      movedFrom = current.revisionId
    } else if (current && current.version !== alias.version) {
      // Something else moved it during the deploy. Sending $LATEST back would
      // put it on a different image from the alias's, so leave it as it is.
      return {
        problems: [
          `The ${LIVE_ALIAS} alias of ${functionName} was moved from version ${alias.version} to version ` +
          `${current.version} by something other than this deploy, so this function was not sent back. Check ` +
          'which image that version runs.'
        ]
      }
    }
  }

  if (movedFrom) {
    try {
      await lambdaUpdateAlias(functionName, LIVE_ALIAS, alias.version, movedFrom)
    } catch (error) {
      // The alias still points at the new version, so that version can't be
      // deleted, and sending $LATEST back would break rule 2. Leave it whole.
      return {
        problems: [
          `Could not move the ${LIVE_ALIAS} alias of ${functionName} back to version ${alias.version} ` +
          `(${error.message}), so it keeps serving the new image unrecorded, and nothing else about it was ` +
          `changed. Move it back by hand: ${handCommands(entry, { aliasMoved: true }).join('; then ')}`
        ]
      }
    }
    steps.push(`its ${LIVE_ALIAS} alias points at version ${alias.version} again`)
  } else {
    steps.push(`its ${LIVE_ALIAS} alias never left version ${alias.version}`)
  }

  if (published && !published.created && Number(published.version) > Number(alias.version)) {
    // A version that already ran the new image, newer than the alias's.
    problems.push(
      `Version ${published.version} of ${functionName} already ran the new image before this deploy, and it is ` +
      `newer than version ${alias.version}, which the ${LIVE_ALIAS} alias is on. The next Terraform apply would ` +
      'point the alias at it and put the new image live. This deploy did not publish it, so it was left alone. ' +
      `Delete it by hand if nothing needs it: ${deleteVersionCommand(functionName, published.version)}`
    )
  }
  if (entry.publishUncertain) {
    problems.push(
      `Publishing ${functionName} failed in a way that may have created a version anyway. If it has a version ` +
      `described "${entry.publishUncertain}", that version is the newest, and the next Terraform apply would ` +
      `point the ${LIVE_ALIAS} alias at it. Find it with aws lambda list-versions-by-function --function-name ` +
      `${functionName}, then delete it: ${deleteVersionCommand(functionName, '<version>')}`
    )
  }

  if (published?.created) {
    try {
      await lambdaDeleteFunctionVersion(functionName, published.version)
      steps.push(`version ${published.version}, which this deploy published, was deleted`)
    } catch (error) {
      problems.push(
        `Could not delete version ${published.version} of ${functionName} (${error.message}). It is still the ` +
        `newest version, so the next Terraform apply would point the ${LIVE_ALIAS} alias at it and put the new ` +
        `image live. Delete it by hand: ${deleteVersionCommand(functionName, published.version)}`
      )
    }
  }

  try {
    await lambdaUpdateFunctionCode(functionName, previousImage)
    steps.push(`its $LATEST was sent back to ${previousImage}`)
  } catch (error) {
    problems.push(
      `Could not send $LATEST of ${functionName} back to ${previousImage} (${error.message}). Its ${LIVE_ALIAS} ` +
      'alias serves the previous release, but $LATEST keeps the new image, so a Terraform config change would ' +
      `publish it and put it live. Send it back by hand: ${updateCodeCommand(functionName, previousImage)}`
    )
  }

  return { done: `${functionName} is back on the previous release: ${joinSteps(steps)}.`, problems }
}

// Where the live alias points now, as { version, revisionId }, or undefined
// when it can't be read.
async function aliasState (functionName) {
  try {
    const { FunctionVersion: version, RevisionId: revisionId } = await lambdaGetAlias(functionName, LIVE_ALIAS)
    return { version, revisionId }
  } catch {
    return undefined
  }
}

// The commands that send one function back by hand, in the order that keeps
// its triggers on the previous release: for a function behind its alias, the
// alias back, the new version deleted, then $LATEST back.
function handCommands ({ functionName, previousImage, alias, published, aliasMoved }, { aliasMoved: moved = !!aliasMoved } = {}) {
  if (!alias) return [updateCodeCommand(functionName, previousImage)]
  return [
    ...(moved ? [updateAliasCommand(functionName, alias.version)] : []),
    ...(published?.created ? [deleteVersionCommand(functionName, published.version)] : []),
    updateCodeCommand(functionName, previousImage)
  ]
}

// A rollback that moved an alias back at once, then did not finish. Once it
// published the image again, the newest version runs it too; until then the
// newest is the release being rolled back from.
function rolledBackBehind ({ functionName, rolledBack, entry }) {
  const head = `${functionName}'s ${LIVE_ALIAS} alias went back to version ${rolledBack.to} at once, so it runs ` +
    'the image this rollback is for.'
  const published = entry?.published
  if (published && Number(published.version) > Number(rolledBack.from)) {
    return `${head} The newest version, ${published.version}, runs that image too, so the next Terraform apply ` +
      'would move the alias there, with today\'s settings. Run the rollback again to finish it.'
  }
  return `${head} But version ${rolledBack.from}, which runs ${rolledBack.fromImage}, the release this rollback is ` +
    `from, is still newer than version ${rolledBack.to}, and $LATEST may still run that image. So the next ` +
    'Terraform apply, or any config change, would put that release live again, with nothing to record it. Run ' +
    'the rollback again to finish it.'
}

const joinSteps = steps => steps.length < 2
  ? steps.join('')
  : `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}`

// A stalled function whose send-back Lambda refused keeps its alias on the old
// version, but its $LATEST may still land the new image.
const stalledBehindAlias = ({ functionName, previousImage, alias }) =>
  `Its ${LIVE_ALIAS} alias is still on version ${alias.version}, so it keeps serving the previous release. But ` +
  'its $LATEST may still land the new image, and a Terraform config change would then publish that and put it ' +
  `live. Once its update is done, send it back by hand: ${updateCodeCommand(functionName, previousImage)}`

function leftOnNewImage (moved) {
  return 'The other functions were left on the new image too, so the new image may go live on every function ' +
    'once that update finishes, and nothing will record it. Check which image each function runs. To go back by ' +
    'hand once no update is in progress: ' +
    moved.map(entry => handCommands(entry).join(', then ')).join('; ')
}

const updateCodeCommand = (functionName, image) =>
  `aws lambda update-function-code --function-name ${functionName} --image-uri ${image}`

const updateAliasCommand = (functionName, version) =>
  `aws lambda update-alias --function-name ${functionName} --name ${LIVE_ALIAS} --function-version ${version}`

const deleteVersionCommand = (functionName, version) =>
  `aws lambda delete-function --function-name ${functionName} --qualifier ${version}`

function headline (outcome, budget) {
  if (outcome.error) return outcome.error.message
  if (outcome.untouched) {
    return `The rollout budget ran out before ${outcome.functionName} could be updated, so it was left as it was.`
  }
  const reason = outcome.reason ? `: ${outcome.reason}` : ''
  return `${outcome.functionName} had not finished updating ${formatDuration(budget.elapsed())} after this ` +
    `deploy's first update (LastUpdateStatus ${outcome.status}${reason}).`
}
