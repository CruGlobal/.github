import { describe, it, expect, beforeEach, vi } from 'vitest'

// The Lambda calls, backed by the small fake below. The two error predicates
// stay real: the wait turns on them.
vi.mock('../src/aws.js', async importOriginal => ({
  isPermanentAwsError: (await importOriginal()).isPermanentAwsError,
  isWaiterTimeout: (await importOriginal()).isWaiterTimeout,
  lambdaListFunctionNames: vi.fn(),
  lambdaGetFunction: vi.fn(),
  lambdaUpdateFunctionCode: vi.fn(),
  lambdaWaitForFunctionUpdated: vi.fn(),
  lambdaGetAlias: vi.fn(),
  lambdaPublishVersion: vi.fn(),
  lambdaUpdateAlias: vi.fn(),
  lambdaDeleteFunctionVersion: vi.fn(),
  lambdaListVersions: vi.fn()
}))

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal()),
  info: vi.fn(),
  warning: vi.fn()
}))

import * as core from '@actions/core'
import * as aws from '../src/aws.js'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../src/ecs-config.js'
import { RESTORE_RESERVE_MS, deployLambda } from '../src/v2/deploy-lambda.js'
import { ROLLOUT_BUDGET_MS, rolloutBudget } from '../src/v2/rollout-budget.js'

const MINUTE = 60 * 1000
const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)
const IMAGE = `${REGISTRY}/example-app@sha256:new`
const previousImage = name => `${REGISTRY}/example-app@sha256:old-${name.split('-').pop()}`
const SCRATCH = `${REGISTRY}/scratch@sha256:placeholder`

// A fake clock the budget and the fake Lambda share.
let now
const sleep = async ms => { now += ms }

// Reads of every function fail with this error while it is set.
let readFailure

// A fake Lambda: each function's image, and an update that finishes (or fails)
// some time after it is sent. Like Lambda, it refuses a second update while
// one is in progress, unless acceptsWhileUpdating: then the second replaces
// the first and takes restoreTakes.
let functions
function addFunction (name, {
  image = previousImage(name), takes = 30 * 1000, fails = '', acceptsWhileUpdating = false, restoreTakes = 30 * 1000
} = {}) {
  functions[name] = { image, takes, fails, acceptsWhileUpdating, restoreTakes, update: null }
}

function status (fn) {
  if (!fn.update) return 'Successful'
  if (now < fn.update.doneAt) return 'InProgress'
  if (fn.fails) return 'Failed'
  fn.image = fn.update.image
  fn.update = null
  return 'Successful'
}

function timedOut () {
  return Object.assign(new Error('{"state":"TIMEOUT","reason":"Waiter has timed out"}'), { name: 'TimeoutError' })
}

function installFakeLambda () {
  aws.lambdaListFunctionNames.mockImplementation(async () => Object.keys(functions))
  aws.lambdaGetFunction.mockImplementation(async name => {
    if (readFailure && readFailure.from <= now && now < readFailure.until) throw readFailure.error
    const fn = functions[name]
    const LastUpdateStatus = status(fn)
    return {
      Configuration: {
        PackageType: 'Image',
        LastUpdateStatus,
        LastUpdateStatusReason: LastUpdateStatus === 'Failed' ? fn.fails : ''
      },
      Code: { ResolvedImageUri: fn.image }
    }
  })
  aws.lambdaUpdateFunctionCode.mockImplementation(async (name, image) => {
    const fn = functions[name]
    if (status(fn) === 'InProgress' && fn.acceptsWhileUpdating) {
      fn.update = { image, doneAt: now + fn.restoreTakes }
      fn.fails = ''
      return
    }
    if (status(fn) === 'InProgress') {
      throw Object.assign(new Error(`The operation cannot be performed at this time. An update is in progress for resource: ${name}`), {
        name: 'ResourceConflictException'
      })
    }
    fn.update = { image, doneAt: now + fn.takes }
    // A restore of the image it already runs finishes at once.
    if (image === fn.image) fn.update.doneAt = now
  })
  // The SDK waiter: success, the waiter's plain-Error FAILURE, or its TIMEOUT.
  aws.lambdaWaitForFunctionUpdated.mockImplementation(async (name, maxWaitTime) => {
    const fn = functions[name]
    const doneIn = fn.update.doneAt - now
    if (doneIn > maxWaitTime * 1000) {
      now += maxWaitTime * 1000
      throw timedOut()
    }
    now += doneIn
    if (status(fn) === 'Failed') throw new Error('{"state":"FAILURE"}')
    return { state: 'SUCCESS' }
  })
}

