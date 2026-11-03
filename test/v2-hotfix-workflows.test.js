import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes, workflowAndActionFiles } from './support/workflow-steps.js'
import { MODES } from '../src/hotfix.js'

// How the hotfix path is wired into the workflows: build-candidate's guard,
// hotfix.yml's order of steps, and every use of the hotfix action. The logic
// itself is tested in v2-hotfix.test.js.

afterAll(removeFakes)

const HOTFIX_ACTION = './cru-github-actions/actions/hotfix'
const hotfixAction = loadYaml('actions/hotfix/action.yml')

describe('build-candidate', () => {
  const workflow = loadYaml('.github/workflows/build-candidate.yml')
  const setup = workflow.jobs.setup
  const names = setup.steps.map((step) => step.name)
  const DEFAULT = "github.ref != format('refs/heads/{0}', github.event.repository.default_branch)"
  const HOTFIX_ONLY = "steps.ref.outputs.hotfix == 'true'"
  const TODAY = '::error title=Build Candidate::candidates build from the default branch only -- REF is not refs/heads/main. Merge the change to main, then dispatch.'

  it('keeps the default-branch step first, before any checkout, and compares in bash rather than an if:', () => {
    const { step } = findStep(workflow, 'setup', 'Assert the calling ref is the default branch')
    expect(setup.steps.indexOf(step)).toBe(0)
    // An if: would compare without case.
    expect(step.if).toBeUndefined()
    expect(DEFAULT).toContain('format(')
    expect(step.id).toBe('ref')
    expect(step.run).toContain('echo "::error title=Build Candidate::candidates build from the default branch only -- $GITHUB_REF is not refs/heads/$DEFAULT_BRANCH. Merge the change to $DEFAULT_BRANCH, then dispatch."')
  })

  describe('the default-branch step', () => {
    const assertRef = (ref, defaultBranch = 'main') => runShellStep(findStep(workflow, 'setup', 'Assert the calling ref is the default branch'), {
      context: { 'github.event.repository.default_branch': defaultBranch },
      runnerEnv: { GITHUB_REF: ref }
    })

    it.each([
      ['refs/heads/main', 'main'],
      ['refs/heads/master', 'master'],
      ['refs/heads/release/v2', 'release/v2']
    ])('lets the real default branch %s build, silently', async (ref, defaultBranch) => {
      const result = await assertRef(ref, defaultBranch)
      expect(result.status, result.stdout).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.outputs).toEqual({})
    })

    it.each([
      ['refs/heads/MAIN', 'main'],
      ['refs/heads/Main', 'main'],
      ['refs/heads/main', 'Main'],
      ['refs/heads/main', 'master'],
      ['refs/heads/main', '']
    ])('refuses %s when the default branch is %j, with today\'s exact message', async (ref, defaultBranch) => {
      const result = await assertRef(ref, defaultBranch)
      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe(`::error title=Build Candidate::candidates build from the default branch only -- ${ref} is not refs/heads/${defaultBranch}. Merge the change to ${defaultBranch}, then dispatch.`)
      expect(result.outputs).toEqual({})
    })

    // Expression comparisons ignore case and git refs do not, so the hotfix
    // shape is matched in bash, exactly, and nothing else gets past.
    it.each([
      'refs/heads/feature/login',
      'refs/heads/hotfix/fix-login',
      'refs/heads/HOTFIX/release-2026-10-20-10140',
      'refs/heads/Hotfix/release-2026-10-20-10140',
      'refs/heads/hotfix/Release-2026-10-20-10140',
      'refs/heads/hotfix/release-2026-10-20-10140/x',
      'refs/heads/hotfix/release-2026-10-20-',
      'refs/heads/xhotfix/release-10140',
      'refs/tags/hotfix/release-10140'
    ])('refuses %s with today\'s exact message', async (ref) => {
      const result = await assertRef(ref)
      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe(TODAY.replace('REF', ref))
      expect(result.outputs).toEqual({})
    })

    it.each(['refs/heads/hotfix/release-2026-10-20-10140', 'refs/heads/hotfix/release-10012'])('passes %s on to the hotfix check', async (ref) => {
      const result = await assertRef(ref)
      expect(result.status, result.stdout).toBe(0)
      expect(result.outputs).toEqual({ hotfix: 'true' })
      expect(result.stdout).not.toContain('::error')
    })
  })

  it('checks a hotfix ref before any build job runs, and only a hotfix ref', () => {
    const hotfixSteps = setup.steps.filter((step) => step.if === HOTFIX_ONLY)
    expect(hotfixSteps.map((step) => step.name)).toEqual([
      'Checkout Cru Actions & Workflows (hotfix check)',
      'Checkout project with full history (hotfix check)',
      'Assert the hotfix branch holds only cherry-picks of default-branch commits'
    ])
    // Every other setup step runs as it always did.
    for (const step of setup.steps) {
      if (!hotfixSteps.includes(step) && step.name !== 'Assert the calling ref is the default branch') expect(step.if, step.name).toBeUndefined()
    }
    // After the project name it needs, and the build jobs wait for setup.
    expect(names.indexOf(hotfixSteps[0].name)).toBeGreaterThan(names.indexOf('Resolve project name & validate type'))
    for (const job of ['build-cloudrun', 'build-ecs', 'build-lambda']) expect(workflow.jobs[job].needs).toBe('setup')
  })

  it('checks exactly the commit the build jobs build', () => {
    const { step: checkout } = findStep(workflow, 'setup', 'Checkout project with full history (hotfix check)')
    expect(checkout.with).toEqual({ ref: '${{ github.sha }}', path: 'project', 'fetch-depth': 0 })
    const { step: guard } = findStep(workflow, 'setup', 'Assert the hotfix branch holds only cherry-picks of default-branch commits')
    expect(guard.uses).toBe(HOTFIX_ACTION)
    expect(guard['continue-on-error']).toBeUndefined()
    expect(guard.with).toEqual({
      mode: 'verify',
      'project-name': '${{ steps.info.outputs.project-name }}',
      path: 'project',
      ref: '${{ github.ref }}',
      sha: '${{ github.sha }}',
      'default-branch': '${{ github.event.repository.default_branch }}'
    })
    for (const job of ['build-cloudrun', 'build-ecs', 'build-lambda']) {
      const build = workflow.jobs[job].steps.find((step) => step.name === 'Checkout project')
      expect(build.with.ref, job).toBe('${{ github.sha }}')
    }
  })
})

