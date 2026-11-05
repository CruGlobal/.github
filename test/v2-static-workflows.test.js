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
    expect(steps[credentialsAt].with['role-to-assume']).toBe('arn:aws:iam::056154071827:role/${{ steps.aws-type.outputs.role }}')
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
    expect(step.with['role-to-assume']).toBe('arn:aws:iam::056154071827:role/${{ steps.aws-type.outputs.role }}')
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
