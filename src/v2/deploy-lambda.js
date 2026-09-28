import * as core from '@actions/core'
import {
  isPermanentAwsError,
  isWaiterTimeout,
  lambdaGetFunction,
  lambdaListFunctionNames,
  lambdaUpdateFunctionCode,
  lambdaWaitForFunctionUpdated
} from '../aws'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../ecs-config'
import { environmentNickname } from './env'
import { assertDigestRef } from './image-ref'
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

  const updated = []
  // Every function this deploy sent the new image to, with the image it ran
  // before, so they can be sent back.
  const moved = []
  const stop = outcome => stopRollout(moved, outcome, budget, stopRolloutOnFailure)
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

    budget.start()
    if (budget.remaining(RESTORE_RESERVE_MS) <= 0) throw await stop({ functionName, untouched: true })
    core.info(`updating Lambda function ${functionName} -> ${image}`)
    try {
      await lambdaUpdateFunctionCode(functionName, image)
    } catch (error) {
      // Refused, so this function was not moved.
      throw await stop({ functionName, error })
    }
    moved.push({ functionName, previousImage: resolved })
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
    if (outcome.unreadable) throw withCause(new Error(unreadable(outcome)), outcome.error)
    if (!outcome.landed) throw await stop(outcome)
    updated.push(functionName)
  }

  if (updated.length === 0) {
    throw new Error(
      `No Lambda functions matching ${projectName}-${nickname} use the app or scratch ECR image; nothing deployed`
    )
  }

  return { deployedImage: image, services: updated }
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
async function stopRollout (moved, outcome, budget, stopRolloutOnFailure) {
  const others = moved.filter(entry => entry.functionName !== outcome.functionName)
  if (outcome.error && others.length === 0) return outcome.error
  const lines = [headline(outcome, budget)]
  if (!stopRolloutOnFailure) {
    lines.push(
      'This deploy does not stop a rollout (a rollback), so no function was sent back: that would be the ' +
      'release it is rolling back from.' +
      (outcome.stalled ? ` ${outcome.functionName} may still go live on the new image, and nothing will record it.` : '') +
      ' Check which image each function runs.'
    )
    return withCause(new Error(lines.join(' ')), outcome.error)
  }
  if (outcome.stalled) {
    const stalled = moved.find(entry => entry.functionName === outcome.functionName)
    const restored = await restoreStalled(stalled, budget)
    if (!restored.taken) {
      lines.push(restored.message, leftOnNewImage(moved))
      return new Error(lines.join(' '))
    }
    lines.push(restored.message)
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
  const lines = []
  for (const { functionName, previousImage } of entries) {
    try {
      await lambdaUpdateFunctionCode(functionName, previousImage)
      restored.push(`${functionName} (${previousImage})`)
    } catch (error) {
      lines.push(
        `Could not restore ${functionName} to ${previousImage} (${error.message}), so it may keep the new image ` +
        `unrecorded. Restore it by hand: ${updateCodeCommand(functionName, previousImage)}`
      )
    }
  }
  if (restored.length > 0) {
    lines.unshift(
      'To keep the app on the release that was live before this deploy, the previous image was sent back to ' +
      `${restored.join(', ')}. Lambda finishes that update on its own.`
    )
  }
  return lines
}

function leftOnNewImage (moved) {
  return 'The other functions were left on the new image too, so the new image may go live on every function ' +
    'once that update finishes, and nothing will record it. Check which image each function runs. To go back by ' +
    'hand once no update is in progress: ' +
    moved.map(({ functionName, previousImage }) => updateCodeCommand(functionName, previousImage)).join('; ')
}

const updateCodeCommand = (functionName, image) =>
  `aws lambda update-function-code --function-name ${functionName} --image-uri ${image}`

function headline (outcome, budget) {
  if (outcome.error) return outcome.error.message
  if (outcome.untouched) {
    return `The rollout budget ran out before ${outcome.functionName} could be updated, so it was left as it was.`
  }
  const reason = outcome.reason ? `: ${outcome.reason}` : ''
  return `${outcome.functionName} had not finished updating ${formatDuration(budget.elapsed())} after this ` +
    `deploy's first update (LastUpdateStatus ${outcome.status}${reason}).`
}