describe('hotfix.yml', () => {
  const workflow = loadYaml('.github/workflows/hotfix.yml')
  const job = workflow.jobs.hotfix
  const names = job.steps.map((step) => step.name)
  const step = (name) => findStep(workflow, 'hotfix', name).step

  it('takes the inputs the wrapper passes, with defaults that change nothing for others', () => {
    const { inputs, secrets } = workflow.on.workflow_call
    expect(Object.keys(inputs).sort()).toEqual(['commit', 'expected-release', 'project-name', 'trusted-automation-actor-ids', 'workflow-ref'])
    for (const name of ['commit', 'expected-release', 'project-name']) expect(inputs[name].required, name).toBe(true)
    expect(inputs['trusted-automation-actor-ids']).toMatchObject({ required: false, default: '' })
    expect(inputs['workflow-ref']).toMatchObject({ required: false, default: 'main' })
    expect(secrets).toEqual({ 'authz-token': expect.objectContaining({ required: true }) })
  })

  it('runs one hotfix per app at a time, never cancelling one in flight, and not in the production lock', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['hotfix'])
    expect(job.concurrency).toEqual({ group: 'hotfix-${{ inputs.project-name }}', 'cancel-in-progress': false })
    expect(job.permissions).toEqual({ 'id-token': 'write', contents: 'read' })
  })

  it('authorizes the account first, then cuts, then dispatches the build, then reports', () => {
    expect(names).toEqual([
      'Configure AWS credentials for app-info',
      'Look up app info (production)',
      'Checkout Cru Actions & Workflows',
      'Authorize actor',
      'Checkout the app repo',
      'Cut the hotfix branch',
      'Build the hotfix branch',
      'Explain a failed build dispatch',
      "Report the app's CI on the hotfix branch"
    ])
    expect(step('Authorize actor')).toMatchObject({
      uses: './cru-github-actions/actions/authorize-actor',
      with: {
        'github-token': '${{ secrets.authz-token }}',
        repository: '${{ steps.app-info.outputs.repository }}',
        'trusted-automation-actor-ids': '${{ inputs.trusted-automation-actor-ids }}',
        'refusal-title': 'actor_not_allowed'
      }
    })
    expect(step('Checkout the app repo').with).toEqual({ repository: '${{ steps.app-info.outputs.repository }}', token: '${{ secrets.authz-token }}', 'fetch-depth': 0, path: 'app' })
    expect(step('Cut the hotfix branch')).toMatchObject({
      id: 'cut',
      uses: HOTFIX_ACTION,
      with: { mode: 'cut', path: 'app', 'project-name': '${{ inputs.project-name }}', commit: '${{ inputs.commit }}', 'expected-release': '${{ inputs.expected-release }}' }
    })
    expect(step('Cut the hotfix branch')['continue-on-error']).toBeUndefined()
  })

  it('dispatches the app\'s pipeline-v2.yml on the hotfix branch, and nothing else', () => {
    expect(step('Build the hotfix branch')).toMatchObject({
      // The dispatch action falls back to main without a ref.
      if: "steps.cut.outputs.branch != ''",
      uses: './cru-github-actions/actions/dispatch',
      with: { 'github-token': '${{ secrets.authz-token }}', repo: '${{ steps.app-info.outputs.repository }}', workflow: 'pipeline-v2.yml', ref: '${{ steps.cut.outputs.branch }}', 'inputs-json': '{}' }
    })
    const dispatch = loadYaml('actions/dispatch/action.yml')
    for (const name of Object.keys(step('Build the hotfix branch').with)) expect(dispatch.inputs).toHaveProperty(name)
  })

  it('never pushes, force-pushes or deletes from a script', () => {
    for (const s of job.steps.filter((s) => typeof s.run === 'string')) {
      expect(s.run, s.name).not.toMatch(/git\s+push|--force|--delete|branch\s+-D|git\s+reset/)
    }
  })

  it('reports the app\'s CI without ever failing the run', () => {
    expect(step("Report the app's CI on the hotfix branch")).toMatchObject({
      if: "${{ !cancelled() && steps.cut.outcome == 'success' }}",
      'continue-on-error': true,
      uses: HOTFIX_ACTION,
      with: { mode: 'report', pushed: '${{ steps.cut.outputs.pushed }}', sha: '${{ steps.cut.outputs.head-sha }}', branch: '${{ steps.cut.outputs.branch }}', 'dispatch-outcome': '${{ steps.dispatch.outcome }}' }
    })
  })

  describe('Look up app info (production)', () => {
    const lookup = () => findStep(workflow, 'hotfix', 'Look up app info (production)')
    const context = { 'inputs.project-name': 'example-app' }

    it('reads the app repo from the production row, defaulting to CruGlobal/<project>', async () => {
      const plain = await runShellStep(lookup(), { context, aws: { Item: { Project: { S: 'example-app' }, Environment: { S: 'production' } } } })
      expect(plain.status, plain.stdout + plain.stderr).toBe(0)
      expect(plain.outputs).toEqual({ repository: 'CruGlobal/example-app' })
      const renamed = await runShellStep(lookup(), { context, aws: { Item: { Repository: { S: 'example-org/example-app-web' } } } })
      expect(renamed.outputs).toEqual({ repository: 'example-org/example-app-web' })
    })

    it('refuses an app with no production row: there is no release to hotfix', async () => {
      const result = await runShellStep(lookup(), { context, aws: {} })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("::error title=no_production::example-app has no CruApplicationInfo row for 'production', so there is no production release to hotfix. Nothing was pushed")
      expect(result.outputs).toEqual({})
    })
  })

  it('explains a failed dispatch: the branch is pushed, the build is not', async () => {
    const result = await runShellStep(findStep(workflow, 'hotfix', 'Explain a failed build dispatch'), {
      context: { 'inputs.project-name': 'example-app', 'steps.cut.outputs.branch': 'hotfix/release-2026-10-20-10140', 'steps.app-info.outputs.repository': 'CruGlobal/example-app' }
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^::error title=dispatch_failed::hotfix\/release-2026-10-20-10140 is on CruGlobal\/example-app, but dispatching its pipeline-v2\.yml failed/m)
  })
})

