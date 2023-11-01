import * as core from '@actions/core'
import assert from 'assert'
import escapeStringRegexp from 'escape-string-regexp'

import {
  ecsDescribeTaskDefinition,
  ecsListServices,
  ecsRegisterTaskDefinition,
  ecsServiceTaskDefinitions,
  ecsUpdateService,
  eventBridgeListRules,
  eventBridgeListTargets, eventBridgeUpdateTarget
} from './aws'

import {
  ecrImageTag,
  ecsCluster,
  environmentNickname,
  runtimeSecrets
} from './ecs-config'

// Keys that exist in DescribeTaskDefinition that we can't send back in a create/update
const INVALID_TASK_DEF_KEYS = [
  'revision',
  'status',
  'task_definition_arn',
  'requires_attributes',
  'compatibilities',
  'registered_at',
  'registered_by'
]

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

    await updateServices(projectName, environment, buildNumber)
    await updateScheduledTasks(projectName, environment, buildNumber)
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function updateServices (projectName, environment, buildNumber) {
  const env = environmentNickname(environment)
  const cluster = ecsCluster(environment)
  const serviceArns = await ecsListServices(new RegExp(`/${escapeStringRegexp(projectName)}-(${environment}|${env})-`), cluster)
  const taskDefs = await ecsServiceTaskDefinitions(serviceArns, cluster)
  for (const [serviceArn, currentTaskDefinition] of Object.entries(taskDefs)) {
    const serviceName = serviceArn.split('/').pop()
    core.info(`Updating ECS Service: ${serviceName}`)
    const taskDefinitionArn = await updateTaskDefinition(currentTaskDefinition, projectName, environment, buildNumber)
    await ecsUpdateService(serviceArn, cluster, taskDefinitionArn)
    // Sleep 3 sec between updates to help with API rate limiting
    await new Promise(resolve => setTimeout(resolve, 10000))
  }
}

async function updateScheduledTasks (projectName, environment, buildNumber) {
  const env = environmentNickname(environment)

  const rules = await eventBridgeListRules(`ecstask-${projectName}-${env}`)
  for (const rule of rules) {
    const targets = await eventBridgeListTargets(rule.Name)
    for (const target of targets) {
      // This really should only ever be 1 target per rule, but API allows for more
      core.info(`Updating ECS Scheduled Task: ${target.Id}`)

      const currentTaskDefinition = await ecsDescribeTaskDefinition(target.EcsParameters.TaskDefinitionArn)
      target.EcsParameters.TaskDefinitionArn = await updateTaskDefinition(currentTaskDefinition.taskDefinition, projectName, environment, buildNumber)
      await eventBridgeUpdateTarget(rule.Name, target)
      // Sleep 10 sec between updates to help with API rate limiting
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
  }
}

async function updateTaskDefinition (taskDefinition, projectName, environment, buildNumber) {
  const image = ecrImageTag(projectName, environment, buildNumber)
  const secrets = await runtimeSecrets(projectName, environment)

  const taskDef = {}
  for (const [key, value] of Object.entries(taskDefinition)) {
    if (INVALID_TASK_DEF_KEYS.includes(key)) {
      continue
    }
    taskDef[key] = value
  }

  for (const container of taskDef.containerDefinitions) {
    // Only update image and secrets for the project container or initial container (skips things like fluentbit container)
    if (container.image === 'scratch' || container.image.indexOf(`/${projectName}`) !== -1) {
      container.image = image
      container.secrets = secrets
    }
  }
  return ecsRegisterTaskDefinition(taskDef)
}

run()