const deploy = (args = {}) => deployLambda(
  { projectName: 'example-app', environment: 'production', image: IMAGE, ...args },
  { budget: rolloutBudget({ now: () => now, sleep, stepStartedAt: 0 }) }
)
const rollback = () => deploy({ stopRolloutOnFailure: false })
const failure = promise => promise.then(() => { throw new Error('expected the deploy to fail') }, error => error)

const infos = () => core.info.mock.calls.map(([message]) => message)
const updatesTo = image => aws.lambdaUpdateFunctionCode.mock.calls.filter(([, sent]) => sent === image)

beforeEach(() => {
  for (const fn of Object.values(aws)) fn.mockReset?.()
  core.info.mockReset()
  core.warning.mockReset()
  now = 0
  functions = {}
  readFailure = null
  installFakeLambda()
  // No function has a live alias here; ./v2-deploy-lambda-alias.test.js covers those.
  aws.lambdaGetAlias.mockRejectedValue(Object.assign(new Error('Alias not found'), { name: 'ResourceNotFoundException' }))
})

describe('deployLambda past the waiter timeout', () => {
  it('keeps polling after the waiter gives up, and an update that finishes later is a success', async () => {
    addFunction('example-app-prod-a', { takes: 12 * MINUTE })

    const result = await deploy()

    expect(result).toEqual({ deployedImage: IMAGE, services: ['example-app-prod-a'] })
    // The waiter's 300 seconds first, as before.
    expect(aws.lambdaWaitForFunctionUpdated).toHaveBeenCalledWith('example-app-prod-a', 300)
    expect(now).toBe(12 * MINUTE)
    expect(core.warning.mock.calls[0][0]).toMatch(/example-app-prod-a was still updating when the waiter gave up/)
    expect(infos()).toContainEqual('example-app-prod-a: update finished, 12m 0s after it was sent.')
  })

  it('fails at once on a Failed update, which leaves the previous image running', async () => {
    addFunction('example-app-prod-a', { takes: 8 * MINUTE, fails: 'The image manifest is not supported.' })
    addFunction('example-app-prod-b')

    await expect(deploy()).rejects.toThrow(
      'example-app-prod-a failed to update to the new image, and keeps running its previous one: ' +
      'The image manifest is not supported.'
    )
    expect(now).toBe(8 * MINUTE)
    // No restore, and the next function is never touched.
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledTimes(1)
  })

  it('fails at once when the waiter itself sees the update fail, in a line with Lambda\'s reason', async () => {
    addFunction('example-app-prod-a', { takes: MINUTE, fails: 'Bad image.' })

    const error = await failure(deploy())

    // Not the waiter's whole result as JSON.
    expect(error.message).toBe(
      'example-app-prod-a failed to update to the new image, and keeps running its previous one: Bad image.'
    )
    expect(error.cause.message).toBe('{"state":"FAILURE"}')
  })

  it('logs one line about every minute while it polls', async () => {
    addFunction('example-app-prod-a', { takes: 12 * MINUTE })

    await deploy()

    const waiting = infos().filter(line => line.includes('waiting for its update to finish'))
    // From the waiter's five minutes to the finish at twelve.
    expect(waiting).toHaveLength(7)
    expect(waiting[0]).toBe(
      'example-app-prod-a: waiting for its update to finish (LastUpdateStatus InProgress). Waited 5m 0s, 38m 0s left.'
    )
  })
})

