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
  it.each([['ecs', 'GitHubDeployECS'], ['lambda', 'GitHubDeployLambda'], ['static', 'GitHubDeployStatic']])('picks the %s role', async (type, role) => {
    const result = await guard('deploy-candidate.yml', 'verify-candidate-aws', type)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.outputs).toEqual({ role })
  })

  it.each(['serverless', '', 'Static', 'cloudrun'])('stops on type %j', async (type) => {
    const result = await guard('deploy-candidate.yml', 'verify-candidate-aws', type)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`::error::v2 AWS stage-less verify supports types 'ecs', 'lambda' and 'static' (got '${type}')`)
    expect(result.outputs).toEqual({})
  })

  it('keeps a type that holds a line break on the error\'s one line', async () => {
    const result = await guard('deploy-candidate.yml', 'verify-candidate-aws', 'static\n::notice::injected')
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toMatch(/^::notice::injected/m)
  })

  it('assumes the role the guard picked', () => {
    const { step } = findStep(workflows['deploy-candidate.yml'], 'verify-candidate-aws', 'Configure AWS credentials')
    expect(step.with['role-to-assume']).toMatch(ROLE_FROM_GUARD)
  })
})

// A stage-less static site is gated by the site check, and an ECS or Lambda
// app by its verify command. Each step names the type it runs for, so exactly
// one gate runs, and the static role, which cannot log in to the registry, is
// never asked to.
describe('deploy-candidate.yml:verify-candidate-aws gates', () => {
  const job = workflows['deploy-candidate.yml'].jobs['verify-candidate-aws']
  const step = name => findStep(workflows['deploy-candidate.yml'], 'verify-candidate-aws', name).step
  const NOT_STATIC = "steps.noop.outputs.skip != 'true' && needs.lookup.outputs.type != 'static'"

  it.each(['Login to Amazon ECR', 'Pull the candidate image', 'Verify the candidate image'])('runs "%s" for every type but static', (name) => {
    expect(step(name).if).toBe(NOT_STATIC)
  })

  it('checks a static site with the verify-static-site action, by the resolved digest', () => {
    const check = step('Check the candidate site')
    expect(check.if).toBe("steps.noop.outputs.skip != 'true' && needs.lookup.outputs.type == 'static'")
    expect(check.uses).toBe('./cru-github-actions/actions/verify-static-site')
    expect(check.with).toEqual({ image: '${{ steps.resolve.outputs.image }}' })
  })

  it('fails the run when the site check fails, within a step limit, before anything is recorded', () => {
    const check = step('Check the candidate site')
    expect(check['continue-on-error']).toBeUndefined()
    expect(check['timeout-minutes']).toBe(15)
    const names = job.steps.map(s => s.name)
    expect(names.indexOf('Check the candidate site')).toBeGreaterThan(names.indexOf('No-op guard (already verified)'))
    for (const record of ['Record deployment event in Datadog', 'Record deployment in ledger', 'Record release event in Flightdeck', 'Notify Slack']) {
      expect(names.indexOf(record), record).toBeGreaterThan(names.indexOf('Check the candidate site'))
    }
  })

  it('writes the same release-candidate ledger row for every type, with the verify marker', () => {
    const ledger = step('Record deployment in ledger')
    expect(ledger.if).toBe("steps.noop.outputs.skip != 'true'")
    expect(ledger.env.TYPE).toBe('${{ needs.lookup.outputs.type }}')
    expect(ledger.run).toContain('--arg environment release-candidate')
    expect(ledger.run).toContain('--arg action deploy')
    expect(ledger.run).toContain('--arg rcmode verify')
  })

  it('names the action\'s only input', () => {
    const action = loadYaml('actions/verify-static-site/action.yml')
    expect(Object.keys(action.inputs)).toEqual(['image'])
    expect(action.inputs.image.required).toBe(true)
    expect(action.runs.main).toBe('../../dist/verify-static-site.js')
  })
})

