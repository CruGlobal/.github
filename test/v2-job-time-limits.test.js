import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { root, loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'
import { STEP_CAP_MS } from '../src/v2/rollout-budget.js'

// Every job in the pipeline v2 reusable workflows has a time limit of its
// own. Without one a job gets GitHub's six-hour default, so a step that hangs
// (a package mirror that stalls, a call that never answers) holds the run, and
// any lock it holds, for six hours.
//
// A job that hits its limit ends `cancelled`, not `failure`: GitHub stops it
// by cancelling it. So the failure notices are pinned here too. They must
// fire on a cancelled job, or a timeout would end with nobody told.

afterAll(removeFakes)

const V2_WORKFLOWS = [
  'build-candidate.yml',
  'deploy-candidate.yml',
  'promote.yml',
  'rollback.yml',
  'hotfix.yml',
  'record-deploy.yml',
  'notify-build-failure.yml'
]

// The other reusable workflows: the older pipeline and the repo's helpers.
// The rule above does not cover them yet. A new reusable workflow has to go
// on one list or the other, so a new v2 workflow cannot slip past the rule.
const NOT_COVERED = [
  'aem-cloud-build.yml',
  'aem-cloud-repo-sync.yml',
  'branch-merge-release.yml',
  'build-cloudrun.yml',
  'build-deploy-cloudrun-function.yml',
  'build-deploy-cloudrun-job.yml',
  'build-deploy-cloudrun-service.yml',
  'build-ecs.yml',
  'build-lambda.yml',
  'bump-version.yml',
  'check-pr-release-label.yml',
  'create-release.yml',
  'cypress-e2e-tests.yml',
  'dependabot-auto-merge-security-patch.yml',
  'dependabot-merge.yml',
  'deploy-cloudrun.yml',
  'deploy-ecs.yml',
  'deploy-lambda.yml',
  'deploy-serverless.yml',
  'dispatch-update.yml',
  'docker-build.yml',
  'generate-build-meta.yml',
  'get-pr-release-label.yml',
  'open-pr.yml',
  'update-sub-repo.yml'
]

// Jobs that may run without a limit, as `<file>:<job id>`. Empty on purpose.
// Add one only with a comment that says why a hang there is better than a
// stop.
const ALLOWED_WITHOUT_LIMIT = []

const workflows = Object.fromEntries(V2_WORKFLOWS.map((file) => [file, loadYaml(`.github/workflows/${file}`)]))
const allJobs = Object.entries(workflows).flatMap(([file, workflow]) => Object.entries(workflow.jobs).map(([id, job]) => [file, id, job]))

// The jobs that change an environment: each holds the production lock or the
// release-candidate lock while it deploys.
const deployJobs = allJobs.filter(([, , job]) => /^(production|release-candidate)-/.test(job.concurrency?.group ?? ''))

function isReusable (workflow) {
  // js-yaml reads the `on:` key as a string, but a YAML 1.1 reader makes it
  // true, so look under both.
  const on = workflow.on ?? workflow[true]
  if (typeof on === 'string') return on === 'workflow_call'
  if (Array.isArray(on)) return on.includes('workflow_call')
  return Object.hasOwn(on ?? {}, 'workflow_call')
}

describe('which workflows the rule covers', () => {
  it('puts every reusable workflow on exactly one list', () => {
    const dir = path.join(root, '.github/workflows')
    const reusable = readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) => isReusable(loadYaml(`.github/workflows/${name}`)))
      .sort()
    expect([...V2_WORKFLOWS, ...NOT_COVERED].sort()).toEqual(reusable)
    for (const file of V2_WORKFLOWS) expect(NOT_COVERED).not.toContain(file)
  })

  it('finds the jobs that deploy', () => {
    expect(deployJobs.map(([file, id]) => `${file}:${id}`)).toEqual([
      'deploy-candidate.yml:deploy-candidate-gcp',
      'deploy-candidate.yml:deploy-candidate-aws',
      'deploy-candidate.yml:verify-candidate-aws',
      'promote.yml:promote-gcp',
      'promote.yml:promote-aws',
      'rollback.yml:rollback-gcp',
      'rollback.yml:rollback-aws'
    ])
  })
})

