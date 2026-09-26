import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as esbuild from 'esbuild'

// The actions with production checks are bundled from src/entry/<name>.js,
// which always calls run(). Their modules never check VITEST, so no value in
// the environment can turn a check off. These tests bundle each entry the way
// esbuild.config.mjs does and run it with VITEST set.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIGEST = 'sha256:' + 'a'.repeat(64)

const ACTIONS = {
  'authorize-actor': {
    inputs: { OPERATION: 'promote', REPOSITORY: 'CruGlobal/some-app' },
    error: '::error::no github-token was given, so the account that started this run attempt cannot be checked; refusing to promote'
  },
  deploy: {
    inputs: { TYPE: 'cloudrun', 'PROJECT-NAME': 'app', ENVIRONMENT: 'production', IMAGE: `us-docker.pkg.dev/p/app/app@${DIGEST}` },
    error: '::error::refusing to deploy to production: no authorize-actor check passed earlier in this job'
  },
  'tag-image': {
    inputs: { TYPE: 'cloudrun', 'PROJECT-NAME': 'app', DIGEST, TAG: 'release-10038' },
    error: '::error::refusing to add the release tag release-10038: no authorize-actor check passed earlier in this job'
  },
  'flightdeck-release-event': {
    inputs: { TOKEN: 'tok', PROJECT: 'APP', ENVIRONMENT: 'production', KIND: 'deploy' },
    error: '::error::refusing to post a release event for production: no authorize-actor check passed earlier in this job'
  }
}

let outDir
beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), 'entries-'))
  await Promise.all(Object.keys(ACTIONS).map((name) => esbuild.build({
    entryPoints: [path.join(root, 'src/entry', `${name}.js`)],
    bundle: true,
    platform: 'node',
    target: 'node24',
    outfile: path.join(outDir, `${name}.js`),
    logLevel: 'silent'
  })))
}, 120000)

afterAll(() => rmSync(outDir, { recursive: true, force: true }))

describe.each(Object.entries(ACTIONS))('%s', (name, { inputs, error }) => {
  it('is built from its entry file', () => {
    const config = readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8')
    expect(config).toContain(`'./src/entry/${name}.js': '${name}'`)
    const entry = readFileSync(path.join(root, 'src/entry', `${name}.js`), 'utf8')
    expect(entry).toMatch(/^run\(\)$/m)
    expect(entry).not.toMatch(/VITEST|process\.env|if \(/)
    expect(readFileSync(path.join(root, 'src', `${name}.js`), 'utf8')).not.toContain('VITEST')
  })

  it('still runs its check when VITEST is set', () => {
    // A clean environment: no runner files, no marker, VITEST on.
    const env = { PATH: process.env.PATH, VITEST: '1', VITEST_WORKER_ID: '1', GITHUB_RUN_ATTEMPT: '1' }
    for (const [key, value] of Object.entries(inputs)) env[`INPUT_${key}`] = value
    const result = spawnSync(process.execPath, [path.join(outDir, `${name}.js`)], { env, encoding: 'utf8', timeout: 30000 })
    expect(result.stdout).toContain(error)
    expect(result.status).toBe(1)
  })
})
