import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock google-auth-library so the apigateway.googleapis.com calls hit a canned
// client, and src/v2/oci.js so no registry reads happen (openImage itself is
// covered by v2-oci.test.js).
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient () { return Promise.resolve({ request: requestMock }) }
  }
}))
vi.mock('../src/v2/oci.js', () => ({ openImage: vi.fn() }))

import { openImage } from '../src/v2/oci.js'
import {
  APIG_BACKEND_SA_ENV,
  APIG_BACKEND_SERVICE_ENV,
  APIG_GATEWAY_ENV,
  APIG_LABEL,
  apigEnv,
  apigSpecKey,
  configIdFor,
  publishApiConfig,
  renderSpec
} from '../src/v2/apigateway.js'

const REPO = 'us-central1-docker.pkg.dev/cru-shared-artifacts/mcp/mcp'
const IMAGE = `${REPO}@sha256:new`
const PROJECT = 'mcp-stage-1234'
const GATEWAY_ID = 'mcp-gw'
const BACKEND_URI = 'https://mcp-api-abc-uc.a.run.app'
const BACKEND_SA = 'gateway-backend@mcp-stage-1234.iam.gserviceaccount.com'
const API = `projects/${PROJECT}/locations/global/apis/mcp-api`
const GATEWAY = `projects/${PROJECT}/locations/us-central1/gateways/${GATEWAY_ID}`
const SPEC = 'swagger: "2.0"\naddress: ${API_GATEWAY_BACKEND}\nissuer: ${OAUTH_ISSUER}\n'
const RENDERED = `swagger: "2.0"\naddress: ${BACKEND_URI}\nissuer: https://issuer.example\n`
const CONFIG_ID = configIdFor(RENDERED)

// The gateway env Terraform injects, plus one unrelated var the spec uses.
const APIG_VARS = [
  { name: APIG_GATEWAY_ENV, value: GATEWAY_ID },
  { name: APIG_BACKEND_SERVICE_ENV, value: 'api' },
  { name: APIG_BACKEND_SA_ENV, value: BACKEND_SA },
  { name: 'OAUTH_ISSUER', value: 'https://issuer.example' }
]

// A Cloud Run service as the API returns it: app container plus a Datadog sidecar.
function service (env, { name = 'api', uri = BACKEND_URI } = {}) {
  return {
    name: `projects/${PROJECT}/locations/us-central1/services/${name}`,
    uri,
    template: {
      containers: [
        { image: `${REPO}@sha256:old`, ports: [{ containerPort: 8080 }], env },
        { name: 'datadog', image: 'gcr.io/datadoghq/agent:latest', env: [{ name: APIG_GATEWAY_ENV, value: 'wrong-gw' }] }
      ]
    }
  }
}

// Stub an image with the given labels and file contents.
function image ({ labels = { [APIG_LABEL]: 'openapi.yaml' }, files = { '/cru/api-gateway/openapi.yaml': SPEC } } = {}) {
  openImage.mockResolvedValue({
    labels,
    readFile: async path => (path in files ? Buffer.from(files[path]) : null)
  })
}

