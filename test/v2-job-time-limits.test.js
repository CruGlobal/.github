import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { root, loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'
import { STEP_CAP_MS } from '../src/v2/rollout-budget.js'
import { DEADLINE_MS, REQUEST_TIMEOUT_MS } from '../src/classify-rollback-safety.js'

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

// The step in a deploy job that changes the environment, or for a stage-less
// candidate, the step that verifies it.
const changesTheEnvironment = (step) => /^Deploy to /.test(step.name ?? '') || step.name === 'Verify the candidate image'

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

// Each curl command in a step's script, with its continued lines joined into
// one and comments left out. A line that only mentions curl in its text (an
// error message, say) is not a command.
function curlCommands (script) {
  return (script ?? '').replace(/\\\n\s*/g, ' ').split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => /\bcurl\s+-/.test(line))
}

const curlFlag = (command, name) => {
  const match = command.match(new RegExp(`--${name} (\\d+)`))
  return match ? Number(match[1]) : undefined
}

// The longest a curl command can run. With no retries, that is --max-time.
// With retries, the wait between tries is not always --retry-delay: a
// server's Retry-After replaces it, so only --retry-max-time bounds the
// waits. curl starts no new try once that much time has gone by, and none
// whose Retry-After would take it past that. So the last try starts no later
// than --retry-max-time plus one --retry-delay, and runs at most --max-time.
// A probe against a local server matched this: 50 + 3 + 20 = 73 seconds at
// most, 72 measured.
function curlWorstCaseSeconds (command) {
  const maxTime = curlFlag(command, 'max-time')
  if (!curlFlag(command, 'retry')) return maxTime
  return curlFlag(command, 'retry-max-time') + curlFlag(command, 'retry-delay') + maxTime
}

// A curl that retries must say how long to wait and when to stop: without
// --retry-delay the waits double from one second, and without
// --retry-max-time a server's Retry-After sets them.
function expectBoundedRetries (command, key) {
  if (!curlFlag(command, 'retry')) return
  expect(curlFlag(command, 'retry-delay') ?? 0, `${key}: ${command}`).toBeGreaterThan(0)
  expect(curlFlag(command, 'retry-max-time') ?? 0, `${key}: ${command}`).toBeGreaterThan(0)
}

