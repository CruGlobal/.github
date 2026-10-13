// Publish the API Gateway config that ships inside the app image.
//
// Background: an app fronted by API Gateway is described by an OpenAPI document
// — routes, JWT issuers, audiences, backend address. Terraform used to own that
// document, which put it a repo away from the code it describes: adding a route
// meant an app PR and an infra PR, and a rollback re-pointed the gateway at
// nothing at all (the config stayed wherever the last apply left it, in front of
// an older app).
//
// So the spec travels *in the image*, like the IAP sign-in page does, and the
// deploy publishes it. Same artifact, same digest, same guarantees as the app
// itself: promote and rollback carry the matching spec for free.
//
// Contract with the app image:
//   LABEL org.cru.api-gateway=<file name>     e.g. "openapi.yaml"
//   COPY  <spec> /cru/api-gateway/<file name>
//
// The spec in the image is ENV-NEUTRAL, because v2 builds once and promotes the
// same digest through every environment: it carries ${VAR} placeholders instead
// of issuer URLs and audiences. The deploy renders it against the environment it
// is deploying to — values come from the app container's own Terraform-injected
// env vars, plus ${API_GATEWAY_BACKEND}, which is the backend Cloud Run
// service's run.app URI. That one cannot come from Terraform: injecting a
// service's own URI into its own env is a dependency cycle, and it is knowable
// here for free (the deploy already listed the services).
//
// Nothing here parses the document. Rendering is a textual ${VAR} substitution
// and the API takes the bytes, so the same code path publishes an OpenAPI 2.0 or
// an OpenAPI 3.0.x spec (API Gateway accepts both; not 3.1). Validation of the
// document's shape is the gateway's job, and it reports it through the create
// operation's error — see awaitOperation.
//
// The rendered document is then published as an *immutable* api config and the
// gateway is re-pointed at it. Config ids are content hashes (cfg-<sha256[0:12]>,
// the same convention the Terraform-managed config used), which buys two things:
// a redeploy whose spec did not change computes the same id, sees the gateway
// already pointing there, and does nothing; and a rollback computes the OLD id,
// finds that config still sitting there, and just re-points the gateway — no
// re-create, no minutes of gateway churn.
//
// Superseded configs are then garbage-collected (best-effort, see
// collectGarbage): they are immutable and would otherwise pile up one per spec
// change forever, and a rollback re-creates the one it needs from the image it
// is rolling back to.
import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { DEFAULT_REGION } from '../gcp'
import { authClient, findAppContainer, parseImageRef } from './gcp'
import { openImage } from './oci'

/** Image label naming the spec file. Absent = this image ships no spec. */
export const APIG_LABEL = 'org.cru.api-gateway'

/** Conventional directory the spec is COPYed to inside the image. */
export const APIG_IMAGE_DIR = '/cru/api-gateway'

/** Env var Terraform injects naming the gateway. Its presence IS the gate. */
export const APIG_GATEWAY_ENV = 'API_GATEWAY_GATEWAY_ID'

/** Env var naming which Cloud Run service the gateway proxies to. */
export const APIG_BACKEND_SERVICE_ENV = 'API_GATEWAY_BACKEND_SERVICE'

/** Env var naming the service account the gateway calls the backend as. */
export const APIG_BACKEND_SA_ENV = 'API_GATEWAY_BACKEND_SA'

/** Placeholder the deploy resolves itself, to the backend service's run.app URI. */
export const BACKEND_VAR = 'API_GATEWAY_BACKEND'

const APIG_API = 'https://apigateway.googleapis.com/v1'

// Gateway updates propagate through a managed Envoy fleet and routinely take
// minutes; a config create is quicker but not instant. Poll gently, and give up
// with a clear message rather than hanging a deploy forever.
const POLL_INTERVAL_MS = 5000
const CONFIG_DEADLINE_MS = 10 * 60 * 1000
const GATEWAY_DEADLINE_MS = 15 * 60 * 1000
// Deleting a detached config is quick, and the whole GC phase is best-effort, so
// it waits far less patiently than the two operations the deploy depends on.
const GC_DEADLINE_MS = 2 * 60 * 1000

// Config ids this module mints: cfg-<sha256[0:12]>. GC only ever deletes ids
// matching this, which excludes Terraform's bootstrap seed config and anything
// hand-made BY CONSTRUCTION rather than by an exclusion list — a config we did
// not create is a config we cannot recreate, so we never touch one.
const GENERATED_CONFIG_ID = /^cfg-[0-9a-f]{12}$/

