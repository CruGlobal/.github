import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import path from 'node:path'
import { AttemptNotAuthorized, assertAttemptAuthorized } from './v2/attempt-guard.js'
import { shaFromTags } from './flightdeck-release-event.js'
import {
  HotfixRefusal,
  PIPELINE_WORKFLOW,
  appWorkflowRuns,
  candidateKind,
  cutHotfix,
  gitIn,
  hotfixPromoteCheck,
  oneLine,
  readProductionLedger,
  short,
  verifyHotfixRef
} from './v2/hotfix.js'

// hotfix: the pipeline v2 hotfix steps, one action with five modes. The logic
// and the reasons behind it are in src/v2/hotfix.js.
//
//   verify        build-candidate.yml, on a hotfix ref: refuse the build
//                 unless the branch is one this pipeline could have cut, for
//                 the release production runs now.
//   cut           hotfix.yml: cut or extend hotfix/<release>, cherry-pick the
//                 fix and push the branch. Refuses unless the authorize-actor
//                 check passed earlier in the same job, because the push is
//                 made with a token that can write to every app repo.
//   report        hotfix.yml, after the build is dispatched: say in the run
//                 summary whether the app's own CI ran on the hotfix branch.
//                 Never fails the run.
//   release-kind  promote.yml, before the deploy: "hotfix" when the promoted
//                 commit came from a hotfix branch, otherwise "deploy", and
//                 whether a hotfix is for the release production runs now
//                 (`check`), which promote's next step reads. Never fails
//                 the step; anything GitHub cannot answer in 30 seconds is
//                 an ordinary deploy.
//   candidate-kind
//                 deploy-candidate.yml, after the deploy: the same "hotfix"
//                 or "deploy" for the candidate, plus a line naming the fixes
//                 it adds to the live release, for the stage Slack message.
//                 Never fails the step; no token, an error or no answer in
//                 about 25 seconds leaves the ordinary message.
//
// The entry point is src/entry/hotfix.js, which always runs the action. This
// module never runs anything on import, so tests can load it.

export const MODES = ['verify', 'cut', 'report', 'release-kind', 'candidate-kind']

// Fail the step with an error titled `title`, the way core.setFailed does
// plus the title, so automation can read a fixed reason word.
function refuse (message, title) {
  process.exitCode = core.ExitCode.Failure
  core.error(oneLine(message), { title })
}

async function writeSummary (lines) {
  try {
    await core.summary.addRaw(lines.join('\n') + '\n').write()
  } catch (error) {
    core.info(`could not write the run summary (${error.message})`)
  }
}

const repoPath = (input) => path.resolve(process.env.GITHUB_WORKSPACE || '.', input || '.')

// build-candidate's refusal for every ref but the default branch, kept word
// for word, with the reason this hotfix branch does not pass added.
export function buildRefusal ({ ref, defaultBranch, why }) {
  return `candidates build from the default branch only -- ${oneLine(ref)} is not refs/heads/${oneLine(defaultBranch)}, and it is not a hotfix branch this pipeline can build: ${oneLine(why)}. Merge the change to ${oneLine(defaultBranch)}, then dispatch, or cut the hotfix branch with the hotfix workflow.`
}

async function runVerify ({ readLedger }) {
  const ref = core.getInput('ref')
  const defaultBranch = core.getInput('default-branch')
  try {
    const { release, base, commits } = await verifyHotfixRef({
      git: gitIn(repoPath(core.getInput('path'))),
      ref,
      sha: core.getInput('sha'),
      defaultBranch,
      project: core.getInput('project-name'),
      readLedger
    })
    const picks = commits.map(({ sha, source }) => `${short(sha)} (from ${short(source)})`).join(', ')
    core.notice(`${ref.replace(/^refs\/heads\//, '')} starts at ${short(base)}, the commit production ran for ${release}, and every commit after it is a clean cherry-pick of a ${defaultBranch} commit${commits.length ? `: ${picks}` : ' (there are none yet)'}`, { title: 'Hotfix build' })
  } catch (error) {
    const why = error instanceof HotfixRefusal ? error.message : `the check could not finish (${error.message})`
    refuse(buildRefusal({ ref, defaultBranch, why }), 'Build Candidate')
  }
}

