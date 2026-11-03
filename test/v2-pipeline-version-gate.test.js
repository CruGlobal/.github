import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// Only the v2 app modules write PipelineVersion "2" on an app-info row. A row
// without it is an app pipeline v2 does not deploy: one still on the old
// pipeline, or one that deploys itself, whose row the utility/app-info module
// writes with a Type of its own. Every v2 lookup that leads to a deploy,
// promote or rollback refuses such a row in its first step, with a message
// that says so. These run the real lookup steps under bash, with a fake aws
// that answers every get-item with the row given.

afterAll(removeFakes)

const SITES = [
  { name: 'promote release-candidate', file: 'promote.yml', job: 'lookup', step: 'Look up app info (release-candidate)', says: 'there is no release candidate to promote' },
  { name: 'promote production', file: 'promote.yml', job: 'lookup', step: 'Look up app info (production)', says: 'there is nothing to promote into' },
  { name: 'rollback', file: 'rollback.yml', job: 'lookup', step: 'Look up app info (production)', says: 'there is no pipeline v2 release to roll back to' },
  { name: 'deploy-candidate', file: 'deploy-candidate.yml', job: 'lookup', step: 'Look up app info', says: 'pipeline v2 does not deploy its candidates' }
]

const lookupOf = (site) => findStep(loadYaml(`.github/workflows/${site.file}`), site.job, site.step)
const lookup = (site, item) => runShellStep(lookupOf(site), { context: { 'inputs.project-name': 'example-app' }, aws: { Item: item } })

const staticRow = { Provider: { S: 'aws' }, Type: { S: 'static' }, FlightdeckProject: { S: 'EXAMPLE' }, SlackChannel: { S: 'C0TESTCHANNEL' } }
const amplifyRow = { ...staticRow, Type: { S: 'amplify' } }
const oldPipelineRow = { Provider: { S: 'aws' }, Type: { S: 'ecs' } }
const v2Row = { Provider: { S: 'aws' }, Type: { S: 'ecs' }, PipelineVersion: { S: '2' }, ProjectId: { S: '' }, FlightdeckProject: { S: 'EXAMPLE' } }

describe.each(SITES.map((site) => [site.name, site]))('%s lookup', (_name, site) => {
  it.each([
    ['a static site', staticRow, 'static'],
    ['an Amplify app', amplifyRow, 'amplify'],
    ['an app on the old pipeline', oldPipelineRow, 'ecs'],
    ['a row with another PipelineVersion', { ...v2Row, PipelineVersion: { S: '1' } }, 'ecs'],
    ['a row with no Type at all', { Provider: { S: 'aws' } }, 'none']
  ])('refuses %s, naming its type, before anything else', async (_label, item, type) => {
    const result = await lookup(site, item)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toMatch(new RegExp(`^::error title=Not a pipeline v2 app::example-app is not on pipeline v2: .*has no PipelineVersion 2 \\(type '${type}'\\), so ${site.says}\\.`, 'm'))
    // It says nothing is wrong with the app, only that it is not one this
    // workflow deploys, and it hands no provider to the jobs after it.
    expect(result.outputs).toEqual({})
  })

  it('keeps a type that holds a line break on the error\'s one line', async () => {
    const result = await lookup(site, { ...staticRow, Type: { S: 'static\n::notice::injected' } })
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toMatch(/^::notice::injected/m)
  })

  it('lets a pipeline v2 row through', async () => {
    const result = await lookup(site, v2Row)
    expect(result.stdout).not.toContain('Not a pipeline v2 app')
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
})

describe('promote with no release-candidate row', () => {
  it('says the app may be one that deploys itself, not only that the row is missing', async () => {
    const result = await runShellStep(lookupOf(SITES[0]), { context: { 'inputs.project-name': 'example-app' }, aws: {} })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("no CruApplicationInfo row for project 'example-app' environment 'staging'")
    expect(result.stdout).toContain('An app with no app module deploys itself and cannot be promoted here.')
  })
})
