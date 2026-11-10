import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// The time limit on the one-time request id hook, checked in a real Node
// process. Inside the test runner the process always has something else
// pending, so a timer that does not keep Node running, or one that is never
// cleared, would go unnoticed here. On a runner it matters: the entry starts
// run() without waiting for it, so if nothing holds the process open, Node
// exits 0 with the step passed and no refusal written. And a timer left
// running keeps the step, and the production lock, until it fires.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TIME_LIMIT_MS = 1500

// Runs in the child. It starts authorize() for an attempt the deploy gate's
// account started, with a fake octokit so nothing reaches the network, and
// does not wait for it, as the entry does with run().
const child = `
import { generateKeyPairSync, sign } from 'node:crypto'
const { authorize } = await import(process.env.AUTHORIZE_ACTOR_URL)

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const now = Math.floor(Date.now() / 1000)
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const claims = {
  iss: 'https://deploy-gate.example.com',
  aud: 'example-org/deploy',
  sub: 'requester@example.com',
  app: 'example-app',
  action: 'promote',
  target: 'candidate-1',
  environment: 'production',
  jti: 'req-1',
  iat: now,
  exp: now + 300
}
const data = b64({ alg: 'ES256', typ: 'JWT' }) + '.' + b64(claims)
const signature = sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
const hooks = {
  'never-answers': () => new Promise(() => {}),
  'answers-at-once': async () => 'claimed'
}

const started = Date.now()
process.on('exit', (code) => console.log(JSON.stringify({ code, elapsed: Date.now() - started })))
authorize({
  octokit: { rest: { users: { getByUsername: async () => ({ data: { id: 12345 } }) } } },
  repository: 'example-org/example-app',
  operation: 'promote',
  actor: 'deploy-gate[bot]',
  actorId: '12345',
  triggeringActor: 'deploy-gate[bot]',
  runAttempt: '1',
  workflowRepository: 'example-org/deploy-workflows',
  runId: '9000000001',
  gateActorId: '12345',
  signedRequest: data + '.' + signature.toString('base64url'),
  gatePublicKeys: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  gateIssuer: claims.iss,
  gateAudience: claims.aud,
  expectedApp: claims.app,
  expectedAction: claims.action,
  expectedTarget: claims.target,
  claimRequestId: hooks[process.env.HOOK],
  timeoutMs: Number(process.env.TIME_LIMIT_MS)
}).then(
  (passedAs) => console.log(JSON.stringify({ passedAs })),
  (error) => {
    console.log(JSON.stringify({ refused: error.message }))
    process.exitCode = 1
  }
)
`

function runChild (hook) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', child], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      AUTHORIZE_ACTOR_URL: pathToFileURL(path.join(root, 'src/authorize-actor.js')).href,
      HOOK: hook,
      TIME_LIMIT_MS: String(TIME_LIMIT_MS)
    },
    encoding: 'utf8',
    timeout: 30000
  })
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
  return { status: result.status, stderr: result.stderr, ...Object.assign({}, ...lines) }
}

describe('the request id hook\'s time limit, in a real Node process', () => {
  it('refuses, and exits non-zero at about the time limit, when the hook waits on nothing', () => {
    const outcome = runChild('never-answers')
    expect(outcome.stderr).toBe('')
    expect(outcome.refused).toContain(`the one-time request id store could not be reached or answered (no answer within ${TIME_LIMIT_MS / 1000} seconds)`)
    expect(outcome.status).toBe(1)
    expect(outcome.code).toBe(1)
    expect(outcome.elapsed).toBeGreaterThanOrEqual(TIME_LIMIT_MS - 100)
    expect(outcome.elapsed).toBeLessThan(TIME_LIMIT_MS + 3000)
  }, 40000)

  it('lets the process end well before the time limit when the hook answers at once', () => {
    const outcome = runChild('answers-at-once')
    expect(outcome.stderr).toBe('')
    expect(outcome.passedAs).toBe('gate')
    expect(outcome.status).toBe(0)
    expect(outcome.elapsed).toBeLessThan(TIME_LIMIT_MS / 3)
  }, 40000)
})

// The same, with the real claim hook (src/v2/gate-claim.js), real fetch and
// real sockets, against local servers that accept a connection and never
// answer. The step must refuse at the time limit, and the process must end
// then, which it only does if no socket is left open.
//
// One case cannot end at once: a connection Node's fetch is still setting up
// (here a TLS handshake nobody answers) stays until fetch's own 10-second
// connect timeout, abort or not. So that case is held to the time limit plus
// those 10 seconds. A connection that is up (the plain-HTTP token service
// below) ends at once.
const FETCH_CONNECT_TIMEOUT_MS = 10000

