import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// The changelog link in each success Slack post, and in promote's GitHub
// Release body. These run the real workflow steps under bash (see
// support/workflow-steps.js), so what is checked is the link a reader gets.
//
// The rule under test: Flightdeck's changelog page when the caller's
// FLIGHTDECK_WORKSPACE variable is a slug, app-info has a FlightdeckProject
// that is a Flightdeck identifier, and the app's repository is the one named
// after the project, with every value URL-encoded. Anything else keeps the
// deploys.cru.org link exactly as it was before Flightdeck links existed.

const WORKFLOW_FILES = {
  promote: '.github/workflows/promote.yml',
  rollback: '.github/workflows/rollback.yml',
  'deploy-candidate': '.github/workflows/deploy-candidate.yml'
}
const workflows = Object.fromEntries(Object.entries(WORKFLOW_FILES).map(([name, file]) => [name, loadYaml(file)]))
const DEFAULT_ENDPOINT = loadYaml('actions/flightdeck-release-event/action.yml').inputs.endpoint.default

afterAll(removeFakes)

const HEAD_SHA = 'c0ffee0000000000000000000000000000000001'
const PROD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

// Every place a changelog link is built. `set` puts the link's `from` and
// `to` where that step reads them; `ledger` answers the deploys.cru.org read
// the candidate steps make for the production sha.
const slackSetters = {
  promote: (ctx, from, to) => {
    ctx['steps.baseline.outputs.prev-sha'] = from
    ctx['steps.release.outputs.release'] = to
  },
  rollback: (ctx, from, to) => {
    ctx['steps.actual-release.outputs.tag || needs.lookup.outputs.release-tag'] = from
    ctx['steps.rollback-safety.outputs.previous-revision'] = to
  },
  candidate: (ctx, from, to, run) => {
    run.ledger = { Items: from === '' ? [] : [{ Sha: from }] }
    ctx['inputs.tag'] = to
  }
}

const SITES = [
  { workflow: 'promote', job: 'promote-gcp', step: 'Notify Slack', kind: 'slack', text: "what's in this release", set: slackSetters.promote },
  { workflow: 'promote', job: 'promote-aws', step: 'Notify Slack', kind: 'slack', text: "what's in this release", set: slackSetters.promote },
  { workflow: 'promote', job: 'promote-gcp', step: 'Publish GitHub Release on the app repo', kind: 'release', set: slackSetters.promote },
  { workflow: 'promote', job: 'promote-aws', step: 'Publish GitHub Release on the app repo', kind: 'release', set: slackSetters.promote },
  { workflow: 'rollback', job: 'rollback-gcp', step: 'Notify Slack', kind: 'slack', text: 'what this rollback reverts', set: slackSetters.rollback },
  { workflow: 'rollback', job: 'rollback-aws', step: 'Notify Slack', kind: 'slack', text: 'what this rollback reverts', set: slackSetters.rollback },
  { workflow: 'deploy-candidate', job: 'deploy-candidate-gcp', step: 'Notify Slack', kind: 'slack', text: "what's in this candidate", set: slackSetters.candidate },
  { workflow: 'deploy-candidate', job: 'deploy-candidate-aws', step: 'Notify Slack', kind: 'slack', text: "what's in this candidate", set: slackSetters.candidate },
  { workflow: 'deploy-candidate', job: 'verify-candidate-aws', step: 'Notify Slack', kind: 'slack', text: "what's in this candidate", set: slackSetters.candidate }
]
const siteName = (site) => `${site.job} / ${site.step}`