describe('promote', () => {
  const workflow = loadYaml('.github/workflows/promote.yml')
  const KIND = 'Tell a hotfix from a deploy'
  const REFUSE = 'Refuse a hotfix that is not for the live release'

  describe.each(['promote-gcp', 'promote-aws'])('%s', (jobId) => {
    const job = workflow.jobs[jobId]
    const names = job.steps.map((s) => s.name)

    it('checks for a stale hotfix inside the lock, after the baseline and before production changes', () => {
      const kind = names.indexOf(KIND)
      const refuse = names.indexOf(REFUSE)
      expect(kind).toBeGreaterThan(names.indexOf('Fetch production baseline'))
      expect(refuse).toBe(kind + 1)
      expect(refuse).toBeLessThan(names.indexOf('Deploy to production'))
      expect(refuse).toBeLessThan(names.indexOf('Classify rollback safety'))
      expect(job.concurrency.group).toBe('production-${{ inputs.project-name }}')
      expect(findStep(workflow, jobId, KIND).step).toMatchObject({
        id: 'release-kind',
        'continue-on-error': true,
        // A backstop inside the production lock; a timed-out step leaves
        // empty outputs, which the next step lets through.
        'timeout-minutes': 2,
        with: { mode: 'release-kind', 'project-name': '${{ inputs.project-name }}', sha: '${{ steps.baseline.outputs.head-sha }}' }
      })
      // The refusal can fail the job; nothing else may hide it.
      const refuseStep = findStep(workflow, jobId, REFUSE).step
      expect(refuseStep['continue-on-error']).toBeUndefined()
      expect(refuseStep.if).toBeUndefined()
    })

    const refuse = (check, why) => runShellStep(findStep(workflow, jobId, REFUSE), {
      context: {
        'inputs.project-name': 'example-app',
        'secrets.datadog-api-key': 'dd-test',
        'steps.release-kind.outputs.check': check,
        'steps.release-kind.outputs.check-why': why
      }
    })

    it.each([
      ['stale', 'stale_hotfix'],
      ['unconfirmed', 'stale_hotfix'],
      ['ledger_unavailable', 'ledger_unavailable']
    ])('refuses check %s as %s, saying why on one line', async (check, reason) => {
      const result = await refuse(check, 'aaaaaaaaaaaa is a hotfix for release-2026-10-20-10140\n::error::injected')
      expect(result.status).toBe(1)
      const errors = result.stdout.split('\n').filter((line) => line.startsWith('::error'))
      expect(errors).toEqual([`::error title=${reason}::aaaaaaaaaaaa is a hotfix for release-2026-10-20-10140 ::error::injected`])
      expect(result.env).toEqual({ PROMOTE_REFUSED: reason })
    })

    // '' is what a step that timed out or failed leaves behind.
    it.each(['live', 'skipped', '', 'something-newer'])('lets a promote with check %j go on, silently', async (check) => {
      const result = await refuse(check, 'anything')
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.env).toEqual({})
    })
  })
})

