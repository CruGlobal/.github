import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// The checks that let an automation account promote one exact candidate:
// production must still run the release it saw, the candidate must be the one
// it approved, and, when it asks, the rollback-safety verdict must be safe.
// These run the real steps from promote.yml under bash (see
// support/workflow-steps.js), in both provider jobs. The AWS job serves ECS
// and Lambda alike, so it covers both.
//
// A refusal is an ::error whose title is a fixed reason word, and it sets
// PROMOTE_REFUSED for the job's failure notice. With none of the inputs set,
// every check is silent and lets the promote through, as before.

const workflow = loadYaml('.github/workflows/promote.yml')
afterAll(removeFakes)

const JOBS = ['promote-gcp', 'promote-aws']
const STALE = 'Refuse a stale promote'
const CANDIDATE = 'Refuse a moved candidate'
const SAFE = 'Refuse a promote that is not rollback-safe'
const GUARDS = [STALE, CANDIDATE, SAFE]

const PROJECT = 'example-app'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const SHA = 'c0ffee0000000000000000000000000000000002'
const LIVE = 'release-2026-10-20-10140'
const NEXT = 'candidate-2026-10-21-10150'
const NEWER = 'candidate-2026-10-21-10151'

const row = (revision) => ({ Project: PROJECT, Environment: 'production', Action: 'promote', Revision: revision })
const ledgerOf = (...revisions) => ({ Items: revisions.map(row) })

// What the runner would supply. Unset inputs are what GitHub gives a caller
// that does not pass them: '' for the strings and false for the boolean.
function context (overrides = {}) {
  return {
    'inputs.project-name': PROJECT,
    'secrets.datadog-api-key': 'dd-test',
    'inputs.expected-current-release': '',
    'inputs.expected-candidate': '',
    'inputs.require-rollback-safe': 'false',
    'steps.release.outputs.candidate': NEXT,
    'steps.release.outputs.release': 'release-2026-10-21-10150',
    'steps.resolve.outputs.tags': `${NEXT},sha-${SHA}`,
    'steps.resolve.outputs.digest': DIGEST,
    'steps.rollback-safety.outputs.verdict': 'safe',
    'steps.rollback-safety.outputs.reasons': '["no migration changes in this release"]',
    ...overrides
  }
}

// The workflow command lines a step printed, e.g. "::error title=x::message".
const annotations = (stdout) => stdout.split('\n').filter((line) => line.startsWith('::'))

async function runGuard (job, name, { overrides, ...options } = {}) {
  return runShellStep(findStep(workflow, job, name), { context: context(overrides), ...options })
}

// A refusal: the step fails, prints exactly one error, titled with the reason
// word, and leaves the word in PROMOTE_REFUSED for the failure notice.
function expectRefused (expect, result, reason, message) {
  expect(result.status, result.stdout).toBe(1)
  const errors = annotations(result.stdout).filter((line) => line.startsWith('::error'))
  expect(errors).toHaveLength(1)
  expect(errors[0].startsWith(`::error title=${reason}::`), errors[0]).toBe(true)
  if (message) expect(errors[0]).toMatch(message)
  expect(result.env).toEqual({ PROMOTE_REFUSED: reason })
  expect(result.outputs).toEqual({})
}

function expectPassed (expect, result) {
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(annotations(result.stdout).filter((line) => !line.startsWith('::notice::'))).toEqual([])
  expect(result.env).toEqual({})
}

