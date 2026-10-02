import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// Deploying a function through its live alias, against a small fake Lambda
// that keeps $LATEST, published versions and the alias. The error predicates
// stay real: the waits turn on them.
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
  lambdaDeleteFunctionVersion: vi.fn()
}))

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal()),
  info: vi.fn(),
  warning: vi.fn()
}))

import * as core from '@actions/core'
import * as aws from '../src/aws.js'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../src/ecs-config.js'
import { deployLambda } from '../src/v2/deploy-lambda.js'
import { rolloutBudget } from '../src/v2/rollout-budget.js'

const MINUTE = 60 * 1000
const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)
const hex = c => c.repeat(64)
const OLD = `${REGISTRY}/example-app@sha256:${hex('a')}`
const NEW = `${REGISTRY}/example-app@sha256:${hex('b')}`
const OTHER = `${REGISTRY}/example-app@sha256:${hex('c')}`

let now
const sleep = async ms => { now += ms }

const awsError = (name, status, message = name) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } })

// One error to throw from the next call of a fake operation, by name.
let failNext

// The fake: per function, $LATEST (image, revision, an update in flight), the
// published versions, and the live alias (or none).
let functions
function addFunction (name, {
  image = OLD, alias = '3', versions = { 1: OTHER, 2: OTHER, 3: image }, takes = 30 * 1000,
  becomesActiveIn = 0, versionFails = '', weights
} = {}) {
  const published = {}
  for (const [version, versionImage] of Object.entries(versions)) {
    published[version] = { image: versionImage, description: '', activeAt: 0, fails: '' }
  }
  functions[name] = {
    image,
    revision: 1,
    takes,
    update: null,
    versions: published,
    nextVersion: Math.max(0, ...Object.keys(published).map(Number)) + 1,
    alias: alias === null ? null : { version: alias, revision: 1, weights },
    becomesActiveIn,
    versionFails
  }
}

function status (fn) {
  if (!fn.update) return 'Successful'
  if (now < fn.update.doneAt) return 'InProgress'
  fn.image = fn.update.image
  fn.revision++
  fn.update = null
  return 'Successful'
}

const newest = fn => String(Math.max(...Object.keys(fn.versions).map(Number)))
const shaOf = image => image.split('@sha256:')[1]

function failing (operation) {
  const error = failNext?.[operation]
  if (error) delete failNext[operation]
  return error
}