describe('job time limits', () => {
  it.each(allJobs.map(([file, id, job]) => [`${file}:${id}`, job]))('%s has a time limit', (key, job) => {
    if (ALLOWED_WITHOUT_LIMIT.includes(key)) return
    const limit = job['timeout-minutes']
    expect(Number.isInteger(limit), `${key} needs timeout-minutes`).toBe(true)
    // GitHub's own ceiling for a job on a hosted runner.
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThanOrEqual(360)
  })

  it('keeps the allow-list honest', () => {
    for (const key of ALLOWED_WITHOUT_LIMIT) {
      const [file, id] = key.split(':')
      expect(workflows[file]?.jobs[id], `${key} is not a job`).toBeDefined()
      expect(workflows[file].jobs[id]['timeout-minutes'], `${key} has a limit now, so take it off the list`).toBeUndefined()
    }
  })

  // The deploy step stops its own rollout wait STEP_CAP_MS after it starts
  // (src/v2/rollout-budget.js), so it can report, pin traffic back and let
  // the record steps run. The job's limit must stay above that cap with room
  // for the steps before and after the deploy, or a slow deploy would be cut
  // off with nothing recorded.
  it.each(deployJobs.map(([file, id, job]) => [`${file}:${id}`, job]))('%s leaves ten minutes past the deploy step\'s own cap', (key, job) => {
    expect(job['timeout-minutes'] * 60 * 1000 - STEP_CAP_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })
})

// Between the deploy and the ledger write, every step has a limit of its own
// or is on the list below. Without one, a call that never answers would run
// until the job's limit, and the job would stop before the ledger row is
// written: a release in production that the ledger does not show.
describe('steps before the ledger write', () => {
  const LEDGER = 'Record deployment in ledger'
  const changesTheEnvironment = (step) => /^Deploy to /.test(step.name ?? '') || step.name === 'Verify the candidate image'

  // Steps on this list may run without a limit of their own, so the job's
  // limit is their backstop. Neither is allowed to fail, so when either one
  // fails, every step after it is skipped, the ledger write included. A step
  // limit would skip the ledger write just as the job's limit does, only
  // sooner, and it could cut off a slow call that would have worked.
  const ALLOWED_BEFORE_LEDGER = [
    // Tags the promoted digest in the registry.
    'Tag digest as release',
    // The credential for the ledger write itself.
    'Configure AWS credentials for ledger'
  ]

  it.each(deployJobs.map(([file, id, job]) => [`${file}:${id}`, job]))('%s limits each step that comes first', (key, job) => {
    const steps = job.steps
    const deploy = steps.findIndex(changesTheEnvironment)
    const ledger = steps.findIndex((step) => step.name === LEDGER)
    expect(deploy, `${key} has no deploy step`).toBeGreaterThanOrEqual(0)
    expect(ledger, `${key} has no ledger step`).toBeGreaterThan(deploy)

    const between = steps.slice(deploy + 1, ledger)
    expect(between.map((step) => step.name)).toContain('Record deployment event in Datadog')
    let limits = 0
    for (const step of between) {
      if (ALLOWED_BEFORE_LEDGER.includes(step.name)) {
        expect(step['continue-on-error'], `${key}: "${step.name}" is on the list because it may not fail`).toBeUndefined()
        continue
      }
      expect(step['timeout-minutes'], `${key}: "${step.name}" needs its own limit, or a place on the list`).toBeGreaterThan(0)
      limits += step['timeout-minutes']
    }
    // What this proves is narrow: the deploy step's own cap plus the step
    // limits counted above stay inside the job's limit. It does not prove the
    // ledger write always starts in time. The cap counts from when the deploy
    // step starts, so the steps before it are not in the sum, and neither are
    // the listed steps, which have no limit. Those took seconds in real runs.
    expect(STEP_CAP_MS + limits * 60 * 1000).toBeLessThan(job['timeout-minutes'] * 60 * 1000)
  })
})

// Every Slack post in these workflows has a two-minute step limit, and every
// curl in the step has --max-time. A post that never answered would otherwise
// run the job into its time limit. After a good deploy the job would then end
// cancelled, and the failure notice would say it stopped.
describe('Slack posts', () => {
  const slackSteps = allJobs.flatMap(([file, id, job]) => (job.steps ?? [])
    .filter((step) => (step.run ?? '').includes('https://slack.com/api/chat.postMessage'))
    .map((step) => [`${file}:${id}: ${step.name}`, file, step]))

  it('finds the Slack posts in every workflow that has one', () => {
    expect([...new Set(slackSteps.map(([, file]) => file))].sort()).toEqual([
      'deploy-candidate.yml',
      'notify-build-failure.yml',
      'promote.yml',
      'record-deploy.yml',
      'rollback.yml'
    ])
  })

  it.each(slackSteps.map(([key, , step]) => [key, step]))('%s has a time limit and caps each curl', (_key, step) => {
    expect(step['timeout-minutes']).toBe(2)
    expect(step['continue-on-error']).toBe(true)
    const curls = step.run.split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /\bcurl\b/.test(line))
    expect(curls.length).toBeGreaterThan(0)
    for (const line of curls) expect(line).toMatch(/--max-time \d+/)
  })
})

