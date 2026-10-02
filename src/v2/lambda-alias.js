import * as core from '@actions/core'
import { lambdaGetAlias, lambdaGetFunction } from '../aws'

// A Lambda function either runs $LATEST, the way every v2 Lambda deploy worked
// at first, or runs through published versions: its triggers call an alias
// named `live`, and the alias points at one version. A version freezes the code
// and the config together, which is what provisioned concurrency needs, and
// moving an alias back to an older version is a rollback that takes effect at
// once.
//
// The app's Terraform owns the alias and publishes too: it sets `publish` on
// the function and points the alias at the newest version, so a config change
// (memory, timeout, environment) goes live on apply without a deploy. That
// only stays safe while every deploy, restore and rollback keeps two rules:
//
//   1. The alias is on the newest version. Otherwise the next apply moves it
//      forward, to whatever that newest version runs.
//   2. $LATEST runs the alias's image. A config change publishes whatever
//      $LATEST holds.
export const LIVE_ALIAS = 'live'

const VERSION = /^[0-9]+$/

// What the deploy role needs to deploy through the alias.
const PERMISSIONS = 'lambda:GetAlias, lambda:GetFunction on the function\'s versions, lambda:PublishVersion, ' +
  'lambda:UpdateAlias, and lambda:DeleteFunction on its versions'

// The function's live alias, as { version, revisionId, image }: the version it
// points at, the alias's own revision (to move it safely), and the image that
// version runs. Null when the function deploys through $LATEST: it has no live
// alias, the alias points at $LATEST, or the deploy role cannot read aliases
// yet (a warning says so). Throws when the alias splits traffic between
// versions, which the pipeline never does and won't undo by guessing.
export async function readLiveAlias (functionName) {
  let alias
  try {
    alias = await lambdaGetAlias(functionName, LIVE_ALIAS)
  } catch (error) {
    if (error?.name === 'ResourceNotFoundException') return null
    if (isAccessDenied(error)) {
      // Roles change on their own schedule, so a role without the new
      // permissions keeps deploying the way it always has.
      core.warning(
        `Could not read the ${LIVE_ALIAS} alias of ${functionName} (${error.message}), so it is treated as a ` +
        'function without one, and its $LATEST is read and deployed as before. If it has the alias, its triggers ' +
        `stay on the old release until the deploy role has ${PERMISSIONS}.`
      )
      return null
    }
    throw error
  }

  const version = alias.FunctionVersion ?? ''
  // An alias on $LATEST follows every update to $LATEST, so today's deploy is
  // already right for it.
  if (!VERSION.test(version)) return null

  const others = Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {})
  if (others.length > 0) {
    throw new Error(
      `The ${LIVE_ALIAS} alias of ${functionName} splits traffic between version ${version} and version ` +
      `${others.join(', ')}. The pipeline only moves an alias that sends all its traffic to one version, so ` +
      'finish or undo the split first.'
    )
  }

  let code
  try {
    ({ Code: code = {} } = await lambdaGetFunction(functionName, version))
  } catch (error) {
    throw explainAccessDenied(error)
  }
  if (!code.ResolvedImageUri) {
    throw new Error(`Version ${version} of ${functionName} has no resolved image; is it an image function?`)
  }
  return { version, revisionId: alias.RevisionId, image: code.ResolvedImageUri }
}

export function isVersionNumber (version) {
  return VERSION.test(String(version ?? ''))
}

// An access-denied error from a step of the alias deploy, saying what the
// role is missing. Any other error comes back as it was.
export function explainAccessDenied (error) {
  if (!isAccessDenied(error)) return error
  const explained = new Error(`${error.message} (to deploy through a ${LIVE_ALIAS} alias, the deploy role needs ${PERMISSIONS})`)
  explained.cause = error
  return explained
}

function isAccessDenied (error) {
  return error?.name === 'AccessDeniedException' || error?.$metadata?.httpStatusCode === 403
}
