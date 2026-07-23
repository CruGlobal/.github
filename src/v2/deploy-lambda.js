import * as core from '@actions/core'
import {
  lambdaGetFunction,
  lambdaListFunctionNames,
  lambdaUpdateFunctionCode,
  lambdaWaitForFunctionUpdated
} from '../aws'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../ecs-config'
import { environmentNickname } from './env'
import { assertDigestRef } from './image-ref'

// Max seconds to wait for a single function's code update to become live.
const MAX_WAIT_SECONDS = 300

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
// Like ECS, Lambda derives everything from the env nickname + naming
// conventions, so runtime-project (a GCP-only input) is ignored here.
//
// Returns { deployedImage, services } (services = updated function names).
export async function deployLambda ({ projectName, environment, image }) {
  assertDigestRef(image) // defensive; the router validates too

  const nickname = environmentNickname(environment)
  const appRepoPrefix = `${ecrRegistry(DEFAULT_ACCOUNT)}/${projectName}@`
  const scratchPrefix = `${ecrRegistry(DEFAULT_ACCOUNT)}/scratch@`
  core.info(`deploying image: ${image} (env ${environment} -> nickname ${nickname})`)

  const functionNames = await lambdaListFunctionNames(projectName, nickname)
  core.info(`functions matching ${projectName}-${nickname}: ${JSON.stringify(functionNames)}`)

  const updated = []
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
    core.info(`updating Lambda function ${functionName} -> ${image}`)
    await lambdaUpdateFunctionCode(functionName, image)
    // Block until the new image is live so a subsequent resolve/verify sees the
    // deployed digest, not the previous one.
    await lambdaWaitForFunctionUpdated(functionName, MAX_WAIT_SECONDS)
    updated.push(functionName)
  }

  if (updated.length === 0) {
    throw new Error(
      `No Lambda functions matching ${projectName}-${nickname} use the app or scratch ECR image; nothing deployed`
    )
  }

  return { deployedImage: image, services: updated }
}