// Reads only. Retrying a GET is unconditionally safe, and a transient 503 from
// apigateway.googleapis.com must not skew the published spec. Same tolerance the
// Artifact Registry calls in ./gcp.js use.
//
// The config-create POST is deliberately NOT retried here: a create that
// succeeds but whose response is lost would be retried into a 409, and gaxios
// would surface the 409, not the success. Instead the create's own 409 handler
// treats "already exists" as success — the same shape addTag uses for its
// idempotent create-or-move.
const GAXIOS_RETRY = {
  retry: true,
  retryConfig: {
    retry: 5,
    retryDelay: 500,
    httpMethodsToRetry: ['GET'],
    statusCodesToRetry: [[429, 429], [500, 599]]
  }
}

// Resource names are full paths (projects/.../<kind>/<name>).
const shortName = resource => resource.split('/').pop()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const httpStatus = error => error?.response?.status ?? error?.status ?? error?.code

/**
 * Read and validate the spec file name from an image's labels.
 *
 * Returns null when the image carries no API-gateway label (the common case, and
 * the legitimate case when rolling back to a release built before this contract
 * existed). Throws when the label is present but unusable: the value becomes a
 * path inside the image, so a malformed one must fail loudly rather than read
 * from a surprising place.
 */
export function apigSpecKey (labels) {
  const raw = labels?.[APIG_LABEL]
  if (raw == null) return null

  const key = raw.trim()
  const invalid =
    key === '' ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (invalid) {
    throw new Error(
      `Image label ${APIG_LABEL}="${raw}" is not a usable file name — ` +
      'expected a relative path with no empty, "." or ".." segments (e.g. "openapi.yaml").'
    )
  }
  return key
}

/**
 * Find the API Gateway wiring for this app by reading Terraform's env vars off
 * the app container of any Cloud Run service. API_GATEWAY_GATEWAY_ID's presence
 * is the signal that this environment expects a pipeline-managed api config —
 * no extra input to plumb through, and no registry read for the apps (most of
 * them) that have no gateway.
 *
 * Read from the services as they exist *before* the deploy rewrites them: the
 * rewritten container drops plain env in favour of secret refs.
 *
 * Returns null when the app has no gateway. Returns
 * `{ gatewayId, backendService, backendSa, env }`, where `env` is the app
 * container's plain-valued env as a name->value map — the substitution vars for
 * the spec. Secret-valued entries are skipped: a spec placeholder resolving to a
 * secret would bake the secret into a config document the gateway serves from.
 *
 * Throws when the gate is set but its companions are not: a half-configured
 * environment is a Terraform bug, and silently skipping would leave the gateway
 * serving whatever stale spec it happened to have.
 */
export function apigEnv (services, repo) {
  for (const service of services) {
    const containers = service.template?.containers ?? []
    const app = findAppContainer(containers, repo)
    if (!app) continue

    const env = {}
    for (const entry of app.env ?? []) {
      if (entry.value !== undefined) env[entry.name] = entry.value
    }

    const gatewayId = env[APIG_GATEWAY_ENV]
    if (!gatewayId) continue

    const backendService = env[APIG_BACKEND_SERVICE_ENV]
    const backendSa = env[APIG_BACKEND_SA_ENV]
    if (!backendService || !backendSa) {
      const missing = [
        backendService ? null : APIG_BACKEND_SERVICE_ENV,
        backendSa ? null : APIG_BACKEND_SA_ENV
      ].filter(Boolean)
      throw new Error(
        `${APIG_GATEWAY_ENV}="${gatewayId}" is set on ${shortName(service.name)} but ` +
        `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not. ` +
        'Terraform must inject all three together.'
      )
    }
    return { gatewayId, backendService, backendSa, env }
  }
  return null
}

// ${NAME}, where NAME is a conventional SHOUTING_CASE env var name. A bare `$`,
// `$FOO` and `${lower}` are all left alone — the spec is YAML that may contain
// them for its own reasons.
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g

/**
 * Render the env-neutral spec against this environment's values.
 *
 * Collects EVERY unresolved placeholder before throwing, so a spec that adds
 * three new variables reports all three at once instead of one per redeploy.
 */
