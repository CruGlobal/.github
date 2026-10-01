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
  eventBridgeListRules,
  eventBridgeListTargets,
  eventBridgeUpdateTarget,
  ssmParameterValue
} from '../aws'
import { ecsCluster, runtimeSecrets } from '../ecs-config'
import { environmentNickname, legacyEnvironment } from './env'
import { composeCompanionTaskDefinition, composeTaskDefinition, ecsServiceRegExp, isEcsAppContainer } from './aws'
import { companionFamily, parseCompanions } from './companions'
import { rollOutServices } from './ecs-rollout'
import { assertDigestRef } from './image-ref'
import { openImage } from './oci'
import { ENDPOINT_ENV, TOKEN_SECRET, publishSourceMaps, sourceMapsEndpointFor } from './sourcemaps'

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
// through untouched. Companion images the app image names are registered into
// their own families once the services land (./companions.js).
//
// Each service update is waited on until its deployment lands, one service
// after another, within one rollout budget for the whole deploy
// (./ecs-rollout.js). A rollout that ends short sends the services this deploy
// moved back to the task definitions they ran before, unless
// `stopRolloutOnFailure` is false (a rollback), and fails the step, so no
// record step names a release that is not live.
//
// ECS derives everything from the env nickname + naming conventions, so
// runtime-project (a GCP-only input) is ignored here.
//
// Returns { deployedImage, services, sourcemaps } (services = short names
// updated).
//
// `rollout` is passed through to rollOutServices; tests use it for a fake
// clock.
export async function deployEcs ({ projectName, environment, image, appUrl, stopRolloutOnFailure = true }, rollout = {}) {
  assertDigestRef(image) // defensive; the router validates too

  const nickname = environmentNickname(environment)
  const legacyEnv = legacyEnvironment(environment)
  const cluster = ecsCluster(nickname)
  core.info(`deploying image: ${image} (env ${environment} -> nickname ${nickname}, cluster ${cluster})`)

  // RUNTIME secrets from SSM (/ecs/<project>/<nick>/...) re-attached to the app
  // container on the new revision, exactly as v1 does.
  const secrets = await runtimeSecrets(projectName, nickname)

  // The matching service list is needed twice (the migration phase borrows a
  // service's run configuration, and the rollout updates each one), so fetch
  // it ONCE here and thread it through both.
  const regexp = ecsServiceRegExp(projectName, legacyEnv, nickname)
  const serviceArns = await ecsListServices(regexp, cluster)
  core.info(`matching services in ${cluster}: ${JSON.stringify(serviceArns.map(shortName))}`)

  // The services' CURRENT (pinned) task definitions. The rollout needs them
  // for the family name and as what each service goes back to if its rollout
  // ends short, and the source-map phase reads the app container's
  // declared ingestion endpoint off them — as they are BEFORE anything is
  // re-registered. Same reason serviceArns is fetched once above: two consumers,
  // one read.
  const taskDefinitions = await ecsServiceTaskDefinitions(serviceArns, cluster)

  // One handle for everything that reads this image: openImage caches what it
  // reads on the handle, so opening it twice would fetch the same blobs twice.
  let handle = null
  const openSharedImage = () => {
    if (handle === null) handle = openImage(image)
    return handle
  }

  // The companions the image names, checked and composed BEFORE anything
  // changes, so a label that breaks the contract fails the deploy with the
  // migration not run and every service untouched.
  const companions = await prepareCompanions({ projectName, nickname, image, taskDefinitions, stopRolloutOnFailure, openSharedImage })

  // Pre-deploy migration phase — runs to completion BEFORE any service is
  // updated, so a failure fails the deploy with the running services untouched.
  await runDatabaseMigrations({ projectName, nickname, cluster, image, secrets, serviceArns })

  // Upload the browser source maps this image carries, if any.
  //
  // ORDER IS LOAD BEARING: this runs AFTER the migration and BEFORE the first
  // service update, and it must stay there. Occurrences that arrive before their
  // maps land are not re-processed, so uploading after the new tasks are serving
  // would leave the first seconds of a deployment's errors permanently
  // unresolved — exactly the window a bad deploy produces errors in. Same
  // placement, and the same reasoning, as the Cloud Run path.
  const sourcemaps = await uploadSourceMaps({ projectName, appUrl, secrets, taskDefinitions, openSharedImage })

  // Each service's PRIMARY deployment right before any is touched: only one
  // that had COMPLETED is a release known to have been live, and so the only
  // one a service may be sent back to if its rollout ends short.
  const starting = serviceArns.length > 0 ? await ecsDescribeServices(serviceArns, cluster) : []
  const updates = await registerServiceRevisions({ projectName, image, secrets, serviceArns, taskDefinitions, starting })

  // ORDER IS LOAD BEARING: the scheduled tasks and the companions are
  // re-pointed only once every service has landed. rollOutServices throws on
  // any rollout that ends short, which leaves them on the task definitions they
  // ran before, so a job never runs a release no service went live on, and a
  // companion always matches the release its app serves. (A jobs-only app has
  // no services to wait on, and goes straight to them.) A rollback is the
  // exception: it moves them however its rollout ends, except when another
  // update took the service over, so rollOutServices runs this itself then
  // (see ./ecs-rollout.js).
  let companionsMoved = false
  const repointScheduledTasks = async () => {
    await updateScheduledTasks({ projectName, nickname, image, secrets })
    await registerCompanions(companions, { stopRolloutOnFailure })
    companionsMoved = true
  }
  let services
  try {
    services = await rollOutServices(updates, { cluster, stopRolloutOnFailure, repointScheduledTasks, ...rollout })
  } catch (error) {
    if (companions.length > 0 && !companionsMoved) {
      error.message += ` The companions (${companions.map(companion => companion.family).join(', ')}) were not ` +
        're-registered either: they still run the task definitions they ran before this deploy.'
    }
    throw error
  }
  await repointScheduledTasks()

  return { deployedImage: image, services, sourcemaps }
}

