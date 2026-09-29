import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes, workflowAndActionFiles } from './support/workflow-steps.js'

// Who each deployment ledger row names. These run the real "Record deployment
// in ledger" steps under bash (see support/workflow-steps.js), so what is
// checked is the item the fake aws was handed.
//
// The rule under test: Actor stays github.actor, the account that started the
// run's first attempt, and TriggeringActor is github.triggering_actor, the
// account that started this attempt. Every row carries both, so a re-run by
// another account names both people, and a first attempt names one person
// twice.

const WORKFLOW_FILES = {
  promote: '.github/workflows/promote.yml',
  rollback: '.github/workflows/rollback.yml',
  'deploy-candidate': '.github/workflows/deploy-candidate.yml'
}
const workflows = Object.fromEntries(Object.entries(WORKFLOW_FILES).map(([name, file]) => [name, loadYaml(file)]))

afterAll(removeFakes)

const STEP = 'Record deployment in ledger'
const LEDGER_TABLE = 'CruDeploymentLedger'
const SHA = 'c0ffee0000000000000000000000000000000001'

// Every ledger write, with the row it should be.
const SITES = [
  { workflow: 'promote', job: 'promote-gcp', environment: 'production', action: 'promote', provider: 'gcp' },
  { workflow: 'promote', job: 'promote-aws', environment: 'production', action: 'promote', provider: 'aws' },
  { workflow: 'rollback', job: 'rollback-gcp', environment: 'production', action: 'rollback', provider: 'gcp' },
  { workflow: 'rollback', job: 'rollback-aws', environment: 'production', action: 'rollback', provider: 'aws' },
  { workflow: 'deploy-candidate', job: 'deploy-candidate-gcp', environment: 'release-candidate', action: 'deploy', provider: 'gcp' },
  { workflow: 'deploy-candidate', job: 'deploy-candidate-aws', environment: 'release-candidate', action: 'deploy', provider: 'aws' },
  { workflow: 'deploy-candidate', job: 'verify-candidate-aws', environment: 'release-candidate', action: 'deploy', provider: 'aws' }
]

// What the runner would supply. `actor` is github.actor and `triggeringActor`
// is github.triggering_actor.
function context ({ actor, triggeringActor }) {
  return {
    'inputs.project-name': 'shop-web',
    'inputs.tag': 'candidate-2026-09-04-10123',
    'secrets.datadog-api-key': 'dd-test',
    'github.actor': actor,
    'github.triggering_actor': triggeringActor,
    'needs.lookup.outputs.type': 'ecs',
    'steps.resolve.outputs.tags': `candidate-2026-09-04-10123,sha-${SHA},release-2026-09-04-10123`,
    'steps.resolve.outputs.digest': 'sha256:' + 'd'.repeat(64),
    'steps.release.outputs.release': 'release-2026-09-04-10123',
    'steps.actual-release.outputs.tag': 'release-2026-09-03-10120',
    'steps.rollback-safety.outputs.verdict': 'safe',
    'steps.rollback-safety.outputs.reasons': '["no migration changes in this release"]'
  }
}

// Run one site's ledger step; resolve to the item it wrote. The tests run
// concurrently, so each passes its own `expect`.
async function rowFrom (expect, site, { actor, triggeringActor, attempt }) {
  const result = await runShellStep(findStep(workflows[site.workflow], site.job, STEP), {
    context: context({ actor, triggeringActor }),
    runnerEnv: { GITHUB_RUN_ATTEMPT: attempt }
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toMatch(/::warning/)
  expect(result.putItem).not.toBeNull()
  expect(result.putItem.table).toBe(LEDGER_TABLE)
  const { item } = result.putItem
  // The row is still the one this site writes, for this attempt.
  expect(item).toMatchObject({
    Project: { S: 'shop-web' },
    Environment: { S: site.environment },
    Action: { S: site.action },
    Provider: { S: site.provider },
    Sha: { S: SHA }
  })
  expect(item.EventAt.S).toMatch(new RegExp(`#9001-${attempt}$`))
  return item
}

// The step a path inside a parsed file belongs to: "<file>:<job>:<step>" in a
// workflow, "<file>:<step>" in a composite action. Anything outside a step (a
// job or workflow env, say) is named by its own path, so it can never match a
// covered step.
function locate (doc, file, at) {
  const stepName = (steps, index) => steps[index].name ?? `step ${index}`
  if (at[0] === 'jobs' && at[2] === 'steps' && typeof at[3] === 'number') {
    return `${file}:${at[1]}:${stepName(doc.jobs[at[1]].steps, at[3])}`
  }
  if (at[0] === 'runs' && at[1] === 'steps' && typeof at[2] === 'number') {
    return `${file}:${stepName(doc.runs.steps, at[2])}`
  }
  return `${file}:${at.join('.')}`
}

// Every place a file names the ledger table: in a run script however it is
// wrapped, in a with: or env: value, or anywhere else. Comments are not read.
function ledgerMentions (file) {
  const doc = loadYaml(file)
  const found = new Set()
  const walk = (node, at) => {
    if (typeof node === 'string') {
      if (node.includes(LEDGER_TABLE)) found.add(locate(doc, file, at))
    } else if (Array.isArray(node)) {
      node.forEach((value, index) => walk(value, [...at, index]))
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key.includes(LEDGER_TABLE)) found.add(locate(doc, file, [...at, key]))
        walk(value, [...at, key])
      }
    }
  }
  walk(doc, [])
  return [...found]
}

describe('the ledger writes', () => {
  it('are the only steps in any workflow or action that name the ledger table', () => {
    const files = workflowAndActionFiles()
    expect(files).toEqual(expect.arrayContaining(Object.values(WORKFLOW_FILES)))
    expect(files.some((file) => file.startsWith('actions/'))).toBe(true)
    expect(files.flatMap(ledgerMentions).sort())
      .toEqual(SITES.map((site) => `${WORKFLOW_FILES[site.workflow]}:${site.job}:${STEP}`).sort())
  })
})

describe.concurrent.each(SITES.map((site) => [site.job, site]))('%s', (_job, site) => {
  it('passes both accounts through env, and never puts an expression in the script', ({ expect }) => {
    const { step } = findStep(workflows[site.workflow], site.job, STEP)
    expect(step.env).toMatchObject({
      ACTOR: '${{ github.actor }}',
      TRIGGERING_ACTOR: '${{ github.triggering_actor }}'
    })
    expect(step.run).not.toMatch(/github\.(triggering_)?actor/)
    expect(step['continue-on-error']).toBe(true)
  })

  it('names both accounts on a re-run by another account', async ({ expect }) => {
    const item = await rowFrom(expect, site, { actor: 'first-starter', triggeringActor: 're-runner', attempt: '2' })
    expect(item.Actor).toEqual({ S: 'first-starter' })
    expect(item.TriggeringActor).toEqual({ S: 're-runner' })
  })

  it('writes TriggeringActor equal to Actor on a first attempt', async ({ expect }) => {
    const item = await rowFrom(expect, site, { actor: 'first-starter', triggeringActor: 'first-starter', attempt: '1' })
    expect(item.Actor).toEqual({ S: 'first-starter' })
    expect(item.TriggeringActor).toEqual({ S: 'first-starter' })
  })
})
