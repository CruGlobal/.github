import * as core from '@actions/core'
import { verifyStatic } from './v2/verify-static.js'

// verify-static-site: the release-candidate gate of a static site with no stage
// environment (app-info RcMode "verify"). It checks the candidate image the way
// the deploy would read it, plus every local link in its HTML, and changes
// nothing anywhere. See src/v2/verify-static.js for what it proves and what it
// does not.
//
// A failure carries the same title as the verify command of a stage-less ECS
// or Lambda app, so the run's annotations read the same for every type.
export async function run () {
  try {
    const image = core.getInput('image', { required: true })
    const result = await verifyStatic({ image })
    core.setOutput('pages', String(result.pages))
    core.setOutput('links', String(result.links))
    core.setOutput('files', String(result.files))
  } catch (error) {
    const message = error.message.replace(/\.?\s*$/, '.')
    core.error(`${message} This candidate is not verified.`, { title: 'Verification failed' })
    process.exitCode = core.ExitCode.Failure
  }
}

// The action's entry point is src/entry/verify-static-site.js, which always
// calls run().
