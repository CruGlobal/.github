// Publish the API Gateway config that ships inside the app image.
//
// The OpenAPI spec travels in the image, like the IAP sign-in page
// (./signin.js), so promote and rollback carry the spec that matches the code.
//
// Contract with the app image:
//   LABEL org.cru.api-gateway=<file name>     e.g. "openapi.yaml"
//   COPY  <spec> /cru/api-gateway/<file name>
//
// Contract with Terraform, as plain env on the app container:
//   API_GATEWAY_GATEWAY_ID       the gateway to point (its presence is the gate)
//   API_GATEWAY_BACKEND_SERVICE  the Cloud Run service the gateway calls
//   API_GATEWAY_BACKEND_SA       the SA the gateway calls it as
//
// The image is built once and promoted, so the spec carries ${VAR}
// placeholders. They are filled from the app container's plain env, plus
// ${API_GATEWAY_BACKEND}, the backend service's run.app URI: Terraform cannot
// inject a service's own URI into that service without a cycle.
//
// Rendering is plain text substitution, so OpenAPI 2.0 and 3.0.x both work;
// the gateway validates the document when the config is created.
//
// Two phases, so a bad spec is caught before anything changes:
//   prepareApiConfig, before the rollout: render the spec and make sure an
//     ACTIVE api config exists for it.
//   pointGateway, after the rollout: point the gateway at that config, then
//     clean up old configs.
//
// Config ids are content hashes (cfg-<sha256[0:12]>), so an unchanged spec is
// a no-op and a rollback finds its old config still there, if not yet cleaned
// up.
import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { DEFAULT_REGION } from '../gcp'
import { authClient, findAppContainer } from './gcp'
import { openImage } from './oci'
import { rolloutBudget } from './rollout-budget'

export const APIG_LABEL = 'org.cru.api-gateway'
export const APIG_IMAGE_DIR = '/cru/api-gateway'
export const APIG_GATEWAY_ENV = 'API_GATEWAY_GATEWAY_ID'
export const APIG_BACKEND_SERVICE_ENV = 'API_GATEWAY_BACKEND_SERVICE'
export const APIG_BACKEND_SA_ENV = 'API_GATEWAY_BACKEND_SA'
/** Placeholder the deploy fills itself, with the backend service's run.app URI. */
export const BACKEND_VAR = 'API_GATEWAY_BACKEND'

const APIG_API = 'https://apigateway.googleapis.com/v1'

// A config create usually takes a minute or two; a gateway update often takes
// several. Both are also held inside the deploy step's cap (./rollout-budget.js)
// so a slow API fails the step rather than letting the job time out.
const POLL_INTERVAL_MS = 5000
const CONFIG_WAIT_MS = 10 * 60 * 1000
const GATEWAY_WAIT_MS = 15 * 60 * 1000

// Old configs kept besides the new and previous one, newest first, so a
// rollback a few releases back is a quick re-point instead of a create.
const KEEP_RECENT = 5

// Only ids this module makes are ever deleted. Terraform's bootstrap config
// and anything made by hand do not match.
const GENERATED_CONFIG_ID = /^cfg-[0-9a-f]{12}$/

// GETs only. A POST whose response is lost would retry into a 409; the create
// handles 409 itself.
const GAXIOS_RETRY = {
  retry: true,
  retryConfig: {
    retry: 5,
    retryDelay: 500,
    httpMethodsToRetry: ['GET'],
    statusCodesToRetry: [[429, 429], [500, 599]]
  }
}

const shortName = resource => resource.split('/').pop()

// A wait of at most `ms`, and never past the deploy step's cap.
function waitBudget (ms, clock) {
  const budget = rolloutBudget({ budgetMs: ms, ...clock })
  budget.start()
  return budget
}
const httpStatus = error => error?.response?.status ?? error?.status

/**
 * The spec's file name, from the image's labels. Null when the image has no
 * label. Throws when the label would read from outside APIG_IMAGE_DIR.
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
      `Image label ${APIG_LABEL}="${raw}" is not a usable file name. ` +
      'Expected a relative path with no empty, "." or ".." segments (e.g. "openapi.yaml").'
    )
  }
  return key
}

/**
 * The gateway wiring Terraform put on any service's app container, read before
 * the deploy rewrites it. Null when no service has API_GATEWAY_GATEWAY_ID.
 * `env` holds only plain values: a secret must never end up in a config the
 * gateway serves. Throws when the gate is set without its companions.
 */
