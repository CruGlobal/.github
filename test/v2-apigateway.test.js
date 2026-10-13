import { describe, it, expect, beforeEach, vi } from 'vitest'

// google-auth-library is mocked so apigateway.googleapis.com calls hit a canned
// client; oci.js so no registry reads happen (covered by v2-oci.test.js).
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
  pointGateway,
  prepareApiConfig,
  renderSpec
} from '../src/v2/apigateway.js'

const REPO = 'us-central1-docker.pkg.dev/example-registry/example-app/example-app'
const IMAGE = `${REPO}@sha256:new`
const PROJECT = 'example-app-stage-0000'
const GATEWAY_ID = 'example-app-gw'
const BACKEND_URI = 'https://api-abc-uc.a.run.app'
const BACKEND_SA = `example-app-gw@${PROJECT}.iam.gserviceaccount.com`
const API = `projects/${PROJECT}/locations/global/apis/example-app`
const GATEWAY = `projects/${PROJECT}/locations/us-central1/gateways/${GATEWAY_ID}`
const SPEC = 'openapi: "3.0.3"\naddress: ${API_GATEWAY_BACKEND}\nissuer: ${OAUTH_ISSUER}\n'
const RENDERED = `openapi: "3.0.3"\naddress: ${BACKEND_URI}\nissuer: https://issuer.example\n`
const CONFIG_ID = configIdFor(RENDERED, BACKEND_SA)

const APIG_VARS = [
  { name: APIG_GATEWAY_ENV, value: GATEWAY_ID },
  { name: APIG_BACKEND_SERVICE_ENV, value: 'api' },
  { name: APIG_BACKEND_SA_ENV, value: BACKEND_SA },
  { name: 'OAUTH_ISSUER', value: 'https://issuer.example' }
]

// A Cloud Run service as the API returns it: app container plus a sidecar.
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

function image ({ labels = { [APIG_LABEL]: 'openapi.yaml' }, files = { '/cru/api-gateway/openapi.yaml': SPEC } } = {}) {
  openImage.mockResolvedValue({
    labels,
    readFile: async path => (path in files ? Buffer.from(files[path]) : null)
  })
}

const httpError = (status, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { response: { status, data: { error: { message } } } })

