import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { basicCredential, cutHotfix, gitIn, tokenPushEnv } from '../src/v2/hotfix.js'
import { PROJECT, RELEASE, fakeLedger, isolateGitConfig, ledgerRow, standardApp } from './support/git-fixture.js'

// Which credential git really sends when the cut pushes with push-token.
//
// actions/checkout saves its token as an http.<server>/.extraheader, in a file
// under $RUNNER_TEMP that the checkout's config pulls in with includeIf. git
// sends every extraheader that matches the remote, so a push-token added on
// top of it would go out as a second Authorization header, and GitHub would
// act on the first. These tests stand a local server in for GitHub: git
// http-backend behind a server that records the Authorization headers of
// every request and refuses the ones a test does not allow. The runner's
// checkout is a clone over HTTP with its token saved the way checkout saves
// it. Nothing leaves the machine, and every token is made up.

vi.setConfig({ testTimeout: 60000 })
beforeAll(isolateGitConfig)

const CHECKOUT_TOKEN = 'example-checkout-token'
const APP_TOKEN = 'example-app-token'
// What git is told to send (an extraheader line), and what the server then
// gets as the Authorization header's value.
const header = (token) => `AUTHORIZATION: basic ${basicCredential(token)}`
const sent = (token) => `basic ${basicCredential(token)}`
const CHECKOUT_HEADER = header(CHECKOUT_TOKEN)
const CHECKOUT_SENT = sent(CHECKOUT_TOKEN)
const APP_SENT = sent(APP_TOKEN)

const cleanups = []
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup() })

// git http-backend serving every repository under `root`, behind a server
// that lets a request through only when `allow({ push, authorization })`
// says so (`authorization` is every Authorization header the request
// carried), and answers 403, or 401 when `unauthorized` is set, otherwise.
async function gitServer (root, allow) {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const authorization = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'authorization') authorization.push(req.rawHeaders[i + 1])
    }
    const service = url.searchParams.get('service') ?? path.basename(url.pathname)
    const push = service === 'git-receive-pack'
    requests.push({ push, authorization })
    const verdict = allow({ push, authorization })
    if (verdict !== true) {
      req.resume()
      res.writeHead(verdict === 401 ? 401 : 403, verdict === 401 ? { 'WWW-Authenticate': 'Basic realm="example"' } : {})
      res.end('Permission denied\n')
      return
    }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        // http-backend takes pushes only from a user the server logged in.
        REMOTE_USER: 'example-user',
        REMOTE_ADDR: '127.0.0.1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: req.headers['git-protocol'] ?? ''
      }
    })
    req.pipe(child.stdin)
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('close', () => {
      const out = Buffer.concat(chunks)
      const end = out.indexOf('\r\n\r\n')
      if (end < 0) {
        res.writeHead(500)
        res.end()
        return
      }
      let status = 200
      const headers = {}
      for (const line of out.subarray(0, end).toString().split('\r\n')) {
        const at = line.indexOf(':')
        const name = line.slice(0, at).trim()
        const value = line.slice(at + 1).trim()
        if (name.toLowerCase() === 'status') status = parseInt(value, 10)
        else headers[name] = value
      }
      res.writeHead(status, headers)
      res.end(out.subarray(end + 4))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => server.close(resolve)))
  return { origin: `http://127.0.0.1:${server.address().port}/`, requests }
}

const exactly = (wanted) => (authorization) => authorization.length === 1 && authorization[0] === wanted

// The usual app (see support/git-fixture.js), served over HTTP, and a
// runner's checkout of it: a clone whose token is saved the way
// actions/checkout saves it, in a file outside the clone pulled in with
// includeIf. `extra(url)` gives lines to add to that file, for the repo at
// `url`. `allow` is the server's rule.
async function checkout ({ allow, extra = () => '' }) {
  const fx = standardApp()
  cleanups.push(() => fx.cleanup())
  const server = await gitServer(fx.root, allow)
  const url = `${server.origin}origin.git`
  const runner = path.join(fx.root, 'runner')
  // Not execFileSync: the server runs in this process, and a blocking call
  // would stop it answering.
  await promisify(execFile)('git', ['-c', `http.${server.origin}.extraheader=${CHECKOUT_HEADER}`, 'clone', '--quiet', url, runner])
  const credentials = path.join(mkdtempSync(path.join(tmpdir(), 'runner-temp-')), 'git-credentials-example.config')
  cleanups.push(() => rmSync(path.dirname(credentials), { recursive: true, force: true }))
  writeFileSync(credentials, `[http "${server.origin}"]\n\textraheader = ${CHECKOUT_HEADER}\n${extra(url)}`)
  execFileSync('git', ['config', '--local', `includeIf.gitdir:${realpathSync(path.join(runner, '.git'))}.path`, credentials], { cwd: runner })
  // The include is live: this is what every git command in the clone sends.
  const saved = execFileSync('git', ['config', '--get-all', `http.${server.origin}.extraheader`], { cwd: runner, encoding: 'utf8' }).trim()
  expect(saved).toBe(CHECKOUT_HEADER)
  server.requests.length = 0
  return { fx, runner, credentials, url, requests: server.requests }
}

const cut = ({ fx, runner }, pushToken) => cutHotfix({
  git: gitIn(runner),
  project: PROJECT,
  commit: fx.fix,
  expectedRelease: RELEASE,
  readLedger: fakeLedger([ledgerRow(RELEASE, fx.release)]).readLedger,
  pushToken
})

