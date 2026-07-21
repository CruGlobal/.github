import { GoogleAuth } from 'google-auth-library'
import { DEFAULT_REGION } from '../gcp'
import { parseImageRef } from './image-ref'

// Re-export the provider-neutral reference helpers so existing importers
// (deploy.js, resolve-cloudrun.js, tests) keep working after the extraction
// into src/v2/image-ref.js.
export { parseImageRef, isDigestRef, isTagRef, assertDigestRef } from './image-ref'

// The shared Artifact Registry project. v2 builds an env-neutral image once and
// pushes it here; every environment then deploys (by digest) out of this one
// registry. Convention: one Artifact Registry repo per app, named after the
// app, with a single image also named after the app:
//
//   us-central1-docker.pkg.dev/cru-shared-artifacts/<project-name>/<project-name>:<tag>
//
export const SHARED_PROJECT = 'cru-shared-artifacts'
export const SHARED_LOCATION = DEFAULT_REGION // us-central1

// Repo name == app name (one repo per app in the shared project).
export function sharedRegistryRepo (projectName) {
  return projectName
}

// Fully-qualified image path (no tag/digest): host/project/repo/image.
export function sharedRegistryImage (projectName) {
  return `${SHARED_LOCATION}-docker.pkg.dev/${SHARED_PROJECT}/${projectName}/${projectName}`
}

// Tag-pinned reference: <image>:<tag> (e.g. candidate-10012, release-3).
export function sharedImageTag (projectName, tag) {
  return `${sharedRegistryImage(projectName)}:${tag}`
}

// Digest-pinned reference: <image>@sha256:... (what v2 always deploys).
export function sharedImageDigest (projectName, digest) {
  return `${sharedRegistryImage(projectName)}@${digest}`
}

// Predicate identifying the "app" container within a Cloud Run service
// template. Mirrors the heuristic v1's src/deploy-cloudrun.js uses so resolve
// and deploy agree on which container carries the app image:
//   1. a single-container service has exactly one, or
//   2. the container already running this app's image (repo match), or
//   3. the ingress container (the one with a port) before any real build.
// `repo` is the tag/digest-stripped image path to match against.
export function isAppContainer (container, containers, repo) {
  return (
    containers.length === 1 ||
    (container.image != null && parseImageRef(container.image).name === repo) ||
    (container.ports?.length ?? 0) > 0
  )
}

// Pick the single app container out of a service template's containers. Prefers
// the most specific signal (repo match) over the ingress-port fallback, so a
// sidecar that happens to expose a port is never mistaken for the app.
export function findAppContainer (containers, repo) {
  if (containers.length === 1) return containers[0]
  return (
    containers.find(c => c.image != null && parseImageRef(c.image).name === repo) ??
    containers.find(c => (c.ports?.length ?? 0) > 0) ??
    null
  )
}

// Obtain an authenticated Google API client (ADC / workload-identity on the
// runner). Split out so tests can mock google-auth-library.
async function authClient () {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  return auth.getClient()
}

// List every DockerImage in an Artifact Registry repo via the REST API,
// following pagination. Each item has { uri, tags, name, ... }; `uri` is the
// canonical digest reference (host/project/repo/image@sha256:...).
export async function listDockerImages (project, repository, location = SHARED_LOCATION) {
  const client = await authClient()
  const url =
    `https://artifactregistry.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/repositories/${repository}/dockerImages`

  const images = []
  let pageToken
  do {
    const res = await client.request({
      url,
      method: 'GET',
      params: { pageSize: 1000, ...(pageToken ? { pageToken } : {}) }
    })
    images.push(...(res.data?.dockerImages ?? []))
    pageToken = res.data?.nextPageToken
  } while (pageToken)
  return images
}

// Resolve a tag (e.g. candidate-10012, release-3) to a digest reference in the
// shared registry. Returns the full digest ref, the sha256:... digest, and all
// tags currently on that digest. Throws if the tag is not present.
export async function resolveTag (projectName, tag) {
  const images = await listDockerImages(SHARED_PROJECT, sharedRegistryRepo(projectName))
  const match = images.find(image => (image.tags ?? []).includes(tag))
  if (!match) {
    throw new Error(
      `Tag "${tag}" not found in ${SHARED_PROJECT}/${sharedRegistryRepo(projectName)}`
    )
  }
  const { digest } = parseImageRef(match.uri)
  return {
    image: sharedImageDigest(projectName, digest),
    digest,
    tags: match.tags ?? []
  }
}

// List the tags currently pointing at a digest in the shared registry. Returns
// [] when the digest is not found (e.g. it lives outside the shared registry),
// so this is safe to call opportunistically for reporting.
export async function tagsForDigest (projectName, digest) {
  const images = await listDockerImages(SHARED_PROJECT, sharedRegistryRepo(projectName))
  const match = images.find(image => parseImageRef(image.uri).digest === digest)
  return match?.tags ?? []
}

// Add (or move) a tag onto a digest via the Artifact Registry REST API — the
// programmatic equivalent of `gcloud artifacts docker tags add`, used by the
// tag-image action to stamp release-<n> onto a promoted digest without shelling
// out to gcloud.
//
// A Docker image version's ID in Artifact Registry is its digest (sha256:...),
// and the image name is the package. For the shared registry the repo and the
// package are both the project name. Requires roles/artifactregistry.writer.
//
// Idempotent: create-or-move (POST to create; if the tag already exists, PATCH
// it to point at this version), matching `tags add` semantics.
export async function addTag (project, repository, packageName, digest, tag) {
  const client = await authClient()
  const parent =
    `projects/${project}/locations/${SHARED_LOCATION}` +
    `/repositories/${repository}/packages/${encodeURIComponent(packageName)}`
  const tagName = `${parent}/tags/${tag}`
  const version = `${parent}/versions/${digest}`

  try {
    await client.request({
      url: `https://artifactregistry.googleapis.com/v1/${parent}/tags`,
      method: 'POST',
      params: { tagId: tag },
      data: { name: tagName, version }
    })
  } catch (error) {
    const status = error?.response?.status ?? error?.status ?? error?.code
    // 409 ALREADY_EXISTS: the tag exists -> move it to this version.
    if (status === 409) {
      await client.request({
        url: `https://artifactregistry.googleapis.com/v1/${tagName}`,
        method: 'PATCH',
        params: { updateMask: 'version' },
        data: { name: tagName, version }
      })
    } else {
      throw error
    }
  }

  const image = `${SHARED_LOCATION}-docker.pkg.dev/${project}/${repository}/${packageName}@${digest}`
  return { tag, version, image }
}