const claimChild = `
import { generateKeyPairSync, sign } from 'node:crypto'
const { authorize } = await import(process.env.AUTHORIZE_ACTOR_URL)

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const now = Math.floor(Date.now() / 1000)
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const claims = {
  iss: 'https://deploy-gate.example.com',
  aud: 'example-org/deploy',
  sub: 'requester@example.com',
  app: 'example-app',
  action: 'promote',
  target: 'candidate-1',
  environment: 'production',
  jti: 'req-1',
  iat: now,
  exp: now + 300
}
const data = b64({ alg: 'ES256', typ: 'JWT' }) + '.' + b64(claims)
const signature = sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })

const started = Date.now()
process.on('exit', (code) => console.log(JSON.stringify({ code, elapsed: Date.now() - started })))
authorize({
  octokit: { rest: { users: { getByUsername: async () => ({ data: { id: 12345 } }) } } },
  repository: 'example-org/example-app',
  operation: 'promote',
  actor: 'deploy-gate[bot]',
  actorId: '12345',
  triggeringActor: 'deploy-gate[bot]',
  runAttempt: '1',
  workflowRepository: 'example-org/deploy-workflows',
  runId: '9000000001',
  gateActorId: '12345',
  signedRequest: data + '.' + signature.toString('base64url'),
  gatePublicKeys: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  gateIssuer: claims.iss,
  gateAudience: claims.aud,
  expectedApp: claims.app,
  expectedAction: claims.action,
  expectedTarget: claims.target,
  gateClaimUrl: process.env.CLAIM_URL,
  gateClaimAudience: 'https://gate.example.com',
  timeoutMs: Number(process.env.TIME_LIMIT_MS)
}).then(
  (passedAs) => console.log(JSON.stringify({ passedAs })),
  (error) => {
    console.log(JSON.stringify({ refused: error.message }))
    process.exitCode = 1
  }
)
`

// A server that accepts every connection and never reads or writes.
async function silentServer () {
  const sockets = new Set()
  const server = net.createServer((socket) => { sockets.add(socket) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(resolve))
    }
  }
}

async function tokenServer () {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ value: 'example-oidc-token' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

function runClaimChild ({ tokenPort, claimPort }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', claimChild], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        AUTHORIZE_ACTOR_URL: pathToFileURL(path.join(root, 'src/authorize-actor.js')).href,
        CLAIM_URL: `https://127.0.0.1:${claimPort}/gate/claim`,
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${tokenPort}/token?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'example-request-token',
        TIME_LIMIT_MS: String(TIME_LIMIT_MS)
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const kill = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.on('close', (status) => {
      clearTimeout(kill)
      const lines = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
      resolve({ status, stderr, ...Object.assign({}, ...lines) })
    })
  })
}

describe('the claim hook\'s time limit, in a real Node process', () => {
  it('refuses at the time limit and ends at once when the runner\'s token service never answers', async () => {
    const token = await silentServer()
    const claim = await silentServer()
    try {
      const outcome = await runClaimChild({ tokenPort: token.port, claimPort: claim.port })
      expect(outcome.stderr).toBe('')
      expect(outcome.refused).toContain(`the one-time request id store could not be reached or answered (no answer within ${TIME_LIMIT_MS / 1000} seconds)`)
      expect(outcome.status).toBe(1)
      expect(outcome.elapsed).toBeGreaterThanOrEqual(TIME_LIMIT_MS - 100)
      expect(outcome.elapsed).toBeLessThan(TIME_LIMIT_MS + 3000)
    } finally {
      await Promise.all([token.close(), claim.close()])
    }
  }, 40000)

  it('refuses at the time limit, and ends by fetch\'s connect timeout, when the claim route never finishes its TLS handshake', async () => {
    const token = await tokenServer()
    const claim = await silentServer()
    try {
      const outcome = await runClaimChild({ tokenPort: token.port, claimPort: claim.port })
      expect(outcome.stderr).toBe('')
      expect(outcome.refused).toContain(`the one-time request id store could not be reached or answered (no answer within ${TIME_LIMIT_MS / 1000} seconds)`)
      expect(outcome.status).toBe(1)
      expect(outcome.elapsed).toBeGreaterThanOrEqual(TIME_LIMIT_MS - 100)
      expect(outcome.elapsed).toBeLessThan(TIME_LIMIT_MS + FETCH_CONNECT_TIMEOUT_MS + 3000)
    } finally {
      await Promise.all([token.close(), claim.close()])
    }
  }, 40000)
})