const pushes = (requests) => requests.filter((request) => request.push)
const reads = (requests) => requests.filter((request) => !request.push)

describe('pushing with push-token', () => {
  it('fetches with the checkout\'s token and pushes with the App\'s alone', async () => {
    const app = await checkout({
      allow: ({ push, authorization }) => push ? exactly(APP_SENT)(authorization) : exactly(CHECKOUT_SENT)(authorization)
    })
    const result = await cut(app, APP_TOKEN)
    expect(result).toMatchObject({ pushed: true, branch: `hotfix/${RELEASE}` })
    expect(app.fx.refs()[`refs/heads/hotfix/${RELEASE}`]).toBe(result.head)
    expect(reads(app.requests).length).toBeGreaterThan(0)
    for (const request of reads(app.requests)) expect(request.authorization).toEqual([CHECKOUT_SENT])
    expect(pushes(app.requests).length).toBeGreaterThan(0)
    for (const request of pushes(app.requests)) expect(request.authorization).toEqual([APP_SENT])
    // Nothing of the App's token is written into the checkout.
    for (const file of [path.join(app.runner, '.git', 'config'), app.credentials]) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toContain(APP_TOKEN)
      expect(text).not.toContain(basicCredential(APP_TOKEN))
    }
  })

  // A header saved for the repo's own URL matches it more closely than the
  // server's, so it is the one an override has to beat.
  it('sets aside a saved header that names the repo itself, not only the server', async () => {
    const other = header('example-other-token')
    const app = await checkout({
      allow: ({ push, authorization }) => push ? exactly(APP_SENT)(authorization) : true,
      extra: (url) => `[http "${url}"]\n\textraheader = ${other}\n`
    })
    expect(execFileSync('git', ['config', '--get-all', `http.${app.url}.extraheader`], { cwd: app.runner, encoding: 'utf8' }).trim()).toBe(other)
    const result = await cut(app, APP_TOKEN)
    expect(result.pushed).toBe(true)
    for (const request of pushes(app.requests)) expect(request.authorization).toEqual([APP_SENT])
  })

  it('pushes with the checkout\'s token, as before, when no push-token is given', async () => {
    const app = await checkout({ allow: ({ authorization }) => exactly(CHECKOUT_SENT)(authorization) })
    const result = await cut(app, '')
    expect(result.pushed).toBe(true)
    expect(pushes(app.requests).length).toBeGreaterThan(0)
    for (const request of pushes(app.requests)) expect(request.authorization).toEqual([CHECKOUT_SENT])
  })

  it('fails when the App may not push, and never tries the checkout\'s token instead', async () => {
    const app = await checkout({ allow: ({ push }) => !push })
    const before = app.fx.refs()
    const error = await cut(app, APP_TOKEN).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(new RegExp(`^the app repo refused the push of hotfix/${RELEASE} with push-token, the GitHub App's token \\(.*403.*\\)\\. The App must be installed on the app repo with Contents: Read and write, its token must not have expired, and no ruleset may stop the App creating or updating hotfix/\\* branches\\. Nothing was pushed, and the push was not tried with any other token$`))
    expect(app.fx.refs()).toEqual(before)
    expect(pushes(app.requests).length).toBeGreaterThan(0)
    for (const request of pushes(app.requests)) expect(request.authorization).toEqual([APP_SENT])
  })

  // A token GitHub does not take (expired, revoked) answers 401, which makes
  // git ask its credential helpers. One that knows the checkout's token must
  // not get the chance to push with it.
  it('fails when the App\'s token is not taken, without asking a credential helper', async () => {
    const app = await checkout({ allow: ({ push }) => push ? 401 : true })
    const asked = path.join(app.fx.root, 'helper-asked')
    execFileSync('git', ['config', '--local', 'credential.helper', `!f() { touch '${asked}'; echo username=x-access-token; echo password=${CHECKOUT_TOKEN}; }; f`], { cwd: app.runner })
    const before = app.fx.refs()
    const error = await cut(app, APP_TOKEN).catch((e) => e)
    expect(error.message).toMatch(new RegExp(`^the app repo refused the push of hotfix/${RELEASE} with push-token, the GitHub App's token \\(`))
    expect(error.message).toMatch(/Nothing was pushed, and the push was not tried with any other token$/)
    expect(app.fx.refs()).toEqual(before)
    expect(() => readFileSync(asked)).toThrow()
    for (const request of pushes(app.requests)) expect(request.authorization).toEqual([APP_SENT])
  })
})

describe('tokenPushEnv', () => {
  it('names the remote\'s push URL, clears the saved headers, and adds the token\'s, in the environment only', async () => {
    const fx = standardApp()
    cleanups.push(() => fx.cleanup())
    const runner = fx.clone()
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.example.test/example-org/example-app'], { cwd: runner })
    execFileSync('git', ['remote', 'set-url', '--push', 'origin', 'https://github.example.test/example-org/example-app-push'], { cwd: runner })
    const key = 'http.https://github.example.test/example-org/example-app-push.extraheader'
    expect(await tokenPushEnv(gitIn(runner), APP_TOKEN)).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: key,
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: key,
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${APP_TOKEN}`).toString('base64')}`,
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: ''
    })
  })
})