// Route the mocked client by URL+method, so tests describe the API surface they
// expect rather than a call sequence.
// `configPages` is the api's existing configs, as one array per response page.
function api ({
  currentConfig = `${API}/configs/cfg-old`,
  configExists = false,
  operations = {},
  configPages = [[]],
  onDelete = () => {}
} = {}) {
  const calls = []
  requestMock.mockImplementation(async options => {
    calls.push(options)
    const { url, method = 'GET' } = options

    if (url.endsWith(GATEWAY) && method === 'GET') return { data: { name: GATEWAY, apiConfig: currentConfig } }
    if (url.endsWith(GATEWAY) && method === 'PATCH') return { data: { name: 'operations/patch', done: false } }
    if (url.endsWith(`${API}/configs`) && method === 'POST') return { data: { name: 'operations/create', done: false } }
    if (url.endsWith(`${API}/configs`) && method === 'GET') {
      const page = Number(options.params?.pageToken ?? 0)
      return {
        data: {
          apiConfigs: configPages[page].map(id => ({ name: `${API}/configs/${id}` })),
          ...(page + 1 < configPages.length ? { nextPageToken: String(page + 1) } : {})
        }
      }
    }
    if (method === 'DELETE') {
      onDelete(shortId(url))
      return { data: { name: `operations/delete-${shortId(url)}`, done: true } }
    }
    if (url.endsWith(`${API}/configs/${CONFIG_ID}`)) {
      if (configExists) return { data: { name: `${API}/configs/${CONFIG_ID}` } }
      throw Object.assign(new Error('not found'), { response: { status: 404 } })
    }
    for (const [name, data] of Object.entries(operations)) {
      if (url.endsWith(`/${name}`)) return { data }
    }
    if (url.includes('/operations/')) return { data: { name: url.split('/v1/')[1], done: true } }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  return calls
}

const publish = (overrides = {}) => publishApiConfig({
  image: IMAGE,
  services: [service(APIG_VARS)],
  repo: REPO,
  runtimeProject: PROJECT,
  pollIntervalMs: 0,
  ...overrides
})

const shortId = resource => resource.split('/').pop()

const callsTo = (calls, method, fragment) =>
  calls.filter(call => (call.method ?? 'GET') === method && call.url.includes(fragment))

beforeEach(() => {
  requestMock.mockReset()
  openImage.mockReset()
})

describe('apigSpecKey', () => {
  it('returns null for an image with no api-gateway label — most apps have none', () => {
    expect(apigSpecKey({})).toBeNull()
    expect(apigSpecKey(undefined)).toBeNull()
  })

  it('returns the declared file name, trimmed', () => {
    expect(apigSpecKey({ [APIG_LABEL]: 'openapi.yaml' })).toBe('openapi.yaml')
    expect(apigSpecKey({ [APIG_LABEL]: ' openapi.yaml\n' })).toBe('openapi.yaml')
  })

  it.each([
    ['an empty value', ''],
    ['an absolute path', '/openapi.yaml'],
    ['a parent-directory escape', '../../etc/passwd'],
    ['a "." segment', './openapi.yaml'],
    ['a backslash', 'api\\openapi.yaml']
  ])('throws on %s', (_label, value) => {
    expect(() => apigSpecKey({ [APIG_LABEL]: value })).toThrow(/not a usable file name/)
  })
})

describe('apigEnv', () => {
  it('returns null when the environment has no gateway', () => {
    expect(apigEnv([service([{ name: 'FOO', value: 'bar' }])], REPO)).toBeNull()
    expect(apigEnv([], REPO)).toBeNull()
  })

  it('ignores the gate on a sidecar container', () => {
    expect(apigEnv([service([])], REPO)).toBeNull()
  })

  it('reads the wiring plus the app container env as substitution vars', () => {
    expect(apigEnv([service(APIG_VARS)], REPO)).toEqual({
      gatewayId: GATEWAY_ID,
      backendService: 'api',
      backendSa: BACKEND_SA,
      env: {
        [APIG_GATEWAY_ENV]: GATEWAY_ID,
        [APIG_BACKEND_SERVICE_ENV]: 'api',
        [APIG_BACKEND_SA_ENV]: BACKEND_SA,
        OAUTH_ISSUER: 'https://issuer.example'
      }
    })
  })

  it('skips secret-valued env, which must never be baked into a served spec', () => {
    const env = [
      ...APIG_VARS,
      { name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'projects/p/secrets/DATABASE_URL' } } }
    ]
    expect(apigEnv([service(env)], REPO).env).not.toHaveProperty('DATABASE_URL')
  })

  it('scans every service, so a multi-service app still resolves', () => {
    const services = [service([], { name: 'worker' }), service(APIG_VARS, { name: 'api' })]
    expect(apigEnv(services, REPO).gatewayId).toBe(GATEWAY_ID)
  })

  it('fails loudly when the gate is set but its companions are not', () => {
    const partial = [{ name: APIG_GATEWAY_ENV, value: GATEWAY_ID }]
    expect(() => apigEnv([service(partial)], REPO)).toThrow(
      /API_GATEWAY_BACKEND_SERVICE and API_GATEWAY_BACKEND_SA are not/
    )
  })
})