export function renderSpec (template, vars) {
  const unresolved = new Set()
  const rendered = template.replace(PLACEHOLDER, (match, name) => {
    // A function replacer's return value is used literally, so a value
    // containing `$&` or `$1` cannot corrupt the output.
    if (!Object.hasOwn(vars, name) || vars[name] == null) {
      unresolved.add(name)
      return match
    }
    return String(vars[name])
  })

  if (unresolved.size > 0) {
    throw new Error(
      `API gateway spec has unresolved placeholder(s): ${[...unresolved].join(', ')}. ` +
      'Each must be a plain-valued env var on the app container (Terraform-injected), ' +
      `or ${BACKEND_VAR}.`
    )
  }
  return rendered
}

/**
 * Content-addressed api config id for a rendered spec. Same convention the
 * Terraform-managed config used, so the first pipeline-published config for an
 * unchanged spec lands on the id Terraform already created.
 */
export function configIdFor (rendered) {
  return `cfg-${createHash('sha256').update(rendered).digest('hex').slice(0, 12)}`
}

// Poll a long-running operation to completion. Surfaces operation.error as a
// thrown error: the LRO is the only place a config create reports a bad spec.
async function awaitOperation (client, operation, { label, deadlineMs, pollIntervalMs }) {
  const started = Date.now()
  let op = operation

  while (!op?.done) {
    if (Date.now() - started > deadlineMs) {
      throw new Error(
        `${label} did not finish within ${Math.round(deadlineMs / 1000)}s (operation ${op?.name})`
      )
    }
    await sleep(pollIntervalMs)
    core.info(`waiting for ${label}…`)
    const res = await client.request({
      url: `${APIG_API}/${op.name}`,
      method: 'GET',
      ...GAXIOS_RETRY
    })
    op = res.data
  }

  if (op.error) {
    throw new Error(`${label} failed: ${op.error.message ?? JSON.stringify(op.error)}`)
  }
  return op
}

// Delete one api config and wait for the deletion to land.
async function deleteConfig (client, configName, { deadlineMs, pollIntervalMs }) {
  const id = shortName(configName)
  const res = await client.request({ url: `${APIG_API}/${configName}`, method: 'DELETE' })
  await awaitOperation(client, res.data, {
    label: `api config ${id} delete`,
    deadlineMs,
    pollIntervalMs
  })
}

/**
 * Settle what is sitting at a config id before we decide to create or re-point.
 *
 * Existence alone is not enough, because only an ACTIVE config can be served,
 * and config ids are content hashes: a create that was interrupted — a cancelled
 * run, a deadline we gave up on — leaves a config at the id that EVERY future
 * deploy of that same spec will compute. Treating it as usable would re-point the
 * gateway at an unservable config, and the id is one this deploy wants to keep,
 * so GC would never reclaim it: the app would be stuck, one warning per deploy,
 * until someone deleted the config by hand.
 *
 * Returns 'absent', 'active', or 'failed'. Transitional states (CREATING,
 * DELETING, ...) are waited out — another run is mid-flight and the outcome we
 * want is whatever it settles on.
 */
async function resolveExistingConfig (client, configName, { pollIntervalMs }) {
  const id = shortName(configName)
  const deadline = Date.now() + CONFIG_DEADLINE_MS

  while (true) {
    let config
    try {
      config = (await client.request({
        url: `${APIG_API}/${configName}`,
        method: 'GET',
        ...GAXIOS_RETRY
      })).data
    } catch (error) {
      if (httpStatus(error) !== 404) throw error
      return 'absent'
    }

    // The API always sets state; an absent one means a response shape we do not
    // know, and refusing to proceed on that would wedge deploys for no gain.
    const state = config?.state ?? 'ACTIVE'
    if (state === 'ACTIVE') return 'active'
    if (state === 'FAILED') return 'failed'

    if (Date.now() > deadline) {
      throw new Error(
        `api config ${id} was still ${state} after ` +
        `${Math.round(CONFIG_DEADLINE_MS / 1000)}s; another deploy may be mid-flight`
      )
    }
    core.info(`api config ${id} is ${state}; waiting…`)
    await sleep(pollIntervalMs)
  }
}