// The reads that run inside a deploy lock (the job's concurrency group),
// before the step that changes the environment. Without a limit, a read that
// never answers holds the lock until the job's own limit, and every promote,
// rollback or candidate deploy of the app waits behind it. Each read keeps the
// way it failed before it had a limit: an advisory read lets the job go on,
// and the stage-less candidate read refuses the promote.
//
// A step stopped by its timeout-minutes fails. With continue-on-error the job
// goes on and failure() stays false, and the outputs it wrote before it was
// stopped may or may not be there. So an advisory read needs
// continue-on-error, or its backstop would turn a hang into a failed job.
describe('reads inside the deploy lock', () => {
  // The stage-less candidate's image pull: about sixteen times the slowest
  // pull seen in real runs (see the comment on the step).
  const PULL_LIMIT_MINUTES = 15
  // [workflow, job, step, step limit in minutes, advisory]
  const READS = [
    // Must succeed. Their clients have no request timeout of their own yet,
    // so the step limit is the backstop; in recent runs each took seconds.
    ['deploy-candidate.yml', 'deploy-candidate-gcp', 'Resolve candidate image', 5, false],
    ['deploy-candidate.yml', 'deploy-candidate-aws', 'Resolve candidate image', 5, false],
    ['deploy-candidate.yml', 'verify-candidate-aws', 'Resolve candidate image', 5, false],
    ['deploy-candidate.yml', 'verify-candidate-aws', 'Pull the candidate image', PULL_LIMIT_MINUTES, false],
    ['promote.yml', 'promote-gcp', 'Resolve running release-candidate image', 5, false],
    ['promote.yml', 'promote-aws', 'Resolve release-candidate image', 5, false],
    ['rollback.yml', 'rollback-gcp', 'Resolve release image', 5, false],
    ['rollback.yml', 'rollback-aws', 'Resolve release image', 5, false],
    ['promote.yml', 'promote-gcp', 'Refuse a stale promote', 2, false],
    ['promote.yml', 'promote-aws', 'Refuse a stale promote', 2, false],
    ['rollback.yml', 'rollback-gcp', 'Refuse a stale rollback', 2, false],
    ['rollback.yml', 'rollback-aws', 'Refuse a stale rollback', 2, false],
    ['promote.yml', 'promote-gcp', 'Fetch production baseline', 1, true],
    ['promote.yml', 'promote-gcp', 'Classify rollback safety', 2, true],
    ['promote.yml', 'promote-aws', 'Resolve candidate from ledger (stage-less)', 2, false],
    ['promote.yml', 'promote-aws', 'Fetch production baseline', 1, true],
    ['promote.yml', 'promote-aws', 'Classify rollback safety', 2, true],
    ['rollback.yml', 'rollback-gcp', 'Rollback-safety advisory', 1, true],
    ['rollback.yml', 'rollback-aws', 'Rollback-safety advisory', 1, true],
    ['deploy-candidate.yml', 'deploy-candidate-gcp', 'Check image currently on release-candidate', 5, true],
    ['deploy-candidate.yml', 'deploy-candidate-aws', 'Check image currently on release-candidate', 5, true],
    ['deploy-candidate.yml', 'verify-candidate-aws', 'Check digest already verified', 1, true]
  ]
  const cases = READS.map(([file, id, name, limit, advisory]) => [`${file}:${id}: ${name}`, file, id, name, limit, advisory])

  it.each(cases)('%s runs inside the lock, before the environment changes', (_key, file, id, name) => {
    const job = workflows[file].jobs[id]
    expect(deployJobs.map(([, , deployJob]) => deployJob)).toContain(job)
    const at = job.steps.findIndex((step) => step.name === name)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(job.steps.findIndex(changesTheEnvironment))
  })

  it.each(cases)('%s has its limit and keeps its failure direction', (key, file, id, name, limit, advisory) => {
    const { step } = findStep(workflows[file], id, name)
    expect(step['timeout-minutes'], key).toBe(limit)
    if (advisory) {
      expect(step['continue-on-error'], `${key} is advisory, so its limit must not fail the job`).toBe(true)
    } else {
      expect(step['continue-on-error'], `${key} must stop the job when it cannot answer`).toBeUndefined()
    }
  })

  it.each(cases.filter(([, file, id, name]) => curlCommands(findStep(workflows[file], id, name).step.run).length > 0))('%s caps each curl inside its step limit', (key, file, id, name, limit) => {
    const { step } = findStep(workflows[file], id, name)
    const curls = curlCommands(step.run)
    expect(curls.length, key).toBeGreaterThan(0)
    for (const command of curls) {
      expect(curlFlag(command, 'connect-timeout'), `${key}: ${command}`).toBeGreaterThan(0)
      expect(curlFlag(command, 'connect-timeout')).toBeLessThan(curlFlag(command, 'max-time'))
      expectBoundedRetries(command, key)
      // Room past the slowest the curl can be, for the runner and jq.
      expect(curlWorstCaseSeconds(command) + 30, `${key}: ${command}`).toBeLessThanOrEqual(limit * 60)
    }
  })

  // The classifier ends its own GitHub reads (src/classify-rollback-safety.js).
  // Its step limit is only a backstop, so it must sit past the action's
  // deadline, with room for the read in flight when the deadline comes.
  it.each(['promote-gcp', 'promote-aws'])('promote.yml:%s gives the classifier more time than its own deadline', (id) => {
    const { step } = findStep(workflows['promote.yml'], id, 'Classify rollback safety')
    expect(DEADLINE_MS + REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(step['timeout-minutes'] * 60 * 1000)
  })

  // The candidate's sha feeds the hotfix check, the classifier and the
  // GitHub Release. It comes from a step with no network call, kept apart
  // from the baseline read, so a baseline read cut short by its limit can
  // only lose the baseline.
  it.each(['promote-gcp', 'promote-aws'])('promote.yml:%s reads the candidate\'s sha in a step that cannot hang', (id) => {
    const job = workflows['promote.yml'].jobs[id]
    const names = job.steps.map((step) => step.name)
    const pick = findStep(workflows['promote.yml'], id, 'Pick the commits to compare').step
    expect(pick.id).toBe('baseline')
    expect(pick.run).not.toMatch(/\b(curl|gh|aws|gcloud)\s/)
    expect(pick.env.PREV_SHA).toBe('${{ steps.production-baseline.outputs.sha }}')
    expect(findStep(workflows['promote.yml'], id, 'Fetch production baseline').step.id).toBe('production-baseline')
    expect(names.indexOf('Pick the commits to compare')).toBe(names.indexOf('Fetch production baseline') + 1)
    expect(names.indexOf('Pick the commits to compare')).toBeLessThan(names.indexOf('Tell a hotfix from a deploy'))
  })

  // Wider than the list above: no curl in a deploy job runs without a time
  // limit before the environment changes, no step there that reaches the
  // network runs without a step limit unless it is on the lists below, and
  // no read of the deployment ledger runs without a limit anywhere in these
  // workflows.
  it.each(deployJobs.map(([file, id, job]) => [`${file}:${id}`, job]))('%s caps every curl before the environment changes', (key, job) => {
    const before = job.steps.slice(0, job.steps.findIndex(changesTheEnvironment))
    for (const step of before) {
      for (const command of curlCommands(step.run)) expect(command, `${key}: "${step.name}"`).toMatch(/--max-time \d+/)
    }
  })

  // Actions from GitHub and the clouds: not ours to change, and none has
  // been seen to hang. Each is listed by the start of its `uses`.
  const THIRD_PARTY = [
    'actions/checkout@',
    'google-github-actions/auth@',
    'aws-actions/configure-aws-credentials@',
    'aws-actions/amazon-ecr-login@'
  ]
  // Our own actions that end their own requests, so a step limit would only
  // repeat theirs.
  const ENDS_ITS_OWN_REQUESTS = [
    // 10 seconds a request, three tries, and it refuses when they run out
    // (src/authorize-actor.js).
    './cru-github-actions/actions/authorize-actor'
  ]
  // Bash comments are not commands.
  const commands = (script) => (script ?? '').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  const reachesNetwork = (step) => step.uses
    ? !step.uses.startsWith('./') || step.uses.startsWith('./cru-github-actions/actions/')
    : /\b(curl|gh|aws|gcloud|docker)\s/.test(commands(step.run))

  it.each(deployJobs.map(([file, id, job]) => [`${file}:${id}`, job]))('%s gives every step that reaches the network a step limit before the environment changes', (key, job) => {
    const before = job.steps.slice(0, job.steps.findIndex(changesTheEnvironment))
    const checked = before.filter(reachesNetwork)
      .filter((step) => !THIRD_PARTY.some((prefix) => step.uses?.startsWith(prefix)))
      .filter((step) => !ENDS_ITS_OWN_REQUESTS.includes(step.uses))
    expect(checked.length).toBeGreaterThan(0)
    for (const step of checked) {
      expect(step['timeout-minutes'], `${key}: "${step.name}" reaches the network inside the lock, so it needs timeout-minutes or a place on a list`).toBeGreaterThan(0)
    }
  })

  it('keeps those lists honest', () => {
    const used = deployJobs.flatMap(([, , job]) => job.steps.map((step) => step.uses).filter(Boolean))
    for (const prefix of THIRD_PARTY) expect(used.some((uses) => uses.startsWith(prefix)), prefix).toBe(true)
    for (const action of ENDS_ITS_OWN_REQUESTS) expect(used, action).toContain(action)
  })

  it('caps every read of the deployment ledger', () => {
    const reads = allJobs.flatMap(([file, id, job]) => (job.steps ?? []).flatMap((step) => curlCommands(step.run)
      .filter((command) => command.includes('https://deploys.cru.org/deployments'))
      .map((command) => [`${file}:${id}: ${step.name}`, command])))
    expect(reads.length).toBeGreaterThan(0)
    for (const [key, command] of reads) {
      expect(command, key).toMatch(/--max-time \d+/)
      expectBoundedRetries(command, key)
    }
  })
})

describe('reads inside the deploy lock, run', () => {
  const ROW_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const HEAD_SHA = 'c0ffee0000000000000000000000000000000001'
  const DIGEST = 'sha256:' + '0'.repeat(64)
  const context = {
    'inputs.project-name': 'example-app',
    'secrets.datadog-api-key': 'dd-test',
    "secrets.slack-bot-token != ''": 'true'
  }
  const run = (file, id, name, options = {}) => runShellStep(findStep(workflows[file], id, name), { ...options, context: { ...context, ...options.context } })
  const lines = (result, prefix) => result.stdout.split('\n').filter((line) => line.startsWith(prefix))

  describe.each(['promote-gcp', 'promote-aws'])('promote.yml:%s', (id) => {
    const baseline = (options) => run('promote.yml', id, 'Fetch production baseline', options)
    const pick = (prevSha) => run('promote.yml', id, 'Pick the commits to compare', {
      context: {
        'steps.resolve.outputs.tags': `candidate-2026-10-21-10150,sha-${HEAD_SHA}`,
        'steps.production-baseline.outputs.sha': prevSha
      }
    })

    it('reads the baseline with a time limit', async () => {
      const result = await baseline({ ledger: { Items: [{ Sha: ROW_SHA }] } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ sha: ROW_SHA })
      expect(lines(result, '::warning')).toEqual([])
      expect(result.ledgerCalls).toHaveLength(1)
      expect(result.ledgerCalls[0]).toMatch(/--connect-timeout 10 --max-time 20 /)
    })

    it('leaves the baseline empty, quietly, when production has no row yet', async () => {
      const result = await baseline({ ledger: { Items: [] } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ sha: '' })
      expect(lines(result, '::warning')).toEqual([])
    })

    it.each([
      ['runs out of time', { ledgerTimesOut: true }],
      ['fails', { ledgerFails: true }],
      ['gets something that is not JSON', { ledger: '<html>bad gateway</html>' }]
    ])('goes on with an empty baseline, and says why, when the read %s', async (_how, options) => {
      const result = await baseline(options)
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ sha: '' })
      expect(lines(result, '::warning')).toEqual([
        '::warning title=Production baseline::could not read the deployment ledger for example-app (it failed or did not answer within 20 seconds), so the rollback-safety verdict will be unclassified'
      ])
    })

    it('passes on the baseline and reads the candidate\'s sha from its tags', async () => {
      const result = await pick(ROW_SHA)
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ 'prev-sha': ROW_SHA, 'head-sha': HEAD_SHA })
    })

    // What a baseline step stopped by its limit leaves behind.
    it('still reads the candidate\'s sha when the baseline step left nothing', async () => {
      const result = await pick('')
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ 'prev-sha': '', 'head-sha': HEAD_SHA })
    })
  })

  // The stale guards' own refusals are pinned in v2-promote-guards; here,
  // only the time limits on the read and that a timeout is still a refusal.
  describe.each([
    ['promote.yml', 'promote-gcp', 'Refuse a stale promote'],
    ['promote.yml', 'promote-aws', 'Refuse a stale promote'],
    ['rollback.yml', 'rollback-gcp', 'Refuse a stale rollback'],
    ['rollback.yml', 'rollback-aws', 'Refuse a stale rollback']
  ])('%s:%s %s', (file, id, name) => {
    const guard = (options) => run(file, id, name, {
      ...options,
      context: {
        'inputs.expected-current-release': 'release-2026-10-20-10140',
        'inputs.expected-previous-release': '',
        'needs.lookup.outputs.release-tag': 'release-2026-10-19-10130'
      }
    })

    it('reads the ledger with a time limit on each try and on the retries', async () => {
      const result = await guard({ ledger: { Items: [{ Revision: 'release-2026-10-20-10140' }] } })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.ledgerCalls).toHaveLength(1)
      expect(result.ledgerCalls[0]).toMatch(/--connect-timeout 10 --max-time 20 --retry 2 --retry-delay 3 --retry-max-time 50 /)
    })

    it('still refuses when the ledger does not answer in time', async () => {
      const result = await guard({ ledgerTimesOut: true })
      expect(result.status).toBe(1)
      expect(lines(result, '::error')).toHaveLength(1)
      expect(lines(result, '::error')[0]).toMatch(/could not read the deployment ledger for example-app/)
    })
  })

  describe('promote.yml:promote-aws stage-less candidate', () => {
    const resolve = (options) => run('promote.yml', 'promote-aws', 'Resolve candidate from ledger (stage-less)', options)

    it('resolves the newest row with a digest, with a time limit on each try', async () => {
      const result = await resolve({ ledger: { Items: [{ Revision: 'candidate-2026-10-21-10151' }, { Revision: 'candidate-2026-10-21-10150', Digest: DIGEST }] } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ revision: 'candidate-2026-10-21-10150', digest: DIGEST })
      expect(result.ledgerCalls).toHaveLength(1)
      expect(result.ledgerCalls[0]).toMatch(/--connect-timeout 10 --max-time 20 --retry 2 --retry-delay 3 --retry-max-time 50 /)
    })

    it('refuses the promote, saying the ledger did not answer in time, when the read runs out of time', async () => {
      const result = await resolve({ ledgerTimesOut: true })
      expect(result.status).toBe(1)
      expect(result.outputs).toEqual({})
      expect(lines(result, '::error')).toEqual([
        '::error::the deployment ledger (deploys.cru.org) did not answer in time for example-app. The app is stage-less, so the ledger is the only record of its release candidate; refusing to promote. Nothing in production was changed. Try again once the ledger answers.'
      ])
    })

    it('refuses the promote when the read fails', async () => {
      const result = await resolve({ ledgerFails: true })
      expect(result.status).toBe(1)
      expect(result.outputs).toEqual({})
      expect(lines(result, '::error')).toEqual([
        '::error::could not read the deployment ledger (deploys.cru.org) for example-app (curl exit 22); the app is stage-less, so the ledger is the only record of its release candidate.'
      ])
    })

    it('refuses the promote when the ledger answers with something that is not JSON', async () => {
      const result = await resolve({ ledger: '<html>bad gateway</html>' })
      expect(result.status).toBe(1)
      expect(result.outputs).toEqual({})
      expect(lines(result, '::error')[0]).toMatch(/returned an unexpected response \(not JSON\)/)
    })

    it('refuses the promote when no row carries a digest', async () => {
      const result = await resolve({ ledger: { Items: [{ Revision: 'candidate-2026-10-21-10151' }] } })
      expect(result.status).toBe(1)
      expect(result.outputs).toEqual({})
      expect(lines(result, '::error')[0]).toMatch(/no release-candidate ledger row with a digest for example-app/)
    })
  })

  describe.each(['rollback-gcp', 'rollback-aws'])('rollback.yml:%s', (id) => {
    const advisory = (options) => run('rollback.yml', id, 'Rollback-safety advisory', options)

    it('warns about a release with destructive migrations, read with a time limit', async () => {
      const result = await advisory({ ledger: { Items: [{ Revision: 'release-2026-10-21-10150', RollbackSafe: 'false', RollbackSafeReasons: '["drizzle/0002_drop.sql: DROP TABLE"]' }] } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({
        'previous-revision': 'release-2026-10-21-10150',
        slack: ':warning: rolling back FROM a release with destructive migrations (drizzle/0002_drop.sql: DROP TABLE); this rollback does NOT revert the schema'
      })
      expect(result.ledgerCalls[0]).toMatch(/--connect-timeout 10 --max-time 20 /)
    })

    it('gives the all-clear when the ledger answered and found nothing', async () => {
      const result = await advisory({ ledger: { Items: [{ Revision: 'release-2026-10-21-10150', RollbackSafe: 'true' }] } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ 'previous-revision': 'release-2026-10-21-10150', slack: '' })
      expect(lines(result, '::warning')).toEqual([])
      expect(lines(result, '::notice')).toEqual(['::notice title=Rollback safety::no destructive-migration warning on the release being rolled back from'])
    })

    it.each([
      ['runs out of time', { ledgerTimesOut: true }],
      ['fails', { ledgerFails: true }],
      ['gets something that is not JSON', { ledger: '<html>bad gateway</html>' }]
    ])('goes on, and says nothing was checked, when the read %s', async (_how, options) => {
      const result = await advisory(options)
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({
        'previous-revision': '',
        slack: ':grey_question: could not check the release being rolled back from for destructive migrations (the deployment ledger could not be read); this rollback does NOT revert the schema'
      })
      expect(lines(result, '::notice')).toEqual([])
      // Not the title a destructive migration gets.
      expect(lines(result, '::warning')).toEqual([
        '::warning title=Rollback safety not checked::could not read the deployment ledger for example-app (it failed or did not answer within 20 seconds), so the release being rolled back from was not checked for destructive migrations; the rollback goes on. The image swap will NOT revert the schema'
      ])
    })

    // The Slack post shows the line under the rollback message.
    it('puts the could-not-check line in the Slack post', async () => {
      const failed = await advisory({ ledgerTimesOut: true })
      const result = await runShellStep(findStep(workflows['rollback.yml'], id, 'Notify Slack'), {
        context: {
          ...context,
          'needs.lookup.outputs.slack-channel': 'C0000000000',
          'secrets.slack-bot-token': 'xoxb-test',
          'needs.lookup.outputs.app-url': 'https://example-app.example.test',
          'needs.lookup.outputs.release-tag': 'release-2026-10-20-10140',
          'steps.actual-release.outputs.tag || needs.lookup.outputs.release-tag': 'release-2026-10-20-10140',
          'steps.rollback-safety.outputs.previous-revision': failed.outputs['previous-revision'],
          'steps.rollback-safety.outputs.slack': failed.outputs.slack,
          'needs.lookup.outputs.repository': 'example-org/example-app',
          'needs.lookup.outputs.flightdeck-project': '',
          'inputs.flightdeck-url': '',
          'vars.FLIGHTDECK_WORKSPACE': '',
          'github.actor': 'example-user',
          'github.triggering_actor': 'example-user'
        }
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.slack.text).toContain('\n:grey_question: could not check the release being rolled back from for destructive migrations')
    })
  })

  describe('deploy-candidate.yml:verify-candidate-aws', () => {
    const check = (options) => run('deploy-candidate.yml', 'verify-candidate-aws', 'Check digest already verified', options)

    it('reads the verified digest with a time limit', async () => {
      const result = await check({ ledger: { Items: [{ Digest: DIGEST }] } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ digest: DIGEST })
      expect(result.ledgerCalls[0]).toMatch(/--connect-timeout 10 --max-time 20 /)
    })

    // An empty digest means "not verified yet": the candidate is verified
    // again, the safe way round.
    it.each([
      ['runs out of time', { ledgerTimesOut: true }],
      ['fails', { ledgerFails: true }]
    ])('leaves the digest empty when the read %s', async (_how, options) => {
      const result = await check(options)
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toEqual({ digest: '' })
    })
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
      "secrets.slack-bot-token != ''": 'true',
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
