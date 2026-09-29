import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for every Lambda SDK op (list/get/update + the v2 wait
// helper). src/ecs-config.js (ecrRegistry — pure) and src/v2/env.js run for real,
// so the selection semantics are exercised end to end. deploy-lambda touches no
// ECR, so no ECR SDK mock is needed.
vi.mock('../src/aws.js', async importOriginal => ({
  // The real predicate: it reads only the error's name, and the wait turns on it.
  isWaiterTimeout: (await importOriginal()).isWaiterTimeout,
  lambdaListFunctionNames: vi.fn(),
  lambdaGetFunction: vi.fn(),
  lambdaUpdateFunctionCode: vi.fn(),
  lambdaWaitForFunctionUpdated: vi.fn()
}))

import * as aws from '../src/aws.js'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../src/ecs-config.js'
import { deployLambda } from '../src/v2/deploy-lambda.js'

const REGISTRY = ecrRegistry(DEFAULT_ACCOUNT)
const IMAGE = `${REGISTRY}/example-app@sha256:new`

function imageFn (resolvedImageUri) {
  return { Configuration: { PackageType: 'Image' }, Code: { ResolvedImageUri: resolvedImageUri } }
}
function zipFn () {
  return { Configuration: { PackageType: 'Zip' }, Code: {} }
}

beforeEach(() => {
  for (const fn of Object.values(aws)) fn.mockReset?.()
  aws.lambdaUpdateFunctionCode.mockResolvedValue({})
  aws.lambdaWaitForFunctionUpdated.mockResolvedValue({})
})

describe('deployLambda digest invariant', () => {
  it('rejects a tag reference before touching infrastructure', async () => {
    await expect(
      deployLambda({ projectName: 'example-app', environment: 'production', image: `${REGISTRY}/example-app:release-3` })
    ).rejects.toThrow(/digest-pinned/)
    expect(aws.lambdaListFunctionNames).not.toHaveBeenCalled()
  })
})

describe('deployLambda selection semantics', () => {
  it('updates app-image AND scratch functions, skips non-image + other-repo, waits after each update', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue([
      'example-app-prod-app', 'example-app-prod-scratch', 'example-app-prod-zip', 'example-app-prod-other'
    ])
    aws.lambdaGetFunction.mockImplementation(name => {
      switch (name) {
        case 'example-app-prod-app': return Promise.resolve(imageFn(`${REGISTRY}/example-app@sha256:old`))
        case 'example-app-prod-scratch': return Promise.resolve(imageFn(`${REGISTRY}/scratch@sha256:zzz`))
        case 'example-app-prod-zip': return Promise.resolve(zipFn())
        case 'example-app-prod-other': return Promise.resolve(imageFn(`${REGISTRY}/other-app@sha256:ooo`))
      }
    })

    const result = await deployLambda({ projectName: 'example-app', environment: 'production', image: IMAGE })

    // production -> nickname prod
    expect(aws.lambdaListFunctionNames).toHaveBeenCalledWith('example-app', 'prod')

    // Only the app-image and scratch (first-deploy flip) functions are updated.
    expect(aws.lambdaUpdateFunctionCode.mock.calls.map(c => c[0])).toEqual(['example-app-prod-app', 'example-app-prod-scratch'])
    for (const [, image] of aws.lambdaUpdateFunctionCode.mock.calls) expect(image).toBe(IMAGE)

    // Every updated function is waited on, once each.
    expect(aws.lambdaWaitForFunctionUpdated.mock.calls.map(c => c[0])).toEqual(['example-app-prod-app', 'example-app-prod-scratch'])

    // The wait for a function runs AFTER its own UpdateFunctionCode.
    expect(aws.lambdaUpdateFunctionCode.mock.invocationCallOrder[0])
      .toBeLessThan(aws.lambdaWaitForFunctionUpdated.mock.invocationCallOrder[0])

    expect(result).toEqual({ deployedImage: IMAGE, services: ['example-app-prod-app', 'example-app-prod-scratch'] })
  })
})

describe('deployLambda wait failure', () => {
  it('aborts the deploy when a function fails to finish updating (no further functions touched)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-a', 'example-app-prod-b'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/example-app@sha256:old`))
    aws.lambdaWaitForFunctionUpdated.mockRejectedValueOnce(new Error('function update Failed'))

    await expect(
      deployLambda({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/Failed/)

    // First function was updated; the deploy stopped before touching the second.
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledTimes(1)
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledWith('example-app-prod-a', IMAGE)
  })
})

describe('deployLambda ignores version', () => {
  it('accepts a version but never injects it (Lambda env is Terraform-owned)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-app'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/example-app@sha256:old`))

    const result = await deployLambda({
      projectName: 'example-app', environment: 'production', image: IMAGE, version: 'release-2026-07-23-10057'
    })

    // Only the image is updated — UpdateFunctionCode carries (name, image) and
    // nothing else; there is no config/env mutation path, so version is inert.
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledTimes(1)
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledWith('example-app-prod-app', IMAGE)
    expect(result).toEqual({ deployedImage: IMAGE, services: ['example-app-prod-app'] })
  })
})

describe('deployLambda no match', () => {
  it('throws when functions exist but none use the app or scratch image', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['example-app-prod-zip', 'example-app-prod-other'])
    aws.lambdaGetFunction.mockImplementation(name =>
      Promise.resolve(name === 'example-app-prod-zip' ? zipFn() : imageFn(`${REGISTRY}/other-app@sha256:ooo`))
    )

    await expect(
      deployLambda({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/nothing deployed/)
    expect(aws.lambdaUpdateFunctionCode).not.toHaveBeenCalled()
  })

  it('throws when there are no matching functions at all', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue([])
    await expect(
      deployLambda({ projectName: 'example-app', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/nothing deployed/)
  })
})