describe.concurrent.each(JOBS)('%s: Refuse a stale promote', (job) => {
  it('does nothing when expected-current-release is unset, and does not read the ledger', async ({ expect }) => {
    const result = await runGuard(job, STALE, { ledgerFails: true })
    expectPassed(expect, result)
    expect(annotations(result.stdout)).toEqual([])
  })

  it.for([
    LIVE,
    '2026-10-20-10140',
    `  ${LIVE}\n`
  ])('goes ahead when production still runs the expected release (%j)', async (expected, { expect }) => {
    const result = await runGuard(job, STALE, { overrides: { 'inputs.expected-current-release': expected }, ledger: ledgerOf(LIVE, 'release-2026-10-19-10130') })
    expectPassed(expect, result)
    expect(result.stdout).toContain(`::notice::production is still running ${LIVE}, as expected`)
  })

  it('refuses when production moved to another release', async ({ expect }) => {
    const result = await runGuard(job, STALE, { overrides: { 'inputs.expected-current-release': 'release-2026-10-19-10130' }, ledger: ledgerOf(LIVE, 'release-2026-10-19-10130') })
    expectRefused(expect, result, 'production_moved', `production is now running ${LIVE}, not release-2026-10-19-10130`)
  })

  it('refuses a bare build number against a dated release, and says to pass the full tag', async ({ expect }) => {
    const result = await runGuard(job, STALE, { overrides: { 'inputs.expected-current-release': '10140' }, ledger: ledgerOf(LIVE) })
    expectRefused(expect, result, 'production_moved', /is a bare build number, but production's release tag is dated .*pass the full tag/)
  })

  it.for(['candidate-2026-10-20-10140', 'release-', 'latest', '10140\nfoo'])('refuses an expected-current-release that is not a release tag (%j)', async (expected, { expect }) => {
    const result = await runGuard(job, STALE, { overrides: { 'inputs.expected-current-release': expected }, ledger: ledgerOf(LIVE) })
    expectRefused(expect, result, 'production_moved', /invalid expected-current-release/)
  })

  it('keeps an input with a line break on the error line', async ({ expect }) => {
    const result = await runGuard(job, STALE, { overrides: { 'inputs.expected-current-release': '10140\n::warning::injected' }, ledger: ledgerOf(LIVE) })
    expectRefused(expect, result, 'production_moved', /invalid expected-current-release '10140 ::warning::injected'/)
    expect(annotations(result.stdout)).toHaveLength(1)
  })

  it.for([
    ['the ledger cannot be read', { ledgerFails: true }, /could not read the deployment ledger for example-app/],
    ['the ledger answers with something that is not JSON', { ledger: '<html>bad gateway</html>' }, /unexpected response/],
    ['the ledger answers without an Items array', { ledger: { message: 'nope' } }, /unexpected response/],
    ['production has no ledger rows (a first promote)', { ledger: { Items: [] } }, /has no production rows/],
    ['the newest row has no Revision', { ledger: { Items: [{ Project: PROJECT }] } }, /has no Revision/]
  ])('fails closed when %s', async ([, options, message], { expect }) => {
    const result = await runGuard(job, STALE, { overrides: { 'inputs.expected-current-release': LIVE }, ...options })
    expectRefused(expect, result, 'production_moved', message)
    expect(result.stdout).toMatch(/cannot confirm production is still running release-2026-10-20-10140; refusing to promote/)
  })
})

describe.concurrent.each(JOBS)('%s: Refuse a moved candidate', (job) => {
  it('does nothing when expected-candidate is unset', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'steps.release.outputs.candidate': NEWER } })
    expectPassed(expect, result)
    expect(annotations(result.stdout)).toEqual([])
  })

  it.for([NEXT, '2026-10-21-10150', ` ${NEXT}\n`])('goes ahead when the candidate is the expected one (%j)', async (expected, { expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'inputs.expected-candidate': expected } })
    expectPassed(expect, result)
    expect(result.stdout).toContain(`::notice::this promote ships ${NEXT} (digest ${DIGEST}), as expected`)
  })

  it('refuses when a newer candidate reached release-candidate', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, {
      overrides: {
        'inputs.expected-candidate': NEXT,
        'steps.release.outputs.candidate': NEWER,
        'steps.release.outputs.release': 'release-2026-10-21-10151',
        'steps.resolve.outputs.tags': `${NEWER},sha-${SHA}`
      }
    })
    expectRefused(expect, result, 'candidate_moved', `the release candidate is now ${NEWER} (digest ${DIGEST}), not ${NEXT}`)
  })

  it('matches the whole tag, so a shorter build number never matches', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'inputs.expected-candidate': 'candidate-2026-10-21-1015' } })
    expectRefused(expect, result, 'candidate_moved', /not candidate-2026-10-21-1015,/)
  })

  it('refuses a bare build number against a dated candidate, and says to pass the full tag', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'inputs.expected-candidate': '10150' } })
    expectRefused(expect, result, 'candidate_moved', /is a bare build number, but the candidate tag is dated .*pass the full tag/)
  })

  it('refuses when the digest also carries the expected tag but the release would be named after another one', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, {
      overrides: {
        'inputs.expected-candidate': NEWER,
        'steps.resolve.outputs.tags': `${NEXT},${NEWER},sha-${SHA}`
      }
    })
    expectRefused(expect, result, 'candidate_moved', `carries ${NEWER} but also ${NEXT}, and this promote would name the release release-2026-10-21-10150 after ${NEXT}`)
  })

  it('refuses when it cannot tell which candidate would ship', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'inputs.expected-candidate': NEXT, 'steps.release.outputs.candidate': '' } })
    expectRefused(expect, result, 'candidate_moved', /could not tell which candidate this promote would ship/)
  })

  it.for(['release-2026-10-21-10150', 'candidate-', 'sha-abc', '10150 10151'])('refuses an expected-candidate that is not a candidate tag (%j)', async (expected, { expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'inputs.expected-candidate': expected } })
    expectRefused(expect, result, 'candidate_moved', /invalid expected-candidate/)
  })

  it('keeps an input with a line break on the error line', async ({ expect }) => {
    const result = await runGuard(job, CANDIDATE, { overrides: { 'inputs.expected-candidate': `${NEXT}\n::warning::injected` } })
    expectRefused(expect, result, 'candidate_moved', /invalid expected-candidate 'candidate-2026-10-21-10150 ::warning::injected'/)
    expect(annotations(result.stdout)).toHaveLength(1)
  })
})

