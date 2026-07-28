import * as core from '@actions/core'
import { ClientException } from '@aws-sdk/client-ecs'
import {
  ecsListServices,
  ecsServiceTaskDefinitions,
  ecsDescribeServices,
  ecsDescribeTaskDefinition,
  ecsRegisterTaskDefinition,
  ecsRunTask,
  ecsDescribeTasks,
  ecsWaitUntilTasksStopped,
  ecsUpdateService,
  eventBridgeListRules,
  eventBridgeListTargets,
  eventBridgeUpdateTarget
} from '../aws'
import { ecsCluster, runtimeSecrets } from '../ecs-config'
import { environmentNickname, legacyEnvironment } from './env'
import { composeTaskDefinition, ecsServiceRegExp } from './aws'
import { assertDigestRef } from './image-ref'

const DB_MIGRATE_CONTAINER = 'db-migrate'

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

  // The matching service list is needed twice — the migration phase borrows a
  // service's run configuration and updateServices re-points each one — so fetch
  // it ONCE here and thread it through both.
  const regexp = ecsServiceRegExp(projectName, legacyEnv, nickname)
  const serviceArns = await ecsListServices(regexp, cluster)
  core.info(`matching services in ${cluster}: ${JSON.stringify(serviceArns.map(shortName))}`)

  // Pre-deploy migration phase — runs to completion BEFORE any service is
  // updated, so a failure fails the deploy with the running services untouched.
  await runDatabaseMigrations({ projectName, nickname, cluster, image, secrets, serviceArns })

  const services = await updateServices({ projectName, cluster, image, secrets, serviceArns })
  await updateScheduledTasks({ projectName, nickname, image, secrets })

  return { deployedImage: image, services }
}

// Run database migrations to completion as a discrete pre-deploy step, mirroring
// the Cloud Run db-migrate job. This REPLACES the retired sidecar model, in which
// the app container's dependsOn on a db-migrate container used condition=START
// with essential=false: the app raced the migration (serving against the
// un-migrated schema) and a failed migration never blocked the app. Here the
// migration is its own task that must finish cleanly first; on any failure we
// throw and updateServices never runs.
//
// Convention-driven, exactly like services and scheduled tasks: the presence of
// the `<project>-<nick>-db-migrate` task-definition family (created by the
// aws/ecs/app module only when the app opts in) is the switch. No family -> the
// app hasn't opted in -> skip. DescribeTaskDefinition on a missing family throws
// ClientException ("Unable to describe task definition"); every other error is a
// real fault and propagates.
//
// This phase runs on EVERY ECS deploy — rc deploys, promote, and rollback — since
// deployEcs is shared. That is intended: migrations are applied once per deploy
// (not once per task launch, the old sidecar's other bug), and a rollback's older
// image simply no-ops against already-applied migrations, matching Cloud Run.
async function runDatabaseMigrations ({ projectName, nickname, cluster, image, secrets, serviceArns }) {
  const family = `${projectName}-${nickname}-db-migrate`

  try {
    await ecsDescribeTaskDefinition(family)
  } catch (error) {
    if (error instanceof ClientException) {
      core.info('no db-migrate task definition family — skipping migrations')
      return
    }
    throw error
  }

  // Compose from the family's latest revision (Terraform's template) with the
  // release digest and refreshed RUNTIME secrets — identical semantics to the
  // service and scheduled-task registrations.
  const taskDefinitionArn = await registerFromFamilyLatest(family, { projectName, image, secrets })
  const runConfig = await migrationRunConfig({ projectName, nickname, cluster, serviceArns })

  core.info(`running database migrations: ${taskDefinitionArn} in cluster ${cluster}`)
  const run = await ecsRunTask({ cluster, taskDefinition: taskDefinitionArn, count: 1, startedBy: 'cru-pipeline-v2', ...runConfig })
  const taskArn = run.tasks?.[0]?.taskArn
  if (!taskArn) {
    const reason = run.failures?.[0]?.reason ?? 'RunTask returned no task'
    throw new Error(`Failed to start db-migrate task in cluster ${cluster}: ${reason}`)
  }

  // Reaching STOPPED is not success on its own (a failed migration also stops);
  // the waiter throws on timeout, and we then require exitCode 0 below.
  const waited = await ecsWaitUntilTasksStopped(cluster, [taskArn])
  if (waited.state !== 'SUCCESS') {
    throw new Error(`db-migrate task ${taskArn} did not stop cleanly (waiter state ${waited.state})`)
  }

  const described = await ecsDescribeTasks(cluster, [taskArn])
  const task = described.tasks?.[0]
  const container = task?.containers?.find(c => c.name === DB_MIGRATE_CONTAINER)
  if (container?.exitCode !== 0) {
    const detail = task?.stoppedReason ?? container?.reason ?? `exit code ${container?.exitCode ?? 'unknown'}`
    throw new Error(`Database migrations failed (task ${taskArn}): ${detail}`)
  }
  core.info(`database migrations succeeded: ${taskArn} (exit 0)`)
}