// Read the companions the image names (./companions.js) and compose each one's
// next revision from its family's latest, ready to register once the services
// land. Returns [{ name, family, taskDefinition }].
//
// What each kind of trouble does, on purpose:
//
//   - The image cannot be read: a warning, and no companions. Every ECS deploy
//     reads the labels, and almost no app has a companion, so a registry
//     hiccup must not fail a deploy that never needed the read. An app that
//     does have one keeps its companion on the release before, until a deploy
//     reads it.
//   - A label breaks the contract, or a family has no container to swap: the
//     deploy fails here, before anything changes.
//   - The family does not exist: skipped. The app's Terraform creates it, so
//     until it does there is nothing to register, exactly as with db-migrate.
//
// A rollback never fails over a companion: in the middle of an incident the
// services matter, so anything wrong here is a warning and the companions are
// left where they are.
async function prepareCompanions ({ projectName, nickname, image, taskDefinitions, stopRolloutOnFailure, openSharedImage }) {
  let labels
  try {
    labels = (await openSharedImage()).labels
  } catch (error) {
    core.warning(`could not read the image's labels, so no companion images were looked for: ${error.message}`)
    return []
  }

  try {
    const named = parseCompanions(labels, { projectName, appImage: image })
    if (named.length === 0) return []
    await assertOwnFamilies(named, { projectName, nickname, taskDefinitions })

    const companions = []
    for (const companion of named) {
      const family = companionFamily(projectName, nickname, companion.name)
      let latest
      try {
        latest = await ecsDescribeTaskDefinition(family)
      } catch (error) {
        if (!(error instanceof ClientException)) throw error
        core.info(`no ${family} task definition family yet, so companion ${companion.name} is skipped`)
        continue
      }
      companions.push({
        name: companion.name,
        family,
        taskDefinition: composeCompanionTaskDefinition(latest.taskDefinition, {
          repository: companion.repository,
          image: companion.image,
          tags: latest.tags ?? []
        })
      })
      core.info(`companion ${companion.name}: ${companion.image} -> ${family}`)
    }
    return companions
  } catch (error) {
    if (stopRolloutOnFailure) throw error
    core.warning(`companions left as they are for this rollback: ${error.message}`)
    return []
  }
}

// A companion's family must be its own. One that is also a service's or a
// scheduled task's would be registered twice by one deploy, with two different
// images, so it is refused before anything changes.
async function assertOwnFamilies (companions, { projectName, nickname, taskDefinitions }) {
  const taken = new Set(Object.values(taskDefinitions).map(taskDefinition => taskDefinition?.family).filter(Boolean))
  const rules = await eventBridgeListRules(`ecstask-${projectName}-${nickname}`)
  for (const rule of rules) {
    for (const target of await eventBridgeListTargets(rule.Name)) {
      const family = familyOf(target.EcsParameters?.TaskDefinitionArn)
      if (family) taken.add(family)
    }
  }
  const clashes = companions
    .map(companion => companionFamily(projectName, nickname, companion.name))
    .filter(family => taken.has(family))
  if (clashes.length > 0) {
    throw new Error(`Companion families ${clashes.join(', ')} are already used by a service or scheduled task`)
  }
}

// Register each companion's next revision. That is all a deploy does for a
// companion: the app starts its task itself, from the newest revision that runs
// the digest its own image expects (./companions.js says why not the bare
// family). On a rollback a failure is a warning (see prepareCompanions).
async function registerCompanions (companions, { stopRolloutOnFailure }) {
  for (const companion of companions) {
    try {
      const taskDefinitionArn = await ecsRegisterTaskDefinition(companion.taskDefinition)
      core.info(`registered companion ${companion.name}: ${taskDefinitionArn}`)
    } catch (error) {
      if (stopRolloutOnFailure) {
        throw new Error(`Could not register companion ${companion.name} (${companion.family}): ${error.message}`, { cause: error })
      }
      core.warning(`companion ${companion.name} left as it is for this rollback: ${error.message}`)
    }
  }
}