describe.concurrent.each(JOBS)('%s: Refuse a promote that is not rollback-safe', (job) => {
  it.for(['unsafe', 'unclassified', ''])('keeps a %j verdict advisory when require-rollback-safe is false', async (verdict, { expect }) => {
    const result = await runGuard(job, SAFE, { overrides: { 'steps.rollback-safety.outputs.verdict': verdict } })
    expectPassed(expect, result)
    expect(annotations(result.stdout)).toEqual([])
  })

  it('goes ahead on a safe verdict when it is required', async ({ expect }) => {
    const result = await runGuard(job, SAFE, { overrides: { 'inputs.require-rollback-safe': 'true' } })
    expectPassed(expect, result)
    expect(result.stdout).toContain('::notice::the rollback-safety verdict is safe (no migration changes in this release)')
  })

  it('goes ahead for an app that declares no migrations, even on its first promote', async ({ expect }) => {
    // The classifier answers safe for a declared-none app without a baseline.
    const result = await runGuard(job, SAFE, { overrides: { 'inputs.require-rollback-safe': 'true', 'steps.rollback-safety.outputs.reasons': '["no database migrations"]' } })
    expectPassed(expect, result)
  })

  it('refuses an unsafe verdict and names the reasons', async ({ expect }) => {
    const result = await runGuard(job, SAFE, {
      overrides: {
        'inputs.require-rollback-safe': 'true',
        'steps.rollback-safety.outputs.verdict': 'unsafe',
        'steps.rollback-safety.outputs.reasons': '["0007_drop.sql: drops a column; a rollback would not restore it","0008_x.sql: renames an object","third"]'
      }
    })
    expectRefused(expect, result, 'not_rollback_safe', 'verdict for this promote is unsafe (0007_drop.sql: drops a column; a rollback would not restore it; 0008_x.sql: renames an object)')
    expect(result.stdout).not.toContain('third')
  })

  it('refuses an unclassified verdict, such as a first promote with no baseline', async ({ expect }) => {
    const result = await runGuard(job, SAFE, {
      overrides: {
        'inputs.require-rollback-safe': 'true',
        'steps.rollback-safety.outputs.verdict': 'unclassified',
        'steps.rollback-safety.outputs.reasons': '["no production baseline"]'
      }
    })
    expectRefused(expect, result, 'not_rollback_safe', /unclassified \(no production baseline\), and require-rollback-safe counts that as not safe/)
  })

  it.for([
    ['no verdict (the classifier step failed)', '', /gave no verdict/],
    ['a verdict it does not know', 'maybe', /unknown verdict 'maybe'/]
  ])('refuses %s', async ([, verdict, message], { expect }) => {
    const result = await runGuard(job, SAFE, { overrides: { 'inputs.require-rollback-safe': 'true', 'steps.rollback-safety.outputs.verdict': verdict, 'steps.rollback-safety.outputs.reasons': '' } })
    expectRefused(expect, result, 'not_rollback_safe', message)
  })

  it('keeps reasons on the error line, so a reason cannot start a workflow command of its own', async ({ expect }) => {
    const result = await runGuard(job, SAFE, {
      overrides: {
        'inputs.require-rollback-safe': 'true',
        'steps.rollback-safety.outputs.verdict': 'unsafe',
        'steps.rollback-safety.outputs.reasons': JSON.stringify(['db/migrate/x\n::warning::injected.rb: unsupported migration format'])
      }
    })
    expectRefused(expect, result, 'not_rollback_safe')
    expect(annotations(result.stdout)).toHaveLength(1)
  })

  it.for(['true', 'false'])('keeps the verdict on one line too (require-rollback-safe %s)', async (requireSafe, { expect }) => {
    const result = await runGuard(job, SAFE, {
      overrides: {
        'inputs.require-rollback-safe': requireSafe,
        'steps.rollback-safety.outputs.verdict': 'maybe\n::warning::injected'
      }
    })
    expect(annotations(result.stdout).filter((line) => line.startsWith('::warning'))).toEqual([])
  })
})