// What the runner would supply. The workspace variable and project are set,
// so the default is a Flightdeck link; each test takes away what it needs to.
// `vars` is the caller's configuration variables, which is where a called
// workflow reads them from.
function baseContext (site) {
  return {
    'inputs.project-name': 'shop-web',
    'inputs.flightdeck-url': workflows[site.workflow].on.workflow_call.inputs['flightdeck-url'].default,
    'vars.FLIGHTDECK_WORKSPACE': 'acme',
    'needs.lookup.outputs.flightdeck-project': 'SHOP',
    'needs.lookup.outputs.slack-channel': 'C0TESTCHANNEL',
    'needs.lookup.outputs.app-url': 'https://shop.example.test',
    'secrets.slack-bot-token': 'xoxb-test',
    'secrets.datadog-api-key': 'dd-test',
    'secrets.authz-token': 'gh-test',
    'github.actor': 'first-starter',
    'github.triggering_actor': 'first-starter',
    'steps.baseline.outputs.head-sha': HEAD_SHA,
    'steps.resolve.outputs.digest': 'sha256:' + 'd'.repeat(64),
    'steps.rollback-safety.outputs.verdict': 'safe',
    'steps.rollback-safety.outputs.reasons': '["no migration changes in this release"]',
    'steps.rollback-safety.outputs.slack': ''
  }
}

// Run one site with `from`/`to` and any context overrides; resolve to the
// link it produced, or null when it produced no changelog line. The tests run
// concurrently, so each passes its own `expect`.
async function linkFrom (expect, site, { from, to, ...overrides }) {
  const context = baseContext(site)
  const run = {}
  site.set(context, from, to, run)
  Object.assign(context, overrides)
  // The lookups default the repository to the one named after the project.
  if (!('needs.lookup.outputs.repository' in overrides)) {
    context['needs.lookup.outputs.repository'] = `CruGlobal/${context['inputs.project-name']}`
  }
  const result = await runShellStep(findStep(workflows[site.workflow], site.job, site.step), { context, ledger: run.ledger })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toMatch(/::warning/)
  if (site.kind === 'slack') {
    expect(result.slack).not.toBeNull()
    const match = /<([^|>]*)\|([^>]*)>$/.exec(result.slack.text)
    if (!match || !match[2].startsWith('what')) return null
    expect(match[2]).toBe(site.text)
    return match[1]
  }
  expect(result.release).not.toBeNull()
  const match = /- \[Changes in this release\]\(([^)]*)\)\n/.exec(result.release.body)
  return match ? match[1] : null
}

// RFC 3986 strict: everything but the unreserved characters is encoded.
const encode = (value) => Array.from(new TextEncoder().encode(value))
  .map((byte) => /[A-Za-z0-9\-._~]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '%' + byte.toString(16).toUpperCase().padStart(2, '0'))
  .join('')

const ranges = {
  promote: { from: PROD_SHA, to: 'release-2026-09-04-10123' },
  rollback: { from: 'release-2026-09-03-10120', to: 'release-2026-09-04-10123' },
  'deploy-candidate': { from: PROD_SHA, to: 'candidate-2026-09-04-10123' }
}