export function apigEnv (services, repo) {
  for (const service of services) {
    const app = findAppContainer(service.template?.containers ?? [], repo)
    if (!app) continue

    const env = {}
    for (const entry of app.env ?? []) {
      if (entry.value !== undefined) env[entry.name] = entry.value
    }

    const gatewayId = env[APIG_GATEWAY_ENV]
    if (!gatewayId) continue

    const backendService = env[APIG_BACKEND_SERVICE_ENV]
    const backendSa = env[APIG_BACKEND_SA_ENV]
    const missing = [
      backendService ? null : APIG_BACKEND_SERVICE_ENV,
      backendSa ? null : APIG_BACKEND_SA_ENV
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new Error(
        `${APIG_GATEWAY_ENV}="${gatewayId}" is set on ${shortName(service.name)} but ` +
        `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not. ` +
        'Terraform must set all three together.'
      )
    }
    return { gatewayId, backendService, backendSa, env }
  }
  return null
}

// ${NAME} with an upper-case env var name. `$FOO` and `${lower}` are left
// alone, since YAML may contain them for its own reasons.
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g

/**
 * Fill the spec's placeholders. Reports every unresolved one at once, so a
 * spec that adds three variables does not take three deploys to fix.
 */
export function renderSpec (template, vars) {
  const unresolved = new Set()
  const rendered = template.replace(PLACEHOLDER, (match, name) => {
    if (!Object.hasOwn(vars, name) || vars[name] == null) {
      unresolved.add(name)
      return match
    }
    return String(vars[name])
  })

  if (unresolved.size > 0) {
    throw new Error(
      `API gateway spec has unresolved placeholder(s): ${[...unresolved].join(', ')}. ` +
      'Each must be a plain-valued env var on the app container, or ' +
      `${BACKEND_VAR}. Placeholders in YAML comments are filled too.`
    )
  }
  return rendered
}

/**
 * Config id for everything that goes into a config: the document and the
 * backend SA, which is fixed for the config's life. A changed SA with the same
 * spec must make a new config, or the gateway would keep calling as the old one.
 */
export function configIdFor (rendered, backendSa) {
  const hash = createHash('sha256').update(rendered).update('\0').update(backendSa).digest('hex')
  return `cfg-${hash.slice(0, 12)}`
}