async function runCut ({ env, readLedger }) {
  try {
    assertAttemptAuthorized('push a hotfix branch', env)
  } catch (error) {
    if (!(error instanceof AttemptNotAuthorized)) throw error
    refuse(error.message, 'actor_not_allowed')
    return
  }
  try {
    const result = await cutHotfix({
      git: gitIn(repoPath(core.getInput('path'))),
      project: core.getInput('project-name'),
      commit: core.getInput('commit'),
      expectedRelease: core.getInput('expected-release'),
      readLedger
    })
    core.setOutput('release', result.release)
    core.setOutput('branch', result.branch)
    core.setOutput('base-sha', result.base)
    core.setOutput('commit-sha', result.commit)
    core.setOutput('head-sha', result.head)
    core.setOutput('pushed', String(result.pushed))
    core.setOutput('already-applied', String(result.alreadyApplied))
    for (const warning of result.warnings) core.warning(warning, { title: 'Hotfix build may not run' })

    const what = result.alreadyApplied
      ? `${result.branch} already has ${short(result.commit)} (as ${short(result.appliedAs)}), so nothing new was pushed. The build is dispatched again; it reuses the candidate when this commit was already built`
      : `cherry-picked ${short(result.commit)} from ${result.defaultBranch} onto ${result.branch} as ${short(result.head)} and pushed the branch`
    core.notice(what, { title: 'Hotfix branch' })
    await writeSummary([
      `## Hotfix for ${result.release}`,
      '',
      `- Production runs \`${result.release}\`, commit \`${short(result.base)}\`. The hotfix branch starts there, not at the tip of \`${result.defaultBranch}\`.`,
      `- Fix: \`${short(result.commit)}\` from \`${result.defaultBranch}\`, cherry-picked with \`-x\`.`,
      result.alreadyApplied
        ? `- \`${result.branch}\` already had this fix (\`${short(result.appliedAs)}\`). Nothing new was pushed.`
        : `- Pushed \`${result.branch}\` at \`${short(result.head)}\`.`,
      ...result.warnings.map((warning) => `- :warning: ${warning}`)
    ])
  } catch (error) {
    if (error instanceof HotfixRefusal) {
      refuse(error.message, error.reason)
      return
    }
    core.setFailed(`the hotfix run could not finish (${oneLine(error.message)}). If the error came after the push, re-run it: a re-run finds the fix already on the branch and only dispatches the build`)
  }
}

async function runReport ({ sleep }) {
  const repository = core.getInput('repository')
  const branch = core.getInput('branch')
  const sha = core.getInput('sha')
  const pushed = core.getInput('pushed') === 'true'
  const dispatched = core.getInput('dispatch-outcome') === 'success'
  const buildsUrl = `https://github.com/${repository}/actions/workflows/${PIPELINE_WORKFLOW}?query=${encodeURIComponent(`branch:${branch}`)}`
  const lines = ['', `### Build and CI for \`${branch}\``, '']
  lines.push(dispatched
    ? `- Build: dispatched \`${PIPELINE_WORKFLOW}\` on \`${branch}\` ([runs](${buildsUrl})). It builds a candidate and sends it to release-candidate; promote it from there as usual.`
    : `- Build: :x: \`${PIPELINE_WORKFLOW}\` was not dispatched on \`${branch}\`; see the run's errors. Run it on the branch by hand once the cause is fixed ([runs](${buildsUrl})).`)
  try {
    const runs = await appWorkflowRuns({
      octokit: getOctokit(core.getInput('github-token')),
      repository,
      sha,
      // Only a push made by this run can still be starting runs.
      attempts: pushed ? 4 : 1,
      sleep
    })
    if (runs.length > 0) {
      core.setOutput('ci-ran', 'true')
      lines.push(`- The app's own CI ran on \`${short(sha)}\`:`)
      for (const run of runs) {
        lines.push(`  - [${run.name}](${run.url}) (${run.event}, ${run.conclusion || run.status || 'started'})`)
      }
      core.notice(`the app's own CI ran on ${branch}: ${runs.map((run) => run.name).join(', ')}`, { title: 'App CI' })
    } else {
      core.setOutput('ci-ran', 'false')
      lines.push(`- The app's own CI did not run on \`${branch}\`: no workflow run for \`${short(sha)}\` besides the build. Most apps run CI only on pull requests and the default branch, which is accepted for now. The fix itself passed its checks on the default branch before it was cherry-picked.`)
      core.notice(`the app's own CI did not run on ${branch}; the fix passed its checks on the default branch`, { title: 'App CI' })
    }
  } catch (error) {
    core.setOutput('ci-ran', 'unknown')
    lines.push(`- Could not tell whether the app's own CI ran on \`${branch}\` (${oneLine(error.message)}).`)
    core.warning(`could not tell whether the app's own CI ran on ${branch} (${oneLine(error.message)})`)
  }
  await writeSummary(lines)
}