function installFakeLambda () {
  aws.lambdaListFunctionNames.mockImplementation(async () => Object.keys(functions))
  aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
    const fn = functions[name]
    if (qualifier) {
      const version = fn.versions[qualifier]
      if (!version) throw awsError('ResourceNotFoundException', 404)
      const state = now < version.activeAt ? 'Pending' : version.fails ? 'Failed' : 'Active'
      return {
        Configuration: { PackageType: 'Image', Version: qualifier, State: state, StateReason: state === 'Failed' ? version.fails : '' },
        Code: { ResolvedImageUri: version.image }
      }
    }
    const LastUpdateStatus = status(fn)
    return {
      Configuration: { PackageType: 'Image', LastUpdateStatus, CodeSha256: shaOf(fn.image), RevisionId: `r${fn.revision}` },
      Code: { ResolvedImageUri: fn.image }
    }
  })
  aws.lambdaUpdateFunctionCode.mockImplementation(async (name, image) => {
    const error = failing(`update:${name}`)
    if (error) throw error
    const fn = functions[name]
    if (status(fn) === 'InProgress') throw awsError('ResourceConflictException', 409, `An update is in progress for resource: ${name}`)
    fn.update = { image, doneAt: image === fn.image ? now : now + fn.takes }
  })
  aws.lambdaWaitForFunctionUpdated.mockImplementation(async (name, maxWaitTime) => {
    const fn = functions[name]
    const doneIn = fn.update.doneAt - now
    if (doneIn > maxWaitTime * 1000) {
      now += maxWaitTime * 1000
      throw Object.assign(new Error('{"state":"TIMEOUT"}'), { name: 'TimeoutError' })
    }
    now += doneIn
    status(fn)
    return { state: 'SUCCESS' }
  })
  aws.lambdaGetAlias.mockImplementation(async name => {
    const error = failing(`getAlias:${name}`)
    if (error) throw error
    const { alias } = functions[name]
    if (!alias) throw awsError('ResourceNotFoundException', 404, 'Alias not found')
    return {
      Name: 'live',
      FunctionVersion: alias.version,
      RevisionId: `a${alias.revision}`,
      ...(alias.weights ? { RoutingConfig: { AdditionalVersionWeights: alias.weights } } : {})
    }
  })
  aws.lambdaPublishVersion.mockImplementation(async (name, { codeSha256, revisionId, description }) => {
    const error = failing(`publish:${name}`)
    if (error) throw error
    const fn = functions[name]
    if (status(fn) === 'InProgress') throw awsError('ResourceConflictException', 409)
    if (revisionId !== `r${fn.revision}`) throw awsError('PreconditionFailedException', 412)
    if (codeSha256 !== shaOf(fn.image)) throw awsError('InvalidParameterValueException', 400, 'CodeSha256 does not match')
    // Nothing changed since the newest version: Lambda returns it as it is.
    const last = newest(fn)
    if (fn.versions[last].image === fn.image) return { Version: last, Description: fn.versions[last].description }
    const version = String(fn.nextVersion++)
    fn.versions[version] = { image: fn.image, description, activeAt: now + fn.becomesActiveIn, fails: fn.versionFails }
    return { Version: version, Description: description }
  })
  aws.lambdaUpdateAlias.mockImplementation(async (name, aliasName, version, revisionId) => {
    const error = failing(`updateAlias:${name}`)
    if (error) throw error
    const fn = functions[name]
    if (aliasName !== 'live') throw new Error(`unexpected alias ${aliasName}`)
    if (revisionId !== `a${fn.alias.revision}`) throw awsError('PreconditionFailedException', 412)
    if (!fn.versions[version]) throw awsError('ResourceNotFoundException', 404)
    fn.alias = { version, revision: fn.alias.revision + 1 }
    return { RevisionId: `a${fn.alias.revision}`, FunctionVersion: version }
  })
  aws.lambdaDeleteFunctionVersion.mockImplementation(async (name, version) => {
    const error = failing(`delete:${name}`)
    if (error) throw error
    const fn = functions[name]
    if (fn.alias?.version === version) throw awsError('ResourceConflictException', 409, 'Version is in use by an alias')
    delete fn.versions[version]
  })
}

// The two rules (see src/v2/lambda-alias.js), checked once Lambda has finished
// every update in flight.
function expectRulesKept (name) {
  const fn = functions[name]
  now += 60 * MINUTE
  status(fn)
  expect(fn.alias.version).toBe(newest(fn))
  expect(fn.image).toBe(fn.versions[fn.alias.version].image)
}

const deploy = (args = {}) => deployLambda(
  { projectName: 'example-app', environment: 'production', image: NEW, ...args },
  { budget: rolloutBudget({ now: () => now, sleep, stepStartedAt: 0 }) }
)
const failure = promise => promise.then(() => { throw new Error('expected the deploy to fail') }, error => error)
const warnings = () => core.warning.mock.calls.map(([message]) => message)

beforeEach(() => {
  for (const fn of Object.values(aws)) fn.mockReset?.()
  core.info.mockReset()
  core.warning.mockReset()
  now = 0
  functions = {}
  failNext = {}
  installFakeLambda()
})

afterEach(() => vi.unstubAllEnvs())

