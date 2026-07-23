import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock v1 src/aws.js for every Lambda SDK op (list/get/update + the v2 wait
// helper). src/ecs-config.js (ecrRegistry — pure) and src/v2/env.js run for real,
// so the selection semantics are exercised end to end. deploy-lambda touches no
// ECR, so no ECR SDK mock is needed.
vi.mock('../src/aws.js', () => ({
  lambdaListFunctionNames: vi.fn(),
  lambdaGetFunction: vi.fn(),
  lambdaUpdateFunctionCode: vi.fn(),
  lambdaWaitForFunctionUpdated: vi.fn()
}))

import * as aws from '../src/aws.js'
import { deployLambda } from '../src/v2/deploy-lambda.js'

const REGISTRY = '056154071827.dkr.ecr.us-east-1.amazonaws.com'
const IMAGE = `${REGISTRY}/hoax@sha256:new`

function imageFn (resolvedImageUri) {
  return { Configuration: { PackageType: 'Image' }, Code: { ResolvedImageUri: resolvedImageUri } }
}
function zipFn () {
  return { Configuration: { PackageType: 'Zip' }, Code: {} }
}

beforeEach(() => {
  for (const fn of Object.values(aws)) fn.mockReset()
  aws.lambdaUpdateFunctionCode.mockResolvedValue({})
  aws.lambdaWaitForFunctionUpdated.mockResolvedValue({})
})

describe('deployLambda digest invariant', () => {
  it('rejects a tag reference before touching infrastructure', async () => {
    await expect(
      deployLambda({ projectName: 'hoax', environment: 'production', image: `${REGISTRY}/hoax:release-3` })
    ).rejects.toThrow(/digest-pinned/)
    expect(aws.lambdaListFunctionNames).not.toHaveBeenCalled()
  })
})

describe('deployLambda selection semantics', () => {
  it('updates app-image AND scratch functions, skips non-image + other-repo, waits after each update', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue([
      'hoax-prod-app', 'hoax-prod-scratch', 'hoax-prod-zip', 'hoax-prod-other'
    ])
    aws.lambdaGetFunction.mockImplementation(name => {
      switch (name) {
        case 'hoax-prod-app': return Promise.resolve(imageFn(`${REGISTRY}/hoax@sha256:old`))
        case 'hoax-prod-scratch': return Promise.resolve(imageFn(`${REGISTRY}/scratch@sha256:zzz`))
        case 'hoax-prod-zip': return Promise.resolve(zipFn())
        case 'hoax-prod-other': return Promise.resolve(imageFn(`${REGISTRY}/other-app@sha256:ooo`))
      }
    })

    const result = await deployLambda({ projectName: 'hoax', environment: 'production', image: IMAGE })

    // production -> nickname prod
    expect(aws.lambdaListFunctionNames).toHaveBeenCalledWith('hoax', 'prod')

    // Only the app-image and scratch (first-deploy flip) functions are updated.
    expect(aws.lambdaUpdateFunctionCode.mock.calls.map(c => c[0])).toEqual(['hoax-prod-app', 'hoax-prod-scratch'])
    for (const [, image] of aws.lambdaUpdateFunctionCode.mock.calls) expect(image).toBe(IMAGE)

    // Every updated function is waited on, once each.
    expect(aws.lambdaWaitForFunctionUpdated.mock.calls.map(c => c[0])).toEqual(['hoax-prod-app', 'hoax-prod-scratch'])

    // The wait for a function runs AFTER its own UpdateFunctionCode.
    expect(aws.lambdaUpdateFunctionCode.mock.invocationCallOrder[0])
      .toBeLessThan(aws.lambdaWaitForFunctionUpdated.mock.invocationCallOrder[0])

    expect(result).toEqual({ deployedImage: IMAGE, services: ['hoax-prod-app', 'hoax-prod-scratch'] })
  })
})

describe('deployLambda wait failure', () => {
  it('aborts the deploy when a function fails to finish updating (no further functions touched)', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['hoax-prod-a', 'hoax-prod-b'])
    aws.lambdaGetFunction.mockResolvedValue(imageFn(`${REGISTRY}/hoax@sha256:old`))
    aws.lambdaWaitForFunctionUpdated.mockRejectedValueOnce(new Error('function update Failed'))

    await expect(
      deployLambda({ projectName: 'hoax', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/Failed/)

    // First function was updated; the deploy stopped before touching the second.
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledTimes(1)
    expect(aws.lambdaUpdateFunctionCode).toHaveBeenCalledWith('hoax-prod-a', IMAGE)
  })
})

describe('deployLambda no match', () => {
  it('throws when functions exist but none use the app or scratch image', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue(['hoax-prod-zip', 'hoax-prod-other'])
    aws.lambdaGetFunction.mockImplementation(name =>
      Promise.resolve(name === 'hoax-prod-zip' ? zipFn() : imageFn(`${REGISTRY}/other-app@sha256:ooo`))
    )

    await expect(
      deployLambda({ projectName: 'hoax', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/nothing deployed/)
    expect(aws.lambdaUpdateFunctionCode).not.toHaveBeenCalled()
  })

  it('throws when there are no matching functions at all', async () => {
    aws.lambdaListFunctionNames.mockResolvedValue([])
    await expect(
      deployLambda({ projectName: 'hoax', environment: 'production', image: IMAGE })
    ).rejects.toThrow(/nothing deployed/)
  })
})
