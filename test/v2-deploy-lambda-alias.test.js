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
  aws.lambdaListVersions.mockImplementation(async name => {
    const error = failing(`listVersions:${name}`)
    if (error) throw error
    return Object.entries(functions[name].versions)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([Version, { image }]) => ({ Version, CodeSha256: shaOf(image) }))
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

  it('warns before anything changes when the alias is behind the newest version', async () => {
    addFunction('example-app-prod-a', { versions: { 3: OLD, 4: OTHER } })

    await deploy()

    expect(warnings()[0]).toBe(
      `example-app-prod-a: its live alias is on version 3, but version 4 is newer (image sha256:${hex('c')}), so ` +
      'the next Terraform apply would move the alias to it. This deploy puts the alias back on the newest version ' +
      'once it lands.'
    )
    expectRulesKept('example-app-prod-a')
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
  it('refuses an alias that splits traffic before it changes any function', async () => {
    addFunction('example-app-prod-a', { alias: null })
    addFunction('example-app-prod-b', { weights: { 2: 0.1 } })

    const error = await failure(deploy())

    expect(error.message).toMatch(/^The live alias of example-app-prod-b splits traffic between version 3 and version 2/)
    expect(aws.lambdaUpdateFunctionCode).not.toHaveBeenCalled()
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

describe('a rollback through a live alias', () => {
  // The release being rolled back from is version 4 (NEW); version 3 still
  // runs OLD, the image the rollback goes back to.
  const rollingBack = (name, options = {}) =>
    addFunction(name, { image: NEW, alias: '4', versions: { 2: OTHER, 3: OLD, 4: NEW }, ...options })
  const rollbackTo = () => deployLambda(
    { projectName: 'example-app', environment: 'production', image: OLD, stopRolloutOnFailure: false },
    { budget: rolloutBudget({ now: () => now, sleep, stepStartedAt: 0 }) }
  )

  it('moves every alias back to a version that runs the image before it updates anything, then finishes', async () => {
    rollingBack('example-app-prod-a')
    rollingBack('example-app-prod-b')

    await rollbackTo()

    const flips = aws.lambdaUpdateAlias.mock.calls.slice(0, 2)
    expect(flips).toEqual([
      ['example-app-prod-a', 'live', '3', 'a1'],
      ['example-app-prod-b', 'live', '3', 'a1']
    ])
    const lastFlip = aws.lambdaUpdateAlias.mock.invocationCallOrder[1]
    expect(aws.lambdaUpdateFunctionCode.mock.invocationCallOrder[0]).toBeGreaterThan(lastFlip)
    // Then it publishes the image again with the current config, and the
    // alias ends on the newest version.
    for (const name of ['example-app-prod-a', 'example-app-prod-b']) {
      expect(functions[name].alias.version).toBe('5')
      expect(functions[name].versions['5'].image).toBe(OLD)
      expectRulesKept(name)
    }
  })

  it('rolls back the ordinary way when no published version runs the image', async () => {
    rollingBack('example-app-prod-a', { versions: { 2: OTHER, 4: NEW } })

    await rollbackTo()

    expect(aws.lambdaUpdateAlias.mock.calls).toEqual([['example-app-prod-a', 'live', '5', 'a1']])
    expectRulesKept('example-app-prod-a')
  })

  it('does not move an alias to a version that is not Active', async () => {
    rollingBack('example-app-prod-a')
    const read = aws.lambdaGetFunction.getMockImplementation()
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
      const response = await read(name, qualifier)
      if (qualifier === '3') response.Configuration.State = 'Inactive'
      return response
    })

    await rollbackTo()

    expect(aws.lambdaUpdateAlias.mock.calls).toEqual([['example-app-prod-a', 'live', '5', 'a1']])
  })

  it('rolls back the ordinary way, with a warning, when it cannot list versions', async () => {
    rollingBack('example-app-prod-a')
    aws.lambdaListVersions.mockRejectedValue(awsError('AccessDeniedException', 403, 'not authorized'))

    await rollbackTo()

    expect(warnings()[0]).toMatch(/could not look for a published version that runs .* \(not authorized \(to deploy through a live alias/)
    expectRulesKept('example-app-prod-a')
  })

  it('says the alias is behind the newest version when the rollback stops after moving it', async () => {
    rollingBack('example-app-prod-a')
    rollingBack('example-app-prod-b')
    failNext['update:example-app-prod-a'] = awsError('ServiceException', 500, 'boom')

    const error = await failure(rollbackTo())

    expect(error.message).toContain('so no function was sent back')
    for (const name of ['example-app-prod-a', 'example-app-prod-b']) {
      expect(error.message).toContain(
        `${name}'s live alias went back to version 3 at once, so it runs the image this rollback is for. But ` +
        `version 4, which runs ${NEW}, the release this rollback is from, is still newer than version 3, and ` +
        '$LATEST may still run that image. So the next Terraform apply, or any config change, would put that ' +
        'release live again, with nothing to record it. Run the rollback again to finish it.'
      )
      expect(functions[name].alias.version).toBe('3')
    }
  })

  it('updates the functions it could not move back before the ones it did', async () => {
    rollingBack('example-app-prod-a')
    rollingBack('example-app-prod-b', { versions: { 2: OTHER, 4: NEW } })

    await rollbackTo()

    expect(aws.lambdaUpdateFunctionCode.mock.calls.map(([name]) => name)).toEqual(['example-app-prod-b', 'example-app-prod-a'])
  })

  it('rolls back the ordinary way when the alias would not move at once', async () => {
    rollingBack('example-app-prod-a')
    aws.lambdaUpdateAlias.mockImplementationOnce(async () => { throw awsError('PreconditionFailedException', 412, 'The alias changed') })

    await rollbackTo()

    expect(warnings()).toContainEqual(expect.stringMatching(
      /^example-app-prod-a: could not move the live alias to version 3 at once \(The alias changed\)/
    ))
    expectRulesKept('example-app-prod-a')
  })

  it('counts a move back whose answer was lost as done', async () => {
    rollingBack('example-app-prod-a')
    rollingBack('example-app-prod-b', { versions: { 2: OTHER, 4: NEW } })
    const move = aws.lambdaUpdateAlias.getMockImplementation()
    aws.lambdaUpdateAlias.mockImplementationOnce(async (...args) => {
      await move(...args)
      throw awsError('ServiceException', 500, 'boom')
    })

    await rollbackTo()

    // a was moved back, so b goes first.
    expect(aws.lambdaUpdateFunctionCode.mock.calls.map(([name]) => name)).toEqual(['example-app-prod-b', 'example-app-prod-a'])
    expectRulesKept('example-app-prod-a')
  })

  it('reads the alias again before going on when a move back is lost and the alias cannot be read', async () => {
    rollingBack('example-app-prod-a')
    const move = aws.lambdaUpdateAlias.getMockImplementation()
    aws.lambdaUpdateAlias.mockImplementationOnce(async (...args) => {
      await move(...args)
      failNext['getAlias:example-app-prod-a'] = awsError('ServiceException', 500, 'boom')
      throw awsError('ServiceException', 500, 'boom')
    })

    await rollbackTo()

    expect(warnings()).toContainEqual(expect.stringMatching(/the alias could not be read to see whether it moved/))
    expect(functions['example-app-prod-a'].alias.version).toBe('5')
    expectRulesKept('example-app-prod-a')
  })

  it('says when the version it moves back to runs with older settings', async () => {
    rollingBack('example-app-prod-a')
    const read = aws.lambdaGetFunction.getMockImplementation()
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
      const response = await read(name, qualifier)
      response.Configuration.MemorySize = qualifier === '3' ? 128 : 512
      response.Configuration.Environment = { Variables: { B: '2', A: '1' } }
      return response
    })

    await rollbackTo()

    expect(warnings()).toContainEqual(
      'example-app-prod-a: version 3 runs with older settings than the function has now (memory), until this ' +
      'rollback publishes the image again with today\'s.'
    )
  })

  it('checks only the three newest versions that report the image, and only one that really runs it', async () => {
    rollingBack('example-app-prod-a', { versions: { 1: OLD, 2: OLD, 3: OLD, 4: OTHER, 5: NEW }, alias: '5' })
    const list = aws.lambdaListVersions.getMockImplementation()
    // Version 4 claims the image's digest but runs another one; 3 and 2 are
    // Inactive, and 1, which would do, is past the three checked.
    aws.lambdaListVersions.mockImplementation(async name =>
      (await list(name)).map(version => version.Version === '4' ? { ...version, CodeSha256: hex('a') } : version))
    const read = aws.lambdaGetFunction.getMockImplementation()
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
      const response = await read(name, qualifier)
      if (qualifier === '3' || qualifier === '2') response.Configuration.State = 'Inactive'
      return response
    })

    await rollbackTo()

    expect(aws.lambdaGetFunction.mock.calls.filter(([, qualifier]) => qualifier === '1')).toEqual([])
    expect(aws.lambdaUpdateAlias.mock.calls).toEqual([['example-app-prod-a', 'live', '6', 'a1']])
  })

  it('says when the newest version already runs the image, after the rollback stops waiting on it', async () => {
    rollingBack('example-app-prod-a', { becomesActiveIn: 60 * MINUTE })

    const error = await failure(rollbackTo())

    expect(error.message).toContain(
      "example-app-prod-a's live alias went back to version 3 at once, so it runs the image this rollback is " +
      'for. The newest version, 5, runs that image too'
    )
  })

  it('says the alias went back when a read fails for good after the move', async () => {
    rollingBack('example-app-prod-a', { takes: 10 * MINUTE })
    let broken = false
    const read = aws.lambdaGetFunction.getMockImplementation()
    aws.lambdaGetFunction.mockImplementation(async (name, qualifier) => {
      if (broken && !qualifier) throw awsError('AccessDeniedException', 403, 'not authorized')
      return read(name, qualifier)
    })
    const wait = aws.lambdaWaitForFunctionUpdated.getMockImplementation()
    aws.lambdaWaitForFunctionUpdated.mockImplementation(async (...args) => {
      try {
        return await wait(...args)
      } finally {
        broken = true
      }
    })

    const error = await failure(rollbackTo())

    expect(error.message).toMatch(/could not read the function while waiting for its update/)
    expect(error.message).toContain("example-app-prod-a's live alias went back to version 3 at once")
  })

  it('does not prune in a rollback', async () => {
    rollingBack('example-app-prod-a', { versions: { 1: OTHER, 2: OTHER, 3: OLD, 4: NEW } })

    await rollbackTo()

    expect(aws.lambdaDeleteFunctionVersion).not.toHaveBeenCalled()
  })

  it('moves no alias at once in an ordinary deploy, even when an older version runs the image', async () => {
    rollingBack('example-app-prod-a')

    await deployLambda({ projectName: 'example-app', environment: 'production', image: OLD },
      { budget: rolloutBudget({ now: () => now, sleep, stepStartedAt: 0 }) })

    expect(aws.lambdaUpdateAlias.mock.calls).toEqual([['example-app-prod-a', 'live', '5', 'a1']])
  })

  it('finishes a rollback whose alias is already on the image', async () => {
    // An earlier rollback moved the alias at once, then stopped.
    rollingBack('example-app-prod-a', { alias: '3', image: OLD })

    await rollbackTo()

    // It says the alias is behind, moves nothing at once, and finishes.
    expect(warnings()).toContainEqual(expect.stringMatching(
      /^example-app-prod-a: its live alias is on version 3, but version 4 is newer \(image sha256:b+\)/
    ))
    expect(aws.lambdaUpdateAlias.mock.calls).toEqual([['example-app-prod-a', 'live', '5', 'a1']])
    expectRulesKept('example-app-prod-a')
  })
})

describe('pruning old versions after a deploy through a live alias', () => {
  const versionsOf = name => Object.keys(functions[name].versions).map(Number)

  it('keeps the newest version of each of the last five images, and deletes the rest', async () => {
    const image = c => `${REGISTRY}/example-app@sha256:${hex(c)}`
    // Seven images, with config-only versions (the same image twice) mixed in.
    addFunction('example-app-prod-a', {
      image: image('7'),
      alias: '10',
      versions: {
        1: image('1'), 2: image('2'), 3: image('3'), 4: image('3'), 5: image('4'),
        6: image('5'), 7: image('5'), 8: image('6'), 9: image('7'), 10: image('7')
      }
    })

    await deploy()

    // NEW is version 11; then images 7, 6, 5 and 4, newest version of each.
    expect(versionsOf('example-app-prod-a')).toEqual([5, 7, 8, 10, 11])
  })

  it('never deletes a version newer than the alias\'s', async () => {
    addFunction('example-app-prod-a')
    const move = aws.lambdaUpdateAlias.getMockImplementation()
    aws.lambdaUpdateAlias.mockImplementationOnce(async (...args) => {
      const result = await move(...args)
      // An apply publishes again right after the deploy moved the alias.
      const fn = functions['example-app-prod-a']
      fn.versions[String(fn.nextVersion++)] = { image: OTHER, description: '', activeAt: 0, fails: '' }
      return result
    })

    await deploy()

    expect(versionsOf('example-app-prod-a')).toEqual([2, 3, 4, 5])
  })

  it('skips a version something else still holds, and keeps going', async () => {
    const image = c => `${REGISTRY}/example-app@sha256:${hex(c)}`
    addFunction('example-app-prod-a', {
      versions: { 1: image('1'), 2: image('2'), 3: OLD, 4: image('4'), 5: image('5'), 6: image('6'), 7: OLD }, alias: '7'
    })
    aws.lambdaDeleteFunctionVersion.mockImplementationOnce(async () => {
      throw awsError('ResourceConflictException', 409, 'Version is in use by another alias')
    })

    await deploy()

    // NEW is version 8. Version 3 (an older OLD) goes first, refused; 2 and 1
    // still go.
    expect(versionsOf('example-app-prod-a')).toEqual([3, 4, 5, 6, 7, 8])
  })

  it('deletes at most twenty versions a deploy, pausing between them', async () => {
    const versions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, OLD]))
    addFunction('example-app-prod-a', { versions, alias: '30' })

    await deploy()

    // Version 30 stays (newest of OLD), 31 is the new one; 20 of the other 29 go.
    expect(versionsOf('example-app-prod-a')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 31])
    expect(aws.lambdaDeleteFunctionVersion).toHaveBeenCalledTimes(20)
  })

  it('stops pruning, with a warning, at a delete that fails for another reason', async () => {
    const image = c => `${REGISTRY}/example-app@sha256:${hex(c)}`
    addFunction('example-app-prod-a', {
      versions: { 1: image('1'), 2: image('2'), 3: OLD, 4: image('4'), 5: image('5'), 6: image('6'), 7: OLD }, alias: '7'
    })
    aws.lambdaDeleteFunctionVersion.mockImplementationOnce(async () => { throw awsError('ServiceException', 500, 'boom') })

    await deploy()

    expect(versionsOf('example-app-prod-a')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(warnings()).toContainEqual('example-app-prod-a: stopped pruning at version 3 (boom).')
  })

  it('never fails the deploy', async () => {
    addFunction('example-app-prod-a')
    aws.lambdaListVersions.mockRejectedValue(awsError('ServiceException', 500, 'boom'))

    expect(await deploy()).toEqual({ deployedImage: NEW, services: ['example-app-prod-a'] })
    expect(warnings()).toContainEqual('example-app-prod-a: could not list its versions to prune old ones (boom).')
  })

  it('does not prune after a deploy that failed', async () => {
    addFunction('example-app-prod-a')
    addFunction('example-app-prod-b', { alias: null })
    failNext['update:example-app-prod-b'] = awsError('ServiceException', 500, 'boom')

    await failure(deploy())

    // Only the read before the deploy lists versions.
    expect(aws.lambdaListVersions).toHaveBeenCalledTimes(1)
  })

  it('leaves functions without the alias alone', async () => {
    addFunction('example-app-prod-a', { alias: null })

    await deploy()

    expect(aws.lambdaListVersions).not.toHaveBeenCalled()
  })
})
