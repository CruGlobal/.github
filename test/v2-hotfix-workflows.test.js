import { describe, it, expect, afterAll } from 'vitest'
import { generateKeyPairSync, createPrivateKey, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(Object.keys(inputs).sort()).toEqual(['allow-push-access', 'break-glass-team', 'commit', 'expected-release', 'gate-actor-id', 'gate-audience', 'gate-claim-audience', 'gate-claim-url', 'gate-issuer', 'gate-public-keys', 'project-name', 'push-app-client-id', 'push-app-key-role-arn', 'push-app-key-secret-id', 'refused-actor-ids', 'signed-request', 'trusted-automation-actor-ids', 'workflow-ref'])
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
    for (const name of ['push-app-client-id', 'push-app-key-secret-id', 'push-app-key-role-arn']) {
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
      "Explain a failed assume of the push App's role",
      "Mint the push App's token",
      'Cut the hotfix branch',
      "Revoke the push App's token",
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
  const EXPLAIN = "Explain a failed assume of the push App's role"
  const MINT = "Mint the push App's token"
  const CUT = 'Cut the hotfix branch'
  const REVOKE = "Revoke the push App's token"
  const ENABLED = "steps.push-app.outputs.enabled == 'true'"

  const CLIENT_ID = 'Iv1.example'
  const SECRET_ID = 'example-hotfix-push/example-app-key'
  const ROLE_ARN = 'arn:aws:iam::000000000000:role/ExampleHotfixPush'
  const REPOSITORY = 'example-org/example-app'
  const ALL = { clientId: CLIENT_ID, secretId: SECRET_ID, roleArn: ROLE_ARN }
  const INSTALLATION_ID = 4242
  const TOKEN = 'example-installation-token-0001'
  // A throwaway key, made for these tests alone.
  const { privateKey: KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  // The base64 lines of a PEM, which must never show in the log.
  const pemBody = (pem) => pem.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('-----'))
  const KEY_BODY = pemBody(KEY)

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

  const choose = ({ clientId = '', secretId = '', roleArn = '' }, { repository = REPOSITORY, olderAction = false } = {}) => runShellStep(findStep(workflow, 'hotfix', CHOOSE), {
    context: {
      'inputs.project-name': 'example-app',
      'inputs.push-app-client-id': clientId,
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
  // What GitHub answers when it mints the token asked for.
  const minted = (changes = {}) => ({
    token: TOKEN,
    expires_at: '2026-01-01T01:00:00Z',
    permissions: { contents: 'write', metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{ id: 1, name: 'example-app', full_name: REPOSITORY }],
    ...changes
  })
  const mint = ({ secret = KEY, secretFails = false, roleKeys = ROLE_KEYS, githubApp = {} } = {}) => runShellStep(findStep(workflow, 'hotfix', MINT), {
    context: {
      'inputs.project-name': 'example-app',
      'steps.push-app.outputs.client-id': CLIENT_ID,
      'steps.push-app.outputs.key-secret-id': SECRET_ID,
      'steps.push-app.outputs.owner': 'example-org',
      'steps.push-app.outputs.repo': 'example-app',
      ...roleKeys
    },
    runnerEnv: JOB_KEYS,
    awsSecret: secret,
    awsSecretFails: secretFails,
    githubApp: { installation: { id: INSTALLATION_ID, account: { login: 'example-org' } }, token: minted(), ...githubApp }
  })

  const errors = (stdout) => stdout.split('\n').filter((line) => line.startsWith('::error'))
  const masks = (stdout) => stdout.split('\n').filter((line) => line.startsWith('::add-mask::')).map((line) => line.slice('::add-mask::'.length))
  // Everything the step printed, except the lines that register a mask.
  const shown = (result) => `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => !line.startsWith('::add-mask::')).join('\n')
  const BEARER = 'Authorization: Bearer '
  const bearerOf = (call) => call.headers.find((header) => header.startsWith(BEARER))?.slice(BEARER.length)
  const basic = (token) => Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  const refusal = (message) => `::error title=push_app_failed::${message}; refusing to cut a hotfix. Nothing was pushed`

  it('sets the App up after the permission check and right before the cut, revokes its token right after, and stops the job if any of it fails', () => {
    const at = (name) => names.indexOf(name)
    expect(at(CHOOSE)).toBeGreaterThan(at('Authorize actor'))
    expect([ASSUME, EXPLAIN, MINT, CUT, REVOKE].map(at)).toEqual([1, 2, 3, 4, 5].map((n) => at(CHOOSE) + n))
    for (const name of [CHOOSE, ASSUME, EXPLAIN, MINT, REVOKE]) expect(step(name)['continue-on-error'], name).toBeUndefined()
    // The choice always runs, so the cut always learns whether the App is set.
    expect(step(CHOOSE)).toMatchObject({ id: 'push-app' })
    expect(step(CHOOSE).if).toBeUndefined()
    for (const name of [ASSUME, MINT]) expect(step(name).if, name).toBe(ENABLED)
    expect(step(EXPLAIN).if).toBe("failure() && steps.push-role.outcome == 'failure'")
    // On a failed or cancelled cut too, and only once a token was minted.
    expect(step(REVOKE).if).toBe("always() && steps.push-token.outputs.token != ''")
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

  it('keeps the App\'s key inside the one step that mints the token: never a step output or a step input', () => {
    const text = readFileSync(path.join(root, '.github/workflows/hotfix.yml'), 'utf8')
    expect(text).not.toContain('create-github-app-token')
    expect(text).not.toMatch(/private-key|push-key/)
    expect(step(MINT)).toMatchObject({ id: 'push-token' })
    expect(step(MINT).uses).toBeUndefined()
    expect(step(MINT).with).toBeUndefined()
    // The only step that reads the secret, and its only output is the token.
    expect(job.steps.filter((s) => /secretsmanager/.test(s.run ?? '')).map((s) => s.name)).toEqual([MINT])
    expect(step(MINT).run.match(/>> "\$GITHUB_OUTPUT"/g)).toHaveLength(1)
    expect(step(MINT).run).toContain('echo "token=$token" >> "$GITHUB_OUTPUT"')
    expect(step(MINT).run).not.toContain('GITHUB_ENV')
    // The cut gets the token, and nothing else of the App's.
    expect(step(CUT).with['push-token']).toBe('${{ steps.push-token.outputs.token }}')
  })

  it('never traces the steps that hold the key, the JWT or the token, and never runs curl verbose', () => {
    for (const name of [MINT, REVOKE]) {
      const run = step(name).run
      expect(run, name).toMatch(/^set \+x$/m)
      expect(run, name).not.toMatch(/set -x|set -o xtrace|set -[a-z]*x/)
      expect(run, name).not.toMatch(/(^|\s)(-v|--verbose|--trace|--trace-ascii)(\s|$)/m)
    }
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
      expect(result.outputs).toEqual({ enabled: 'true', 'client-id': CLIENT_ID, 'key-secret-id': SECRET_ID, 'key-role-arn': ROLE_ARN, owner: 'example-org', repo: 'example-app' })
      expect(errors(result.stdout)).toEqual([])
    })

    it('trims a stray space or line break at either end', async () => {
      const result = await choose({ clientId: ` ${CLIENT_ID}\n`, secretId: `${SECRET_ID} `, roleArn: `\n${ROLE_ARN}` })
      expect(result.status).toBe(0)
      expect(result.outputs).toMatchObject({ 'client-id': CLIENT_ID, 'key-secret-id': SECRET_ID, 'key-role-arn': ROLE_ARN })
    })

    it.each([
      [{ clientId: CLIENT_ID }, 'push-app-key-secret-id and push-app-key-role-arn are empty'],
      [{ clientId: CLIENT_ID, secretId: SECRET_ID }, 'push-app-key-role-arn is empty'],
      [{ roleArn: ROLE_ARN }, 'push-app-client-id and push-app-key-secret-id are empty'],
      [{ clientId: ' ', secretId: SECRET_ID, roleArn: ROLE_ARN }, 'push-app-client-id is empty']
    ])('refuses a mix of set and empty (%j), naming what is missing', async (inputs, missing) => {
      const result = await choose(inputs)
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(`push-app-client-id, push-app-key-secret-id and push-app-key-role-arn go together, but ${missing}. Set all three to push the hotfix branch as the GitHub App, or none to push it with authz-token`)])
      expect(result.outputs).toEqual({})
    })

    // A line break inside would start a new output line, such as enabled=.
    it.each([
      [{ ...ALL, secretId: 'example key' }, 'push-app-key-secret-id'],
      [{ ...ALL, roleArn: `${ROLE_ARN}\nenabled=false` }, 'push-app-key-role-arn'],
      [{ ...ALL, clientId: 'Iv1.\texample' }, 'push-app-client-id']
    ])('refuses a value with a space or line break inside it (%j)', async (inputs, name) => {
      const result = await choose(inputs)
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(`${name} has a space or a line break inside it`)])
      expect(result.outputs).toEqual({})
    })

    it('refuses a hotfix action from before push-as-app, which would push with authz-token', async () => {
      const result = await choose(ALL, { olderAction: true })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal('the hotfix action at workflow-ref v2 cannot push as a GitHub App (it takes no push-as-app input), so it would push with authz-token. Point workflow-ref at the CruGlobal/.github release that added push-app-client-id, or a later one')])
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
      expect(errors(result.stdout)).toEqual([refusal(`the app repo '${repository}' is not in owner/name form, so a token cannot be limited to it`)])
      expect(result.outputs).toEqual({})
    })
  })

  describe(MINT, () => {
    it('reads the key with the role\'s keys alone, and mints a token for the app repo alone, with contents: write alone', async () => {
      const result = await mint()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs).toEqual({ token: TOKEN })
      expect(errors(result.stdout)).toEqual([])
      expect(result.secretCall).toBe(`secretsmanager get-secret-value --region us-east-1 --secret-id ${SECRET_ID} --query SecretString --output text`)
      expect(result.secretCallKeys).toBe('role-access-key|role-secret-key|role-session-token')
      // The job's own keys are not changed for later steps.
      expect(result.env).toEqual({})
      const calls = result.githubAppCalls
      expect(calls.map(({ method, path, data }) => ({ method, path, data }))).toEqual([
        { method: 'GET', path: 'repos/example-org/example-app/installation', data: '' },
        { method: 'POST', path: `app/installations/${INSTALLATION_ID}/access_tokens`, data: '{"repositories":["example-app"],"permissions":{"contents":"write"}}' }
      ])
      // Both with the one JWT, given on standard input.
      for (const call of calls) {
        expect(call.headers).toEqual([`${BEARER}${bearerOf(call)}`, 'Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28'])
        expect(call.args).toContain('-H @-')
      }
      expect(bearerOf(calls[1])).toBe(bearerOf(calls[0]))
      expect(result.stdout.split('\n').filter((line) => line && !line.startsWith('::add-mask::'))).toEqual([`Minted a token for ${REPOSITORY} alone, with contents: write alone, as the GitHub App ${CLIENT_ID}. It is revoked once the cut is done.`])
    })

    it('signs an RS256 JWT with the App\'s key, issued by the client id a minute ago and ending within nine minutes', async () => {
      const before = Math.floor(Date.now() / 1000)
      const result = await mint()
      const after = Math.floor(Date.now() / 1000)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const jwt = bearerOf(result.githubAppCalls[0])
      const [header, claims, signature] = jwt.split('.')
      const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
      expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
      const { iat, exp, iss, ...rest } = decode(claims)
      expect(rest).toEqual({})
      expect(iss).toBe(CLIENT_ID)
      expect(iat).toBeGreaterThanOrEqual(before - 60)
      expect(iat).toBeLessThanOrEqual(after - 60)
      expect(exp - iat).toBe(600)
      expect(exp).toBeLessThanOrEqual(after + 540)
      // base64url, with no padding, as a JWT is written.
      for (const part of [header, claims, signature]) expect(part).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), PUBLIC_KEY, Buffer.from(signature, 'base64url'))).toBe(true)
    })

    it('masks the JWT, the token and the credential git sends for it, and shows nothing of them, the key or the role\'s keys', async () => {
      const result = await mint()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const jwt = bearerOf(result.githubAppCalls[0])
      expect(masks(result.stdout)).toEqual([jwt, TOKEN, basic(TOKEN)])
      const log = shown(result)
      for (const secret of [jwt, ...jwt.split('.').slice(1), TOKEN, basic(TOKEN), ...KEY_BODY, 'role-secret-key', 'role-session-token']) {
        expect(log).not.toContain(secret)
      }
      // The key is never even masked: no line of it reaches the runner.
      for (const line of KEY_BODY) expect(result.stdout + result.stderr).not.toContain(line)
      // No command line carries the JWT or a token.
      for (const call of result.githubAppCalls) {
        expect(call.args).not.toContain(jwt)
        expect(call.args).not.toContain('Authorization')
      }
    })

    it.each([
      ['a PKCS#8 key', createPrivateKey(KEY).export({ type: 'pkcs8', format: 'pem' })],
      ['a key saved with Windows line endings', KEY.replaceAll('\n', '\r\n')],
      ['a key with blank lines around it', `\n${KEY}\n\n`]
    ])('takes %s', async (_what, secret) => {
      const result = await mint({ secret })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs).toEqual({ token: TOKEN })
    })

    const ONE_LINE = `the Secrets Manager secret ${SECRET_ID} holds the key on one line, with \\n written where its line breaks should be. Store the key file the App's settings page downloads as it is, with its line breaks`
    const SINGLE_LINE = `the Secrets Manager secret ${SECRET_ID} holds a single line, so it is not a PEM key file. Its secret string must be the key file the App's settings page downloads, with its line breaks`
    const NOT_PEM = `the Secrets Manager secret ${SECRET_ID} does not hold a PEM private key. Its secret string must be the key file the App's settings page downloads`
    const NOT_RSA = `the Secrets Manager secret ${SECRET_ID} holds a PEM block that openssl cannot read as an RSA private key with no passphrase. It must be one of the App's private keys, as the App's settings page downloads it`
    it.each([
      ['the key on one line with \\n for its line breaks', KEY.trim().replaceAll('\n', '\\n'), ONE_LINE],
      // The aws CLI prints None for a secret with no secret string.
      ['None', 'None', SINGLE_LINE],
      ['JSON', '{"private_key":"example"}', SINGLE_LINE],
      ['bare base64', KEY_BODY.join(''), SINGLE_LINE],
      ['a public key', PUBLIC_KEY, NOT_PEM],
      ['a key with text before it', `key:\n${KEY}`, NOT_PEM],
      ['a key cut short', KEY.split('\n').slice(0, -2).join('\n'), NOT_PEM],
      ['an EC key', generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey, NOT_RSA],
      ['an RSA block that is not a key', '-----BEGIN RSA PRIVATE KEY-----\nZXhhbXBsZSBub3QgYSBrZXk=\n-----END RSA PRIVATE KEY-----', NOT_RSA]
    ])('refuses %s before asking GitHub for anything, saying nothing of the value', async (_what, secret, message) => {
      const result = await mint({ secret })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(message)])
      expect(result.githubAppCalls).toEqual([])
      expect(result.outputs).toEqual({})
      expect(masks(result.stdout)).toEqual([])
      const log = result.stdout + result.stderr
      for (const line of pemBody(secret.replaceAll('\\n', '\n'))) expect(log).not.toContain(line)
    })

    it('fails, saying what to check, when the key cannot be read', async () => {
      const result = await mint({ secretFails: true })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(`could not read the push App's private key from the Secrets Manager secret ${SECRET_ID} in us-east-1 (see the aws error above). push-app-key-role-arn must be allowed secretsmanager:GetSecretValue on it, and the secret must have a value`)])
      expect(result.githubAppCalls).toEqual([])
      expect(result.outputs).toEqual({})
    })

    it('never reads the key with the job\'s own keys', async () => {
      const result = await mint({ roleKeys: { ...ROLE_KEYS, 'steps.push-role.outputs.aws-access-key-id': '' } })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal("assuming the role that reads the push App's key gave no credentials, so the key was not read")])
      expect(result.secretCall).toBeNull()
    })

    it.each([
      ['401', `GitHub did not take the App's JWT. push-app-client-id must be the App's client id, and ${SECRET_ID} must hold one of the App's current private keys`],
      ['404', `the App is not installed on ${REPOSITORY}`],
      ['000', 'GitHub did not answer'],
      ['500', `push-app-client-id must be the App's client id, and the App must be installed on ${REPOSITORY}`]
    ])('fails, saying what to check, when GitHub answers %s to the installation lookup, and mints nothing', async (status, why) => {
      const result = await mint({ githubApp: { installationStatus: status, installation: { message: 'example error' } } })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(`could not find the GitHub App ${CLIENT_ID}'s installation on ${REPOSITORY} (GitHub answered ${status}): ${why}`)])
      expect(result.githubAppCalls.map(({ method }) => method)).toEqual(['GET'])
      expect(result.outputs).toEqual({})
      // GitHub's answer is not printed.
      expect(shown(result)).not.toContain('example error')
    })

    it('fails when the installation GitHub names has no id', async () => {
      const result = await mint({ githubApp: { installation: { id: 'example' } } })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(`could not find the GitHub App ${CLIENT_ID}'s installation on ${REPOSITORY} (GitHub answered 200): push-app-client-id must be the App's client id, and the App must be installed on ${REPOSITORY}`)])
      expect(result.githubAppCalls).toHaveLength(1)
    })

    it.each([
      ['422', { message: 'The permissions requested are not granted to this installation.' }],
      ['403', { message: 'example error' }],
      ['201', { expires_at: '2026-01-01T01:00:00Z' }]
    ])('fails when GitHub answers %s to minting the token, without printing its answer', async (status, answer) => {
      const result = await mint({ githubApp: { tokenStatus: status, token: answer } })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal(`GitHub did not mint a token for ${REPOSITORY} as the GitHub App ${CLIENT_ID} (GitHub answered ${status}). The App needs Contents: Read and write, and its installation must cover ${REPOSITORY}`)])
      expect(result.outputs).toEqual({})
      expect(shown(result)).not.toContain(answer.message ?? answer.expires_at)
    })

    it('refuses a token that is not a single word, without showing it', async () => {
      const result = await mint({ githubApp: { token: minted({ token: 'example-token\nexample-second-line' }) } })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([refusal("GitHub's answer held a token that is not a single word, so it was not used")])
      expect(result.outputs).toEqual({})
      expect(result.stdout + result.stderr).not.toContain('example-second-line')
    })

    it.each([
      ['a workflows permission too', { permissions: { contents: 'write', metadata: 'read', workflows: 'write' } }],
      ['contents: read', { permissions: { contents: 'read', metadata: 'read' } }],
      ['metadata: write', { permissions: { contents: 'write', metadata: 'write' } }],
      ['no permissions', { permissions: undefined }],
      ['another repo', { repositories: [{ full_name: 'example-org/other-app' }] }],
      ['another repo too', { repositories: [{ full_name: REPOSITORY }, { full_name: 'example-org/other-app' }] }],
      ['no repos', { repositories: undefined }]
    ])('revokes, unused, a token with %s, and refuses', async (_what, changes) => {
      const answer = minted(changes)
      const result = await mint({ githubApp: { token: answer } })
      expect(result.status).toBe(1)
      const granted = JSON.stringify({ permissions: answer.permissions ?? null, repositories: (answer.repositories ?? []).map((repo) => repo.full_name) })
      expect(errors(result.stdout)).toEqual([refusal(`GitHub gave a token with ${granted}, not contents: write on ${REPOSITORY} alone, so it was revoked unused`)])
      expect(result.outputs).toEqual({})
      const revoke = result.githubAppCalls[2]
      expect(result.githubAppCalls).toHaveLength(3)
      expect(revoke).toMatchObject({ method: 'DELETE', path: 'installation/token', data: '' })
      expect(bearerOf(revoke)).toBe(TOKEN)
      expect(revoke.args).not.toContain(TOKEN)
      // Masked before anything about it is said.
      expect(masks(result.stdout)).toEqual([bearerOf(result.githubAppCalls[0]), TOKEN, basic(TOKEN)])
      expect(shown(result)).not.toContain(TOKEN)
    })

    it('warns when that revoke fails, and still refuses', async () => {
      const result = await mint({ githubApp: { token: minted({ permissions: { contents: 'write', workflows: 'write' } }), revokeStatus: '401' } })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('::warning title=push_app_token_not_revoked::GitHub answered 401 to revoking the token it gave. It expires on its own within an hour')
      expect(errors(result.stdout)).toHaveLength(1)
    })

    it.each([
      ['no metadata permission', { permissions: { contents: 'write' } }],
      ['the repo named in other case', { repositories: [{ full_name: 'Example-Org/Example-App' }] }]
    ])('takes a token with %s', async (_what, changes) => {
      const result = await mint({ githubApp: { token: minted(changes) } })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs).toEqual({ token: TOKEN })
      expect(result.githubAppCalls).toHaveLength(2)
    })
  })

  describe(REVOKE, () => {
    const revoke = (githubApp = {}) => runShellStep(findStep(workflow, 'hotfix', REVOKE), {
      context: { 'inputs.project-name': 'example-app', 'steps.push-token.outputs.token': TOKEN },
      githubApp
    })

    it('revokes the token, given to curl on its standard input', async () => {
      const result = await revoke()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toBe("Revoked the push App's token.\n")
      expect(result.githubAppCalls).toHaveLength(1)
      const [call] = result.githubAppCalls
      expect(call).toMatchObject({ method: 'DELETE', path: 'installation/token', data: '' })
      expect(call.headers).toEqual([`${BEARER}${TOKEN}`, 'Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28'])
      expect(call.args).not.toContain(TOKEN)
    })

    it.each(['401', '000'])('only warns when GitHub answers %s, so the run\'s result stays the cut\'s', async (status) => {
      const result = await revoke({ revokeStatus: status })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`::warning title=push_app_token_not_revoked::GitHub answered ${status} to revoking the push App's token. It expires on its own within an hour`)
      expect(result.stdout + result.stderr).not.toContain(TOKEN)
    })
  })

  describe(EXPLAIN, () => {
    it('says what the role must trust when it could not be assumed', async () => {
      const result = await runShellStep(findStep(workflow, 'hotfix', EXPLAIN), {
        context: { 'inputs.project-name': 'example-app', 'steps.push-app.outputs.key-role-arn': ROLE_ARN }
      })
      expect(result.status).toBe(1)
      expect(errors(result.stdout)).toEqual([`::error title=push_app_failed::could not assume ${ROLE_ARN} with this job's OIDC token (see the step above), so the push App's key was not read. The role must trust this reusable workflow as the caller runs it: the caller's repo and ref as the token's sub, and CruGlobal/.github's hotfix.yml, at the ref the caller pinned, as its job_workflow_ref. Nothing was pushed`])
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