describe('deployLambda reading a function while it polls', () => {
  const awsError = (name, status) => Object.assign(new Error(`${name}: it said no`), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } })
  })

  it.each([
    ['AccessDeniedException', 403],
    ['ResourceNotFoundException', 404],
    ['InvalidParameterValueException', 400]
  ])('fails at once, sending nothing back, on a %s (%i): the update\'s state is unknown', async (name, status) => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { takes: 20 * MINUTE })
    // From the first poll past the waiter, 5 minutes into b's update.
    readFailure = { error: awsError(name, status), from: 6 * MINUTE, until: Infinity }

    const error = await failure(deploy())

    expect(error.message).toBe(
      `example-app-prod-b: could not read the function while waiting for its update (${name}: it said no). The ` +
      "update's state is unknown: its new image may still go live, and nothing would record it. Nothing was sent " +
      'back, since that could take functions off a release that did land. Check which image each function runs.'
    )
    expect(error.cause).toBe(readFailure.error)
    expect(aws.lambdaUpdateFunctionCode.mock.calls.filter(([, image]) => image !== IMAGE)).toHaveLength(0)
  })

  it.each([
    ['a 429', 'TooManyRequestsException', 429],
    ['a ThrottlingException sent as a 400', 'ThrottlingException', 400],
    ['a RequestLimitExceeded sent as a 400', 'RequestLimitExceeded', 400],
    ['a 5xx', 'ServiceException', 500],
    ['a network error, with no status', 'TimeoutError', undefined]
  ])('keeps polling through %s, and lands', async (_, name, status) => {
    addFunction('example-app-prod-a', { takes: 12 * MINUTE })
    readFailure = { error: awsError(name, status), from: 6 * MINUTE, until: 8 * MINUTE }

    await expect(deploy()).resolves.toEqual({ deployedImage: IMAGE, services: ['example-app-prod-a'] })
    expect(now).toBe(12 * MINUTE)
  })
})