describe('deployLambda through a live alias', () => {
  it('publishes the new image and moves the alias to it, keeping both rules', async () => {
    addFunction('example-app-prod-a')

    expect(await deploy()).toEqual({ deployedImage: NEW, services: ['example-app-prod-a'] })

    expect(aws.lambdaPublishVersion).toHaveBeenCalledWith('example-app-prod-a', {
      codeSha256: hex('b'),
      revisionId: 'r2',
      description: expect.stringMatching(new RegExp(`^Deployed sha256:${hex('b')} \\(`))
    })
    expect(aws.lambdaUpdateAlias).toHaveBeenCalledWith('example-app-prod-a', 'live', '4', 'a1')
    expect(functions['example-app-prod-a'].alias.version).toBe('4')
    expect(functions['example-app-prod-a'].versions['4'].image).toBe(NEW)
    expectRulesKept('example-app-prod-a')
  })

  it('names the run in the description of the version it publishes', async () => {
    vi.stubEnv('GITHUB_RUN_ID', '123')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
    addFunction('example-app-prod-a')

    await deploy()

    expect(functions['example-app-prod-a'].versions['4'].description).toMatch(/\(run 123\.2, [0-9a-f]{8}\)$/)
  })

  it('deploys a function without the alias exactly as before, next to one with it', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { alias: null })

    await deploy()

    expect(aws.lambdaPublishVersion.mock.calls.map(([name]) => name)).toEqual(['example-app-prod-a'])
    expect(aws.lambdaUpdateAlias.mock.calls.map(([name]) => name)).toEqual(['example-app-prod-a'])
    expect(functions['example-app-prod-b'].image).toBe(NEW)
  })

  it('treats an alias on $LATEST like no alias: it already follows $LATEST', async () => {
    addFunction('example-app-prod-a', { alias: '$LATEST' })

    await deploy()

    expect(aws.lambdaPublishVersion).not.toHaveBeenCalled()
    expect(functions['example-app-prod-a'].image).toBe(NEW)
  })

  it('deploys to $LATEST, with a warning, when the role cannot read aliases yet', async () => {
    addFunction('example-app-prod-a')
    failNext['getAlias:example-app-prod-a'] = awsError('AccessDeniedException', 403, 'not authorized to perform lambda:GetAlias')

    await deploy()

    expect(aws.lambdaPublishVersion).not.toHaveBeenCalled()
    expect(functions['example-app-prod-a'].image).toBe(NEW)
    expect(warnings()[0]).toMatch(
      /^Could not read the live alias of example-app-prod-a \(not authorized .*\), so it is treated as a function without one/
    )
  })

  it('moves nothing when the image is already published on the version the alias is on', async () => {
    addFunction('example-app-prod-a', { image: NEW, versions: { 3: NEW } })

    await deploy()

    expect(aws.lambdaUpdateAlias).not.toHaveBeenCalled()
    expect(functions['example-app-prod-a'].versions).toHaveProperty('3')
    expect(Object.keys(functions['example-app-prod-a'].versions)).toEqual(['3'])
  })

  it('waits for a version that starts out Pending before moving the alias to it', async () => {
    addFunction('example-app-prod-a', { becomesActiveIn: 2 * MINUTE })

    await deploy()

    expect(functions['example-app-prod-a'].alias.version).toBe('4')
    expect(now).toBeGreaterThanOrEqual(30 * 1000 + 2 * MINUTE)
  })

  it('restores the live release when the alias it starts from is not the image $LATEST runs', async () => {
    addFunction('example-app-prod-a', { image: OTHER, versions: { 3: OLD } })
    addFunction('example-app-prod-b')
    failNext['update:example-app-prod-b'] = awsError('ServiceException', 500, 'boom')

    const error = await failure(deploy())

    expect(warnings()[0]).toMatch(/example-app-prod-a: \$LATEST runs .*, but version 3, .* runs /)
    expect(error.message).toContain(`its $LATEST was sent back to ${OLD}`)
    expectRulesKept('example-app-prod-a')
  })
})