// Routes the mocked client by URL and method.
// `configStates`: what successive GETs of this spec's config report (a state,
//   or null for 404); the last entry repeats.
// `configs`: the api's existing configs, as pages of { id, createTime }.
// `fail`: { 'METHOD fragment': error } to make one call throw.
function api ({
  currentConfig = `${API}/configs/cfg-000000000000`,
  configStates = [null],
  operations = {},
  configs = [[]],
  fail = {},
  gatewayStates = ['ACTIVE']
} = {}) {
  const calls = []
  let configGets = 0
  let gatewayGets = 0
  requestMock.mockImplementation(async options => {
    calls.push(options)
    const { url, method = 'GET' } = options
    for (const [key, error] of Object.entries(fail)) {
      const [failMethod, fragment] = key.split(' ')
      if (method === failMethod && url.includes(fragment)) throw error
    }

    if (url.endsWith(GATEWAY) && method === 'GET') {
      const state = gatewayStates[Math.min(gatewayGets++, gatewayStates.length - 1)]
      return { data: { name: GATEWAY, apiConfig: currentConfig, state } }
    }
    if (url.endsWith(GATEWAY) && method === 'PATCH') return { data: { name: 'operations/patch', done: false } }
    if (url.endsWith(`${API}/configs`) && method === 'POST') return { data: { name: 'operations/create', done: false } }
    if (url.endsWith(`${API}/configs`) && method === 'GET') {
      const page = Number(options.params?.pageToken ?? 0)
      return {
        data: {
          apiConfigs: configs[page].map(({ id, createTime }) => ({ name: `${API}/configs/${id}`, createTime })),
          ...(page + 1 < configs.length ? { nextPageToken: String(page + 1) } : {})
        }
      }
    }
    if (method === 'DELETE') return { data: { name: `operations/delete-${shortId(url)}`, done: true } }
    if (url.endsWith(`${API}/configs/${CONFIG_ID}`)) {
      const state = configStates[Math.min(configGets++, configStates.length - 1)]
      if (state == null) throw httpError(404, 'not found')
      return { data: { name: `${API}/configs/${CONFIG_ID}`, state } }
    }
    for (const [name, data] of Object.entries(operations)) {
      if (url.endsWith(`/${name}`)) return { data }
    }
    if (url.includes('/operations/')) return { data: { name: url.split('/v1/')[1], done: true } }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  return calls
}

// A fake clock, so waits of many minutes take no time.
function fakeClock () {
  let t = 0
  return { now: () => t, sleep: async ms => { t += ms }, stepStartedAt: 0, elapsed: () => t }
}

const prepare = (overrides = {}) => prepareApiConfig({
  image: IMAGE,
  services: [service(APIG_VARS)],
  repo: REPO,
  runtimeProject: PROJECT,
  timing: { pollIntervalMs: 1000, ...fakeClock() },
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
  it('returns null for an image with no api-gateway label - most apps have none', () => {
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

  it('leaves a bare $ and a brace-less $NAME alone - the spec is YAML', () => {
    expect(renderSpec('cost: $5 and $NAME and ${lower}', {})).toBe('cost: $5 and $NAME and ${lower}')
  })

  it('treats an empty value as unresolved', () => {
    expect(() => renderSpec('${A}', { A: '' })).toThrow(/unresolved placeholder\(s\): A/)
  })

  it('refuses a value with a newline, which could add YAML structure', () => {
    expect(() => renderSpec('x: ${A}', { A: 'a\nb: c' })).toThrow(/contain a newline: A/)
  })

  it('inserts values literally, so $& in a value cannot corrupt the output', () => {
    expect(renderSpec('${A}', { A: 'a$&b' })).toBe('a$&b')
  })
})

describe('configIdFor', () => {
  it('is stable, short, lowercase and content-addressed', () => {
    expect(configIdFor('hello', BACKEND_SA)).toBe(configIdFor('hello', BACKEND_SA))
    expect(configIdFor('hello', BACKEND_SA)).toMatch(/^cfg-[0-9a-f]{12}$/)
    expect(configIdFor('hello', BACKEND_SA)).not.toBe(configIdFor('hello ', BACKEND_SA))
  })

  // The SA is fixed for a config's life, so a new SA needs a new config.
  it('changes when only the backend SA changes', () => {
    expect(configIdFor('hello', BACKEND_SA)).not.toBe(configIdFor('hello', 'other@example.iam.gserviceaccount.com'))
  })
})

describe('prepareApiConfig', () => {
  it('does nothing for an environment with no gateway, without opening the image', async () => {
    expect(await prepare({ services: [service([{ name: 'FOO', value: 'bar' }])] })).toBeNull()
    expect(openImage).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('uses the shared image handle when given one', async () => {
    image()
    api()
    const oci = vi.fn(() => openImage())
    await prepare({ oci })
    expect(oci).toHaveBeenCalledTimes(1)
  })

  it('fails when the environment has a gateway but the image has no spec', async () => {
    image({ labels: {} })
    await expect(prepare()).rejects.toThrow(/has no org.cru.api-gateway label/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('fails when the label promises a spec the image does not carry', async () => {
    image({ files: {} })
    await expect(prepare()).rejects.toThrow(/no file at \/cru\/api-gateway\/openapi.yaml/)
  })

  it('fails when the named backend service is not deployed here', async () => {
    image()
    const services = [service(APIG_VARS, { name: 'web' })]
    await expect(prepare({ services })).rejects.toThrow(/"api" must name a Cloud Run service .*found: web/)
  })

  it('fails when the backend service has no uri', async () => {
    image()
    await expect(prepare({ services: [service(APIG_VARS, { uri: '' })] })).rejects.toThrow(/with a URI/)
  })

  it('fails on an unresolved placeholder before calling the API', async () => {
    image({ files: { '/cru/api-gateway/openapi.yaml': `${SPEC}aud: \${GATEWAY_JWT_AUDIENCE}\n` } })
    await expect(prepare()).rejects.toThrow(/unresolved placeholder\(s\): GATEWAY_JWT_AUDIENCE/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('is unchanged, with no create, when the gateway already serves this spec', async () => {
    image()
    const calls = api({ currentConfig: `${API}/configs/${CONFIG_ID}` })
    const plan = await prepare()
    expect(plan).toMatchObject({ status: 'unchanged', configId: CONFIG_ID, previousConfigId: CONFIG_ID })
    expect(calls).toHaveLength(1)
  })

  it('creates the config with the rendered spec and the backend SA', async () => {
    image()
    const calls = api()
    const plan = await prepare()

    expect(plan).toMatchObject({ status: 'created', configId: CONFIG_ID, previousConfigId: 'cfg-000000000000', apiName: API })
    const [create] = callsTo(calls, 'POST', '/configs')
    expect(create.params).toEqual({ apiConfigId: CONFIG_ID })
    expect(create.data.gatewayServiceAccount).toBe(BACKEND_SA)
    expect(Buffer.from(create.data.openapiDocuments[0].document.contents, 'base64').toString()).toBe(RENDERED)
    // Not pointed yet: that is pointGateway's job, after the rollout.
    expect(callsTo(calls, 'PATCH', GATEWAY)).toHaveLength(0)
  })

  it('reports a spec the gateway rejects, from the create operation', async () => {
    image()
    api({ operations: { 'operations/create': { name: 'operations/create', done: true, error: { message: 'invalid openapi' } } } })
    await expect(prepare()).rejects.toThrow(/api config cfg-[0-9a-f]{12} create failed: invalid openapi/)
  })

  it('says which grants are missing on a 403', async () => {
    image()
    api({ fail: { 'POST /configs': httpError(403, "Permission 'iam.serviceAccounts.actAs' denied") } })
    await expect(prepare()).rejects.toThrow(
      new RegExp(`creating api config .*HTTP 403.*actAs' denied.*roles/apigateway.admin.*roles/iam.serviceAccountUser on ${BACKEND_SA}`)
    )
  })

  it('says what it was doing when reading the gateway fails', async () => {
    image()
    api({ fail: { [`GET ${GATEWAY}`]: httpError(404, 'gateway not found') } })
    await expect(prepare()).rejects.toThrow(`reading gateway ${GATEWAY_ID} in us-central1 failed (HTTP 404): gateway not found`)
  })

  it('times out a create that never finishes, inside the wait', async () => {
    image()
    const clock = fakeClock()
    api({ operations: { 'operations/create': { name: 'operations/create', done: false } } })
    await expect(prepare({ timing: { pollIntervalMs: 5000, ...clock } })).rejects.toThrow(/did not finish in time/)
    expect(clock.elapsed()).toBeGreaterThanOrEqual(10 * 60 * 1000)
    expect(clock.elapsed()).toBeLessThan(11 * 60 * 1000)
  })

  it('waits out an earlier update still in flight before comparing', async () => {
    image()
    const calls = api({ gatewayStates: ['UPDATING', 'UPDATING', 'ACTIVE'], currentConfig: `${API}/configs/${CONFIG_ID}` })
    expect((await prepare()).status).toBe('unchanged')
    expect(callsTo(calls, 'GET', GATEWAY)).toHaveLength(3)
  })

  it('gives up on a gateway that stays UPDATING', async () => {
    image()
    api({ gatewayStates: ['UPDATING'] })
    await expect(prepare()).rejects.toThrow(/gateway example-app-gw was still UPDATING/)
  })

  it('reuses an ACTIVE config, the rollback path', async () => {
    image()
    const calls = api({ configStates: ['ACTIVE'] })
    expect((await prepare()).status).toBe('reused')
    expect(callsTo(calls, 'POST', '/configs')).toHaveLength(0)
  })

  it('waits out a config another run is still creating', async () => {
    image()
    const calls = api({ configStates: ['CREATING', 'CREATING', 'ACTIVE'] })
    expect((await prepare()).status).toBe('reused')
    expect(callsTo(calls, 'POST', '/configs')).toHaveLength(0)
  })

  it('replaces a FAILED config left by an earlier run', async () => {
    image()
    const calls = api({ configStates: ['FAILED'] })
    expect((await prepare()).status).toBe('created')
    expect(callsTo(calls, 'DELETE', `/configs/${CONFIG_ID}`)).toHaveLength(1)
    expect(callsTo(calls, 'POST', '/configs')).toHaveLength(1)
  })

  it('treats a 409 on create as success once the racing create is ACTIVE', async () => {
    image()
    api({ configStates: [null, 'CREATING', 'ACTIVE'], fail: { 'POST /configs': httpError(409, 'already exists') } })
    expect((await prepare()).status).toBe('reused')
  })

  it.each([[null, 'gone'], ['FAILED', 'FAILED']])('fails when a racing create ends up %s', async (state, word) => {
    image()
    api({ configStates: [null, state], fail: { 'POST /configs': httpError(409, 'already exists') } })
    await expect(prepare()).rejects.toThrow(`created concurrently but is ${word}`)
  })

  it('fails when the gateway has no config to learn the api name from', async () => {
    image()
    api({ currentConfig: null })
    await expect(prepare()).rejects.toThrow(/has no usable apiConfig/)
  })
})

describe('pointGateway', () => {
  async function prepared (options = {}) {
    image()
    const calls = api(options)
    const plan = await prepare()
    calls.length = 0
    return { plan, calls }
  }

  it('does nothing when the spec is unchanged', async () => {
    const { plan, calls } = await prepared({ currentConfig: `${API}/configs/${CONFIG_ID}` })
    expect(await pointGateway(plan)).toMatchObject({ status: 'unchanged', configId: CONFIG_ID, deletedConfigIds: [] })
    expect(calls).toHaveLength(0)
  })

  it('points the gateway at the config and waits for the update', async () => {
    const { plan, calls } = await prepared({
      operations: { 'operations/patch': { name: 'operations/patch', done: true } }
    })
    const result = await pointGateway(plan)

    expect(result).toMatchObject({ status: 'created', gatewayId: GATEWAY_ID, configId: CONFIG_ID, previousConfigId: 'cfg-000000000000' })
    const [patch] = callsTo(calls, 'PATCH', GATEWAY)
    expect(patch.params).toEqual({ updateMask: 'apiConfig' })
    expect(patch.data).toEqual({ apiConfig: `${API}/configs/${CONFIG_ID}` })
    expect(callsTo(calls, 'GET', 'operations/patch')).toHaveLength(1)
  })

  it('fails when the gateway update fails', async () => {
    const { plan } = await prepared({
      operations: { 'operations/patch': { name: 'operations/patch', done: true, error: { message: 'boom' } } }
    })
    await expect(pointGateway(plan)).rejects.toThrow(`gateway ${GATEWAY_ID} update failed: boom`)
  })

  it('stops waiting at the deploy step cap, not just its own 15 minutes', async () => {
    image()
    api({ operations: { 'operations/patch': { name: 'operations/patch', done: false } } })
    // 48 minutes into a step capped at 50.
    let t = 48 * 60 * 1000
    const clock = { now: () => t, sleep: async ms => { t += ms }, stepStartedAt: 0 }
    const plan = await prepare({ timing: { pollIntervalMs: 5000, ...clock } })
    await expect(pointGateway(plan)).rejects.toThrow(/did not finish in time.*re-run the deploy/)
    expect(t).toBeLessThanOrEqual(50 * 60 * 1000 + 5000)
  })

  it('deletes old generated configs, keeping the new, the previous, the 5 newest and anything it did not make', async () => {
    const old = n => ({ id: `cfg-${String(n).padStart(12, '0')}`, createTime: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z` })
    const { plan, calls } = await prepared({
      configs: [[
        { id: 'bootstrap', createTime: '2025-01-01T00:00:00Z' },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(old),
        { id: CONFIG_ID, createTime: '2026-02-01T00:00:00Z' }
      ]]
    })
    const result = await pointGateway(plan)
    // Newest five are the new one and 8..5; the previous (cfg-0) is not listed.
    expect(result.deletedConfigIds).toEqual([old(4).id, old(3).id, old(2).id, old(1).id])
    expect(callsTo(calls, 'DELETE', '/configs/bootstrap')).toHaveLength(0)
  })

  it('never deletes the previous config, however old', async () => {
    const { plan } = await prepared({
      configs: [[
        { id: 'cfg-000000000000', createTime: '2020-01-01T00:00:00Z' },
        ...[1, 2, 3, 4, 5, 6].map(n => ({ id: `cfg-${'a'.repeat(11)}${n}`, createTime: `2026-01-0${n}T00:00:00Z` }))
      ]]
    })
    const result = await pointGateway(plan)
    expect(result.deletedConfigIds).toEqual(['cfg-aaaaaaaaaaa1'])
  })

  it('follows pagination when listing configs', async () => {
    const ids = n => Array.from({ length: n }, (_, i) => ({ id: `cfg-${'b'.repeat(10)}${String(i).padStart(2, '0')}`, createTime: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    const all = ids(8)
    const { plan } = await prepared({ configs: [all.slice(0, 4), all.slice(4)] })
    expect((await pointGateway(plan)).deletedConfigIds).toHaveLength(3)
  })

  it.each([
    ['a delete is rejected', false],
    ['the configs cannot be listed', true]
  ])('only warns when %s', async (_label, listFails) => {
    const old = [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `cfg-${'c'.repeat(11)}${n}`, createTime: `2026-01-0${n}T00:00:00Z` }))
    const { plan } = await prepared({ configs: [old] })
    // Swapped in after prepare, so only the clean-up sees the failure.
    const delegate = requestMock.getMockImplementation()
    requestMock.mockImplementation(async options => {
      const method = options.method ?? 'GET'
      if (listFails && method === 'GET' && options.url.endsWith(`${API}/configs`)) throw new Error('list blew up')
      if (!listFails && method === 'DELETE') throw httpError(403, 'denied')
      return delegate(options)
    })
    await expect(pointGateway(plan)).resolves.toMatchObject({ status: 'created', deletedConfigIds: [] })
  })

  it('keeps deleting after one delete fails', async () => {
    const old = [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `cfg-${'d'.repeat(11)}${n}`, createTime: `2026-01-0${n}T00:00:00Z` }))
    const { plan } = await prepared({ configs: [old], fail: { 'DELETE dddd2': httpError(400, 'in use') } })
    expect((await pointGateway(plan)).deletedConfigIds).toEqual(['cfg-ddddddddddd1'])
  })
})
