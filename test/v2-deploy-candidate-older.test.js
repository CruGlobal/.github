import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// deploy-candidate's older-candidate guard. GitHub can start a run late, so
// the deploy of an older candidate can arrive after a newer one has landed on
// release-candidate. The guard skips it the way the no-op guard skips a
// same-digest deploy, but only when the build number says older AND GitHub
// says the candidate's commit comes before the running one's. A hotfix is
// numbered from the same counter as the default branch, so the commit check
// is what keeps a hotfix and a default-branch build replacing each other as
// they always have. Anything the guard cannot check deploys, as before, with
// a warning.
//
// These run the real steps from deploy-candidate.yml under bash (see
// support/workflow-steps.js), in both deploy jobs. The AWS job serves ECS,
// Lambda and static sites alike.

const workflow = loadYaml('.github/workflows/deploy-candidate.yml')
const scratch = mkdtempSync(path.join(tmpdir(), 'older-candidate-'))
afterAll(() => {
  removeFakes()
  rmSync(scratch, { recursive: true, force: true })
})

const JOBS = ['deploy-candidate-gcp', 'deploy-candidate-aws']
const OLDER = 'Older-candidate guard (newer already deployed)'
const NOOP = 'No-op guard (already deployed)'

const REPO = 'example-org/example-app'
const TOKEN = 'ghs-example-token'
const DIGEST_A = 'sha256:' + 'a'.repeat(64)
const DIGEST_B = 'sha256:' + 'b'.repeat(64)
const SHA_A = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567'
const SHA_B = 'c0ffee0000000000000000000000000000000002'
const EARLIER = 'candidate-2026-10-21-10150'
const LATER = 'candidate-2026-10-21-10151'

// What the runner would supply: by default, a deploy of EARLIER (digest A)
// while release-candidate runs LATER (digest B), with a token to ask GitHub.
function context ({
  tag = EARLIER,
  force = 'false',
  want = DIGEST_A,
  wantTags = `${EARLIER},sha-${SHA_A}`,
  have = DIGEST_B,
  haveTags = `${LATER},sha-${SHA_B}`,
  token = TOKEN,
  repository = REPO,
  older = ''
} = {}) {
  return {
    'inputs.project-name': 'example-app',
    'secrets.datadog-api-key': 'dd-test',
    "secrets.slack-bot-token != ''": 'true',
    'inputs.tag': tag,
    'inputs.force': force,
    'steps.resolve.outputs.digest': want,
    'steps.resolve.outputs.tags': wantTags,
    'steps.current.outputs.digest': have,
    'steps.current.outputs.tags': haveTags,
    'secrets.github-token': token,
    'needs.lookup.outputs.repository': repository,
    'steps.older.outputs.skip': older
  }
}

// The workflow command lines a step printed, e.g. "::notice title=x::message".
const annotations = (stdout) => stdout.split('\n').filter((line) => line.startsWith('::'))
const warnings = (stdout) => annotations(stdout).filter((line) => line.startsWith('::warning'))

