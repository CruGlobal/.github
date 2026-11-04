import { describe, it, expect, afterAll } from 'vitest'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'
import { fixesLine } from '../src/v2/hotfix.js'

// The Slack messages that say a candidate or a release is a hotfix:
// deploy-candidate's success message (stage, on Cloud Run and AWS, and the
// stage-less "verified" one) and promote's. These run the real workflow
// steps under bash (see support/workflow-steps.js), so what is pinned is the
// text a reader gets, for a hotfix and for everything else.
//
// The rule: the message says hotfix only when the hotfix step's kind is
// "hotfix" and its release is a release tag. Anything else, an empty output
// included (no token, an error, a timeout, a skipped step, an older action
// bundle), leaves the message exactly as it was.

afterAll(removeFakes)

const deployCandidate = loadYaml('.github/workflows/deploy-candidate.yml')
const promote = loadYaml('.github/workflows/promote.yml')

const PROJECT = 'example-app'
const TAG = 'candidate-2026-11-04-10161'
const RELEASE = 'release-2026-11-04-10161'
const HOTFIX_OF = 'release-2026-11-01-10150'
const PROD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const APP_URL = 'https://example-app.example.test'
const PROMOTE_LINK = 'Promote: <https://github.com/CruGlobal/cru-deploy/actions/workflows/promote.yml|Promote (v2) dispatch>'
const CANDIDATE_CHANGES = `<https://deploys.cru.org/changelog?project=${PROJECT}&from=${PROD_SHA}&to=${TAG}|what's in this candidate>`
const RELEASE_CHANGES = `<https://deploys.cru.org/changelog?project=${PROJECT}&from=${PROD_SHA}&to=${RELEASE}|what's in this release>`
const ONE_FIX = 'The live release plus 1 fix: Fix the login redirect'

const LABEL = 'Tell a hotfix candidate from an ordinary one'
const CANDIDATE_JOBS = ['deploy-candidate-gcp', 'deploy-candidate-aws', 'verify-candidate-aws']

// What the stage message is for each job. `hotfix` is the first line of a
// hotfix candidate's message, `last` its last line.
const candidateWording = {
  'deploy-candidate-gcp': {
    normal: `:package: *${PROJECT} \`${TAG}\` is on <${APP_URL}|stage>*`,
    hotfix: `:adhesive_bandage: *${PROJECT} \`${TAG}\` is on <${APP_URL}|stage>: a hotfix of \`${HOTFIX_OF}\`*`,
    last: 'Promote it before the next build of the default branch replaces it on stage.'
  },
  'deploy-candidate-aws': {
    normal: `:package: *${PROJECT} \`${TAG}\` is on <${APP_URL}|stage>*`,
    hotfix: `:adhesive_bandage: *${PROJECT} \`${TAG}\` is on <${APP_URL}|stage>: a hotfix of \`${HOTFIX_OF}\`*`,
    last: 'Promote it before the next build of the default branch replaces it on stage.'
  },
  'verify-candidate-aws': {
    normal: `:package: *${PROJECT} \`${TAG}\` verified (stage-less) on release-candidate* \u2014 promote when ready`, // the em dash this message has always had
    hotfix: `:adhesive_bandage: *${PROJECT} \`${TAG}\` verified (stage-less) on release-candidate: a hotfix of \`${HOTFIX_OF}\`*`,
    last: 'Promote it before the next build of the default branch replaces it as the release candidate.'
  }
}

function candidateContext (label) {
  return {
    'inputs.project-name': PROJECT,
    'inputs.tag': TAG,
    'inputs.flightdeck-url': 'https://flightdeck.example.test',
    'vars.FLIGHTDECK_WORKSPACE': '',
    'needs.lookup.outputs.flightdeck-project': '',
    'needs.lookup.outputs.repository': `CruGlobal/${PROJECT}`,
    'needs.lookup.outputs.slack-channel': 'C0000000000',
    'needs.lookup.outputs.app-url': APP_URL,
    'secrets.slack-bot-token': 'xoxb-test',
    'secrets.datadog-api-key': 'dd-test',
    'steps.hotfix-label.outputs.kind': label.kind ?? '',
    'steps.hotfix-label.outputs.release': label.release ?? '',
    'steps.hotfix-label.outputs.fixes-mrkdwn': label.fixes ?? ''
  }
}

