import * as core from '@actions/core'
import {
  ecsListServices,
  ecsServiceTaskDefinitions,
  ecsDescribeTaskDefinition,
  ecsRegisterTaskDefinition,
  ecsUpdateService,
  eventBridgeListRules,
  eventBridgeListTargets,
  eventBridgeUpdateTarget
} from '../aws'
import { ecsCluster, runtimeSecrets } from '../ecs-config'
import { environmentNickname, legacyEnvironment } from './env'
import { composeTaskDefinition, ecsServiceRegExp } from './aws'
import { assertDigestRef } from './image-ref'

// Deploy a pre-built, digest-pinned image to a target environment's ECS.
//
// RATIFIED v2 SEMANTICS (deliberately different from v1's action, which copied
// the service's currently-running revision): the deploy composes from the
// FAMILY'S LATEST task-definition revision — Terraform owns that template, and
// DescribeTaskDefinition on the bare family name returns its latest revision. We
// swap ONLY the app container's image to the given digest ref, refresh RUNTIME
// secrets from SSM, register a new revision, update every matching service, and
// re-point EventBridge scheduled tasks. Sidecars (nginx, fluentbit, …) pass
// through untouched.
//
// ECS derives everything from the env nickname + naming conventions, so
// runtime-project (a GCP-only input) is ignored here.
//
// Returns { deployedImage, services } (services = short names updated).
export async function deployEcs ({ projectName, environment, image }) {
  assertDigestRef(image) // defensive; the router validates too

  const nickname = environmentNickname(environment)
  const legacyEnv = legacyEnvironment(environment)
  const cluster = ecsCluster(nickname)
  core.info(`deploying image: ${image} (env ${environment} -> nickname ${nickname}, cluster ${cluster})`)

  // RUNTIME secrets from SSM (/ecs/<project>/<nick>/...) re-attached to the app
  // container on the new revision, exactly as v1 does.
  const secrets = await runtimeSecrets(projectName, nickname)

  const services = await updateServices({ projectName, legacyEnv, nickname, cluster, image, secrets })
  await updateScheduledTasks({ projectName, nickname, image, secrets })

  return { deployedImage: image, services }
}

async function updateServices ({ projectName, legacyEnv, nickname, cluster, image, secrets }) {
  const regexp = ecsServiceRegExp(projectName, legacyEnv, nickname)
  const serviceArns = await ecsListServices(regexp, cluster)
  core.info(`matching services in ${cluster}: ${JSON.stringify(serviceArns.map(shortName))}`)

  // The service's current task def only tells us which FAMILY to compose from;
  // we then register from that family's latest revision, not this one.
  const current = await ecsServiceTaskDefinitions(serviceArns, cluster)

  const updated = []
  for (const serviceArn of serviceArns) {
    const family = current[serviceArn]?.family
    if (!family) {
      throw new Error(`Could not determine the task-definition family for service ${shortName(serviceArn)}`)
    }
    const taskDefinitionArn = await registerFromFamilyLatest(family, { projectName, image, secrets })
    core.info(`updating ECS service ${shortName(serviceArn)} -> ${taskDefinitionArn}`)
    await ecsUpdateService(serviceArn, cluster, taskDefinitionArn)
    updated.push(shortName(serviceArn))
  }
  return updated
}

async function updateScheduledTasks ({ projectName, nickname, image, secrets }) {
  // EventBridge rules for scheduled ECS tasks follow `ecstask-<project>-<nick>`.
  const rules = await eventBridgeListRules(`ecstask-${projectName}-${nickname}`)
  for (const rule of rules) {
    const targets = await eventBridgeListTargets(rule.Name)
    for (const target of targets) {
      core.info(`re-pointing scheduled task ${target.Id} on rule ${rule.Name}`)
      const family = familyOf(target.EcsParameters?.TaskDefinitionArn)
      if (!family) {
        throw new Error(`Scheduled-task target ${target.Id} on rule ${rule.Name} has no task-definition ARN`)
      }
      target.EcsParameters.TaskDefinitionArn = await registerFromFamilyLatest(family, { projectName, image, secrets })
      await eventBridgeUpdateTarget(rule.Name, target)
    }
  }
}

// Compose + register a new revision from the family's LATEST task definition
// (Terraform's template). Returns the new revision's ARN.
async function registerFromFamilyLatest (family, { projectName, image, secrets }) {
  // DescribeTaskDefinition on the bare family name returns the latest revision.
  const latest = await ecsDescribeTaskDefinition(family)
  const taskDef = composeTaskDefinition(latest.taskDefinition, {
    projectName,
    image,
    secrets,
    tags: latest.tags ?? []
  })
  return ecsRegisterTaskDefinition(taskDef)
}

// A task-definition ARN is arn:aws:ecs:<region>:<acct>:task-definition/<family>:<rev>.
// The bare family name is the segment after '/', minus the ':<rev>' suffix.
function familyOf (taskDefinitionArn) {
  if (!taskDefinitionArn) return undefined
  return taskDefinitionArn.split('/').pop().split(':')[0]
}

// Service/target ARNs are full paths (…:service/<cluster>/<name>); the short
// name is the final segment.
function shortName (arn) {
  return arn.split('/').pop()
}
