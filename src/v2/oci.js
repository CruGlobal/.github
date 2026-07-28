// Read-only OCI registry client: enough of the Docker Registry v2 API to read
// an image's labels and pull one small file out of its filesystem, without a
// docker daemon and without materializing the whole image.
//
// Why not `docker pull` / `crane`: the deploy runner has neither a daemon warmed
// up nor a binary to install, and both would download every layer. The only
// consumer (src/v2/signin.js) wants a ~100KB file that the app's Dockerfile
// COPYs in a late, tiny layer, so scanning layers newest-first normally reads
// exactly one small blob.
//
// Artifact Registry serves the Docker v2 API at
// https://<location>-docker.pkg.dev/v2/<project>/<repo>/<image>/... and accepts
// a plain OAuth bearer token, so the same ADC credentials the rest of the deploy
// uses work here. Requires roles/artifactregistry.reader, which every env's
// cru-deploy SA already holds for resolve-image.
import * as core from '@actions/core'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { authClient, parseImageRef } from './gcp'
import { findInTar } from './tar'

// Manifest media types we can read. Both spellings of both formats, plus the
// multi-platform index/list wrappers buildx emits even for a single platform.
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json'
].join(', ')

// Platform we deploy. Cloud Run runs linux/amd64; an index's other entries
// (notably buildx attestation manifests, which carry `unknown/unknown`) are
// skipped.
const PLATFORM = { os: 'linux', architecture: 'amd64' }

// Registry reads are pure GETs, so retrying them is unconditionally safe. Same
// tolerance the Artifact Registry REST calls in ./gcp.js use, and for the same
// reason: a transient AR 503 must not fail a deploy.
const GAXIOS_RETRY = {
  retry: true,
  retryConfig: {
    retry: 5,
    retryDelay: 500,
    httpMethodsToRetry: ['GET'],
    statusCodesToRetry: [[429, 429], [500, 599]]
  }
}

// Split a digest-pinned reference into the pieces the v2 API needs:
// us-central1-docker.pkg.dev/cru-shared-artifacts/bills/bills@sha256:abc
//   -> { host, repository: 'cru-shared-artifacts/bills/bills', reference: 'sha256:abc' }
export function parseRegistryRef (ref) {
  const { name, digest, tag } = parseImageRef(ref)
  const slash = name.indexOf('/')
  if (slash === -1) {
    throw new Error(`Image reference "${ref}" has no registry host`)
  }
  const reference = digest ?? tag
  if (!reference) {
    throw new Error(`Image reference "${ref}" is not pinned to a digest or tag`)
  }
  return { host: name.slice(0, slash), repository: name.slice(slash + 1), reference }
}

// GET a registry URL. `responseType` is 'text' for JSON documents (the registry
// labels them application/vnd.*+json, which gaxios will not auto-parse) and
// 'arraybuffer' for blobs.
async function registryGet ({ host, repository, kind, reference, accept, responseType }) {
  const client = await authClient()
  const res = await client.request({
    url: `https://${host}/v2/${repository}/${kind}/${reference}`,
    method: 'GET',
    headers: accept ? { Accept: accept } : {},
    responseType,
    ...GAXIOS_RETRY
  })
  return res.data
}

async function manifestDocument (target, reference) {
  const body = await registryGet({
    ...target,
    kind: 'manifests',
    reference,
    accept: MANIFEST_ACCEPT,
    responseType: 'text'
  })
  return typeof body === 'string' ? JSON.parse(body) : body
}

// Pick this platform's manifest out of an index/list.
function selectPlatform (index) {
  const candidates = (index.manifests ?? []).filter(
    entry => entry.platform?.os === PLATFORM.os && entry.platform?.architecture === PLATFORM.architecture
  )
  if (candidates.length === 0) {
    const seen = (index.manifests ?? [])
      .map(entry => `${entry.platform?.os ?? '?'}/${entry.platform?.architecture ?? '?'}`)
      .join(', ')
    throw new Error(
      `Image index has no ${PLATFORM.os}/${PLATFORM.architecture} manifest (found: ${seen || 'none'})`
    )
  }
  return candidates[0].digest
}

// Decompress a layer blob according to its media type.
function decompressLayer (mediaType, blob) {
  if (mediaType.includes('zstd')) return zstdDecompressSync(blob)
  if (mediaType.includes('gzip')) return gunzipSync(blob)
  return blob
}

// Layers that are not a filesystem diff we can read.
function isReadableLayer (mediaType) {
  // "foreign"/"nondistributable" layers live on another host entirely.
  return mediaType.includes('.tar') && !mediaType.includes('foreign') && !mediaType.includes('nondistributable')
}

/**
 * Open a digest-pinned image for reading: resolves the platform manifest and
 * fetches the (small) config blob so labels are available synchronously.
 *
 * Returns { labels, readFile(path) }. `readFile` scans layers newest-first and
 * returns a Buffer, or null when no layer contains the path.
 */
export async function openImage (imageRef) {
  const target = parseRegistryRef(imageRef)

  let manifest = await manifestDocument(target, target.reference)
  // An index/list wraps per-platform manifests; resolve one more hop.
  if (manifest.manifests) {
    manifest = await manifestDocument(target, selectPlatform(manifest))
  }
  if (!manifest.config?.digest) {
    throw new Error(`Image manifest for ${imageRef} has no config descriptor`)
  }

  const configBody = await registryGet({
    ...target,
    kind: 'blobs',
    reference: manifest.config.digest,
    responseType: 'text'
  })
  const config = typeof configBody === 'string' ? JSON.parse(configBody) : configBody

  return {
    labels: config.config?.Labels ?? {},

    async readFile (path) {
      // Newest layer first: a file COPYed late in the Dockerfile is found in the
      // first (and typically tiny) blob we fetch, and a path rewritten by a
      // later layer resolves to the version the container would actually see.
      const layers = (manifest.layers ?? []).filter(layer => isReadableLayer(layer.mediaType))
      for (const [index, layer] of [...layers].reverse().entries()) {
        const blob = await registryGet({
          ...target,
          kind: 'blobs',
          reference: layer.digest,
          responseType: 'arraybuffer'
        })
        const found = findInTar(decompressLayer(layer.mediaType, Buffer.from(blob)), path)
        if (found) {
          core.info(`found ${path} in layer ${layers.length - index}/${layers.length} (${layer.digest})`)
          return found
        }
      }
      return null
    }
  }
}
