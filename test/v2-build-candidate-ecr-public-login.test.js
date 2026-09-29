import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// The ECR Public login in each candidate build job. public.ecr.aws meters
// anonymous pulls per source IP, and GitHub-hosted runners share their IPs, so
// every build logs Docker in first with a pull-only role named by an org
// variable. The rules under test: every build job has it, a no-change build
// skips it, it never replaces the build role's AWS credentials (later steps
// count builds, resolve and push with those), and it can never fail a build.

const workflow = loadYaml('.github/workflows/build-candidate.yml')
const BUILD_JOBS = ['build-cloudrun', 'build-ecs', 'build-lambda']
const ASSUME = 'Assume the ECR Public pull role'
const LOGIN = 'Log in to ECR Public'
const GUARD = "steps.guard.outputs.found != 'true'"
const CONFIGURE_AWS = 'aws-actions/configure-aws-credentials@'

// The build role the job configured earlier, and the pull role's step outputs.
const BUILD_ROLE_ENV = {
  AWS_ACCESS_KEY_ID: 'build-role-key-id',
  AWS_SECRET_ACCESS_KEY: 'build-role-secret',
  AWS_SESSION_TOKEN: 'build-role-session'
}
const PULL_ROLE = { keyId: 'pull-role-key-id', secret: 'pull-role-secret', session: 'pull-role-session' }
const PASSWORD = 'ecr-public-login-password'

// Fake aws and docker that record what they were given. The shared fakes in
// support/workflow-steps.js answer other services, so these go on a PATH of
// their own.
const FAKE_AWS = `#!/bin/bash
printf '%s\\n' "$*" >> "$ECR_FAKE_OUT/aws-args"
printf '%s %s %s\\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" >> "$ECR_FAKE_OUT/aws-creds"
if [ "$FAKE_AWS_FAILS" = 1 ]; then echo 'An error occurred (AccessDeniedException)' >&2; exit 254; fi
echo '${PASSWORD}'
`
const FAKE_DOCKER = `#!/bin/bash
printf '%s\\n' "$*" >> "$ECR_FAKE_OUT/docker-args"
cat >> "$ECR_FAKE_OUT/docker-stdin"
if [ "$FAKE_DOCKER_FAILS" = 1 ]; then echo 'Error response from daemon: login failed' >&2; exit 1; fi
echo 'Login Succeeded'
`

let fakeBin
beforeAll(() => {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'ecr-public-fakes-'))
  for (const [name, body] of Object.entries({ aws: FAKE_AWS, docker: FAKE_DOCKER })) {
    writeFileSync(path.join(fakeBin, name), body)
    chmodSync(path.join(fakeBin, name), 0o755)
  }
})
afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true })
  removeFakes()
})

const stepIndex = (steps, test) => steps.findIndex(test)

