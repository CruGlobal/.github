import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { root, loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// Every place the v2 workflows decide something by an app's type, with static
// added. The type guards run under bash as the runner would run them. The
// rule they pin: each AWS job picks its deploy role in the guard step, and a
// type the guard does not know stops there instead of falling through to
// another type's role.

afterAll(removeFakes)

const workflows = Object.fromEntries(['build-candidate.yml', 'deploy-candidate.yml', 'promote.yml', 'rollback.yml']
  .map(file => [file, loadYaml(`.github/workflows/${file}`)]))

const CONTEXT = {
  'inputs.project-name': 'example-app',
  'secrets.datadog-api-key': 'dd-test',
  "secrets.slack-bot-token != ''": 'true'
}
const guard = (file, job, type) => runShellStep(findStep(workflows[file], job, 'Guard supported AWS type'), {
  context: { ...CONTEXT, 'needs.lookup.outputs.type': type }
})

// The role ARN in the account the workflow names, with the role's name taken
// from the guard step and nothing else.
const ROLE_FROM_GUARD = /^arn:aws:iam::\d{12}:role\/\$\{\{ steps\.aws-type\.outputs\.role \}\}$/

const DEPLOY_JOBS = [
  ['deploy-candidate.yml', 'deploy-candidate-aws'],
  ['promote.yml', 'promote-aws'],
  ['rollback.yml', 'rollback-aws']
]

describe.each(DEPLOY_JOBS)('%s:%s type guard', (file, job) => {
  it.each([
    ['ecs', 'GitHubDeployECS'],
    ['lambda', 'GitHubDeployLambda'],
    ['static', 'GitHubDeployStatic']
  ])('picks the %s deploy role', async (type, role) => {
    const result = await guard(file, job, type)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.outputs).toEqual({ role })
  })

  it.each(['serverless', 'fargate', '', 'Static', 'cloudrun'])('stops on type %j and picks no role', async (type) => {
    const result = await guard(file, job, type)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`::error::v2 AWS deploys support types 'ecs', 'lambda' and 'static' (got '${type}')`)
    expect(result.outputs).toEqual({})
  })

  it('keeps a type that holds a line break on the error\'s one line', async () => {
    const result = await guard(file, job, 'ecs\n::notice::injected')
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toMatch(/^::notice::injected/m)
  })

  it('assumes the role the guard picked, and nothing else', () => {
    const steps = workflows[file].jobs[job].steps
    const guardAt = steps.findIndex(step => step.name === 'Guard supported AWS type')
    const credentialsAt = steps.findIndex(step => step.name === 'Configure AWS credentials')
    expect(steps[guardAt].id).toBe('aws-type')
    expect(guardAt).toBeLessThan(credentialsAt)
    expect(steps[credentialsAt].with['role-to-assume']).toMatch(ROLE_FROM_GUARD)
  })
})

describe('deploy-candidate.yml:verify-candidate-aws type guard', () => {
  it.each([['ecs', 'GitHubDeployECS'], ['lambda', 'GitHubDeployLambda']])('picks the %s role', async (type, role) => {
    const result = await guard('deploy-candidate.yml', 'verify-candidate-aws', type)
    expect(result.status).toBe(0)
    expect(result.outputs).toEqual({ role })
  })

  it('refuses a static site, which cannot be stage-less', async () => {
    const result = await guard('deploy-candidate.yml', 'verify-candidate-aws', 'static')
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("::error::RcMode 'verify' (stage-less) is not supported for static sites yet")
    expect(result.outputs).toEqual({})
  })

  it.each(['serverless', ''])('stops on type %j', async (type) => {
    const result = await guard('deploy-candidate.yml', 'verify-candidate-aws', type)
    expect(result.status).not.toBe(0)
    expect(result.outputs).toEqual({})
  })

  it('assumes the role the guard picked', () => {
    const { step } = findStep(workflows['deploy-candidate.yml'], 'verify-candidate-aws', 'Configure AWS credentials')
    expect(step.with['role-to-assume']).toMatch(ROLE_FROM_GUARD)
  })
})