// One API call, with errors that say what was being done. A 403 also says
// which grants the deploy needs, since those live in the app's Terraform.
async function call (client, what, options, { backendSa } = {}) {
  try {
    return (await client.request(options)).data
  } catch (error) {
    const status = httpStatus(error)
    const detail = error.response?.data?.error?.message ?? error.message
    let message = `${what} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    if (status === 403) {
      message = message.replace(/\.?$/, '.') + ' The deploy service account needs roles/apigateway.admin on the project' +
        (backendSa ? ` and roles/iam.serviceAccountUser on ${backendSa}.` : '.')
    }
    throw Object.assign(new Error(message, { cause: error }), { status })
  }
}

const getter = url => ({ url: `${APIG_API}/${url}`, method: 'GET', ...GAXIOS_RETRY })

// Wait for a long-running operation. The operation's error is where a create
// reports a spec the gateway rejects.
async function awaitOperation (client, operation, { label, budget, pollIntervalMs }) {
  let op = operation
  while (!op?.done) {
    if (budget.remaining() <= 0) {
      throw new Error(
        `${label} did not finish in time (operation ${op?.name}). It carries on at Google; ` +
        're-run the deploy to pick up where it left off.'
      )
    }
    await budget.sleep(pollIntervalMs)
    core.info(`waiting for ${label}...`)
    op = await call(client, `${label}: reading the operation`, getter(op.name))
  }
  if (op.error) {
    throw new Error(`${label} failed: ${op.error.message ?? JSON.stringify(op.error)}`)
  }
  return op
}

// 'absent', 'active' or 'failed'. In-between states (CREATING, DELETING) mean
// another run is mid-flight, so they are waited out.
async function configState (client, configName, { budget, pollIntervalMs }) {
  const id = shortName(configName)
  while (true) {
    let config
    try {
      config = await call(client, `reading api config ${id}`, getter(configName))
    } catch (error) {
      if (error.status === 404) return 'absent'
      throw error
    }
    const state = config?.state ?? 'ACTIVE'
    if (state === 'ACTIVE') return 'active'
    if (state === 'FAILED') return 'failed'
    if (budget.remaining() <= 0) {
      throw new Error(`api config ${id} was still ${state}; another deploy may be mid-flight`)
    }
    core.info(`api config ${id} is ${state}; waiting...`)
    await budget.sleep(pollIntervalMs)
  }
}

// Create the config, or settle for one already there. Only an ACTIVE config
// can be served. A FAILED one, left by an interrupted run, sits at the id every
// later deploy of this spec computes, so it is replaced rather than skipped.
async function ensureConfig (client, { apiName, configId, rendered, backendSa, budget, pollIntervalMs }) {
  const configName = `${apiName}/configs/${configId}`
  const wait = { budget, pollIntervalMs }

  const state = await configState(client, configName, wait)
  if (state === 'active') return 'reused'
  if (state === 'failed') {
    core.warning(`api config ${configId} is FAILED, left by an earlier run; replacing it`)
    const op = await call(client, `deleting failed api config ${configId}`, { url: `${APIG_API}/${configName}`, method: 'DELETE' })
    await awaitOperation(client, op, { label: `api config ${configId} delete`, ...wait })
  }

  core.info(`creating api config ${configId} (${rendered.length} bytes of spec)`)
  try {
    const op = await call(client, `creating api config ${configId}`, {
      url: `${APIG_API}/${apiName}/configs`,
      method: 'POST',
      params: { apiConfigId: configId },
      data: {
        // REST v1 spells the backend SA as this top-level field.
        gatewayServiceAccount: backendSa,
        openapiDocuments: [
          { document: { path: 'openapi.yaml', contents: Buffer.from(rendered).toString('base64') } }
        ]
      }
    }, { backendSa })
    await awaitOperation(client, op, { label: `api config ${configId} create`, ...wait })
  } catch (error) {
    // Another run made the same bytes first. Wait for it to land.
    if (error.status !== 409) throw error
    core.info(`api config ${configId} was created concurrently; waiting for it`)
    const raced = await configState(client, configName, wait)
    if (raced !== 'active') {
      throw new Error(`api config ${configId} was created concurrently but is ${raced === 'absent' ? 'gone' : 'FAILED'}`, { cause: error })
    }
    return 'reused'
  }
  return 'created'
}

/**
 * Phase one, before the rollout. Returns null when the environment has no
 * gateway (most apps), without opening the image. Otherwise renders this
 * image's spec, makes sure an ACTIVE config exists for it, and returns the
 * plan pointGateway carries out. Throws on anything wrong, including an image
 * with no spec: the caller decides whether that is fatal (a rollback is not).
 *
 * `oci` is a function returning the deploy's shared image handle.
 */
export async function prepareApiConfig ({ image, services, repo, runtimeProject, oci, region = DEFAULT_REGION, timing = {} }) {
  const wiring = apigEnv(services, repo)
  if (!wiring) return null
  const { gatewayId, backendService, backendSa, env } = wiring
  const { pollIntervalMs = POLL_INTERVAL_MS, ...clock } = timing

  const handle = oci ? await oci() : await openImage(image)
  const specKey = apigSpecKey(handle.labels)
  if (specKey === null) {
    throw new Error(
      `${APIG_GATEWAY_ENV}="${gatewayId}" says this environment has an API gateway, but ${image} ` +
      `has no ${APIG_LABEL} label, so there is no spec to publish.`
    )
  }
  const source = `${APIG_IMAGE_DIR}/${specKey}`
  core.info(`extracting ${source} from ${image}`)
  const template = await handle.readFile(source)
  if (!template) {
    throw new Error(
      `Image declares ${APIG_LABEL}="${specKey}" but has no file at ${source}. ` +
      'The Dockerfile must COPY the spec there.'
    )
  }

  const backend = services.find(service => shortName(service.name) === backendService)
  if (!backend?.uri) {
    throw new Error(
      `${APIG_BACKEND_SERVICE_ENV}="${backendService}" must name a Cloud Run service with a URI in ` +
      `${runtimeProject} (found: ${services.map(s => shortName(s.name)).join(', ') || 'none'}).`
    )
  }

  const rendered = renderSpec(template.toString('utf8'), { ...env, [BACKEND_VAR]: backend.uri })
  const configId = configIdFor(rendered, backendSa)

  const client = await authClient()
  const gatewayName = `projects/${runtimeProject}/locations/${region}/gateways/${gatewayId}`
  const gateway = await call(client, `reading gateway ${gatewayId}`, getter(gatewayName), { backendSa })

  // Configs live under locations/global, under an api Terraform owns; the
  // gateway's current config is the only place that api is named.
  const current = gateway?.apiConfig
  const match = current?.match(/^(projects\/[^/]+\/locations\/global\/apis\/[^/]+)\/configs\/([^/]+)$/)
  if (!match) {
    throw new Error(`Gateway ${gatewayName} has no usable apiConfig (got ${current ?? 'none'}).`)
  }
  const [, apiName, previousConfigId] = match
  const plan = { gatewayId, gatewayName, apiName, configId, previousConfigId, backendSa, pollIntervalMs, clock }

  if (previousConfigId === configId) return { ...plan, status: 'unchanged' }

  const budget = waitBudget(CONFIG_WAIT_MS, clock)
  const status = await ensureConfig(client, { apiName, configId, rendered, backendSa, budget, pollIntervalMs })
  core.info(`api config ${configId} is ready (${status})`)
  return { ...plan, status }
}

// Delete generated configs beyond the ones worth keeping. Requests the
// deletes without waiting on them. Never fails the deploy: a leftover config
// is clutter, not an outage.
async function collectGarbage (client, { apiName, keep }) {
  const deleted = []
  try {
    const configs = []
    let pageToken
    do {
      const page = await call(client, 'listing api configs', {
        ...getter(`${apiName}/configs`),
        params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) }
      })
      configs.push(...(page?.apiConfigs ?? []))
      pageToken = page?.nextPageToken
    } while (pageToken)

    const generated = configs
      .filter(config => GENERATED_CONFIG_ID.test(shortName(config.name ?? '')))
      .sort((a, b) => String(b.createTime ?? '').localeCompare(String(a.createTime ?? '')))
    const kept = new Set([...keep, ...generated.slice(0, KEEP_RECENT).map(config => shortName(config.name))])
    for (const config of generated) {
      const id = shortName(config.name)
      if (kept.has(id)) continue
      await call(client, `deleting api config ${id}`, { url: `${APIG_API}/${config.name}`, method: 'DELETE' })
      deleted.push(id)
    }
    if (deleted.length > 0) core.info(`deleting old api configs: ${deleted.join(', ')}`)
  } catch (error) {
    core.warning(`old api configs not cleaned up (deploy unaffected): ${error.message}`)
  }
  return deleted
}

/**
 * Phase two, after the rollout: point the gateway at the plan's config.
 * Returns { status, gatewayId, configId, previousConfigId, deletedConfigIds }.
 */
export async function pointGateway (plan) {
  const { gatewayId, gatewayName, apiName, configId, previousConfigId, backendSa, pollIntervalMs, clock, status } = plan
  const result = { status, gatewayId, configId, previousConfigId, deletedConfigIds: [] }
  if (status === 'unchanged') return result

  const client = await authClient()
  core.info(`pointing gateway ${gatewayId} at ${configId} (this takes a few minutes)`)
  const op = await call(client, `pointing gateway ${gatewayId} at ${configId}`, {
    url: `${APIG_API}/${gatewayName}`,
    method: 'PATCH',
    params: { updateMask: 'apiConfig' },
    data: { apiConfig: `${apiName}/configs/${configId}` }
  }, { backendSa })
  await awaitOperation(client, op, {
    label: `gateway ${gatewayId} update`,
    budget: waitBudget(GATEWAY_WAIT_MS, clock),
    pollIntervalMs
  })

  result.deletedConfigIds = await collectGarbage(client, { apiName, keep: [configId, previousConfigId] })
  return result
}