// Promote takes a stage-less static site's candidate from the ledger, exactly
// as it does a stage-less ECS app's, so no stage bucket is read.
describe('promote.yml:promote-aws for a stage-less static site', () => {
  const step = name => findStep(workflows['promote.yml'], 'promote-aws', name).step

  it('resolves the ledger\'s candidate tag, not the release-candidate environment', () => {
    const resolve = step('Resolve release-candidate image')
    expect(resolve.with.type).toBe('${{ needs.lookup.outputs.type }}')
    expect(resolve.with.mode).toBe("${{ needs.lookup.outputs.rc-mode == 'verify' && 'tag' || 'environment' }}")
    expect(resolve.with.tag).toBe("${{ needs.lookup.outputs.rc-mode == 'verify' && steps.ledger-candidate.outputs.revision || '' }}")
    expect(step('Resolve candidate from ledger (stage-less)').if).toBe("needs.lookup.outputs.rc-mode == 'verify'")
    expect(step('Confirm candidate digest is unchanged (stage-less)').if).toBe("needs.lookup.outputs.rc-mode == 'verify'")
  })

  it('deploys the digest it resolved, which the step before confirmed against the ledger', () => {
    expect(step('Deploy to production').with.image).toBe('${{ steps.resolve.outputs.image }}')
    expect(step('Confirm candidate digest is unchanged (stage-less)').env.RESOLVED_DIGEST).toBe('${{ steps.resolve.outputs.digest }}')
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
// production's own release as the candidate. Only a static site deploys to a
// bucket, so no other type is checked.
describe('one bucket for stage and production', () => {
  const site = (bucket, distribution, type = 'static') => ({
    Provider: { S: 'aws' }, Type: { S: type }, PipelineVersion: { S: '2' }, ProjectId: { S: '' },
    Bucket: { S: bucket }, DistributionId: { S: distribution }
  })

  describe('promote', () => {
    const production = (item, rc) => runShellStep(findStep(workflows['promote.yml'], 'lookup', 'Look up app info (production)'), {
      context: {
        'inputs.project-name': 'example-app',
        'steps.app-info-rc.outputs.type': rc.type ?? 'static',
        'steps.app-info-rc.outputs.bucket': rc.bucket,
        'steps.app-info-rc.outputs.distribution-id': rc.distribution
      },
      aws: { Item: item }
    })

    it('passes the release-candidate row\'s type, bucket and distribution on, on one line each and trimmed', async () => {
      const result = await runShellStep(findStep(workflows['promote.yml'], 'lookup', 'Look up app info (release-candidate)'), {
        context: { 'inputs.project-name': 'example-app' },
        aws: { Item: site(' example-site-stage\n::notice::x ', '  E000STAGE000') }
      })
      expect(result.status, result.stdout).toBe(0)
      expect(result.outputs.type).toBe('static')
      expect(result.outputs.bucket).toBe('example-site-stage ::notice::x')
      expect(result.outputs['distribution-id']).toBe('E000STAGE000')
    })

    it.each([
      ['Bucket', site('example-site', 'E000PROD000'), { bucket: 'example-site', distribution: 'E000STAGE000' }, "Bucket 'example-site'"],
      ['DistributionId', site('example-site-prod', 'E000SHARED00'), { bucket: 'example-site-stage', distribution: 'E000SHARED00' }, "DistributionId 'E000SHARED00'"],
      ['Bucket, once trimmed', site(' example-site  ', 'E000PROD000'), { bucket: 'example-site', distribution: 'E000STAGE000' }, "Bucket 'example-site'"]
    ])('refuses rows that share a %s, before anything changes', async (_label, item, rc, named) => {
      const result = await production(item, rc)
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain(`::error::example-app's CruApplicationInfo rows for 'staging' and 'production' both name ${named}.`)
      expect(result.stdout).toContain('must be separate sites')
      expect(result.outputs).toEqual({})
    })

    it.each([
      ['two sites', site('example-site-prod', 'E000PROD000'), { bucket: 'example-site-stage', distribution: 'E000STAGE000' }],
      ['an app that is not a static site', site('', '', 'ecs'), { type: 'ecs', bucket: '', distribution: '' }],
      // A row of another type that happens to carry the attributes is not a
      // site, so it is not checked.
      ['an ecs app whose rows share a Bucket', site('example-bucket', 'E000SHARED00', 'ecs'), { type: 'ecs', bucket: 'example-bucket', distribution: 'E000SHARED00' }]
    ])('lets %s through', async (_label, item, rc) => {
      const result = await production(item, rc)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).not.toContain('must be separate sites')
    })
  })

  describe('deploy-candidate', () => {
    const lookup = awsByEnvironment => runShellStep(findStep(workflows['deploy-candidate.yml'], 'lookup', 'Look up app info'), {
      context: { 'inputs.project-name': 'example-app' },
      awsByEnvironment
    })

    it.each([
      ['Bucket', site('example-site', 'E000STAGE000'), site('example-site', 'E000PROD000'), "Bucket 'example-site'"],
      ['DistributionId', site('example-site-stage', 'E000SHARED00'), site('example-site-prod', 'E000SHARED00'), "DistributionId 'E000SHARED00'"],
      ['Bucket, once trimmed', site('example-site ', 'E000STAGE000'), site('  example-site', 'E000PROD000'), "Bucket 'example-site'"]
    ])('refuses a static site whose production row shares its %s', async (_label, staging, production, named) => {
      const result = await lookup({ staging: { Item: staging }, production: { Item: production } })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain(`both name ${named}.`)
      expect(result.outputs).toEqual({})
    })

    it.each([
      ['two sites', { Item: site('example-site-prod', 'E000PROD000') }],
      ['no production row yet (a pre-release site)', {}]
    ])('lets a static site with %s through', async (_label, production) => {
      const result = await lookup({ staging: { Item: site('example-site-stage', 'E000STAGE000') }, production })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.outputs.type).toBe('static')
      expect(result.stdout).not.toContain('Same-site check skipped')
    })

    it('skips the check with a warning when the production row cannot be read, and deploys', async () => {
      const result = await lookup({ staging: { Item: site('example-site-stage', 'E000STAGE000') }, production: 'FAIL' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain(
        "::warning title=Same-site check skipped::could not read example-app's CruApplicationInfo row for 'production', " +
        'so this run did not check that release-candidate and production name different buckets and distributions. Promote checks it again.'
      )
      expect(result.outputs.type).toBe('static')
    })

    // A production read that failed would warn, so no warning means no read.
    it.each([
      ['an ecs app', site('', '', 'ecs')],
      ['an ecs app whose row carries a Bucket its production row shares', site('example-bucket', 'E000SHARED00', 'ecs')]
    ])('reads no production row for %s', async (_label, staging) => {
      const result = await lookup({ staging: { Item: staging }, production: 'FAIL' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).not.toContain('Same-site check skipped')
      expect(result.stdout).not.toContain('must be separate sites')
      expect(result.outputs.type).toBe('ecs')
    })
  })
})