// Upload the image's browser source maps, never failing the deploy.
//
// Telemetry policy, identical to the Cloud Run path: everything in here is
// wrapped, every failure is a warning, and the deploy carries on. A partial
// upload is strictly better than none — each map resolves its own chunk
// independently of the others — so there is no all-or-nothing to preserve.
//
// The gates run cheapest-first so an app that ships no maps pays nothing:
//
//   1. TOKEN. runtimeSecrets already told us the RUNTIME parameter NAMES (it
//      reads the path undecrypted to build `valueFrom` references), so the "is
//      this environment wired for error tracking?" question is answered with no
//      call at all — and crucially no registry read. Its absence is the signal
//      that it is not, which is the overwhelmingly common case and must stay
//      silent.
//   2. LABEL. The image's config blob, which the companion check has already
//      read (the handle is shared).
//   3. APP URL. Needed to turn a staged path into the URL a browser reports.
//   4. FILES. Only now is a layer downloaded.
//
// The secret's SSM path is taken from `valueFrom` rather than rebuilt here.
// /ecs/<project>/<nick>/<KEY> is spelled with the Terraform env nickname, which
// is neither the v2 environment name nor the legacy one, and runtimeSecrets has
// already resolved it correctly — so reading it back is one fewer place for the
// three spellings to be confused.
async function uploadSourceMaps ({ projectName, appUrl, secrets, taskDefinitions, openSharedImage }) {
  const skipped = { status: 'skipped', uploaded: 0, failed: 0 }
  const parameter = secrets.find(secret => secret.name === TOKEN_SECRET)?.valueFrom
  if (!parameter) return skipped

  try {
    const token = await ssmParameterValue(parameter)
    if (!token) return skipped
    return await publishSourceMaps({
      oci: await openSharedImage(),
      appUrl,
      token,
      endpoint: sourceMapsEndpoint(taskDefinitions, projectName)
    })
  } catch (error) {
    core.warning(`source maps not uploaded (deploy unaffected): ${error.message}`)
    return { status: 'failed', uploaded: 0, failed: 0 }
  }
}

// ROLLBAR_ENDPOINT as the app container declares it in the task definitions the
// services are running right now. An ECS container definition spells plain env
// vars `environment: [{ name, value }]` (its `secrets` are SSM references, which
// hold no value here), so that is what is read; sourcemaps.js decides what the
// value means.
function sourceMapsEndpoint (taskDefinitions, projectName) {
  return sourceMapsEndpointFor(
    Object.values(taskDefinitions).flatMap(taskDefinition =>
      (taskDefinition?.containerDefinitions ?? [])
        .filter(container => isEcsAppContainer(container, projectName))
        .map(container => container.environment?.find(entry => entry.name === ENDPOINT_ENV)?.value)
    )
  )
}

// Run database migrations to completion as a discrete pre-deploy step, mirroring
// the Cloud Run db-migrate job. This REPLACES the retired sidecar model, in which
// the app container's dependsOn on a db-migrate container used condition=START
// with essential=false: the app raced the migration (serving against the
// un-migrated schema) and a failed migration never blocked the app. Here the
// migration is its own task that must finish cleanly first; on any failure we
// throw and no service is updated.
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

// `taskDefinitions` are the services' CURRENT (pinned) revisions, fetched by the
// caller. Each one tells us which FAMILY to compose from (we then register
// from that family's latest revision, not this one), and is what the service
// goes back to if its rollout ends short. Every revision is registered before
// any service is updated, so a registration that fails leaves every service as
// it was.
async function registerServiceRevisions ({ projectName, image, secrets, serviceArns, taskDefinitions, starting }) {
  const updates = []
  for (const serviceArn of serviceArns) {
    const current = taskDefinitions[serviceArn]
    if (!current?.family) {
      throw new Error(`Could not determine the task-definition family for service ${shortName(serviceArn)}`)
    }
    const taskDefinitionArn = await registerFromFamilyLatest(current.family, { projectName, image, secrets })
    const service = starting.find(candidate => candidate.serviceArn === serviceArn)
    const primary = service?.deployments?.find(deployment => deployment.status === 'PRIMARY')
    updates.push({
      serviceArn,
      taskDefinitionArn,
      previous: {
        taskDefinitionArn: current.taskDefinitionArn,
        // A service no deploy has touched yet runs the scratch placeholder
        // Terraform gave it, which serves nothing: there is nothing to go
        // back to.
        placeholder: (current.containerDefinitions ?? []).some(container =>
          isEcsAppContainer(container, projectName) && container.image === 'scratch'
        ),
        // A PRIMARY still rolling out, or one that failed, may not be what
        // served. AWS leaves rolloutState out behind a Classic Load Balancer;
        // there, a PRIMARY that is the only deployment stands in for COMPLETED.
        live: Boolean(primary) && primary.taskDefinition === current.taskDefinitionArn &&
          (primary.rolloutState ? primary.rolloutState === 'COMPLETED' : service.deployments.length === 1),
        deployment: primary?.id,
        rolloutState: primary?.rolloutState
      }
    })
  }
  return updates
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