describe('deployLambda at the bound', () => {
  it('sends the stalled function back first, and leaves the others when Lambda refuses it', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { image: SCRATCH })
    addFunction('example-app-prod-c', { takes: Infinity })

    const error = await failure(deploy())

    expect(error.message).toMatch(
      /^example-app-prod-c had not finished updating 43m \d+s after this deploy's first update \(LastUpdateStatus InProgress\)\./
    )
    // Its update is still in progress, so Lambda refuses to send it back.
    expect(error.message).toContain(
      `Could not send example-app-prod-c back to ${previousImage('example-app-prod-c')} (The operation cannot be ` +
      'performed at this time. An update is in progress for resource: example-app-prod-c).'
    )
    // So the others stay on the new image, and the app ends up on it everywhere.
    expect(error.message).toContain(
      'The other functions were left on the new image too, so the new image may go live on every function once ' +
      'that update finishes, and nothing will record it.'
    )
    expect(error.message).toContain(
      `aws lambda update-function-code --function-name example-app-prod-a --image-uri ${previousImage('example-app-prod-a')}`
    )
    expect(updatesTo(previousImage('example-app-prod-a'))).toHaveLength(0)
    expect(updatesTo(SCRATCH)).toHaveLength(0)
  })

  it('sends the others back, scratch included, once the stalled function is back', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { image: SCRATCH })
    addFunction('example-app-prod-c', { takes: Infinity, acceptsWhileUpdating: true })

    const error = await failure(deploy())

    expect(error.message).toContain(`example-app-prod-c is back on ${previousImage('example-app-prod-c')}.`)
    expect(error.message).toContain(
      'the previous image was sent back to ' +
      `example-app-prod-a (${previousImage('example-app-prod-a')}), example-app-prod-b (${SCRATCH}).`
    )
    // The stalled one went back first, and was watched until it had.
    const order = aws.lambdaUpdateFunctionCode.mock.calls.map(([name, image]) => `${name} ${image === IMAGE ? 'new' : 'back'}`)
    expect(order.slice(3)).toEqual(['example-app-prod-c back', 'example-app-prod-a back', 'example-app-prod-b back'])
    expect(functions['example-app-prod-c'].image).toBe(previousImage('example-app-prod-c'))
    // Inside the budget: the wait stopped with the reserve in hand, and the
    // restore finished within it.
    expect(now).toBeGreaterThanOrEqual(ROLLOUT_BUDGET_MS - RESTORE_RESERVE_MS)
    expect(now).toBeLessThanOrEqual(ROLLOUT_BUDGET_MS)
  })

  it('sends the others back once Lambda takes the stalled function\'s change, though it cannot be seen to finish', async () => {
    addFunction('example-app-prod-a')
    // Its way back takes longer than the reserve.
    addFunction('example-app-prod-b', { takes: Infinity, acceptsWhileUpdating: true, restoreTakes: 10 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(
      `example-app-prod-b was sent back to ${previousImage('example-app-prod-b')}, but that had not finished in time ` +
      '(LastUpdateStatus InProgress); Lambda finishes that update on its own.'
    )
    expect(error.message).toContain(`the previous image was sent back to example-app-prod-a (${previousImage('example-app-prod-a')}).`)
    expect(error.message).not.toContain('left on the new image')
  })

  it('sends the others back once Lambda takes the stalled function\'s change, though it cannot be checked on', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { takes: Infinity, acceptsWhileUpdating: true })
    // Reads fail for good from the moment the restores start.
    const denied = Object.assign(new Error('AccessDeniedException: no'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } })
    const send = aws.lambdaUpdateFunctionCode.getMockImplementation()
    aws.lambdaUpdateFunctionCode.mockImplementation(async (name, image) => {
      if (image !== IMAGE) readFailure = { error: denied, from: now, until: Infinity }
      return send(name, image)
    })

    const error = await failure(deploy())

    expect(error.message).toContain(
      `example-app-prod-b was sent back to ${previousImage('example-app-prod-b')}, but it could not be checked on ` +
      '(AccessDeniedException: no); Lambda finishes that update on its own.'
    )
    expect(error.message).toContain(`the previous image was sent back to example-app-prod-a (${previousImage('example-app-prod-a')}).`)
  })

  it('sends the earlier functions back when a later one\'s update fails, and leaves the failed one as it is', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { takes: 2 * MINUTE, fails: 'Bad image.' })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^example-app-prod-b failed to update to the new image, and keeps running its previous one: Bad image\. /)
    expect(error.message).toContain(`the previous image was sent back to example-app-prod-a (${previousImage('example-app-prod-a')}).`)
    // Lambda kept b's previous image when its update failed.
    expect(updatesTo(previousImage('example-app-prod-b'))).toHaveLength(0)
  })

  it('shares one budget between functions, and leaves one it has no time for untouched', async () => {
    addFunction('example-app-prod-a', { takes: 43 * MINUTE })
    addFunction('example-app-prod-b')

    const error = await failure(deploy())

    expect(error.message).toMatch(/^The rollout budget ran out before example-app-prod-b could be updated/)
    expect(aws.lambdaUpdateFunctionCode.mock.calls.filter(([name]) => name === 'example-app-prod-b')).toHaveLength(0)
    expect(updatesTo(previousImage('example-app-prod-a'))).toHaveLength(1)
  })
})

describe('deployLambda for a rollback', () => {
  it('never sends a function back at the bound', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { takes: Infinity, acceptsWhileUpdating: true })

    const error = await failure(rollback())

    expect(error.message).toContain(
      'This deploy does not stop a rollout (a rollback), so no function was sent back: that would be the release ' +
      'it is rolling back from. example-app-prod-b may still go live on the new image, and nothing will record it.'
    )
    expect(aws.lambdaUpdateFunctionCode.mock.calls.filter(([, image]) => image !== IMAGE)).toHaveLength(0)
  })

  it('never sends the earlier functions back when a later one fails', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { takes: 2 * MINUTE, fails: 'Bad image.' })

    const error = await failure(rollback())

    expect(error.message).toMatch(/^example-app-prod-b failed to update to the new image, .*Bad image\. This deploy does not stop a rollout/)
    expect(aws.lambdaUpdateFunctionCode.mock.calls.filter(([, image]) => image !== IMAGE)).toHaveLength(0)
  })
})
