import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { root, loadYaml, findStep, runShellStep, removeFakes, workflowAndActionFiles } from './support/workflow-steps.js'

// The runner pastes a ${{ }} expression's value into a run: script before the
// shell reads it, so a value with quotes or $( ) in it would run as shell.
// Every step passes values through env: and reads them as shell variables.

afterAll(removeFakes)

// The starter workflows app repos copy from workflow-templates/.
function workflowTemplateFiles () {
  const dir = 'workflow-templates'
  if (!existsSync(path.join(root, dir))) return []
  return readdirSync(path.join(root, dir))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `${dir}/${name}`)
}

// Every step with a run: script, named "<file>:<job>:<step>" in a workflow and
// "<file>:<step>" in a composite action.
function runSteps (file) {
  const doc = loadYaml(file)
  const stepLists = Object.entries(doc.jobs ?? {}).map(([jobId, job]) => [`${file}:${jobId}`, job.steps ?? []])
  if (doc.runs?.steps) stepLists.push([file, doc.runs.steps])
  return stepLists.flatMap(([where, steps]) => steps
    .map((step, index) => ({ where: `${where}:${step.name ?? `step ${index}`}`, run: step.run }))
    .filter((step) => typeof step.run === 'string'))
}

describe('run: scripts', () => {
  it('never put an expression in the script, in any workflow, template or action', () => {
    const files = [...workflowAndActionFiles(), ...workflowTemplateFiles()]
    expect(files.some((file) => file.startsWith('.github/workflows/'))).toBe(true)
    const found = files.flatMap(runSteps).filter((step) => step.run.includes('${{')).map((step) => step.where)
    expect(found).toEqual([])
  })
})

// Rollback's release input becomes a tag output, so it must be one release
// name and nothing else. One trailing newline is allowed, as it always was. A
// newline anywhere else must not get through.
describe('rollback Normalize release tag', () => {
  const { job, step } = findStep(loadYaml('.github/workflows/rollback.yml'), 'lookup', 'Normalize release tag')
  const normalize = (release) => runShellStep({ job, step }, { context: { 'inputs.release': release } })

  it.each([
    ['release-2026-07-23-10056', 'release-2026-07-23-10056'],
    ['2026-07-23-10056', 'release-2026-07-23-10056'],
    ['release-10056', 'release-10056'],
    ['10056', 'release-10056'],
    ['10056\n', 'release-10056'],
    ['release-2026-07-23-10056\n', 'release-2026-07-23-10056']
  ])('accepts %j as %s', async (release, tag) => {
    const result = await normalize(release)
    expect(result.status, result.stdout).toBe(0)
    expect(result.outputs).toEqual({ tag })
  })

  it.each([
    '',
    'release-abc',
    '2026-07-23-',
    '10056\nfoo',
    'foo\n10056',
    '10056\ntag=release-1',
    '10056\n\n'
  ])('refuses %j', async (release) => {
    const result = await normalize(release)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toMatch(/::error::invalid release/)
    expect(result.outputs).toEqual({})
  })
})

// Callers of the AEM sync pass the literal text ${GITHUB_ACTOR} in the git
// name and email, and the old inline script let the shell expand it. The step
// still expands that one token, and no other shell text.
describe('aem-cloud-repo-sync set git config', () => {
  const { job, step } = findStep(loadYaml('.github/workflows/aem-cloud-repo-sync.yml'), 'aem-cloud-repo-sync', 'set git config')
  const CALLER_NAME = '${GITHUB_ACTOR}'
  const CALLER_EMAIL = '${GITHUB_ACTOR}@users.noreply.github.com'

  // Run the real step with its own global git config file, and read back the
  // name and email it set.
  async function gitIdentity ({ name, email, actor, env = {} }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'aem-git-'))
    const config = path.join(dir, 'gitconfig')
    try {
      const result = await runShellStep({ job, step }, {
        context: { 'inputs.user-name': name, 'inputs.user-email': email },
        runnerEnv: { GITHUB_ACTOR: actor, GIT_CONFIG_GLOBAL: config, ...env }
      })
      expect(result.status, result.stderr).toBe(0)
      const read = (key) => execFileSync('git', ['config', '--file', config, '--get', key], { encoding: 'utf8' }).replace(/\n$/, '')
      return { name: read('user.name'), email: read('user.email') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.each([
    ['octo-dev', 'octo-dev@users.noreply.github.com'],
    ['dependabot[bot]', 'dependabot[bot]@users.noreply.github.com']
  ])('fills in the actor %s from the caller values', async (actor, email) => {
    expect(await gitIdentity({ name: CALLER_NAME, email: CALLER_EMAIL, actor })).toEqual({ name: actor, email })
  })

  it('passes a value without the token through unchanged', async () => {
    expect(await gitIdentity({ name: 'Jane Doe', email: 'jane@example.org', actor: 'octo-dev' }))
      .toEqual({ name: 'Jane Doe', email: 'jane@example.org' })
  })

  it('does not expand any other shell text', async () => {
    const name = '$(whoami) ${HOME} $GITHUB_ACTOR'
    const email = '${CLOUD_REPOSITORY_PASSWORD}@example.org'
    expect(await gitIdentity({ name, email, actor: 'octo-dev', env: { CLOUD_REPOSITORY_PASSWORD: 'not-this' } }))
      .toEqual({ name, email })
  })
})
