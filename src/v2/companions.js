import escapeStringRegexp from 'escape-string-regexp'
import { parseImageRef } from './image-ref'

// Companion images: a second image an ECS app builds alongside its own, ships
// in the same release, and runs as a one-off task it starts itself rather than
// as a service. The deploy keeps the companion's task definition on the same
// release as the app, and promote keeps the companion image as long as the
// release that names it.
//
// THE CONTRACT. The app image names each companion with a label:
//
//   LABEL org.cru.companion.<name>=<registry>/<project>/<suffix>@sha256:<digest>
//
//   <name>   lowercase letters and digits, joined by single dashes. It picks
//            the companion's task-definition family, <project>-<nick>-<name>,
//            which the app's Terraform creates. "db-migrate" is taken.
//   value    a digest reference in the same registry as the app image, in a
//            repository under the app's own namespace, <project>/<suffix>.
//            A project name has no '/', so only this app's repositories can
//            match. A dash would not do: one app's name is often another's
//            prefix (<project>-ui can be a different app), and promote writes
//            release tags into every companion's repository.
//
// The build pushes the companion first, then bakes its digest into the app
// image's label, so the app image is the one record of which companion goes
// with it. A label that breaks these rules fails the deploy before anything
// changes.
//
// The app starts its companion from the newest revision of the family that runs
// the digest its own image expects, never from the bare family name. A
// Terraform change to the family registers a new latest revision on the scratch
// placeholder, and it stays that way until the next deploy.
export const COMPANION_LABEL_PREFIX = 'org.cru.companion.'

// Families the pipeline already owns. A companion may not take their names.
const RESERVED_NAMES = ['db-migrate']

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

// The companions an image names, as [{ name, image, repository, digest }],
// sorted by name. `appImage` is the app image's own reference: a companion must
// sit in its registry. Throws with every problem at once when any label breaks
// the contract.
export function parseCompanions (labels, { projectName, appImage }) {
  const registry = registryOf(appImage)
  const repository = new RegExp(`^${escapeStringRegexp(projectName)}/[a-z0-9]+(?:[._-][a-z0-9]+)*$`)
  const companions = []
  const problems = []

  for (const [label, value] of Object.entries(labels ?? {})) {
    if (!label.startsWith(COMPANION_LABEL_PREFIX)) continue
    const name = label.slice(COMPANION_LABEL_PREFIX.length)
    const problem = labelProblem({ name, value, registry, repository, projectName })
    if (problem) {
      problems.push(`${label}: ${problem}`)
      continue
    }
    const { name: ref, digest } = parseImageRef(value)
    companions.push({ name, image: value, repository: ref.slice(registry.length + 1), digest })
  }

  if (problems.length > 0) {
    throw new Error(`The image's companion labels break the contract: ${problems.join('; ')}`)
  }
  return companions.sort((a, b) => a.name.localeCompare(b.name))
}

function labelProblem ({ name, value, registry, repository, projectName }) {
  if (!NAME.test(name)) return 'the name must be lowercase letters and digits joined by single dashes'
  if (RESERVED_NAMES.includes(name)) return `the name "${name}" is taken by the pipeline`
  if (typeof value !== 'string' || value === '') return 'the value is empty'

  const { name: ref, digest } = parseImageRef(value)
  if (!digest || !DIGEST.test(digest)) return `"${value}" is not pinned by a sha256 digest`
  if (registryOf(ref) !== registry) return `"${value}" is not in the app image's registry, ${registry}`
  const repo = ref.slice(registry.length + 1)
  if (!repository.test(repo)) return `repository "${repo}" is not one name under "${projectName}/"`
  return undefined
}

// The registry host is everything before the first '/'.
function registryOf (ref) {
  return parseImageRef(ref).name.split('/')[0]
}

// <project>-<nick>-<name>: the family the app's Terraform creates for a
// companion, named the way services, db-migrate and scheduled tasks are.
export function companionFamily (projectName, nickname, name) {
  return `${projectName}-${nickname}-${name}`
}
