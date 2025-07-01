import * as core from '@actions/core'
import assert from 'assert'

import {
  lambdaGetFunction,
  lambdaListFunctionNames,
  lambdaUpdateFunctionCode,
} from './aws'

import {
  ecrImageDigest,
  ecrRegistry,
  environmentNickname,
} from './ecs-config'

async function run () {
  const isDefined = i => !!i

  try {

    const projectName = core.getInput('project-name', { required: false }) || process.env.PROJECT_NAME
    core.debug(`projectName: ${projectName}`)
    const environment = core.getInput('environment', { required: false }) || process.env.ENVIRONMENT
    core.debug(`environment: ${environment}`)
    const buildNumber = core.getInput('build-number', { required: false }) || process.env.BUILD_NUMBER
    core.debug(`buildNumber: ${buildNumber}`)

    assert(
      [projectName, environment, buildNumber].every(isDefined),
      'Missing required input or environment value. Has "setup-env" action been run?'
    )

    await updateLambdaFunctions(projectName, environment, buildNumber)
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function updateLambdaFunctions(projectName, environment, buildNumber) {
  const env = environmentNickname(environment)
  const imageDigestUri = await ecrImageDigest(projectName, environment, buildNumber)

  // List all Lambda functions that match the project name and environment
  const functionNames = await lambdaListFunctionNames(projectName, env)

  // Update each Lambda function that uses the ECR image
  for (const functionName of functionNames) {
    const fn = await lambdaGetFunction(functionName)
    if (fn.Code.ImageUri.startsWith(`${ecrRegistry('cruds')}/${projectName}@`)) {
      core.info(`Updating Lambda function: ${functionName}`)
      await lambdaUpdateFunctionCode(functionName, imageDigestUri)
    } else {
      core.info(`Skipping Lambda function: ${functionName} (not using ECR image)`)
      continue
    }
    // Sleep 5 sec between updates to help with API rate limiting
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
}

run()