// Borrow the db-migrate task's run configuration from the app's own
// infrastructure so migrations run on the same network / launch footing as the
// app. Prefer a matching service; for a jobs-only app (no services) fall back to
// the EventBridge scheduled-task target. Only when NEITHER exists is there
// nothing to borrow from — throw rather than guess.
//
// The ABSENCE of a networkConfiguration is itself a valid borrowed config, not a
// miss: an awsvpc service (Fargate, or EC2 with a VPC attachment) describes one,
// while an EC2 capacity-provider service in bridge mode — ECS's default, and
// what most legacy Cru apps run — has none at all. Passing a network config to a
// bridge task definition is rejected just as surely as omitting one from an
// awsvpc task definition, so we borrow whatever the app has, and the module
// derives the db-migrate task def's network mode the same way (see
// local.db_migrate_awsvpc in cru-terraform-modules aws/ecs/app/ecs.tf).
async function migrationRunConfig ({ projectName, nickname, cluster, serviceArns }) {
  if (serviceArns.length > 0) {
    const [service] = await ecsDescribeServices([serviceArns[0]], cluster)
    if (service) {
      return runConfigOf(service.networkConfiguration, service.launchType, service.capacityProviderStrategy)
    }
  }

  const target = await firstScheduledTaskTarget(projectName, nickname)
  const ecsParams = target?.EcsParameters
  if (ecsParams) {
    return runConfigOf(
      ecsNetworkConfigFromEventBridge(ecsParams.NetworkConfiguration),
      ecsParams.LaunchType,
      ecsParams.CapacityProviderStrategy
    )
  }

  throw new Error('db-migrate family exists but no service or scheduled task to borrow run configuration from')
}

// RunTask accepts launchType OR capacityProviderStrategy, never both; a capacity
// provider strategy (when the borrowed config has one) wins. networkConfiguration
// is omitted ENTIRELY for a bridge-mode source — RunTask rejects the parameter on
// a task definition that isn't awsvpc, so an explicit null/undefined key is not
// the same thing as no key.
function runConfigOf (networkConfiguration, launchType, capacityProviderStrategy) {
  const network = networkConfiguration ? { networkConfiguration } : {}
  return capacityProviderStrategy?.length
    ? { ...network, capacityProviderStrategy }
    : { ...network, launchType }
}

// The first EventBridge scheduled-task target for the app (jobs-only fallback).
async function firstScheduledTaskTarget (projectName, nickname) {
  const rules = await eventBridgeListRules(`ecstask-${projectName}-${nickname}`)
  for (const rule of rules) {
    const targets = await eventBridgeListTargets(rule.Name)
    if (targets.length > 0) return targets[0]
  }
  return undefined
}

// An EventBridge target's NetworkConfiguration uses PascalCase awsvpc keys
// (Subnets/SecurityGroups/AssignPublicIp); RunTask expects camelCase. Convert so
// the jobs-only fallback produces a valid RunTask networkConfiguration.
function ecsNetworkConfigFromEventBridge (networkConfiguration) {
  const vpc = networkConfiguration?.awsvpcConfiguration
  if (!vpc) return undefined
  return {
    awsvpcConfiguration: {
      subnets: vpc.Subnets,
      securityGroups: vpc.SecurityGroups,
      assignPublicIp: vpc.AssignPublicIp
    }
  }
}

async function updateServices ({ projectName, cluster, image, secrets, serviceArns }) {
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