// A caller that sends none of the new inputs (every wrapper and CLI until
// they opt in) runs exactly as before: each check is silent and goes ahead,
// whatever the ledger, the candidate or the verdict say.
describe.concurrent.each(JOBS)('%s: a caller that sends none of the inputs', (job) => {
  it.for(GUARDS)('%s lets the promote through without a word', async (name, { expect }) => {
    const result = await runGuard(job, name, {
      overrides: { 'steps.release.outputs.candidate': NEWER, 'steps.rollback-safety.outputs.verdict': 'unsafe' },
      ledgerFails: true
    })
    expectPassed(expect, result)
    expect(annotations(result.stdout)).toEqual([])
  })
})

// An allowlisted automation account may only promote a candidate it names,
// with a safe verdict required. lookup refuses it otherwise. A person's
// promote never meets this check.
describe.concurrent('lookup: Refuse an automation promote that does not name its candidate', () => {
  const NAME = 'Refuse an automation promote that does not name its candidate'
  const check = (passedAs, { candidate = NEXT, requireSafe = 'true' } = {}) => runShellStep(findStep(workflow, 'lookup', NAME), {
    context: {
      'steps.authz.outputs.passed-as': passedAs,
      'inputs.expected-candidate': candidate,
      'inputs.require-rollback-safe': requireSafe
    }
  })

  it('lets an automation promote through when it names its candidate and requires a safe verdict', async ({ expect }) => {
    const result = await check('automation')
    expect(result.status, result.stdout).toBe(0)
    expect(annotations(result.stdout)).toEqual([])
  })

  it.for([
    ['expected-candidate is missing', { candidate: '' }, /does not set expected-candidate;/],
    ['expected-candidate is blank', { candidate: ' \n' }, /does not set expected-candidate;/],
    ['require-rollback-safe is off', { requireSafe: 'false' }, /does not set require-rollback-safe: true;/],
    ['both are missing', { candidate: '', requireSafe: 'false' }, /does not set expected-candidate and require-rollback-safe: true;/]
  ])('refuses an automation promote when %s', async ([, options, message], { expect }) => {
    const result = await check('automation', options)
    expect(result.status).toBe(1)
    const errors = annotations(result.stdout)
    expect(errors).toHaveLength(1)
    expect(errors[0].startsWith('::error title=actor_not_allowed::'), errors[0]).toBe(true)
    expect(errors[0]).toMatch(message)
  })

  it.for(['push-access', ''])('leaves a promote that passed as %j alone, whatever it sets', async (passedAs, { expect }) => {
    const result = await check(passedAs, { candidate: '', requireSafe: 'false' })
    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('runs right after the authz check, reads how it passed, and cannot be skipped', () => {
    const steps = workflow.jobs.lookup.steps
    const authz = steps.findIndex((step) => step.name === 'Authorize actor')
    expect(steps[authz].id).toBe('authz')
    const step = steps[authz + 1]
    expect(step.name).toBe(NAME)
    expect(step.env.PASSED_AS).toBe('${{ steps.authz.outputs.passed-as }}')
    expect(step.if).toBeUndefined()
    expect(step['continue-on-error']).toBeUndefined()
  })
})

// The stage-less digest check refuses before production changes, so it
// carries a reason word too.
describe.concurrent('promote-aws: Confirm candidate digest is unchanged (stage-less)', () => {
  const confirm = (ledgerDigest) => runShellStep(findStep(workflow, 'promote-aws', 'Confirm candidate digest is unchanged (stage-less)'), {
    context: {
      'inputs.project-name': PROJECT,
      'secrets.datadog-api-key': 'dd-test',
      'steps.ledger-candidate.outputs.digest': ledgerDigest,
      'steps.resolve.outputs.digest': DIGEST,
      'steps.ledger-candidate.outputs.revision': NEXT
    }
  })

  it('refuses a re-pointed tag as candidate_moved', async ({ expect }) => {
    const result = await confirm('sha256:' + 'b'.repeat(64))
    expectRefused(expect, result, 'candidate_moved', /Candidate digest moved: example-app's tag candidate-2026-10-21-10150 now resolves to/)
  })

  it('goes ahead when the digest is the verified one', async ({ expect }) => {
    const result = await confirm(DIGEST)
    expect(result.status).toBe(0)
    expect(result.env).toEqual({})
  })
})

// Where the checks sit. A refusal must come before anything in production
// changes, and the production checks must run inside the production lock.
describe('promote guard wiring', () => {
  const inputs = workflow.on.workflow_call.inputs

  it('declares the inputs as optional, each defaulting to off', () => {
    expect(inputs['trusted-automation-actor-ids']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(inputs['expected-candidate']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(inputs['expected-current-release']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(inputs['require-rollback-safe']).toMatchObject({ type: 'boolean', required: false, default: false })
  })

  // Steps that change production, or write a record that later counts as
  // trusted. Every guard must come before the first of them.
  const changesProduction = (step) =>
    ['./cru-github-actions/actions/deploy', './cru-github-actions/actions/tag-image', './cru-github-actions/actions/flightdeck-release-event'].includes(step.uses) ||
    /put-item|gh api|chat\.postMessage|api\.datadoghq\.com/.test(step.run ?? '')

  describe.each(JOBS)('%s', (job) => {
    const { steps, concurrency } = workflow.jobs[job]
    const at = (name) => {
      const index = steps.findIndex((step) => step.name === name)
      expect(index, name).toBeGreaterThanOrEqual(0)
      return index
    }

    it('runs every guard inside the production lock, with no way to skip it', () => {
      expect(concurrency).toEqual({ group: 'production-${{ inputs.project-name }}', 'cancel-in-progress': false })
      for (const name of GUARDS) {
        const step = steps[at(name)]
        expect(step.if, name).toBeUndefined()
        expect(step['continue-on-error'], name).toBeUndefined()
      }
    })

    it('checks production right after the authz check, before any credential is set up', () => {
      expect(steps[1].name).toBe('Authorize the account that started this attempt')
      expect(at(STALE)).toBe(2)
    })

    it('checks the candidate the deploy ships, after it is resolved and named', () => {
      expect(at(CANDIDATE)).toBeGreaterThan(at('Determine release number from candidate'))
      const resolve = steps.findIndex((step) => step.id === 'resolve')
      expect(at(CANDIDATE)).toBeGreaterThan(resolve)
      expect(steps[at('Deploy to production')].with.image).toBe('${{ steps.resolve.outputs.image }}')
    })

    it('checks the verdict after it is classified', () => {
      expect(at(SAFE)).toBeGreaterThan(at('Classify rollback safety'))
      expect(steps[at(SAFE)].env.VERDICT).toBe('${{ steps.rollback-safety.outputs.verdict }}')
    })

    it('refuses before anything in production changes, including the deploy\'s migration', () => {
      const lastGuard = Math.max(...GUARDS.map(at))
      const firstChange = steps.findIndex(changesProduction)
      expect(steps[firstChange].name).toBe('Deploy to production')
      expect(lastGuard).toBeLessThan(firstChange)
      if (job === 'promote-gcp') expect(lastGuard).toBeLessThan(at('Configure GCP credentials (production SA)'))
    })
  })

  // One check, two copies: the reasoning sits in promote-gcp's comments, so
  // the AWS copy must not drift from it.
  it.each(GUARDS)('%s is the same step in both jobs', (name) => {
    const [gcp, aws] = JOBS.map((job) => findStep(workflow, job, name).step)
    expect(aws).toEqual(gcp)
  })
})

// The failure notice in Slack tells a refusal apart from a failed deploy.
describe.concurrent.each(JOBS)('%s: Notify Slack (failure)', (job) => {
  const notify = (runnerEnv = {}, release = 'release-2026-10-21-10150') => runShellStep(findStep(workflow, job, 'Notify Slack (failure)'), {
    context: {
      'inputs.project-name': PROJECT,
      'secrets.datadog-api-key': 'dd-test',
      'needs.lookup.outputs.slack-channel': 'C0000000000',
      'secrets.slack-bot-token': 'xoxb-test',
      'github.actor': 'release-helper[bot]',
      'github.triggering_actor': 'release-helper[bot]',
      "steps.release.outputs.release || ''": release
    },
    runnerEnv
  })

  it('says FAILED, as before, when no check refused', async ({ expect }) => {
    const result = await notify()
    expect(result.status, result.stderr).toBe(0)
    expect(result.slack.text).toBe(':x: *example-app promote `release-2026-10-21-10150` to production FAILED* by release-helper[bot]\nhttps://github.com/example-org/deploy-wrappers/actions/runs/9001')
  })

  it('says refused, with the reason, when a check refused', async ({ expect }) => {
    const result = await notify({ PROMOTE_REFUSED: 'candidate_moved' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.slack.text).toBe(':no_entry: *example-app promote `release-2026-10-21-10150` to production refused* (`candidate_moved`) by release-helper[bot]; production was not changed\nhttps://github.com/example-org/deploy-wrappers/actions/runs/9001')
  })

  it('names the release-candidate image when the refusal came before the release was named', async ({ expect }) => {
    const result = await notify({ PROMOTE_REFUSED: 'production_moved' }, '')
    expect(result.slack.text).toMatch(/^:no_entry: \*example-app promote the release-candidate image to production refused\* \(`production_moved`\)/)
  })
})
