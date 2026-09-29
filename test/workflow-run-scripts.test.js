import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes, workflowAndActionFiles } from './support/workflow-steps.js'

// The runner pastes a ${{ }} expression's value into a run: script before the
// shell reads it, so a value with quotes or $( ) in it would run as shell.
// Every step passes values through env: and reads them as shell variables.

afterAll(removeFakes)

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
  it('never put an expression in the script, in any workflow or action', () => {
    const files = workflowAndActionFiles()
    expect(files.some((file) => file.startsWith('.github/workflows/'))).toBe(true)
    const found = files.flatMap(runSteps).filter((step) => step.run.includes('${{')).map((step) => step.where)
    expect(found).toEqual([])
  })
})

// Rollback's release input becomes a tag output, so it must be one release
// name and nothing else. A value with a newline in it must not get through.
describe('rollback Normalize release tag', () => {
  const { job, step } = findStep(loadYaml('.github/workflows/rollback.yml'), 'lookup', 'Normalize release tag')
  const normalize = (release) => runShellStep({ job, step }, { context: { 'inputs.release': release } })

  it.each([
    ['release-2026-07-23-10056', 'release-2026-07-23-10056'],
    ['2026-07-23-10056', 'release-2026-07-23-10056'],
    ['release-10056', 'release-10056'],
    ['10056', 'release-10056']
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
    '10056\ntag=release-1'
  ])('refuses %j', async (release) => {
    const result = await normalize(release)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toMatch(/::error::invalid release/)
    expect(result.outputs).toEqual({})
  })
})