describe('every use of the hotfix action', () => {
  const uses = workflowAndActionFiles()
    .filter((file) => file.startsWith('.github/workflows/'))
    .flatMap((file) => Object.entries(loadYaml(file).jobs ?? {}).flatMap(([jobId, job]) =>
      (job.steps ?? []).filter((step) => step.uses === HOTFIX_ACTION).map((step) => [`${file}:${jobId}:${step.name}`, step])))

  it('is in build-candidate, both promote jobs and hotfix.yml', () => {
    expect(uses.map(([where]) => where)).toEqual([
      '.github/workflows/build-candidate.yml:setup:Assert the hotfix branch holds only cherry-picks of default-branch commits',
      '.github/workflows/hotfix.yml:hotfix:Cut the hotfix branch',
      ".github/workflows/hotfix.yml:hotfix:Report the app's CI on the hotfix branch",
      '.github/workflows/promote.yml:promote-gcp:Tell a hotfix from a deploy',
      '.github/workflows/promote.yml:promote-aws:Tell a hotfix from a deploy'
    ])
  })

  it.each(uses)('%s names a mode and passes only declared inputs', (_where, step) => {
    expect(MODES).toContain(step.with.mode)
    for (const name of Object.keys(step.with)) expect(hotfixAction.inputs).toHaveProperty(name)
  })
})