describe('renderSpec', () => {
  it('substitutes every placeholder on a line', () => {
    expect(renderSpec('${A}/${B}-${A}', { A: 'x', B: 'y' })).toBe('x/y-x')
  })

  it('lists every unresolved name in one error', () => {
    const error = (() => {
      try { renderSpec('${A} ${B} ${C} ${B}', { B: 'ok' }) } catch (e) { return e }
    })()
    expect(error.message).toMatch(/unresolved placeholder\(s\): A, C/)
  })

  it('leaves a bare $ and a brace-less $NAME alone — the spec is YAML', () => {
    expect(renderSpec('cost: $5 and $NAME and ${lower}', {})).toBe('cost: $5 and $NAME and ${lower}')
  })

  it('inserts values literally, so $& in a value cannot corrupt the output', () => {
    expect(renderSpec('${A}', { A: 'a$&b' })).toBe('a$&b')
  })
})

describe('configIdFor', () => {
  it('is stable and content-addressed', () => {
    expect(configIdFor('hello')).toBe(configIdFor('hello'))
    expect(configIdFor('hello')).toMatch(/^cfg-[0-9a-f]{12}$/)
    expect(configIdFor('hello')).not.toBe(configIdFor('hello '))
  })
})

describe('publishApiConfig', () => {
  it('does nothing for an environment with no gateway', async () => {
    const result = await publish({ services: [service([{ name: 'FOO', value: 'bar' }])] })
    expect(result).toEqual({ published: false, reason: 'not-configured' })
    expect(openImage).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('reports no-label when the image ships no spec', async () => {
    image({ labels: {} })
    api()
    expect(await publish()).toEqual({ published: false, reason: 'no-label' })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('fails when the label promises a spec the image does not carry', async () => {
    image({ files: {} })
    api()
    await expect(publish()).rejects.toThrow(/has no file at \/cru\/api-gateway\/openapi\.yaml/)
  })

  it('fails when the named backend service is not deployed here', async () => {
    image()
    const env = APIG_VARS.map(e => e.name === APIG_BACKEND_SERVICE_ENV ? { ...e, value: 'nope' } : e)
    await expect(publish({ services: [service(env)] })).rejects.toThrow(/names a Cloud Run service that does not exist/)
  })

  it('does nothing when the gateway already serves this exact spec', async () => {
    image()
    const calls = api({ currentConfig: `${API}/configs/${CONFIG_ID}` })

    expect(await publish()).toEqual({
      published: true,
      reason: 'unchanged',
      gatewayId: GATEWAY_ID,
      configId: CONFIG_ID,
      apiConfig: `${API}/configs/${CONFIG_ID}`
    })

    // Exactly one call: the gateway read that proved there was nothing to do.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://apigateway.googleapis.com/v1/${GATEWAY}`)
  })

  it('creates the config and re-points the gateway', async () => {
    image()
    const calls = api({
      operations: {
        'operations/create': { name: 'operations/create', done: true },
        'operations/patch': { name: 'operations/patch', done: true }
      }
    })

    const result = await publish()
    expect(result).toEqual({
      published: true,
      reason: 'created',
      gatewayId: GATEWAY_ID,
      configId: CONFIG_ID,
      apiConfig: `${API}/configs/${CONFIG_ID}`,
      previousConfigId: 'cfg-old',
      deletedConfigIds: []
    })

    // The api's identity comes from parsing the gateway's CURRENT apiConfig, and
    // configs live under locations/global regardless of the gateway's region.
    const [create] = callsTo(calls, 'POST', '/configs')
    expect(create.url).toBe(`https://apigateway.googleapis.com/v1/${API}/configs`)
    expect(create.params).toEqual({ apiConfigId: CONFIG_ID })
    expect(create.data.displayName).toBe('sha256:new')
    // Top-level per REST v1 discovery; the nested gatewayConfig.backendConfig
    // shape belongs to the Terraform provider, not the API.
    expect(create.data.gatewayServiceAccount).toBe(BACKEND_SA)
    expect(create.data).not.toHaveProperty('gatewayConfig')

    const [document] = create.data.openapiDocuments
    expect(document.document.path).toBe('openapi.yaml')
    expect(Buffer.from(document.document.contents, 'base64').toString('utf8')).toBe(RENDERED)

    const [patch] = callsTo(calls, 'PATCH', '/gateways/')
    expect(patch.url).toBe(`https://apigateway.googleapis.com/v1/${GATEWAY}`)
    expect(patch.params).toEqual({ updateMask: 'apiConfig' })
    expect(patch.data).toEqual({ apiConfig: `${API}/configs/${CONFIG_ID}` })
  })

  it('polls both long-running operations until they report done', async () => {
    image()
    let creates = 0
    let patches = 0
    const calls = []
    requestMock.mockImplementation(async options => {
      calls.push(options)
      const { url, method = 'GET' } = options
      if (url.endsWith(GATEWAY) && method === 'GET') return { data: { apiConfig: `${API}/configs/cfg-old` } }
      if (url.endsWith(GATEWAY) && method === 'PATCH') return { data: { name: 'operations/patch', done: false } }
      if (url.endsWith(`${API}/configs`) && method === 'POST') return { data: { name: 'operations/create', done: false } }
      if (url.endsWith(`${API}/configs`) && method === 'GET') return { data: { apiConfigs: [] } }
      if (url.endsWith(`${API}/configs/${CONFIG_ID}`)) throw Object.assign(new Error('nope'), { response: { status: 404 } })
      if (url.endsWith('operations/create')) return { data: { name: 'operations/create', done: ++creates >= 2 } }
      if (url.endsWith('operations/patch')) return { data: { name: 'operations/patch', done: ++patches >= 3 } }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    await publish()
    expect(creates).toBe(2)
    expect(patches).toBe(3)
  })

  it('surfaces an operation error — a bad spec only fails inside the LRO', async () => {
    image()
    api({ operations: { 'operations/create': { name: 'operations/create', done: true, error: { code: 3, message: 'invalid openapi: duplicate operationId' } } } })
    await expect(publish()).rejects.toThrow(/invalid openapi: duplicate operationId/)
  })

  it('treats a 409 on create as success — the config is content-addressed', async () => {
    image()
    const calls = []
    requestMock.mockImplementation(async options => {
      calls.push(options)
      const { url, method = 'GET' } = options
      if (url.endsWith(GATEWAY) && method === 'GET') return { data: { apiConfig: `${API}/configs/cfg-old` } }
      if (url.endsWith(GATEWAY) && method === 'PATCH') return { data: { name: 'operations/patch', done: true } }
      if (url.endsWith(`${API}/configs`) && method === 'POST') throw Object.assign(new Error('exists'), { response: { status: 409 } })
      if (url.endsWith(`${API}/configs`) && method === 'GET') return { data: { apiConfigs: [] } }
      if (url.endsWith(`${API}/configs/${CONFIG_ID}`)) throw Object.assign(new Error('nope'), { response: { status: 404 } })
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    const result = await publish()
    expect(result.published).toBe(true)
    expect(callsTo(calls, 'PATCH', '/gateways/')).toHaveLength(1)
  })

  it('skips the create when the config already exists — the rollback path', async () => {
    image()
    const calls = api({ configExists: true, operations: { 'operations/patch': { name: 'operations/patch', done: true } } })

    const result = await publish()
    expect(result.reason).toBe('repointed')
    expect(callsTo(calls, 'POST', '/configs')).toHaveLength(0)
    expect(callsTo(calls, 'PATCH', '/gateways/')).toHaveLength(1)
  })

  it('collects superseded configs, sparing the active, the previous and anything it did not mint', async () => {
    image()
    const previous = 'cfg-000000000000'
    const deletes = []
    const calls = api({
      currentConfig: `${API}/configs/${previous}`,
      onDelete: id => deletes.push(id),
      configPages: [[
        'bootstrap', // Terraform's seed config — not a cfg- id, never touched
        'hand-made-2026', // someone's manual config — likewise
        previous, // the config this deploy just replaced — kept for a 1-step rollback
        CONFIG_ID, // the config now serving traffic
        'cfg-aaaaaaaaaaaa',
        'cfg-bbbbbbbbbbbb'
      ]]
    })

    const result = await publish()
    expect(deletes).toEqual(['cfg-aaaaaaaaaaaa', 'cfg-bbbbbbbbbbbb'])
    expect(result.deletedConfigIds).toEqual(['cfg-aaaaaaaaaaaa', 'cfg-bbbbbbbbbbbb'])

    // GC runs only after the gateway is safely re-pointed.
    const [patch] = callsTo(calls, 'PATCH', '/gateways/')
    expect(calls.indexOf(patch)).toBeLessThan(calls.findIndex(call => call.method === 'DELETE'))
  })

  it('follows pagination, so an api with many configs is fully collected', async () => {
    image()
    const deletes = []
    api({
      onDelete: id => deletes.push(id),
      configPages: [['cfg-aaaaaaaaaaaa'], ['bootstrap', 'cfg-bbbbbbbbbbbb'], [CONFIG_ID]]
    })

    await publish()
    expect(deletes).toEqual(['cfg-aaaaaaaaaaaa', 'cfg-bbbbbbbbbbbb'])
  })

  it('collects nothing when the spec is unchanged — the gateway was never re-pointed', async () => {
    image()
    const calls = api({ currentConfig: `${API}/configs/${CONFIG_ID}`, configPages: [['cfg-aaaaaaaaaaaa']] })

    const result = await publish()
    expect(result).not.toHaveProperty('deletedConfigIds')
    expect(callsTo(calls, 'DELETE', '/configs/')).toHaveLength(0)
  })

  it('warns instead of failing the deploy when a delete is rejected', async () => {
    image()
    api({
      onDelete: () => { throw Object.assign(new Error('403 apigateway.apiConfigs.delete denied'), { response: { status: 403 } }) },
      configPages: [['cfg-aaaaaaaaaaaa']]
    })

    // Leaked configs are clutter, not an outage.
    const result = await publish()
    expect(result.published).toBe(true)
    expect(result.deletedConfigIds).toEqual([])
  })

  it('warns instead of failing the deploy when the configs cannot be listed', async () => {
    image()
    const calls = []
    requestMock.mockImplementation(async options => {
      calls.push(options)
      const { url, method = 'GET' } = options
      if (url.endsWith(GATEWAY) && method === 'GET') return { data: { apiConfig: `${API}/configs/cfg-old` } }
      if (url.endsWith(GATEWAY) && method === 'PATCH') return { data: { name: 'operations/patch', done: true } }
      if (url.endsWith(`${API}/configs`) && method === 'POST') return { data: { name: 'operations/create', done: true } }
      if (url.endsWith(`${API}/configs`) && method === 'GET') throw new Error('list blew up')
      if (url.endsWith(`${API}/configs/${CONFIG_ID}`)) throw Object.assign(new Error('nope'), { response: { status: 404 } })
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    const result = await publish()
    expect(result.published).toBe(true)
    expect(result.deletedConfigIds).toEqual([])
  })

  it('fails when the gateway has no bootstrap config to learn the api name from', async () => {
    image()
    api({ currentConfig: null })
    await expect(publish()).rejects.toThrow(/has no usable apiConfig/)
  })
})