// The old expression, `type == 'lambda' && 'GitHubDeployLambda' ||
// 'GitHubDeployECS'`, gave every type that was not lambda the ECS role. No
// workflow may pick a deploy role by an expression like that again.
it('no workflow picks a deploy role with an expression that can fall through', () => {
  const dir = path.join(root, '.github/workflows')
  for (const name of readdirSync(dir).filter(file => /\.ya?ml$/.test(file))) {
    const text = readFileSync(path.join(dir, name), 'utf8')
    expect(text, name).not.toMatch(/&&\s*'GitHubDeploy\w+'\s*\|\|/)
  }
})

describe('the deploy steps name the release they record', () => {
  it.each([
    ['deploy-candidate.yml', 'deploy-candidate-aws', 'Deploy to release-candidate', '${{ inputs.tag }}', undefined],
    ['promote.yml', 'promote-aws', 'Deploy to production', '${{ steps.release.outputs.release }}', undefined],
    ['rollback.yml', 'rollback-aws', 'Deploy to production', '${{ steps.actual-release.outputs.tag }}', 'false']
  ])('%s:%s', (file, job, name, revision, stop) => {
    const { step } = findStep(workflows[file], job, name)
    expect(step.with.revision).toBe(revision)
    expect(step.with.type).toBe('${{ needs.lookup.outputs.type }}')
    expect(step.with['stop-rollout-on-failure']).toBe(stop)
  })

  it('promote tags a static site\'s release in the same step as any AWS type', () => {
    const { step } = findStep(workflows['promote.yml'], 'promote-aws', 'Tag digest as release')
    expect(step.with.type).toBe('${{ needs.lookup.outputs.type }}')
  })
})

describe('build-candidate', () => {
  const validate = (type) => runShellStep(findStep(workflows['build-candidate.yml'], 'setup', 'Resolve project name & validate type'), {
    context: { 'inputs.type': type, 'inputs.project-name': 'example-app' }
  })

  it.each(['ecs', 'lambda', 'cloudrun', 'static'])('accepts type %s', async (type) => {
    const result = await validate(type)
    expect(result.status, result.stdout).toBe(0)
    expect(result.outputs['project-name']).toBe('example-app')
  })

  it.each(['serverless', 'Static', ''])('refuses type %j', async (type) => {
    const result = await validate(type)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`::error::unknown type '${type}'; expected ecs, lambda, cloudrun, or static`)
  })

  it('keeps a type that holds a line break on the error\'s one line', async () => {
    const result = await validate('x\n::notice::injected')
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toMatch(/^::notice::injected/m)
  })

  it('builds a static site in the ECR job ECS uses, and in no other', () => {
    const jobs = workflows['build-candidate.yml'].jobs
    expect(jobs['build-ecs'].if).toBe("inputs.type == 'ecs' || inputs.type == 'static'")
    expect(jobs['build-ecs'].name).toBe("Build Candidate (${{ inputs.type == 'static' && 'static site' || 'ECS' }})")
    expect(jobs['build-lambda'].if).toBe("inputs.type == 'lambda'")
    expect(jobs['build-cloudrun'].if).toBe("inputs.type == 'cloudrun'")
    // So the outputs and the failure notice, which read the ECS job, cover it.
    expect(workflows['build-candidate.yml'].on.workflow_call.outputs.digest.value).toContain('jobs.build-ecs.outputs.digest')
    expect(jobs['notify-failure'].needs).toContain('build-ecs')
  })
})

// The lookups that route on type refuse a gcp row typed anything but
// cloudrun, so a static row with the wrong provider fails loudly instead of
// being deployed as a Cloud Run service. The Cloud Run module always writes
// Type "cloudrun", so its rows pass as before.
describe('a gcp row must be typed cloudrun', () => {
  const LOOKUPS = [
    ['deploy-candidate.yml', 'lookup', 'Look up app info', 'staging'],
    ['promote.yml', 'lookup', 'Look up app info (release-candidate)', 'staging'],
    ['rollback.yml', 'lookup', 'Look up app info (production)', 'production']
  ]
  const gcpRow = type => ({
    Provider: { S: 'gcp' }, Type: { S: type }, PipelineVersion: { S: '2' }, ProjectId: { S: 'example-app-stage-0000' }, FlightdeckProject: { S: 'EXAMPLE' }
  })
  const run = (file, job, name, item) => runShellStep(findStep(workflows[file], job, name), {
    context: { 'inputs.project-name': 'example-app' },
    aws: { Item: item }
  })

  describe.each(LOOKUPS)('%s %s', (file, job, name, legacy) => {
    it.each(['static', 'ecs', ''])('refuses a gcp row of type %j, before anything else', async (type) => {
      const result = await run(file, job, name, gcpRow(type))
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain(
        `::error::example-app's CruApplicationInfo row for '${legacy}' has provider 'gcp' and type '${type}', but pipeline v2 deploys only type 'cloudrun' on gcp. Nothing was changed.`
      )
      expect(result.outputs).toEqual({})
    })

    it('lets a Cloud Run row through, as before', async () => {
      const result = await run(file, job, name, gcpRow('cloudrun'))
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs.provider).toBe('gcp')
    })

    it('lets an aws static row through', async () => {
      const result = await run(file, job, name, { ...gcpRow('static'), Provider: { S: 'aws' } })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    })
  })
})