describe.concurrent.each(SITES.map((site) => [siteName(site), site]))('%s', (_name, site) => {
  const { from, to } = ranges[site.workflow]
  const oldLink = `https://deploys.cru.org/changelog?project=shop-web&from=${from}&to=${to}`

  it('links to the project changelog on Flightdeck when the workspace and FlightdeckProject are set', async ({ expect }) => {
    expect(await linkFrom(expect, site, { from, to })).toBe(`https://flightdeck.cru.org/acme/projects/SHOP/changelog?from=${from}&to=${to}&app=shop-web`)
  })

  it('uses a given Flightdeck URL, without its trailing slash', async ({ expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'inputs.flightdeck-url': 'https://flightdeck.example.test/' }))
      .toBe(`https://flightdeck.example.test/acme/projects/SHOP/changelog?from=${from}&to=${to}&app=shop-web`)
  })

  it('keeps the old link exactly when app-info has no FlightdeckProject', async ({ expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.flightdeck-project': '' })).toBe(oldLink)
  })

  it('keeps the old link exactly when the FLIGHTDECK_WORKSPACE variable is unset', async ({ expect }) => {
    // An unset variable reads as an empty string.
    expect(await linkFrom(expect, site, { from, to, 'vars.FLIGHTDECK_WORKSPACE': '' })).toBe(oldLink)
  })

  it('keeps the old link for a FlightdeckProject that is not a Flightdeck identifier', async ({ expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.flightdeck-project': 'shop' })).toBe(oldLink)
  })

  it('keeps the old link for a workspace that is not a plain slug', async ({ expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'vars.FLIGHTDECK_WORKSPACE': 'acme/other' })).toBe(oldLink)
  })

  it('keeps the old link when app-info names a repository other than the one named after the project', async ({ expect }) => {
    // Flightdeck's changelog reads the repository named after the project, so
    // its page would compare the wrong repository.
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.repository': 'CruGlobal/shop-web-app' })).toBe(oldLink)
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.repository': 'other-org/shop-web' })).toBe(oldLink)
  })

  it('reads the repository without regard to case, and builds the link when none is known', async ({ expect }) => {
    const link = `https://flightdeck.cru.org/acme/projects/SHOP/changelog?from=${from}&to=${to}&app=shop-web`
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.repository': 'cruglobal/SHOP-WEB' })).toBe(link)
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.repository': '' })).toBe(link)
  })

  it('URL-encodes every value in the Flightdeck link', async ({ expect }) => {
    // Shell-safe inside double quotes (the candidate steps put the tag
    // straight into the script), but full of URL and Slack syntax.
    const oddFrom = 'a1b2&to=evil|x>y'
    const oddTo = 'tag 1/2#3?z=%41+é(x)'
    const link = await linkFrom(expect, site, { from: oddFrom, to: oddTo, 'inputs.project-name': 'shop web&x=1' })
    expect(link).toBe(`https://flightdeck.cru.org/acme/projects/SHOP/changelog?from=${encode(oddFrom)}&to=${encode(oddTo)}&app=${encode('shop web&x=1')}`)
    // Nothing left that would end a Slack <url|text> link or a Markdown one early.
    expect(link).not.toMatch(/[\s|<>()#]/)
  })

  it('still leaves the line out when there is nothing to compare', async ({ expect }) => {
    // Promote and the candidate steps need a production baseline (`from`);
    // rollback needs the release production was running (`to`).
    const missing = site.workflow === 'rollback' ? { from, to: '' } : { from: '', to }
    expect(await linkFrom(expect, site, missing)).toBeNull()
    expect(await linkFrom(expect, site, { ...missing, 'needs.lookup.outputs.flightdeck-project': '' })).toBeNull()
  })

  if (site.workflow === 'rollback') {
    it('leaves the line out when production was already on the target release', async ({ expect }) => {
      expect(await linkFrom(expect, site, { from, to: from })).toBeNull()
    })
  }
})

// The full list of values that must NOT produce a Flightdeck link, run on one
// site of each kind. Every site builds its link with the same jq function
// (checked below), so these hold for all of them.
const REPRESENTATIVE = [SITES[0], SITES[2]]

describe.concurrent.each(REPRESENTATIVE.map((site) => [siteName(site), site]))('%s: values that keep the old link', (_name, site) => {
  const { from, to } = ranges[site.workflow]
  const oldLink = `https://deploys.cru.org/changelog?project=shop-web&from=${from}&to=${to}`

  it.for([
    'shop', 'Shop', '1SHOP', 'S-HOP', 'SHOP_1', 'SHOPPINGLIST', 'ABCDEFGHIJK', ' SHOP', 'SHOP ', 'SHOP\n', 'SHOP\nX', 'ŠHOP'
  ])('FlightdeckProject %j', async (project, { expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.flightdeck-project': project })).toBe(oldLink)
  })

  it.for(['S', 'A1', 'ABCDEFGHIJ'])('accepts the identifier %j', async (project, { expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'needs.lookup.outputs.flightdeck-project': project }))
      .toBe(`https://flightdeck.cru.org/acme/projects/${project}/changelog?from=${from}&to=${to}&app=shop-web`)
  })

  it.for([
    'Acme', '-acme', 'acme corp', 'acme/other', '../acme', 'acme?x=1', 'acme#x', 'acme\n', 'acmé', 'acme_co'
  ])('workspace %j', async (workspace, { expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'vars.FLIGHTDECK_WORKSPACE': workspace })).toBe(oldLink)
  })

  it.for([
    '', 'http://flightdeck.example.test', 'https://flightdeck.example.test/?x=1', 'https://flightdeck.example.test#top',
    'https://user@flightdeck.example.test', 'javascript:alert(1)', 'https://flightdeck.example.test|evil',
    'https://flightdeck.example.test/a b', 'https://flightdeck.example.test>x', 'ftp://flightdeck.example.test'
  ])('Flightdeck URL %j', async (url, { expect }) => {
    expect(await linkFrom(expect, site, { from, to, 'inputs.flightdeck-url': url })).toBe(oldLink)
  })
})