describe('failure notices reach a job that timed out', () => {
  // build-candidate's notice is a job of its own, so it reads the build
  // jobs' results. In a job's `if`, cancelled() is true only when the whole
  // run was cancelled (a person's cancel), and a single job that ran out of
  // time has the result `cancelled`.
  it('build-candidate announces a failed or cancelled build, and not a cancelled run', () => {
    const job = workflows['build-candidate.yml'].jobs['notify-failure']
    expect(job.if.replace(/\s+/g, ' ').trim()).toBe(
      "${{ !cancelled() && (needs.build-cloudrun.result == 'failure' || needs.build-ecs.result == 'failure' || needs.build-lambda.result == 'failure' || needs.build-cloudrun.result == 'cancelled' || needs.build-ecs.result == 'cancelled' || needs.build-lambda.result == 'cancelled') }}"
    )
    expect(job.needs).toEqual(['setup', 'build-cloudrun', 'build-ecs', 'build-lambda'])
  })

  // Inside a job, a timeout and a person's cancel both leave the job
  // cancelled, so failure() is false for both and only cancelled() is true.
  it.each(deployJobs.map(([file, id]) => [`${file}:${id}`, file, id]))('%s posts its failure notice on a cancel too', (_key, file, id) => {
    const { step } = findStep(workflows[file], id, 'Notify Slack (failure)')
    expect(step.if).toBe('failure() || cancelled()')
    expect(step['continue-on-error']).toBe(true)
    expect(step.env.JOB_STATUS).toBe('${{ job.status }}')
  })

  // Promote's wording, refusals included, is pinned in v2-promote-guards.
  const messages = [
    ['deploy-candidate.yml', 'deploy-candidate-gcp',
      ':x: *example-app `candidate-2026-10-21-10150` deploy to stage FAILED*',
      ':octagonal_sign: *example-app `candidate-2026-10-21-10150` deploy to stage stopped before it finished*: it was cancelled, or it ran past its time limit'],
    ['deploy-candidate.yml', 'deploy-candidate-aws',
      ':x: *example-app `candidate-2026-10-21-10150` deploy to stage FAILED*',
      ':octagonal_sign: *example-app `candidate-2026-10-21-10150` deploy to stage stopped before it finished*: it was cancelled, or it ran past its time limit'],
    ['deploy-candidate.yml', 'verify-candidate-aws',
      ':x: *example-app `candidate-2026-10-21-10150` verification FAILED (stage-less)*',
      ':octagonal_sign: *example-app `candidate-2026-10-21-10150` verification stopped before it finished (stage-less)*: it was cancelled, or it ran past its time limit'],
    ['rollback.yml', 'rollback-gcp',
      ':x: *example-app rollback in production FAILED* by example-user',
      ':octagonal_sign: *example-app rollback in production by example-user stopped before it finished*: it was cancelled, or it ran past its time limit'],
    ['rollback.yml', 'rollback-aws',
      ':x: *example-app rollback in production FAILED* by example-user',
      ':octagonal_sign: *example-app rollback in production by example-user stopped before it finished*: it was cancelled, or it ran past its time limit'],
    // The account named is the one that started the run, not one that
    // stopped it, so a re-run names both, as the FAILED line does.
    ['rollback.yml', 'rollback-aws',
      ':x: *example-app rollback in production FAILED* by example-user (re-run by other-user)',
      ':octagonal_sign: *example-app rollback in production by example-user (re-run by other-user) stopped before it finished*: it was cancelled, or it ran past its time limit',
      'other-user']
  ]

  const notify = (file, id, status, triggering) => runShellStep(findStep(workflows[file], id, 'Notify Slack (failure)'), {
    context: {
      'inputs.project-name': 'example-app',
      'secrets.datadog-api-key': 'dd-test',
      'needs.lookup.outputs.slack-channel': 'C0000000000',
      'secrets.slack-bot-token': 'xoxb-test',
      'inputs.tag': 'candidate-2026-10-21-10150',
      'github.actor': 'example-user',
      'github.triggering_actor': triggering,
      'job.status': status
    }
  })
  const RUN_URL = 'https://github.com/example-org/deploy-wrappers/actions/runs/9001'

  describe.concurrent.each(messages)('%s:%s', (file, id, failed, stopped, triggering = 'example-user') => {
    it(`says FAILED, as before, when a step failed (this attempt started by ${triggering})`, async ({ expect }) => {
      const result = await notify(file, id, 'failure', triggering)
      expect(result.status, result.stderr).toBe(0)
      expect(result.slack.text).toBe(`${failed}\n${RUN_URL}`)
    })

    it(`says it stopped, naming both causes, when the job was cancelled (this attempt started by ${triggering})`, async ({ expect }) => {
      const result = await notify(file, id, 'cancelled', triggering)
      expect(result.status, result.stderr).toBe(0)
      expect(result.slack.text).toBe(`${stopped}\n${RUN_URL}`)
    })
  })
})