describe('deployLambda through a live alias, when it ends short', () => {
  it('refuses an alias that splits traffic, and sends back the functions before it', async () => {
    addFunction('example-app-prod-a', { alias: null })
    addFunction('example-app-prod-b', { weights: { 2: 0.1 } })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^The live alias of example-app-prod-b splits traffic between version 3 and version 2/)
    expect(error.message).toContain(`the previous image was sent back to example-app-prod-a (${OLD})`)
    expect(functions['example-app-prod-b'].update).toBeNull()
    expect(functions['example-app-prod-b'].image).toBe(OLD)
  })

  it('sends a function back when its publish is refused, leaving its alias alone', async () => {
    addFunction('example-app-prod-a')
    failNext['publish:example-app-prod-a'] = awsError('PreconditionFailedException', 412, 'The revision ID does not match')

    const error = await failure(deploy())

    expect(error.message).toMatch(/^The revision ID does not match/)
    expect(error.message).toContain(
      `example-app-prod-a is back on the previous release: its live alias never left version 3 and its $LATEST was sent back to ${OLD}.`
    )
    expect(aws.lambdaDeleteFunctionVersion).not.toHaveBeenCalled()
    expectRulesKept('example-app-prod-a')
  })

  it('deletes the version it published when that version never became active', async () => {
    addFunction('example-app-prod-a', { versionFails: 'The image could not be optimized' })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Version 4 of example-app-prod-a failed to become active: The image could not be optimized/)
    expect(error.message).toContain('version 4, which this deploy published, was deleted')
    expect(functions['example-app-prod-a'].versions).not.toHaveProperty('4')
    expectRulesKept('example-app-prod-a')
  })

  it('does not move the alias to a version still Pending when the budget runs out', async () => {
    addFunction('example-app-prod-a', { becomesActiveIn: 60 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Version 4 of example-app-prod-a was not active .* after it was published \(State Pending\), so the live alias was not moved to it\./)
    expect(aws.lambdaUpdateAlias).not.toHaveBeenCalled()
    expectRulesKept('example-app-prod-a')
  })

  it('moves an alias back, deletes its new version and sends $LATEST back when a later function fails', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { alias: null })
    failNext['update:example-app-prod-b'] = awsError('InvalidParameterValueException', 400, 'bad image')

    const error = await failure(deploy())

    expect(error.message).toContain(
      'example-app-prod-a is back on the previous release: its live alias points at version 3 again, ' +
      `version 4, which this deploy published, was deleted and its $LATEST was sent back to ${OLD}.`
    )
    // The alias first, so the triggers are back before anything else changes.
    const order = [aws.lambdaUpdateAlias, aws.lambdaDeleteFunctionVersion, aws.lambdaUpdateFunctionCode]
      .map(fn => fn.mock.invocationCallOrder.at(-1))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expectRulesKept('example-app-prod-a')
  })

  it('never deletes a version it did not publish', async () => {
    // The newest version already runs the new image, but the alias is behind
    // it: Lambda hands that version back instead of publishing one.
    addFunction('example-app-prod-a', { versions: { 3: OLD, 5: NEW }, image: OLD })
    addFunction('example-app-prod-b', { alias: null })
    failNext['update:example-app-prod-b'] = awsError('InvalidParameterValueException', 400, 'bad image')

    const error = await failure(deploy())

    expect(aws.lambdaUpdateAlias).toHaveBeenCalledWith('example-app-prod-a', 'live', '5', 'a1')
    expect(aws.lambdaDeleteFunctionVersion).not.toHaveBeenCalled()
    expect(error.message).toContain('its live alias points at version 3 again and its $LATEST was sent back to')
    // It says the version it left breaks rule 1, and how to fix it.
    expect(error.message).toContain(
      'Version 5 of example-app-prod-a already ran the new image before this deploy, and it is newer than ' +
      'version 3, which the live alias is on. The next Terraform apply would point the alias at it and put the ' +
      'new image live. This deploy did not publish it, so it was left alone. Delete it by hand if nothing needs ' +
      'it: aws lambda delete-function --function-name example-app-prod-a --qualifier 5'
    )
  })

  it('counts an alias move whose answer was lost as done', async () => {
    addFunction('example-app-prod-a')
    const move = aws.lambdaUpdateAlias.getMockImplementation()
    aws.lambdaUpdateAlias.mockImplementationOnce(async (...args) => {
      await move(...args)
      // The SDK's retry carries the old revision.
      throw awsError('PreconditionFailedException', 412, 'The Revision Id provided does not match')
    })

    expect(await deploy()).toEqual({ deployedImage: NEW, services: ['example-app-prod-a'] })
    expectRulesKept('example-app-prod-a')
  })

  it('moves back an alias whose move this deploy made but could not confirm', async () => {
    addFunction('example-app-prod-a')
    const move = aws.lambdaUpdateAlias.getMockImplementation()
    aws.lambdaUpdateAlias.mockImplementationOnce(async (...args) => {
      await move(...args)
      failNext['getAlias:example-app-prod-a'] = awsError('ServiceException', 500, 'boom')
      throw awsError('PreconditionFailedException', 412, 'The Revision Id provided does not match')
    })

    const error = await failure(deploy())

    expect(error.message).toContain(
      'example-app-prod-a is back on the previous release: its live alias points at version 3 again, version 4'
    )
    expectRulesKept('example-app-prod-a')
  })

  it('says a failed publish may have left a version, and how to find it', async () => {
    addFunction('example-app-prod-a')
    const publish = aws.lambdaPublishVersion.getMockImplementation()
    aws.lambdaPublishVersion.mockImplementationOnce(async (...args) => {
      await publish(...args)
      throw awsError('ServiceException', 500, 'We encountered an internal error')
    })

    const error = await failure(deploy())

    const { description } = functions['example-app-prod-a'].versions['4']
    expect(error.message).toContain(
      'Publishing example-app-prod-a failed in a way that may have created a version anyway. If it has a version ' +
      `described "${description}", that version is the newest`
    )
  })

  it('says nothing about a stray version when the publish was refused outright', async () => {
    addFunction('example-app-prod-a')
    failNext['publish:example-app-prod-a'] = awsError('InvalidParameterValueException', 400, 'CodeSha256 does not match')

    expect((await failure(deploy())).message).not.toContain('may have created a version')
  })

  it('names the permissions the role is missing when a step of the alias deploy is denied', async () => {
    addFunction('example-app-prod-a')
    failNext['publish:example-app-prod-a'] = awsError('AccessDeniedException', 403, 'not authorized to perform lambda:PublishVersion')

    expect((await failure(deploy())).message).toMatch(
      /^not authorized to perform lambda:PublishVersion \(to deploy through a live alias, the deploy role needs lambda:GetAlias, /
    )
  })

  it('does not wait on an Inactive version, which Lambda only wakes on an invocation', async () => {
    addFunction('example-app-prod-a', { versions: { 3: OLD, 5: NEW }, image: OLD })
    const read = aws.lambdaGetFunction.getMockImplementation()
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
      const response = await read(name, qualifier)
      if (qualifier === '5') response.Configuration.State = 'Inactive'
      return response
    })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^Version 5 of example-app-prod-a is Inactive/)
    expect(now).toBeLessThan(5 * MINUTE)
    expect(functions['example-app-prod-a'].alias.version).toBe('3')
  })

  it('gives the hand fix in alias order when a function without the alias stalls', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { alias: null, takes: 60 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(
      'aws lambda update-alias --function-name example-app-prod-a --name live --function-version 3, then ' +
      'aws lambda delete-function --function-name example-app-prod-a --qualifier 4, then ' +
      `aws lambda update-function-code --function-name example-app-prod-a --image-uri ${OLD}; ` +
      `aws lambda update-function-code --function-name example-app-prod-b --image-uri ${OLD}`
    )
  })

  it('leaves a function alone when something else moved its alias during the deploy', async () => {
    addFunction('example-app-prod-a')
    aws.lambdaUpdateAlias.mockImplementationOnce(async name => {
      functions[name].alias = { version: '2', revision: 9 }
      throw awsError('PreconditionFailedException', 412, 'The alias changed')
    })

    const error = await failure(deploy())

    expect(error.message).toContain(
      'The live alias of example-app-prod-a was moved from version 3 to version 2 by something other than this ' +
      'deploy, so this function was not sent back.'
    )
    expect(aws.lambdaDeleteFunctionVersion).not.toHaveBeenCalled()
    expect(functions['example-app-prod-a'].image).toBe(NEW)
  })

  it('changes nothing else about a function whose alias would not move back', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { alias: null })
    failNext['update:example-app-prod-b'] = awsError('InvalidParameterValueException', 400, 'bad image')
    aws.lambdaUpdateAlias.mockImplementationOnce(aws.lambdaUpdateAlias.getMockImplementation())
    aws.lambdaUpdateAlias.mockImplementationOnce(async () => { throw awsError('ServiceException', 500, 'boom') })

    const error = await failure(deploy())

    expect(error.message).toContain(
      'Could not move the live alias of example-app-prod-a back to version 3 (boom), so it keeps serving the new ' +
      'image unrecorded, and nothing else about it was changed. Move it back by hand: aws lambda update-alias ' +
      '--function-name example-app-prod-a --name live --function-version 3; then aws lambda delete-function ' +
      `--function-name example-app-prod-a --qualifier 4; then aws lambda update-function-code --function-name ` +
      `example-app-prod-a --image-uri ${OLD}`
    )
    expect(aws.lambdaDeleteFunctionVersion).not.toHaveBeenCalled()
    expect(functions['example-app-prod-a'].image).toBe(NEW)
  })

  it('says how to delete the new version by hand when the role cannot', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { alias: null })
    failNext['update:example-app-prod-b'] = awsError('InvalidParameterValueException', 400, 'bad image')
    failNext['delete:example-app-prod-a'] = awsError('AccessDeniedException', 403, 'not authorized')

    const error = await failure(deploy())

    expect(error.message).toContain(
      'Could not delete version 4 of example-app-prod-a (not authorized). It is still the newest version, so the ' +
      'next Terraform apply would point the live alias at it and put the new image live. Delete it by hand: ' +
      'aws lambda delete-function --function-name example-app-prod-a --qualifier 4'
    )
    expect(functions['example-app-prod-a'].alias.version).toBe('3')
    expect(functions['example-app-prod-a'].update.image).toBe(OLD)
  })

  it('still sends the others back when a function behind its alias stalls and Lambda refuses its send-back', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { takes: 60 * MINUTE })

    const error = await failure(deploy())

    expect(error.message).toContain(
      'Its live alias is still on version 3, so it keeps serving the previous release. But its $LATEST may still ' +
      'land the new image'
    )
    expect(error.message).toContain('example-app-prod-a is back on the previous release: its live alias points at version 3 again')
    expect(functions['example-app-prod-b'].alias.version).toBe('3')
    expectRulesKept('example-app-prod-a')
  })

  it('sends nothing back in a rollback', async () => {
    addFunction('example-app-prod-a')
    failNext['publish:example-app-prod-a'] = awsError('ServiceException', 500, 'boom')

    const error = await failure(deploy({ stopRolloutOnFailure: false }))

    expect(error.message).toContain(
      'Check which image each function runs (for a function with a live alias, the image of the version it points at).'
    )
    expect(functions['example-app-prod-a'].image).toBe(NEW)
    expect(functions['example-app-prod-a'].alias.version).toBe('3')
  })

  it('does not publish a $LATEST that something else changed after the update landed', async () => {
    addFunction('example-app-prod-a')
    const read = aws.lambdaGetFunction.getMockImplementation()
    let reads = 0
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
      const response = await read(name, qualifier)
      // The initial read, then the one before publishing.
      if (!qualifier && ++reads === 2) response.Code.ResolvedImageUri = OTHER
      return response
    })

    const error = await failure(deploy())

    expect(error.message).toMatch(
      /^example-app-prod-a: \$LATEST runs .*sha256:c+, not the image this deploy sent, so it was not published/
    )
    expect(aws.lambdaPublishVersion).not.toHaveBeenCalled()
  })
})