// Delete the api configs this module minted that nothing points at any more.
//
// Configs are immutable, so without this they accumulate one per spec change,
// forever. Deleting them costs nothing at rollback time: a rollback deploys an
// old image whose rendered spec hashes back to its own config id and simply
// re-creates it. The one exception — keeping the config that was active before
// this deploy — makes the overwhelmingly common rollback (one step back) a plain
// re-point that skips the create wait entirely.
//
// Runs only after the gateway has been successfully re-pointed, so `keep` is
// never serving traffic. Entirely best-effort: a leaked config is clutter, not
// an outage, and must never turn a good deploy red.
async function collectGarbage (client, { apiName, keep, pollIntervalMs }) {
  const deleted = []
  try {
    const names = []
    let pageToken
    do {
      const res = await client.request({
        url: `${APIG_API}/${apiName}/configs`,
        method: 'GET',
        params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
        ...GAXIOS_RETRY
      })
      names.push(...(res.data?.apiConfigs ?? []).map(config => config.name).filter(Boolean))
      pageToken = res.data?.nextPageToken
    } while (pageToken)

    const stale = names.filter(name => {
      const id = shortName(name)
      return GENERATED_CONFIG_ID.test(id) && !keep.includes(id)
    })
    core.info(`api configs: ${names.length} total, keeping ${keep.join(', ')}, deleting ${stale.length}`)

    for (const name of stale) {
      const id = shortName(name)
      await deleteConfig(client, name, { deadlineMs: GC_DEADLINE_MS, pollIntervalMs })
      core.info(`deleted superseded api config ${id}`)
      deleted.push(id)
    }
  } catch (error) {
    core.warning(`superseded api configs not cleaned up (deploy unaffected): ${error.message}`)
  }
  return deleted
}

/**
 * Render this image's API Gateway spec for the target environment, publish it as
 * an immutable api config, and point the gateway at it.
 *
 * Returns `{ published: false, reason: 'not-configured' }` when the environment
 * has no gateway (most apps), and `{ published: false, reason: 'no-label' }`
 * when the image ships no spec — legitimate during the rollout and permanently
 * legitimate when rolling back to an older release. Those two are the ONLY
 * non-failures: anything else throws and fails the deploy, because a gateway left
 * serving the previous release's spec in front of this release's code is a broken
 * app, whatever the cause (see deploy-cloudrun.js). Garbage collection is the one
 * exception, and it is not part of what gets served.
 */