// A static site's release candidate and production must be two sites: with one
// bucket, every stage deploy would change production, and promote would read
// production's own release as the candidate.
describe('one bucket for stage and production', () => {
  const site = (bucket, distribution) => ({
    Provider: { S: 'aws' }, Type: { S: 'static' }, PipelineVersion: { S: '2' }, ProjectId: { S: '' },
    Bucket: { S: bucket }, DistributionId: { S: distribution }
  })

  describe('promote', () => {
    const production = (item, rc) => runShellStep(findStep(workflows['promote.yml'], 'lookup', 'Look up app info (production)'), {
      context: {
        'inputs.project-name': 'example-app',
        'steps.app-info-rc.outputs.bucket': rc.bucket,
        'steps.app-info-rc.outputs.distribution-id': rc.distribution
      },
      aws: { Item: item }
    })

    it('passes the release-candidate row\'s bucket and distribution on, on one line each', async () => {
      const result = await runShellStep(findStep(workflows['promote.yml'], 'lookup', 'Look up app info (release-candidate)'), {
        context: { 'inputs.project-name': 'example-app' },
        aws: { Item: site('example-site-stage\n::notice::x', 'E000STAGE000') }
      })
      expect(result.status, result.stdout).toBe(0)
      expect(result.outputs.bucket).toBe('example-site-stage ::notice::x')
      expect(result.outputs['distribution-id']).toBe('E000STAGE000')
    })

    it.each([
      ['Bucket', site('example-site', 'E000PROD000'), { bucket: 'example-site', distribution: 'E000STAGE000' }],
      ['DistributionId', site('example-site-prod', 'E000SHARED00'), { bucket: 'example-site-stage', distribution: 'E000SHARED00' }]
    ])('refuses rows that share a %s, before anything changes', async (attribute, item, rc) => {
      const result = await production(item, rc)
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain(`::error::example-app's CruApplicationInfo rows for 'staging' and 'production' both name ${attribute} '`)
      expect(result.stdout).toContain('must be separate sites')
      expect(result.outputs).toEqual({})
    })

    it.each([
      ['two sites', site('example-site-prod', 'E000PROD000'), { bucket: 'example-site-stage', distribution: 'E000STAGE000' }],
      ['an app that is not a static site', { ...site('', ''), Type: { S: 'ecs' } }, { bucket: '', distribution: '' }]
    ])('lets %s through', async (_label, item, rc) => {
      const result = await production(item, rc)
      expect(result.status, result.stdout + result.stderr).toBe(0)
    })
  })

  describe('deploy-candidate', () => {
    const lookup = awsByEnvironment => runShellStep(findStep(workflows['deploy-candidate.yml'], 'lookup', 'Look up app info'), {
      context: { 'inputs.project-name': 'example-app' },
      awsByEnvironment
    })

    it.each([
      ['Bucket', site('example-site', 'E000STAGE000'), site('example-site', 'E000PROD000')],
      ['DistributionId', site('example-site-stage', 'E000SHARED00'), site('example-site-prod', 'E000SHARED00')]
    ])('refuses a static site whose production row shares its %s', async (attribute, staging, production) => {
      const result = await lookup({ staging: { Item: staging }, production: { Item: production } })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain(`both name ${attribute} '`)
      expect(result.outputs).toEqual({})
    })

    it.each([
      ['two sites', { Item: site('example-site-prod', 'E000PROD000') }],
      ['no production row yet (a pre-release site)', {}]
    ])('lets a static site with %s through', async (_label, production) => {
      const result = await lookup({ staging: { Item: site('example-site-stage', 'E000STAGE000') }, production })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs.type).toBe('static')
    })
  })
})