describe('changelog link wiring', () => {
  const runOf = (site) => findStep(workflows[site.workflow], site.job, site.step).step.run
  const defOf = (site) => {
    const match = /def changelog\(\$from; \$to\):[\s\S]*?\n\s*end;/.exec(runOf(site))
    expect(match, siteName(site)).not.toBeNull()
    return match[0]
  }

  it('builds every link with the same jq function', () => {
    const first = defOf(SITES[0])
    for (const site of SITES.slice(1)) expect(defOf(site), siteName(site)).toBe(first)
  })

  it('finds every step that builds a changelog link', () => {
    const found = Object.entries(workflows).flatMap(([name, workflow]) => Object.entries(workflow.jobs)
      .flatMap(([jobId, job]) => job.steps.filter((step) => (step.run ?? '').includes('deploys.cru.org/changelog'))
        .map((step) => `${name}:${jobId} / ${step.name}`)))
    expect(found.sort()).toEqual(SITES.map((site) => `${site.workflow}:${siteName(site)}`).sort())
  })

  it.each(SITES.map((site) => [siteName(site), site]))('%s reads the URL, the workspace variable, FlightdeckProject and the repository', (_name, site) => {
    const { step } = findStep(workflows[site.workflow], site.job, site.step)
    expect(step.env).toMatchObject({
      FLIGHTDECK_URL: '${{ inputs.flightdeck-url }}',
      FLIGHTDECK_WORKSPACE: '${{ vars.FLIGHTDECK_WORKSPACE }}',
      FLIGHTDECK_PROJECT: '${{ needs.lookup.outputs.flightdeck-project }}',
      APP_REPO: '${{ needs.lookup.outputs.repository }}'
    })
  })

  it.each(Object.entries(workflows))('%s takes the workspace from a variable, not an input', (_name, workflow) => {
    const inputs = workflow.on.workflow_call.inputs
    // The same default the release-event action posts to, so a caller never
    // has to pass it.
    expect(inputs['flightdeck-url']).toMatchObject({ type: 'string', required: false, default: DEFAULT_ENDPOINT })
    // A caller that passes an input the called release does not declare
    // fails to start, so the workspace is a variable: a caller can then move
    // back to an older release without changing anything.
    expect(inputs).not.toHaveProperty('flightdeck-workspace')
    expect(JSON.stringify(workflow)).not.toContain('inputs.flightdeck-workspace')
    // Every job that links reads FlightdeckProject and the repository from lookup.
    expect(workflow.jobs.lookup.outputs).toMatchObject({
      'flightdeck-project': expect.stringContaining('outputs.flightdeck-project'),
      repository: expect.stringContaining('outputs.repository')
    })
  })
})

// deploy-candidate's lookup had no repository output until the Repository
// check needed one. It reads the same app-info row as the rest of the lookup,
// with the same default promote and rollback use.
describe('deploy-candidate lookup: repository', () => {
  const { job, step } = findStep(workflows['deploy-candidate'], 'lookup', 'Look up app info')
  const item = (extra = {}) => ({
    Item: { Provider: { S: 'aws' }, Type: { S: 'ecs' }, ProjectId: { S: '' }, FlightdeckProject: { S: 'SHOP' }, ...extra }
  })
  const lookup = (aws) => runShellStep({ job, step }, { context: { 'inputs.project-name': 'shop-web' }, aws })

  it('is the app-info Repository when there is one', async () => {
    const result = await lookup(item({ Repository: { S: 'CruGlobal/shop-web-app' } }))
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toMatchObject({ repository: 'CruGlobal/shop-web-app', 'flightdeck-project': 'SHOP' })
  })

  it('is the repository named after the project when app-info has none', async () => {
    const result = await lookup(item())
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.repository).toBe('CruGlobal/shop-web')
  })

  it('is a job output', () => {
    expect(job.outputs.repository).toBe('${{ steps.app-info.outputs.repository }}')
  })
})
