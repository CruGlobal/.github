import * as core from '@actions/core'
import { cloudrunListJobs, cloudrunListServices, listSecrets, runJob, updateJob, updateService } from '../gcp'
import { RUNTIME_PARAM_TYPES } from '../ecs-config'
import { assertDigestRef, isAppContainer, parseImageRef } from './gcp'

// Name of the optional database-migrations Cloud Run job, created by the
// gcp/cloudrun/app terraform module when `database_migrations` is enabled.
// Every other job (e.g. scheduled_jobs) gets its image/secrets refreshed but
// is only executed by its own Cloud Scheduler cron, never by the deploy.
const DB_MIGRATE_JOB = 'db-migrate'

// The job's/service's `name` is a full resource path (projects/.../<kind>/<name>).
const shortName = resource => resource.split('/').pop()

// Deploy a pre-built, digest-pinned image to a target environment's Cloud Run.
//
// Ported from v1's src/deploy-cloudrun.js, with one core change: the image is
// an explicit digest reference passed in (build-once/promote-the-artifact),
// never constructed from a tag here. Orchestration is otherwise identical:
//   1. if a `db-migrate` job exists, refresh + run it to completion first;
//      a failure fails the deploy with services untouched.
//   2. refresh other jobs' image/secrets without executing them.
//   3. update each service, rewriting ONLY the app container (sidecars such as
//      the Datadog agent are preserved) and re-attaching RUNTIME secrets, then
//      force a new revision.
//
// Returns { deployedImage, services } (services = short names updated).
export async function deployCloudRun ({ image, runtimeProject }) {
  assertDigestRef(image) // defensive; the router validates too
  if (!runtimeProject) {
    throw new Error('runtime-project is required to deploy a cloudrun image')
  }

  core.info(`deploying image: ${image}`)
  const repo = parseImageRef(image).name

  const services = await cloudrunListServices(runtimeProject)
  core.info(`services: ${JSON.stringify(services.map(s => s.name))}`)
  const jobs = await cloudrunListJobs(runtimeProject)
  core.info(`jobs: ${JSON.stringify(jobs.map(j => j.name))}`)
  const secrets = await listSecrets(runtimeProject, RUNTIME_PARAM_TYPES)

  // Run database migrations (if the db-migrate job exists) to completion before
  // updating anything else. A failed migration fails the deploy and leaves the
  // running services and scheduled jobs untouched.
  const migrateJob = jobs.find(job => shortName(job.name) === DB_MIGRATE_JOB)
  if (migrateJob) {
    await updateJobImage(migrateJob, image, secrets)
    core.info(`executing job: ${migrateJob.name}`)
    await runJob(migrateJob.name)
  }

  // Refresh the image/secrets on the remaining jobs (e.g. scheduled_jobs). They
  // run on their own cron, so they are updated but not executed here.
  for (const job of jobs) {
    if (job === migrateJob) continue
    await updateJobImage(job, image, secrets)
  }

  // Update each Cloud Run service. Refresh only the APP container's image/env
  // and pass ALL containers through, so sidecars are preserved — e.g. the
  // Datadog Agent the gcp/cloudrun/app module adds when datadog_apm = true.
  const updatedServices = []
  for (const service of services) {
    const containers = service.template.containers
    const updated = containers.map(container =>
      isAppContainer(container, containers, repo)
        ? { ...container, image, env: mergeEnvVars(container.env, secrets) }
        : container
    )
    core.info(`updating service: ${service.name} (${updated.length} container(s))`)
    await updateService(service.name, updated)
    updatedServices.push(shortName(service.name))
  }

  return { deployedImage: image, services: updatedServices }
}

// Update a Cloud Run job's container image and secrets in place.
async function updateJobImage (job, image, secrets) {
  const container = job.template.template.containers[0]
  container.image = image
  container.env = mergeEnvVars(container.env, secrets)
  core.info(`updating job: ${job.name}`)
  await updateJob(job)
}

// Persist a container's non-secret ENV vars and (re)add all secret ENV vars as
// secretKeyRef:latest references.
function mergeEnvVars (currentEnv, secrets) {
  const envVars = []

  // Persist non-secret ENV vars
  if (currentEnv) {
    for (const env of currentEnv) {
      if (env.value !== undefined) {
        envVars.push(env)
      }
    }
  }

  // Add secret ENV vars
  for (const secret of secrets) {
    envVars.push({
      name: secret.name.split('/').pop(),
      valueSource: {
        secretKeyRef: {
          secret: secret.name,
          version: 'latest' // TODO: pin to specific secret version
        }
      }
    })
  }

  return envVars
}