export async function publishApiConfig ({
  image,
  services,
  repo,
  runtimeProject,
  region = DEFAULT_REGION,
  pollIntervalMs = POLL_INTERVAL_MS
}) {
  const wiring = apigEnv(services, repo)
  if (!wiring) return { published: false, reason: 'not-configured' }
  const { gatewayId, backendService, backendSa, env } = wiring

  if (!runtimeProject) {
    throw new Error('runtime-project is required to publish an api gateway config')
  }

  const oci = await openImage(image)
  const specKey = apigSpecKey(oci.labels)
  if (specKey === null) return { published: false, reason: 'no-label' }

  const source = `${APIG_IMAGE_DIR}/${specKey}`
  core.info(`extracting ${source} from ${image}`)
  const template = await oci.readFile(source)
  if (!template) {
    throw new Error(
      `Image declares ${APIG_LABEL}="${specKey}" but has no file at ${source}. ` +
      'The Dockerfile must COPY the spec there.'
    )
  }

  // ${API_GATEWAY_BACKEND}: the backend service's own run.app URI, which only
  // the deploy can know (see the header comment).
  const backend = services.find(service => shortName(service.name) === backendService)
  if (!backend) {
    throw new Error(
      `${APIG_BACKEND_SERVICE_ENV}="${backendService}" names a Cloud Run service that does not ` +
      `exist in ${runtimeProject} (found: ${services.map(s => shortName(s.name)).join(', ') || 'none'}).`
    )
  }
  if (!backend.uri) {
    throw new Error(
      `Cloud Run service "${backendService}" has no uri, so ` +
      `\${${BACKEND_VAR}} cannot be resolved.`
    )
  }

  const rendered = renderSpec(template.toString('utf8'), { ...env, [BACKEND_VAR]: backend.uri })
  const configId = configIdFor(rendered)

  const client = await authClient()
  const gatewayName = `projects/${runtimeProject}/locations/${region}/gateways/${gatewayId}`
  const gateway = (await client.request({
    url: `${APIG_API}/${gatewayName}`,
    method: 'GET',
    ...GAXIOS_RETRY
  })).data

  // The gateway's current apiConfig is a full resource name and the only place
  // the api's identity is written down: api configs live under locations/global
  // (not the gateway's region), under an api the Terraform module owns.
  const current = gateway?.apiConfig
  const match = current?.match(/^(projects\/[^/]+\/locations\/global\/apis\/[^/]+)\/configs\/([^/]+)$/)
  if (!match) {
    throw new Error(
      `Gateway ${gatewayName} has no usable apiConfig (got ${current ?? 'none'}). ` +
      'Terraform must create the gateway with a bootstrap config.'
    )
  }
  const [, apiName, currentConfigId] = match

  if (currentConfigId === configId) {
    return { published: true, reason: 'unchanged', gatewayId, configId, apiConfig: current }
  }

  const configName = `${apiName}/configs/${configId}`

  // The config may already exist: a rollback re-points at a config published by
  // an earlier deploy, and a retried run re-computes the same hash. Only an
  // ACTIVE one is worth re-pointing at (see resolveExistingConfig).
  let existing = await resolveExistingConfig(client, configName, { pollIntervalMs })

  if (existing === 'failed') {
    // An earlier run left a broken config at the id this spec hashes to, and
    // configs are immutable, so the only way forward is to replace it. Safe to
    // delete: a FAILED config cannot be serving traffic, and the gateway points
    // elsewhere (currentConfigId !== configId, checked above).
    core.warning(
      `api config ${configId} exists but is FAILED, left by an earlier run; ` +
      'deleting it and creating it again'
    )
    await deleteConfig(client, configName, { deadlineMs: CONFIG_DEADLINE_MS, pollIntervalMs })
    existing = 'absent'
  }

  const exists = existing === 'active'
  if (exists) {
    core.info(`api gateway config ${configId} already exists; re-pointing the gateway`)
  } else {
    core.info(`creating api gateway config ${configId} (${rendered.length} bytes of spec)`)
    try {
      const created = await client.request({
        url: `${APIG_API}/${apiName}/configs`,
        method: 'POST',
        params: { apiConfigId: configId },
        data: {
          // Stamp the config with the digest it was rendered from, so the
          // console answers "which release is this gateway serving?".
          displayName: parseImageRef(image).digest ?? image,
          // REST v1 spells this as a top-level, immutable field. The nested
          // gateway_config { backend_config { google_service_account } } shape
          // is the Terraform provider's own, and the API rejects it.
          gatewayServiceAccount: backendSa,
          openapiDocuments: [
            { document: { path: 'openapi.yaml', contents: Buffer.from(rendered).toString('base64') } }
          ]
        }
      })
      await awaitOperation(client, created.data, {
        label: `api config ${configId} create`,
        deadlineMs: CONFIG_DEADLINE_MS,
        pollIntervalMs
      })
    } catch (error) {
      // 409 ALREADY_EXISTS: another run (or a retried request) won the race.
      // Configs are content-addressed, so whoever created it created the same
      // bytes — but wait for that create to actually land before re-pointing.
      if (httpStatus(error) !== 409) throw error
      core.info(`api gateway config ${configId} was created concurrently; waiting for it`)
      const raced = await resolveExistingConfig(client, configName, { pollIntervalMs })
      if (raced !== 'active') {
        // FAILED means the gateway rejected these exact bytes; 'absent' means a
        // concurrent deploy's GC took it back out. Either way there is nothing to
        // re-point at.
        throw new Error(
          `api config ${configId} was created concurrently but is ` +
          `${raced === 'absent' ? 'gone' : 'FAILED'}`,
          { cause: error }
        )
      }
    }
  }

  core.info(`pointing gateway ${gatewayId} at ${configId} (this takes a few minutes)`)
  const patched = await client.request({
    url: `${APIG_API}/${gatewayName}`,
    method: 'PATCH',
    params: { updateMask: 'apiConfig' },
    data: { apiConfig: configName }
  })
  await awaitOperation(client, patched.data, {
    label: `gateway ${gatewayId} update`,
    deadlineMs: GATEWAY_DEADLINE_MS,
    pollIntervalMs
  })

  const deletedConfigIds = await collectGarbage(client, {
    apiName,
    keep: [configId, currentConfigId],
    pollIntervalMs
  })

  return {
    published: true,
    reason: exists ? 'repointed' : 'created',
    gatewayId,
    configId,
    apiConfig: configName,
    previousConfigId: currentConfigId,
    deletedConfigIds
  }
}