// Never fails the step. The kind labels the release event; `check` is read
// by promote's next step, which refuses a stale or unconfirmed hotfix and a
// hotfix whose release the ledger could not confirm.
async function runReleaseKind ({ readLedger, request }) {
  let result
  try {
    result = await hotfixPromoteCheck({
      octokit: getOctokit(core.getInput('github-token')),
      repository: core.getInput('repository'),
      sha: core.getInput('sha'),
      project: core.getInput('project-name'),
      readLedger,
      request
    })
  } catch (error) {
    const why = `the hotfix check could not run (${oneLine(error.message)})`
    result = { kind: 'deploy', why, check: 'skipped', checkWhy: why, warning: `${why}, so this promote goes on as an ordinary one` }
  }
  core.setOutput('kind', result.kind)
  core.setOutput('branch', result.branch ?? '')
  core.setOutput('release', result.release ?? '')
  core.setOutput('check', result.check)
  core.setOutput('check-why', oneLine(result.checkWhy))
  // The warning says what happened to this promote, which depends on where
  // GitHub stopped answering: before it knew a hotfix (an ordinary promote),
  // or during a confirmed hotfix's check (refused by the next step).
  if (result.warning) core.warning(oneLine(result.warning))
  core.info(`release kind ${result.kind}: ${oneLine(result.why)}; hotfix check ${result.check}: ${oneLine(result.checkWhy)}`)
}

// Never fails the step, and never warns about a missing token: a caller that
// passes none is an older wrapper, and its message stays the ordinary one.
// The outputs only change deploy-candidate's Slack message.
async function runCandidateKind ({ readLedger, request }) {
  const token = core.getInput('github-token')
  let result
  if (!token) {
    result = { kind: 'deploy', why: 'no github-token was given, so the candidate was not checked', fixes: '', fixesWhy: 'not checked' }
  } else {
    try {
      result = await candidateKind({
        octokit: getOctokit(token),
        repository: core.getInput('repository'),
        sha: shaFromTags(core.getInput('image-tags')),
        project: core.getInput('project-name'),
        readLedger,
        request
      })
    } catch (error) {
      const why = `could not tell whether this candidate is a hotfix (${oneLine(error.message)})`
      result = { kind: 'deploy', why, fixes: '', fixesWhy: 'not checked' }
      core.warning(`${why}, so the stage message is the ordinary one`, { title: 'Hotfix label' })
    }
  }
  core.setOutput('kind', result.kind)
  core.setOutput('branch', result.branch ?? '')
  core.setOutput('release', result.release ?? '')
  core.setOutput('fixes-mrkdwn', oneLine(result.fixes))
  core.info(`candidate kind ${result.kind}: ${oneLine(result.why)}; fixes: ${oneLine(result.fixesWhy)}`)
}

export async function run ({ env = process.env, readLedger = readProductionLedger, sleep, request } = {}) {
  const mode = core.getInput('mode').trim()
  try {
    switch (mode) {
      case 'verify': return await runVerify({ readLedger })
      case 'cut': return await runCut({ env, readLedger })
      case 'report': return await runReport({ sleep })
      case 'release-kind': return await runReleaseKind({ readLedger, request })
      case 'candidate-kind': return await runCandidateKind({ readLedger, request })
      default: core.setFailed(`unknown mode '${oneLine(mode)}'; expected one of ${MODES.join(', ')}`)
    }
  } catch (error) {
    core.setFailed(oneLine(error?.message ?? error))
  }
}