// Run the guard, then the no-op guard with what the guard wrote, the way the
// job does. `github` is what a GitHub compare read answers.
async function deploy (job, { github = {}, ...overrides } = {}, harness = {}) {
  const summary = path.join(scratch, `summary-${Math.random().toString(36).slice(2)}`)
  const guard = await runShellStep(findStep(workflow, job, OLDER), {
    context: context(overrides),
    ghCompare: github,
    runnerEnv: { GITHUB_STEP_SUMMARY: summary },
    ...harness
  })
  const noop = await runShellStep(findStep(workflow, job, NOOP), {
    context: context({ ...overrides, older: guard.outputs.skip ?? '' })
  })
  return { guard, noop, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' }
}

const skipNotice = (running, skipped) =>
  `::notice title=Newer candidate already deployed::release-candidate already runs a newer candidate ${running}; skipping ${skipped} (set force to deploy it anyway).`

describe('deploy-candidate.yml older-candidate guard, wiring', () => {
  it.each(JOBS)('%s checks between reading what runs and the no-op guard', (job) => {
    const names = workflow.jobs[job].steps.map((step) => step.name)
    const at = names.indexOf(OLDER)
    expect(at).toBe(names.indexOf('Check image currently on release-candidate') + 1)
    expect(names.indexOf(NOOP)).toBe(at + 1)
  })

  it('is the same guard in both jobs', () => {
    const [gcp, aws] = JOBS.map((job) => findStep(workflow, job, OLDER).step)
    expect(aws.run).toBe(gcp.run)
    expect(aws.env).toEqual(gcp.env)
    const [gcpNoop, awsNoop] = JOBS.map((job) => findStep(workflow, job, NOOP).step)
    expect(awsNoop.run).toBe(gcpNoop.run)
    expect(awsNoop.env).toEqual(gcpNoop.env)
  })

  // A guard that fails or runs out of time must let the deploy go on, as a
  // failed read of what runs already does.
  it.each(JOBS)('%s never stops the deploy on a guard that fails', (job) => {
    const { step } = findStep(workflow, job, OLDER)
    expect(step.id).toBe('older')
    expect(step['continue-on-error']).toBe(true)
    expect(step['timeout-minutes']).toBe(1)
    expect(step.if).toBeUndefined()
  })

  it.each(JOBS)('%s reads what runs from the registry tags the read before it found', (job) => {
    const { step } = findStep(workflow, job, OLDER)
    expect(step.env).toEqual({
      TAG: '${{ inputs.tag }}',
      FORCE: '${{ inputs.force }}',
      WANT: '${{ steps.resolve.outputs.digest }}',
      WANT_TAGS: '${{ steps.resolve.outputs.tags }}',
      HAVE: '${{ steps.current.outputs.digest }}',
      HAVE_TAGS: '${{ steps.current.outputs.tags }}',
      GH_TOKEN: '${{ secrets.github-token }}',
      APP_REPO: '${{ needs.lookup.outputs.repository }}'
    })
  })

  // The no-op guard stays the one switch: every step after it keys on its
  // skip output, as before, so a skip for an older candidate skips them all.
  it.each(JOBS)('%s skips through the no-op guard, so every later step still keys on one switch', (job) => {
    const steps = workflow.jobs[job].steps
    const noop = findStep(workflow, job, NOOP).step
    expect(noop.env.OLDER).toBe('${{ steps.older.outputs.skip }}')
    const after = steps.slice(steps.indexOf(noop) + 1)
    const gated = after.filter((step) => String(step.if ?? '').includes("steps.noop.outputs.skip != 'true'"))
    const ungated = after.filter((step) => !gated.includes(step)).map((step) => step.name)
    expect(ungated).toEqual(['Notify Slack (failure)'])
    expect(gated.map((step) => step.name)).toContain(workflow.jobs[job].steps.find((step) => /^Deploy to /.test(step.name)).name)
  })

  it('leaves the stage-less verify job as it was', () => {
    const names = workflow.jobs['verify-candidate-aws'].steps.map((step) => step.name)
    expect(names).not.toContain(OLDER)
  })
})

describe.each(JOBS)('deploy-candidate.yml:%s older-candidate guard', (job) => {
  describe('skips', () => {
    it('a candidate older than the one release-candidate runs, on the same history', async () => {
      const { guard, noop, summary } = await deploy(job, { github: { status: 'behind' } })

      expect(guard.status, guard.stderr).toBe(0)
      expect(guard.outputs).toEqual({ skip: 'true' })
      expect(annotations(guard.stdout)).toEqual([skipNotice(LATER, EARLIER)])
      expect(summary).toBe(`### Deploy skipped\n\nrelease-candidate already runs a newer candidate ${LATER}; skipping ${EARLIER} (set force to deploy it anyway).\n`)

      // Asked once, with a time limit, the running commit first.
      expect(guard.comparePath).toBe(`repos/${REPO}/compare/${SHA_B}...${SHA_A}`)
      expect(guard.githubCalls).toHaveLength(1)
      expect(guard.githubCalls[0]).toMatch(/--connect-timeout 10 --max-time 20 /)
      expect(guard.githubCalls[0]).toContain(`Authorization: Bearer ${TOKEN}`)

      // The no-op guard turns that into the skip every later step reads,
      // and says nothing more: the guard already said why.
      expect(noop.status, noop.stderr).toBe(0)
      expect(noop.outputs).toEqual({ skip: 'true' })
      expect(annotations(noop.stdout)).toEqual([])
    })

    it('an undated candidate-<n> tag, which shares the counter', async () => {
      const { guard, noop } = await deploy(job, { tag: 'candidate-10150', wantTags: `candidate-10150,sha-${SHA_A}`, github: { status: 'behind' } })
      expect(guard.outputs).toEqual({ skip: 'true' })
      expect(annotations(guard.stdout)).toEqual([skipNotice(LATER, 'candidate-10150')])
      expect(noop.outputs).toEqual({ skip: 'true' })
    })

    it('a late build from a hotfix branch that already has a newer build on stage', async () => {
      const first = 'candidate-2026-10-21-10160'
      const second = 'candidate-2026-10-21-10161'
      const { guard, noop } = await deploy(job, {
        tag: first,
        wantTags: `${first},sha-${SHA_A}`,
        haveTags: `${second},sha-${SHA_B}`,
        github: { status: 'behind' }
      })
      expect(guard.outputs).toEqual({ skip: 'true' })
      expect(annotations(guard.stdout)).toEqual([skipNotice(second, first)])
      expect(noop.outputs).toEqual({ skip: 'true' })
    })

    it('without a summary file, and still skips', async () => {
      const guard = await runShellStep(findStep(workflow, job, OLDER), { context: context(), ghCompare: { status: 'behind' } })
      expect(guard.status, guard.stderr).toBe(0)
      expect(guard.outputs).toEqual({ skip: 'true' })
    })
  })

  describe('deploys', () => {
    // A deploy that goes on: the guard says skip=false, the no-op guard does
    // not skip, and nothing is skipped behind anyone's back.
    function expectDeploys ({ guard, noop }) {
      expect(guard.status, guard.stderr).toBe(0)
      expect(guard.outputs).toEqual({ skip: 'false' })
      expect(noop.status, noop.stderr).toBe(0)
      expect(noop.outputs).toEqual({ skip: 'false' })
      expect(annotations(noop.stdout)).toEqual([])
    }

    it('a newer candidate, without asking GitHub', async () => {
      const result = await deploy(job, {
        tag: LATER,
        want: DIGEST_B,
        wantTags: `${LATER},sha-${SHA_B}`,
        have: DIGEST_A,
        haveTags: `${EARLIER},sha-${SHA_A}`
      })
      expectDeploys(result)
      expect(annotations(result.guard.stdout)).toEqual([])
      expect(result.guard.githubCalls).toEqual([])
      expect(result.summary).toBe('')
    })

    it('an older candidate when force is set, without asking GitHub', async () => {
      const result = await deploy(job, { force: 'true', github: { status: 'behind' } })
      expectDeploys(result)
      expect(annotations(result.guard.stdout)).toEqual([])
      expect(result.guard.githubCalls).toEqual([])
    })

    it('when force is set, even if the guard had said skip', async () => {
      const noop = await runShellStep(findStep(workflow, job, NOOP), { context: context({ force: 'true', older: 'true' }) })
      expect(noop.outputs).toEqual({ skip: 'false' })
    })

    it('an older candidate whose commit comes after the running one\'s', async () => {
      const result = await deploy(job, { github: { status: 'ahead' } })
      expectDeploys(result)
      expect(warnings(result.guard.stdout)).toEqual([])
      expect(result.guard.stdout).toContain('its commit comes after that one\'s, so it is deployed')
    })

    it('an older candidate built from the same commit', async () => {
      const result = await deploy(job, { github: { status: 'identical' } })
      expectDeploys(result)
      expect(warnings(result.guard.stdout)).toEqual([])
    })

    it('when a digest carries a newer candidate tag than the one asked for', async () => {
      const result = await deploy(job, { wantTags: `${EARLIER},candidate-2026-10-22-10152,sha-${SHA_A}`, github: { status: 'behind' } })
      expectDeploys(result)
      expect(result.guard.githubCalls).toEqual([])
    })

    it('when the running digest carries a candidate tag as old as the one asked for', async () => {
      const result = await deploy(job, { haveTags: `${LATER},candidate-2026-10-20-10149,sha-${SHA_B}`, github: { status: 'behind' } })
      expectDeploys(result)
      expect(result.guard.githubCalls).toEqual([])
    })
  })

  // A hotfix candidate is tagged candidate-<yyyy-mm-dd>-<n> like any other,
  // with n from the same counter. So by build number alone, a reused
  // default-branch candidate looks older than a hotfix built since, and a
  // hotfix sent again looks older than a default-branch build made since.
  // Their commits are on split histories, so GitHub says diverged and each
  // still replaces the other, as it does today.
  describe('hotfix candidates', () => {
    const HOTFIX = 'candidate-2026-10-21-10160'
    const MAIN = 'candidate-2026-10-21-10155'
    const NEXT_MAIN = 'candidate-2026-10-22-10162'

    it('a new hotfix replaces the default-branch build on stage, without asking GitHub', async () => {
      const { guard, noop } = await deploy(job, {
        tag: HOTFIX,
        want: DIGEST_A,
        wantTags: `${HOTFIX},sha-${SHA_A}`,
        haveTags: `${MAIN},sha-${SHA_B}`
      })
      expect(guard.outputs).toEqual({ skip: 'false' })
      expect(guard.githubCalls).toEqual([])
      expect(noop.outputs).toEqual({ skip: 'false' })
    })

    it('the nightly run of the default branch, which reuses an older candidate, still replaces the hotfix', async () => {
      const { guard, noop } = await deploy(job, {
        tag: MAIN,
        wantTags: `${MAIN},sha-${SHA_A}`,
        haveTags: `${HOTFIX},sha-${SHA_B}`,
        github: { status: 'diverged' }
      })
      expect(guard.outputs).toEqual({ skip: 'false' })
      expect(warnings(guard.stdout)).toEqual([])
      expect(guard.stdout).toContain(`${MAIN} has a lower build number than ${HOTFIX}, the candidate release-candidate runs, but the two are built from split histories`)
      expect(guard.comparePath).toBe(`repos/${REPO}/compare/${SHA_B}...${SHA_A}`)
      expect(noop.outputs).toEqual({ skip: 'false' })
    })

    it('a newer default-branch build replaces the hotfix, without asking GitHub', async () => {
      const { guard, noop } = await deploy(job, {
        tag: NEXT_MAIN,
        want: DIGEST_A,
        wantTags: `${NEXT_MAIN},sha-${SHA_A}`,
        haveTags: `${HOTFIX},sha-${SHA_B}`
      })
      expect(guard.outputs).toEqual({ skip: 'false' })
      expect(guard.githubCalls).toEqual([])
      expect(noop.outputs).toEqual({ skip: 'false' })
    })

    it('a hotfix sent again by a re-run of the hotfix workflow replaces a newer default-branch build', async () => {
      const { guard, noop } = await deploy(job, {
        tag: HOTFIX,
        wantTags: `${HOTFIX},sha-${SHA_A}`,
        haveTags: `${NEXT_MAIN},sha-${SHA_B}`,
        github: { status: 'diverged' }
      })
      expect(guard.outputs).toEqual({ skip: 'false' })
      expect(warnings(guard.stdout)).toEqual([])
      expect(noop.outputs).toEqual({ skip: 'false' })
    })
  })

  // Every way the check can fail to be made: the deploy goes on, as before,
  // with one warning that says why.
  describe('deploys with a warning when it cannot check', () => {
    async function expectNotChecked (overrides, harness, why) {
      const { guard, noop } = await deploy(job, overrides, harness)
      expect(guard.status, guard.stderr).toBe(0)
      expect(guard.outputs).toEqual({ skip: 'false' })
      const tag = overrides.tag ?? EARLIER
      expect(warnings(guard.stdout)).toEqual([
        `::warning title=Candidate order not checked::${why}, so ${tag.replace(/[\r\n]/g, ' ')} is deployed without checking whether release-candidate runs a newer candidate`
      ])
      expect(noop.outputs).toEqual({ skip: 'false' })
      return guard
    }
    const older = `${EARLIER} has a lower build number than ${LATER}, the candidate release-candidate runs`

    it('when the read of what runs found nothing (a fresh environment, a placeholder, services on different images, or a read that failed)', async () => {
      const guard = await expectNotChecked({ have: '', haveTags: '' }, {},
        'the step above could not tell which image release-candidate runs (nothing is deployed there yet, it does not serve one image, or the read failed)')
      expect(guard.githubCalls).toEqual([])
    })

    it('when the running image carries no candidate tag', async () => {
      await expectNotChecked({ haveTags: `release-2026-10-20-10140,sha-${SHA_B}` }, {},
        `release-candidate runs ${DIGEST_B}, which carries no candidate tag`)
    })

    it('when the running image\'s tags could not be read', async () => {
      await expectNotChecked({ haveTags: '' }, {}, `release-candidate runs ${DIGEST_B}, which carries no candidate tag`)
    })

    it.each([
      'sha-' + SHA_A,
      'release-2026-10-20-10140',
      'candidate-latest',
      'candidate-2026-10-21-' + '1'.repeat(19)
    ])('when the tag asked for, %s, is not a candidate tag', async (tag) => {
      const guard = await expectNotChecked({ tag, github: { status: 'behind' } }, {}, `${tag} is not a candidate-<yyyy-mm-dd>-<n> tag`)
      expect(guard.githubCalls).toEqual([])
    })

    it('when no github-token was given', async () => {
      const guard = await expectNotChecked({ token: '', github: { status: 'behind' } }, {},
        `${older}, but no github-token was given to check that its commit comes before that one's (a hotfix is numbered from the same counter)`)
      expect(guard.githubCalls).toEqual([])
    })

    it.each([
      ['no sha- tag', `${EARLIER}`],
      ['two sha- tags', `${EARLIER},sha-${SHA_A},sha-${'d'.repeat(40)}`]
    ])('when the candidate\'s image has %s', async (_what, wantTags) => {
      const guard = await expectNotChecked({ wantTags, github: { status: 'behind' } }, {}, `${older}, but its image does not name one commit with a sha- tag`)
      expect(guard.githubCalls).toEqual([])
    })

    it('when the running image has no sha- tag', async () => {
      await expectNotChecked({ haveTags: LATER, github: { status: 'behind' } }, {},
        `${older}, but the image release-candidate runs does not name one commit with a sha- tag`)
    })

    it.each([
      ['not owner/name', 'example-app', 'example-app'],
      ['empty', '', ''],
      ['two lines', `${REPO}\n::error::boom`, `${REPO} ::error::boom`]
    ])('when the app repository is %s', async (_what, repository, shown) => {
      const guard = await expectNotChecked({ repository, github: { status: 'behind' } }, {},
        `${older}, but the app repository '${shown}' is not in owner/name form`)
      expect(guard.githubCalls).toEqual([])
    })

    it('when GitHub does not answer in time', async () => {
      await expectNotChecked({}, { ghCompareTimesOut: true },
        `${older}, but GitHub did not answer within 20 seconds whether its commit comes before that one's`)
    })

    it('when GitHub refuses the compare', async () => {
      await expectNotChecked({}, { ghCompareFails: true }, `${older}, but GitHub could not compare the two commits (curl exit 22)`)
    })

    it.each([
      ['something that is not JSON', '<html>bad gateway</html>'],
      ['no status', {}],
      ['a status it does not know', { status: 'sideways' }]
    ])('when GitHub answers %s', async (_what, github) => {
      const result = await deploy(job, {}, { ghCompare: github })
      expect(result.guard.outputs).toEqual({ skip: 'false' })
      expect(warnings(result.guard.stdout)).toEqual([
        `::warning title=Candidate order not checked::${older}, but GitHub did not say how the two commits compare, so ${EARLIER} is deployed without checking whether release-candidate runs a newer candidate`
      ])
      expect(result.noop.outputs).toEqual({ skip: 'false' })
    })

    // A tag with a line break cannot resolve in a registry, so it never gets
    // this far. If one did, it must not add a workflow command of its own.
    it('in one line when the tag holds a line break', async () => {
      const tag = 'candidate-1\n::error::boom'
      const guard = await expectNotChecked({ tag }, {}, 'candidate-1 ::error::boom is not a candidate-<yyyy-mm-dd>-<n> tag')
      expect(annotations(guard.stdout).filter((line) => line.startsWith('::error'))).toEqual([])
    })
  })

  // The existing no-op: same digest. The guard leaves it to the no-op guard,
  // which says "Already deployed" exactly as before.
  describe('same digest', () => {
    it('is still the no-op guard\'s skip, with its own notice', async () => {
      const { guard, noop } = await deploy(job, {
        tag: LATER,
        want: DIGEST_B,
        wantTags: `${LATER},sha-${SHA_B}`,
        github: { status: 'identical' }
      })
      expect(guard.outputs).toEqual({ skip: 'false' })
      expect(annotations(guard.stdout)).toEqual([])
      expect(guard.githubCalls).toEqual([])
      expect(noop.outputs).toEqual({ skip: 'true' })
      expect(annotations(noop.stdout)).toEqual([
        `::notice title=Already deployed::release-candidate already runs ${LATER} (${DIGEST_B}); skipping (set force to redeploy).`
      ])
    })

    it('redeploys with force, as before', async () => {
      const { noop } = await deploy(job, { tag: LATER, want: DIGEST_B, wantTags: `${LATER},sha-${SHA_B}`, force: 'true' })
      expect(noop.outputs).toEqual({ skip: 'false' })
    })
  })
})
