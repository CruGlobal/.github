import * as core from '@actions/core'
import { lambdaGetFunction, lambdaListFunctionNames } from '../aws'
import { DEFAULT_ACCOUNT, ecrRegistry } from '../ecs-config'
import { environmentNickname } from './env'
import { ecrImageRef, ecrResolveDigest, ecrTagsForDigest } from './aws'
import { parseImageRef } from './image-ref'

// Resolve a Lambda image to a digest reference in the shared ECR registry.
//
// mode=tag:         resolve <tag> against the app's ECR repo -> digest, and
//                   report every tag on that digest.
// mode=environment: read the image currently deployed on the target env's Lambda
//                   functions and return it. An image function's
//                   Code.ResolvedImageUri is ALWAYS a digest ref, so — unlike ECS
//                   — there is no tag-ref branch to resolve.
//
// Like ECS, Lambda derives everything from the env nickname + naming conventions
// — no runtime-project input (that is GCP-only).
//
// Returns { image, digest, tags } where `image` is a full ECR digest reference.
export async function resolveLambda ({ mode, projectName, tag, environment }) {
  if (mode === 'tag') {
    core.info(`resolving ECR tag "${tag}" for ${projectName}`)
    const { digest, tags } = await ecrResolveDigest(projectName, tag)
    return { image: ecrImageRef(projectName, digest), digest, tags }
  }

  if (mode === 'environment') {
    return resolveRunningImage(projectName, environment)
  }

  throw new Error(`Unknown resolve mode "${mode}". Expected "tag" or "environment".`)
}

async function resolveRunningImage (projectName, environment) {
  const nickname = environmentNickname(environment)
  // Digest-ref prefix for the app's own ECR repo. Functions still on the shared
  // scratch image (<registry>/scratch@...) have never been deployed and carry no
  // resolvable app image, so they are skipped — mirroring ECS's scratch skip.
  const appRepoPrefix = `${ecrRegistry(DEFAULT_ACCOUNT)}/${projectName}@`

  const functionNames = await lambdaListFunctionNames(projectName, nickname)
  core.info(`functions matching ${projectName}-${nickname}: ${JSON.stringify(functionNames)}`)
  if (functionNames.length === 0) {
    throw new Error(`No Lambda functions matching ${projectName}-${nickname} found`)
  }

  let runningImage
  for (const functionName of functionNames) {
    const fn = await lambdaGetFunction(functionName)
    if (fn.Configuration?.PackageType !== 'Image') continue
    const resolved = fn.Code?.ResolvedImageUri
    if (resolved?.startsWith(appRepoPrefix)) {
      runningImage = resolved
      break
    }
  }

  if (!runningImage) {
    throw new Error(
      `Could not find a deployed app image for ${projectName} on any ${projectName}-${nickname} ` +
      'Lambda function (all are on the scratch placeholder or are not image functions)'
    )
  }
  core.info(`deployed Lambda image: ${runningImage}`)

  // Code.ResolvedImageUri is always a digest ref for image functions.
  const { digest } = parseImageRef(runningImage)
  // Report tags opportunistically; a digest that predates the v2 tag families
  // simply has no candidate/release tags.
  const tags = await ecrTagsForDigest(projectName, digest).catch(() => [])
  return { image: ecrImageRef(projectName, digest), digest, tags }
}