// Run one job's login step the way the runner would, after the build role's
// credentials are in the job env. Resolves to the result plus what the fakes
// recorded, and whether the step wrote to the job env ($GITHUB_ENV).
async function runLogin (jobId, { roleArn = 'role-arn-from-org-variable', outcome = 'success', outputs = PULL_ROLE, awsFails = false, dockerFails = false } = {}) {
  const out = mkdtempSync(path.join(tmpdir(), 'ecr-public-login-'))
  try {
    const result = await runShellStep(findStep(workflow, jobId, LOGIN), {
      context: {
        'needs.setup.outputs.project-name': 'example-app',
        'vars.ECR_PUBLIC_PULL_ROLE_ARN': roleArn,
        'steps.ecr-public-role.outcome': outcome,
        'steps.ecr-public-role.outputs.aws-access-key-id': outputs.keyId,
        'steps.ecr-public-role.outputs.aws-secret-access-key': outputs.secret,
        'steps.ecr-public-role.outputs.aws-session-token': outputs.session
      },
      runnerEnv: {
        ...BUILD_ROLE_ENV,
        PATH: `${fakeBin}:${process.env.PATH}`,
        GITHUB_ENV: path.join(out, 'github-env'),
        ECR_FAKE_OUT: out,
        FAKE_AWS_FAILS: awsFails ? '1' : '',
        FAKE_DOCKER_FAILS: dockerFails ? '1' : ''
      }
    })
    const read = (name) => existsSync(path.join(out, name)) ? readFileSync(path.join(out, name), 'utf8') : null
    return {
      ...result,
      aws: read('aws-args'),
      awsCreds: read('aws-creds'),
      docker: read('docker-args'),
      dockerStdin: read('docker-stdin'),
      wroteJobEnv: existsSync(path.join(out, 'github-env'))
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

describe.each(BUILD_JOBS)('the ECR Public login in %s', (jobId) => {
  const { steps } = workflow.jobs[jobId]
  const assume = findStep(workflow, jobId, ASSUME).step
  const login = findStep(workflow, jobId, LOGIN).step

  it('runs after the build role and the no-change guard, and before buildx and the build', () => {
    const buildRole = stepIndex(steps, (s) => s.uses?.startsWith(CONFIGURE_AWS) && s !== assume)
    const guard = stepIndex(steps, (s) => s.id === 'guard')
    const buildx = stepIndex(steps, (s) => s.uses?.startsWith('docker/setup-buildx-action@'))
    const build = stepIndex(steps, (s) => s.name === 'Run build.sh')
    const order = [buildRole, guard, steps.indexOf(assume), steps.indexOf(login), buildx, build]
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('is skipped on a no-change build, and the assume also when the variable is unset', () => {
    expect(assume.if).toContain(GUARD)
    expect(assume.if).toContain("vars.ECR_PUBLIC_PULL_ROLE_ARN != ''")
    expect(login.if).toBe(GUARD)
  })

  it('hands the pull role out as step outputs and never exports it over the build role', () => {
    expect(assume.uses).toBe(`${CONFIGURE_AWS}v6`)
    expect(assume.id).toBe('ecr-public-role')
    expect(assume.with['role-to-assume']).toBe('${{ vars.ECR_PUBLIC_PULL_ROLE_ARN }}')
    expect(String(assume.with['output-credentials'])).toBe('true')
    expect(String(assume.with['output-env-credentials'])).toBe('false')
    // Each of these would touch the job's existing credentials or reuse them.
    for (const input of ['unset-current-credentials', 'role-chaining', 'aws-profile', 'aws-access-key-id', 'use-existing-credentials']) {
      expect(assume.with).not.toHaveProperty(input)
    }
    // The build role's step stays the only one in the job that exports credentials.
    const exporting = steps.filter((s) => s.uses?.startsWith(CONFIGURE_AWS) && String(s.with?.['output-env-credentials']) !== 'false')
    expect(exporting).toHaveLength(1)
    expect(exporting[0]).not.toBe(assume)
    expect(login.run).not.toMatch(/GITHUB_ENV|GITHUB_PATH/)
  })

  it('can never fail the build', () => {
    expect(assume['continue-on-error']).toBe(true)
    expect(login['continue-on-error']).toBe(true)
  })

  it('passes expressions through env, never inline in the script', () => {
    expect(login.run).not.toMatch(/\$\{\{/)
  })

  it('is the same pair of steps as the Cloud Run job', () => {
    expect(assume).toEqual(findStep(workflow, 'build-cloudrun', ASSUME).step)
    expect(login).toEqual(findStep(workflow, 'build-cloudrun', LOGIN).step)
  })

  it('logs Docker in with the pull role only, over stdin, leaving the job env alone', async () => {
    const result = await runLogin(jobId)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toMatch(/::warning/)
    expect(result.aws).toBe('ecr-public get-login-password --region us-east-1\n')
    expect(result.awsCreds).toBe(`${PULL_ROLE.keyId} ${PULL_ROLE.secret} ${PULL_ROLE.session}\n`)
    expect(result.docker).toBe('login --username AWS --password-stdin public.ecr.aws\n')
    expect(result.dockerStdin).toBe(`${PASSWORD}\n`)
    expect(result.stdout + result.stderr).not.toContain(PASSWORD)
    expect(result.wroteJobEnv).toBe(false)
  })

  it('warns and carries on when the org variable is unset', async () => {
    const result = await runLogin(jobId, { roleArn: '', outcome: 'skipped', outputs: { keyId: '', secret: '', session: '' } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/::warning title=ECR Public login skipped::ECR_PUBLIC_PULL_ROLE_ARN is not set.*stay anonymous/)
    expect(result.aws).toBeNull()
    expect(result.docker).toBeNull()
  })

  it('warns and carries on when the role could not be assumed', async () => {
    const result = await runLogin(jobId, { outcome: 'failure', outputs: { keyId: '', secret: '', session: '' } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/::warning title=ECR Public login skipped::could not assume.*stay anonymous/)
    expect(result.aws).toBeNull()
    expect(result.docker).toBeNull()
  })

  it('warns and carries on when the token request fails', async () => {
    const result = await runLogin(jobId, { awsFails: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/::warning title=ECR Public login failed::.*stay anonymous/)
    expect(result.wroteJobEnv).toBe(false)
  })

  it('warns and carries on when docker login fails', async () => {
    const result = await runLogin(jobId, { dockerFails: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/::warning title=ECR Public login failed::.*stay anonymous/)
    expect(result.wroteJobEnv).toBe(false)
  })
})
