import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { root, loadYaml, findStep, runShellStep, removeFakes, workflowAndActionFiles } from './support/workflow-steps.js'
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
    expect(Object.keys(inputs).sort()).toEqual(['allow-push-access', 'break-glass-team', 'commit', 'expected-release', 'gate-actor-id', 'gate-audience', 'gate-claim-audience', 'gate-claim-url', 'gate-issuer', 'gate-public-keys', 'project-name', 'push-app-id', 'push-app-key-role-arn', 'push-app-key-secret-id', 'refused-actor-ids', 'signed-request', 'trusted-automation-actor-ids', 'workflow-ref'])
    for (const name of ['commit', 'expected-release', 'project-name']) expect(inputs[name].required, name).toBe(true)
    expect(inputs['trusted-automation-actor-ids']).toMatchObject({ required: false, default: '' })
    expect(inputs['refused-actor-ids']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(inputs['break-glass-team']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(inputs['allow-push-access']).toMatchObject({ type: 'string', required: false, default: 'true' })
    expect(inputs['gate-claim-url']).toMatchObject({ type: 'string', required: false, default: '' })
    expect(inputs['gate-claim-audience']).toMatchObject({ type: 'string', required: false, default: '' })
    for (const name of ['gate-actor-id', 'signed-request', 'gate-public-keys', 'gate-issuer', 'gate-audience']) {
      expect(inputs[name], name).toMatchObject({ type: 'string', required: false, default: '' })
    }
    // Empty pushes with authz-token, as before.
    for (const name of ['push-app-id', 'push-app-key-secret-id', 'push-app-key-role-arn']) {
      expect(inputs[name], name).toMatchObject({ type: 'string', required: false, default: '' })
    }
    expect(inputs['workflow-ref']).toMatchObject({ required: false, default: 'main' })
    expect(secrets).toEqual({ 'authz-token': expect.objectContaining({ required: true }) })
  })

  it('runs one hotfix per app at a time, never cancelling one in flight, and not in the production lock', () => {
    // The authorize job runs first, outside the lock (see
    // v2-gate-wiring.test.js), and the hotfix job waits for it.
    expect(Object.keys(workflow.jobs)).toEqual(['authorize', 'hotfix'])
    expect(job.needs).toBe('authorize')
    expect(workflow.jobs.authorize.concurrency).toBeUndefined()
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
      'Choose who pushes the hotfix branch',
      "Assume the role that reads the push App's key",
      "Read the push App's private key",
      "Mint the push App's token",
      'Explain a failed push App setup',
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
        'refused-actor-ids': '${{ inputs.refused-actor-ids }}',
        'break-glass-team': '${{ inputs.break-glass-team }}',
        'allow-push-access': '${{ inputs.allow-push-access }}',
        'gate-claim-url': '${{ inputs.gate-claim-url }}',
        'gate-claim-audience': '${{ inputs.gate-claim-audience }}',
        'gate-actor-id': '${{ inputs.gate-actor-id }}',
        'signed-request': '${{ inputs.signed-request }}',
        'gate-public-keys': '${{ inputs.gate-public-keys }}',
        'gate-issuer': '${{ inputs.gate-issuer }}',
        'gate-audience': '${{ inputs.gate-audience }}',
        'expected-app': '${{ inputs.project-name }}',
        'expected-action': 'hotfix',
        'expected-target': '${{ inputs.commit }}',
        'refusal-title': 'actor_not_allowed'
      }
    })
    expect(step('Checkout the app repo').with).toEqual({ repository: '${{ steps.app-info.outputs.repository }}', token: '${{ secrets.authz-token }}', 'fetch-depth': 0, path: 'app' })
    expect(step('Cut the hotfix branch')).toMatchObject({
      id: 'cut',
      uses: HOTFIX_ACTION,
      with: {
        mode: 'cut',
        path: 'app',
        'project-name': '${{ inputs.project-name }}',
        commit: '${{ inputs.commit }}',
        'expected-release': '${{ inputs.expected-release }}',
        'push-as-app': '${{ steps.push-app.outputs.enabled }}',
        'push-token': '${{ steps.push-token.outputs.token }}'
      }
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

describe('hotfix.yml: pushing as a GitHub App', () => {
  const workflow = loadYaml('.github/workflows/hotfix.yml')
  const job = workflow.jobs.hotfix
  const names = job.steps.map((s) => s.name)
  const step = (name) => findStep(workflow, 'hotfix', name).step
  const CHOOSE = 'Choose who pushes the hotfix branch'
  const ASSUME = "Assume the role that reads the push App's key"
  const READ = "Read the push App's private key"
  const MINT = "Mint the push App's token"
  const EXPLAIN = 'Explain a failed push App setup'
  const ENABLED = "steps.push-app.outputs.enabled == 'true'"

  const APP_ID = '123456'
  const SECRET_ID = 'example-hotfix-push/example-app-key'
  const ROLE_ARN = 'arn:aws:iam::000000000000:role/ExampleHotfixPush'
  const REPOSITORY = 'example-org/example-app'
  const ALL = { appId: APP_ID, secretId: SECRET_ID, roleArn: ROLE_ARN }
  // Made up: base64 of plain text, in a PEM's shape.
  const KEY_LINES = ['ZXhhbXBsZSBrZXkgbGluZSBvbmUsIGZvciBhIHRlc3Qgb25seSwgbm90IGEga2V5', 'ZXhhbXBsZSBrZXkgbGluZSB0d28=']
  const KEY = ['-----BEGIN RSA PRIVATE KEY-----', ...KEY_LINES, '-----END RSA PRIVATE KEY-----'].join('\n')

  // The job's workspace, with this repo where the job checks CruGlobal/.github
  // out, or with a hotfix action from before push-as-app there.
  const workspaces = []
  afterAll(() => { for (const dir of workspaces) rmSync(dir, { recursive: true, force: true }) })
  function workspace ({ olderAction = false } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hotfix-workspace-'))
    workspaces.push(dir)
    if (olderAction) {
      const actionDir = path.join(dir, 'cru-github-actions', 'actions', 'hotfix')
      mkdirSync(actionDir, { recursive: true })
      writeFileSync(path.join(actionDir, 'action.yml'), "name: Hotfix\ninputs:\n  mode:\n    required: true\n  path:\n    default: '.'\nruns:\n  using: 'node24'\n  main: '../../dist/hotfix.js'\n")
    } else {
      symlinkSync(root, path.join(dir, 'cru-github-actions'))
    }
    return dir
  }

  const choose = ({ appId = '', secretId = '', roleArn = '' }, { repository = REPOSITORY, olderAction = false } = {}) => runShellStep(findStep(workflow, 'hotfix', CHOOSE), {
    context: {
      'inputs.project-name': 'example-app',
      'inputs.push-app-id': appId,
      'inputs.push-app-key-secret-id': secretId,
      'inputs.push-app-key-role-arn': roleArn,
      'inputs.workflow-ref': 'v2',
      'steps.app-info.outputs.repository': repository
    },
    runnerEnv: { GITHUB_WORKSPACE: workspace({ olderAction }) }
  })

  const ROLE_KEYS = { 'steps.push-role.outputs.aws-access-key-id': 'role-access-key', 'steps.push-role.outputs.aws-secret-access-key': 'role-secret-key', 'steps.push-role.outputs.aws-session-token': 'role-session-token' }
  // The job's own keys, from the deploy role it assumed first.
  const JOB_KEYS = { AWS_ACCESS_KEY_ID: 'deploy-access-key', AWS_SECRET_ACCESS_KEY: 'deploy-secret-key', AWS_SESSION_TOKEN: 'deploy-session-token' }
  const read = (options = {}, roleKeys = ROLE_KEYS) => runShellStep(findStep(workflow, 'hotfix', READ), {
    context: { 'inputs.project-name': 'example-app', 'steps.push-app.outputs.key-secret-id': SECRET_ID, ...roleKeys },
    runnerEnv: JOB_KEYS,
    ...options
  })
  const errors = (stdout) => stdout.split('\n').filter((line) => line.startsWith('::error'))

  it('sets the App up after the permission check and right before the cut, and stops the job if any of it fails', () => {
    const at = (name) => names.indexOf(name)
    expect(at(CHOOSE)).toBeGreaterThan(at('Authorize actor'))
    expect([ASSUME, READ, MINT, EXPLAIN, 'Cut the hotfix branch'].map(at)).toEqual([1, 2, 3, 4, 5].map((n) => at(CHOOSE) + n))
    for (const name of [CHOOSE, ASSUME, READ, MINT, EXPLAIN]) expect(step(name)['continue-on-error'], name).toBeUndefined()
    // The choice always runs, so the cut always learns whether the App is set.
    expect(step(CHOOSE)).toMatchObject({ id: 'push-app' })
    expect(step(CHOOSE).if).toBeUndefined()
    for (const name of [ASSUME, READ, MINT]) expect(step(name).if, name).toBe(ENABLED)
    expect(step(EXPLAIN).if).toBe("failure() && (steps.push-role.outcome == 'failure' || steps.push-token.outcome == 'failure')")
  })

  it('assumes the role in this job, keeping its keys out of the job env, so the deploy role stays the job\'s AWS identity', () => {
    expect(step(ASSUME)).toMatchObject({ id: 'push-role', uses: step('Configure AWS credentials for app-info').uses })
    expect(step(ASSUME).with).toEqual({
      'aws-region': 'us-east-1',
      'role-to-assume': '${{ steps.push-app.outputs.key-role-arn }}',
      'output-credentials': true,
      'output-env-credentials': false,
      'retry-max-attempts': 2
    })
    // Nothing after the deploy role sets the job's AWS keys again.
    const awsKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']
    for (const s of job.steps.slice(1)) {
      for (const key of awsKeys) expect(Object.keys(s.env ?? {}), `${s.name} sets ${key}`).not.toContain(key)
      expect(s.uses === 'aws-actions/configure-aws-credentials@v6' ? s.with['output-env-credentials'] : false, s.name).toBe(false)
    }
  })

  it('mints a token for the app repo alone, with contents: write and no other permission', () => {
    expect(step(MINT)).toMatchObject({ id: 'push-token', uses: 'actions/create-github-app-token@v3' })
    expect(step(MINT).with).toEqual({
      'client-id': '${{ steps.push-app.outputs.app-id }}',
      'private-key': '${{ steps.push-key.outputs.private-key }}',
      owner: '${{ steps.push-app.outputs.owner }}',
      repositories: '${{ steps.push-app.outputs.repo }}',
      'permission-contents': 'write'
    })
  })

  describe(CHOOSE, () => {
    it('keeps authz-token, silently, when none of the three is set', async () => {
      const result = await choose({})
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs).toEqual({ enabled: 'false' })
      expect(errors(result.stdout)).toEqual([])
    })

    it('chooses the App when all three are set, with the app repo split for the token', async () => {
      const result = await choose(ALL)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs).toEqual({ enabled: 'true', 'app-id': APP_ID, 'key-secret-id': SECRET_ID, 'key-role-arn': ROLE_ARN, owner: 'example-org', repo: 'example-app' })
      expect(errors(result.stdout)).toEqual([])
    })

    it('trims a stray space or line break at either end', async () => {
      const result = await choose({ appId: ` ${APP_ID}\n`, secretId: `${SECRET_ID} `, roleArn: `\n${ROLE_ARN}` })
      expect(result.status).toBe(0)
      expect(result.outputs).toMatchObject({ 'app-id': APP_ID, 'key-secret-id': SECRET_ID, 'key-role-arn': ROLE_ARN })
    })

    it.each([
      [{ appId: APP_ID }, 'push-app-key-secret-id and push-app-key-role-arn are empty'],
      [{ appId: APP_ID, secretId: SECRET_ID }, 'push-app-key-role-arn is empty'],
      [{ roleArn: ROLE_ARN }, 'push-app-id and push-app-key-secret-id are empty'],
      [{ appId: ' ', secretId: SECRET_ID, roleArn: ROLE_ARN }, 'push-app-id is empty']
    ])('refuses a mix of set and empty (%j), naming what is missing', async (inputs, missing) => {
      const result = await choose(inputs)
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::push-app-id, push-app-key-secret-id and push-app-key-role-arn go together, but ${missing}. Set all three to push the hotfix branch as the GitHub App, or none to push it with authz-token; refusing to cut a hotfix. Nothing was pushed`])
      expect(result.outputs).toEqual({})
    })

    // A line break inside would start a new output line, such as enabled=.
    it.each([
      [{ ...ALL, secretId: 'example key' }, 'push-app-key-secret-id'],
      [{ ...ALL, roleArn: `${ROLE_ARN}\nenabled=false` }, 'push-app-key-role-arn'],
      [{ ...ALL, appId: '12\t34' }, 'push-app-id']
    ])('refuses a value with a space or line break inside it (%j)', async (inputs, name) => {
      const result = await choose(inputs)
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::${name} has a space or a line break inside it; refusing to cut a hotfix. Nothing was pushed`])
      expect(result.outputs).toEqual({})
    })

    it('refuses a hotfix action from before push-as-app, which would push with authz-token', async () => {
      const result = await choose(ALL, { olderAction: true })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual(["::error title=push_app_failed::the hotfix action at workflow-ref v2 cannot push as a GitHub App (it takes no push-as-app input), so it would push with authz-token. Point workflow-ref at the CruGlobal/.github release that added push-app-id, or a later one; refusing to cut a hotfix. Nothing was pushed"])
      expect(result.outputs).toEqual({})
    })

    it('lets an older hotfix action push with authz-token as before when the App is not set', async () => {
      const result = await choose({}, { olderAction: true })
      expect(result.status).toBe(0)
      expect(result.outputs).toEqual({ enabled: 'false' })
    })

    it.each(['example-app', 'example-org/example-app/extra', '/example-app', 'example-org/'])('refuses an app repo that is not owner/name (%j)', async (repository) => {
      const result = await choose(ALL, { repository })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::the app repo '${repository}' is not in owner/name form, so a token cannot be limited to it; refusing to cut a hotfix. Nothing was pushed`])
      expect(result.outputs).toEqual({})
    })
  })

  describe(READ, () => {
    it('reads the key with the role\'s keys alone, masks every line of it first, and passes it on', async () => {
      const result = await read({ awsSecret: KEY })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs).toEqual({ 'private-key': KEY })
      expect(result.secretCall).toBe(`secretsmanager get-secret-value --region us-east-1 --secret-id ${SECRET_ID} --query SecretString --output text`)
      expect(result.secretCallKeys).toBe('role-access-key|role-secret-key|role-session-token')
      // The job's own keys are not changed for later steps.
      expect(result.env).toEqual({})
      const lines = result.stdout.split('\n').filter(Boolean)
      expect(lines.slice(0, KEY_LINES.length)).toEqual(KEY_LINES.map((line) => `::add-mask::${line}`))
      expect(lines.slice(KEY_LINES.length)).toEqual([`Read the push App's private key from ${SECRET_ID}.`])
    })

    it('masks the lines of a key saved with Windows line endings without their carriage returns', async () => {
      const result = await read({ awsSecret: KEY.replaceAll('\n', '\r\n') })
      expect(result.status).toBe(0)
      expect(result.stdout.split('\n').filter((line) => line.startsWith('::add-mask::'))).toEqual(KEY_LINES.map((line) => `::add-mask::${line}`))
    })

    it('fails, saying what to check, when the key cannot be read', async () => {
      const result = await read({ awsSecret: KEY, awsSecretFails: true })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::could not read the push App's private key from the Secrets Manager secret ${SECRET_ID} in us-east-1 (see the aws error above). push-app-key-role-arn must be allowed secretsmanager:GetSecretValue on it, and the secret must have a value; refusing to cut a hotfix. Nothing was pushed`])
      expect(result.outputs).toEqual({})
    })

    // The aws CLI prints None for a secret with no secret string.
    it.each(['None', '{"private_key":"example"}', 'ZXhhbXBsZQ=='])('fails when the secret is not a PEM private key (%j), and passes nothing on', async (secret) => {
      const result = await read({ awsSecret: secret })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::the Secrets Manager secret ${SECRET_ID} does not hold a PEM private key. Its secret string must be the key file the App's settings page downloads; refusing to cut a hotfix. Nothing was pushed`])
      expect(result.outputs).toEqual({})
    })

    it('never reads the key with the job\'s own keys', async () => {
      const result = await read({ awsSecret: KEY }, { ...ROLE_KEYS, 'steps.push-role.outputs.aws-access-key-id': '' })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual(["::error title=push_app_failed::assuming the role that reads the push App's key gave no credentials, so the key was not read; refusing to cut a hotfix. Nothing was pushed"])
      expect(result.secretCall).toBeNull()
    })
  })

  describe(EXPLAIN, () => {
    const explain = (roleOutcome) => runShellStep(findStep(workflow, 'hotfix', EXPLAIN), {
      context: {
        'inputs.project-name': 'example-app',
        'steps.push-role.outcome': roleOutcome,
        'steps.push-app.outputs.key-role-arn': ROLE_ARN,
        'steps.push-app.outputs.app-id': APP_ID,
        'steps.push-app.outputs.key-secret-id': SECRET_ID,
        'steps.app-info.outputs.repository': REPOSITORY
      }
    })

    it('says what the role must trust when it could not be assumed', async () => {
      const result = await explain('failure')
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::could not assume ${ROLE_ARN} with this job's OIDC token (see the step above), so the push App's key was not read. The role must trust this job: the caller's repo and ref as the token's sub, and CruGlobal/.github's hotfix.yml, at the ref the caller pinned, as its job_workflow_ref. Nothing was pushed`])
    })

    it('says what the App needs when its token could not be minted', async () => {
      const result = await explain('success')
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::could not mint a token for the GitHub App ${APP_ID} on ${REPOSITORY} (see the step above). The App must be installed on ${REPOSITORY} with Contents: Read and write, and ${SECRET_ID} must hold one of the App's current private keys. Nothing was pushed`])
    })
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
      // The step that sets head-sha, which the kind step reads.
      expect(names.indexOf('Pick the commits to compare')).toBeGreaterThanOrEqual(0)
      expect(kind).toBeGreaterThan(names.indexOf('Pick the commits to compare'))
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

  it('is in build-candidate, the three deploy-candidate jobs, both promote jobs and hotfix.yml', () => {
    expect(uses.map(([where]) => where)).toEqual([
      '.github/workflows/build-candidate.yml:setup:Assert the hotfix branch holds only cherry-picks of default-branch commits',
      '.github/workflows/deploy-candidate.yml:deploy-candidate-gcp:Tell a hotfix candidate from an ordinary one',
      '.github/workflows/deploy-candidate.yml:deploy-candidate-aws:Tell a hotfix candidate from an ordinary one',
      '.github/workflows/deploy-candidate.yml:verify-candidate-aws:Tell a hotfix candidate from an ordinary one',
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