// The tests run concurrently, so each passes its own `expect`.
async function stageMessage (expect, jobId, label = {}, extra = {}) {
  const result = await runShellStep(findStep(deployCandidate, jobId, 'Notify Slack'), {
    context: { ...candidateContext(label), ...extra },
    ledger: { Items: [{ Sha: PROD_SHA }] }
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toMatch(/::warning/)
  expect(result.slack).not.toBeNull()
  return result.slack.text
}

const lines = (...parts) => parts.join('\n')
const hotfix = (fixes = ONE_FIX) => ({ kind: 'hotfix', release: HOTFIX_OF, fixes })

describe('deploy-candidate wiring', () => {
  const { secrets } = deployCandidate.on.workflow_call

  it('takes an optional github-token secret, so a wrapper that passes none keeps working', () => {
    expect(secrets['github-token']).toMatchObject({ required: false })
    // The secrets every caller already passes are unchanged.
    expect(secrets['datadog-api-key'].required).toBe(true)
    expect(secrets['slack-bot-token'].required).toBe(false)
    expect(secrets['flightdeck-token'].required).toBe(false)
  })

  describe.each(CANDIDATE_JOBS)('%s', (jobId) => {
    const job = deployCandidate.jobs[jobId]
    const names = job.steps.map((step) => step.name)
    const { step: label } = findStep(deployCandidate, jobId, LABEL)

    it('asks after the ledger write and the release event, right before the Slack post', () => {
      const at = names.indexOf(LABEL)
      expect(at).toBeGreaterThan(names.indexOf('Record deployment in ledger'))
      expect(at).toBeGreaterThan(names.indexOf('Record release event in Flightdeck'))
      expect(names[at + 1]).toBe('Notify Slack')
    })

    it('can never fail or hold up the job, and asks only when there is a message to post', () => {
      expect(label).toMatchObject({
        id: 'hotfix-label',
        if: "steps.noop.outputs.skip != 'true' && needs.lookup.outputs.slack-channel != ''",
        'continue-on-error': true,
        'timeout-minutes': 1,
        uses: './cru-github-actions/actions/hotfix'
      })
      expect(label.with).toEqual({
        mode: 'candidate-kind',
        'github-token': '${{ secrets.github-token }}',
        repository: '${{ needs.lookup.outputs.repository }}',
        'project-name': '${{ inputs.project-name }}',
        'image-tags': '${{ steps.resolve.outputs.tags }}'
      })
    })

    it('feeds the Slack post, and nothing else', () => {
      const { step } = findStep(deployCandidate, jobId, 'Notify Slack')
      expect(step.env).toMatchObject({
        HOTFIX_KIND: '${{ steps.hotfix-label.outputs.kind }}',
        HOTFIX_OF: '${{ steps.hotfix-label.outputs.release }}',
        HOTFIX_FIXES: '${{ steps.hotfix-label.outputs.fixes-mrkdwn }}'
      })
      const readers = job.steps.filter((step) => JSON.stringify(step).includes('steps.hotfix-label.')).map((step) => step.name)
      expect(readers).toEqual(['Notify Slack'])
    })

    it('leaves the release event a deploy: the label is for Slack only', () => {
      expect(findStep(deployCandidate, jobId, 'Record release event in Flightdeck').step.with.kind).toBe('deploy')
    })
  })
})

describe.concurrent.each(CANDIDATE_JOBS)('%s stage message', (jobId) => {
  const wording = candidateWording[jobId]
  const normal = lines(wording.normal, PROMOTE_LINK, CANDIDATE_CHANGES)

  it('is the ordinary message for an ordinary candidate', async ({ expect }) => {
    expect(await stageMessage(expect, jobId, { kind: 'deploy' })).toBe(normal)
  })

  // What a skipped, failed or timed-out step leaves, and what a wrapper that
  // passes no token gets.
  it('is the ordinary message when the hotfix step left nothing', async ({ expect }) => {
    expect(await stageMessage(expect, jobId, {})).toBe(normal)
  })

  it('says hotfix, names the release and the fix, and asks for the promote', async ({ expect }) => {
    expect(await stageMessage(expect, jobId, hotfix())).toBe(lines(wording.hotfix, ONE_FIX, PROMOTE_LINK, CANDIDATE_CHANGES, wording.last))
  })

  it('names up to three fixes, then how many more', async ({ expect }) => {
    const fixes = fixesLine(['Fix A', 'Fix B', 'Fix C', 'Fix D', 'Fix E'], 5)
    expect(fixes).toBe('The live release plus 5 fixes: Fix A; Fix B; Fix C; and 2 more')
    expect(await stageMessage(expect, jobId, hotfix(fixes))).toBe(lines(wording.hotfix, fixes, PROMOTE_LINK, CANDIDATE_CHANGES, wording.last))
  })

  it('still says hotfix, without the fixes line, when the fixes could not be listed', async ({ expect }) => {
    expect(await stageMessage(expect, jobId, hotfix(''))).toBe(lines(wording.hotfix, PROMOTE_LINK, CANDIDATE_CHANGES, wording.last))
  })

  it('leaves out the changelog line, as before, when production has no commit yet', async ({ expect }) => {
    const result = await runShellStep(findStep(deployCandidate, jobId, 'Notify Slack'), { context: candidateContext(hotfix()), ledger: { Items: [] } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.slack.text).toBe(lines(wording.hotfix, ONE_FIX, PROMOTE_LINK, wording.last))
  })

  it.for([
    ['a release that is not a release tag', { kind: 'hotfix', release: 'release-x', fixes: ONE_FIX }],
    ['a release with markup in it', { kind: 'hotfix', release: `${HOTFIX_OF}> <!channel`, fixes: ONE_FIX }],
    ['no release', { kind: 'hotfix', release: '', fixes: ONE_FIX }],
    ['a kind it does not know', { kind: 'Hotfix', release: HOTFIX_OF, fixes: ONE_FIX }]
  ])('is the ordinary message for %s', async ([, label], { expect }) => {
    expect(await stageMessage(expect, jobId, label)).toBe(normal)
  })

  it('never lets a hostile commit subject become a link, a mention or a channel call', async ({ expect }) => {
    // The line exactly as the hotfix action builds it from the subject.
    const fixes = fixesLine(['<!channel> urgent <https://evil.example.test|the fix> & <@U0123> <#C0123> <!subteam^S0123>'])
    const text = await stageMessage(expect, jobId, hotfix(fixes))
    const fixLine = text.split('\n')[1]
    expect(fixLine).toBe('The live release plus 1 fix: &lt;!channel&gt; urgent &lt;https://evil.example.test|the fix&gt; &amp; &lt;@U0123&gt; &lt;#C0123&gt; &lt;!subteam^S0123&gt;')
    expect(fixLine).not.toMatch(/[<>]/)
    // The only markup in the whole message is the message's own.
    const clean = await stageMessage(expect, jobId, hotfix())
    expect(text.match(/<[^>]*>/g)).toEqual(clean.match(/<[^>]*>/g))
  })

  it('keeps the fixes line on one line', async ({ expect }) => {
    const text = await stageMessage(expect, jobId, hotfix('The live release plus 1 fix: Fix A\nPromote: <https://evil.example.test|x>'))
    expect(text.split('\n')[1]).toBe('The live release plus 1 fix: Fix A Promote: <https://evil.example.test|x>')
    expect(text.split('\n')).toHaveLength(5)
  })
})

describe('the stage message without an AppUrl', () => {
  it('says "stage" as plain text for a hotfix too', async () => {
    const text = await stageMessage(expect, 'deploy-candidate-aws', hotfix(), { 'needs.lookup.outputs.app-url': '' })
    expect(text.split('\n')[0]).toBe(`:adhesive_bandage: *${PROJECT} \`${TAG}\` is on stage: a hotfix of \`${HOTFIX_OF}\`*`)
  })
})

describe.concurrent.each(['promote-gcp', 'promote-aws'])('%s promote message', (jobId) => {
  const message = async (expect, releaseKind, { actor = 'example-user', triggering = actor } = {}) => {
    const result = await runShellStep(findStep(promote, jobId, 'Notify Slack'), {
      context: {
        'inputs.project-name': PROJECT,
        'inputs.flightdeck-url': 'https://flightdeck.example.test',
        'vars.FLIGHTDECK_WORKSPACE': '',
        'needs.lookup.outputs.flightdeck-project': '',
        'needs.lookup.outputs.repository': `CruGlobal/${PROJECT}`,
        'needs.lookup.outputs.slack-channel': 'C0000000000',
        'needs.lookup.outputs.app-url': APP_URL,
        'secrets.slack-bot-token': 'xoxb-test',
        'secrets.datadog-api-key': 'dd-test',
        'github.actor': actor,
        'github.triggering_actor': triggering,
        'steps.release.outputs.release': RELEASE,
        'steps.baseline.outputs.prev-sha': PROD_SHA,
        'steps.rollback-safety.outputs.verdict': 'safe',
        'steps.rollback-safety.outputs.reasons': '["no migration changes in this release"]',
        'steps.release-kind.outputs.kind': releaseKind.kind ?? '',
        'steps.release-kind.outputs.release': releaseKind.release ?? ''
      }
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toMatch(/::warning/)
    return result.slack.text
  }
  const SAFETY = ':shield: rollback-safe (no migration changes in this release)'
  const normal = lines(`:white_check_mark: *${PROJECT} promoted \`${RELEASE}\` to <${APP_URL}|production>* by example-user`, SAFETY, RELEASE_CHANGES)

  it('is the ordinary message for an ordinary promote', async ({ expect }) => {
    expect(await message(expect, { kind: 'deploy', release: '' })).toBe(normal)
  })

  it('is the ordinary message when the hotfix step left nothing', async ({ expect }) => {
    expect(await message(expect, {})).toBe(normal)
  })

  it('says hotfix, naming the release it fixes, between the release and the account', async ({ expect }) => {
    expect(await message(expect, { kind: 'hotfix', release: HOTFIX_OF })).toBe(lines(
      `:white_check_mark: *${PROJECT} promoted \`${RELEASE}\` to <${APP_URL}|production>* (hotfix of \`${HOTFIX_OF}\`) by example-user`,
      SAFETY,
      RELEASE_CHANGES
    ))
  })

  it('keeps the re-run note after the account', async ({ expect }) => {
    expect((await message(expect, { kind: 'hotfix', release: HOTFIX_OF }, { triggering: 'other-user' })).split('\n')[0])
      .toBe(`:white_check_mark: *${PROJECT} promoted \`${RELEASE}\` to <${APP_URL}|production>* (hotfix of \`${HOTFIX_OF}\`) by example-user (re-run by other-user)`)
  })

  it.for([
    ['a release that is not a release tag', { kind: 'hotfix', release: 'release-x' }],
    ['a release with markup in it', { kind: 'hotfix', release: `${HOTFIX_OF}> <!channel` }],
    ['no release', { kind: 'hotfix', release: '' }],
    ['a deploy that names a release', { kind: 'deploy', release: HOTFIX_OF }]
  ])('is the ordinary message for %s', async ([, releaseKind], { expect }) => {
    expect(await message(expect, releaseKind)).toBe(normal)
  })

  it('reads the kind from the step that tells a hotfix from a deploy', () => {
    expect(findStep(promote, jobId, 'Notify Slack').step.env).toMatchObject({
      HOTFIX_KIND: '${{ steps.release-kind.outputs.kind }}',
      HOTFIX_OF: '${{ steps.release-kind.outputs.release }}'
    })
  })
})
