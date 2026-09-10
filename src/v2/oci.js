// Read-only OCI registry client: enough of the Docker Registry v2 API to read
// an image's labels and pull one small file out of its filesystem, without a
// docker daemon and without materializing the whole image.
//
// Why not `docker pull` / `crane`: the deploy runner has neither a daemon warmed
// up nor a binary to install, and both would download every layer. The consumers
// (src/v2/signin.js, src/v2/sourcemaps.js) want a ~100KB file, or a directory of
// them, that the app's Dockerfile COPYs in a late, tiny layer, so scanning
// layers newest-first normally reads exactly one small blob.
//
// Artifact Registry serves the Docker v2 API at
// https://<location>-docker.pkg.dev/v2/<project>/<repo>/<image>/... and accepts
// a plain OAuth bearer token, so the same ADC credentials the rest of the deploy
// uses work here. Requires roles/artifactregistry.reader, which every env's
// cru-deploy SA already holds for resolve-image.
import * as core from '@actions/core'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { authClient, parseImageRef } from './gcp'
import { findInTar, listInTar } from './tar'

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

// Byte caps on what one readFile() will pull into memory. Both blob and
// decompressed layer are held whole (the tar reader wants random access), so
// without caps a huge or bomb-compressed layer is an OOM on the runner.
//
// By construction the file we want lives in a late, tiny COPY layer — the
// verified bills image found it in an 87KB blob — so skipping anything bigger
// than the compressed cap costs nothing real and, unlike a post-fetch check,
// avoids the download. A layer that decompresses past the second cap throws
// (node:zlib ERR_BUFFER_TOO_LARGE); the caller warns rather than fails.
export const MAX_LAYER_BLOB_BYTES = 256 * 1024 * 1024
export const MAX_LAYER_BYTES = 1024 * 1024 * 1024

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

// Decompress a layer blob according to its media type, refusing to expand past
// MAX_LAYER_BYTES.
function decompressLayer (mediaType, blob) {
  const limit = { maxOutputLength: MAX_LAYER_BYTES }
  if (mediaType.includes('zstd')) return zstdDecompressSync(blob, limit)
  if (mediaType.includes('gzip')) return gunzipSync(blob, limit)
  return blob
}

// Layers that are not a filesystem diff we can read.
function isReadableLayer (mediaType) {
  // "foreign"/"nondistributable" layers live on another host entirely.
  return mediaType.includes('.tar') && !mediaType.includes('foreign') && !mediaType.includes('nondistributable')
}

// Total decompressed bytes one handle will keep around for reuse. A deploy now
// makes two passes over the same image (source maps, then the sign-in page) and
// both start at the newest layer, so without a cache the second pass re-fetches
// and re-inflates blobs the first one just read. Bounded because the per-layer
// caps above permit a lot: past the budget the cache stops admitting layers and
// reads fall back to fetching, which is slower but never an OOM.
export const MAX_CACHED_LAYER_BYTES = 512 * 1024 * 1024

/**
 * Open a digest-pinned image for reading: resolves the platform manifest and
 * fetches the (small) config blob so labels are available synchronously.
 *
 * Returns { labels, readFile(path), readDir(prefix) }. Both readers scan layers
 * newest-first, and layers they inflate are cached on the handle — so pass ONE
 * handle to everything that reads the same image rather than opening it twice.
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

  // Decompressed layers this handle has already read, keyed by digest.
  const cache = new Map()
  let cached = 0

  async function layerTar (layer) {
    const hit = cache.get(layer.digest)
    if (hit) return hit

    const blob = await registryGet({
      ...target,
      kind: 'blobs',
      reference: layer.digest,
      responseType: 'arraybuffer'
    })
    const tar = decompressLayer(layer.mediaType, Buffer.from(blob))
    if (cached + tar.length <= MAX_CACHED_LAYER_BYTES) {
      cache.set(layer.digest, tar)
      cached += tar.length
    }
    return tar
  }

  /**
   * Scan layers newest-first, handing each inflated layer to `inspect`, and
   * return the first non-null result.
   *
   * Newest-first is the whole performance story: a file COPYed late in the
   * Dockerfile is found in the first (and typically tiny) blob we fetch. It is
   * also the correctness story for readFile — a path rewritten by a later layer
   * resolves to the version the container would actually see. For readDir it is
   * a documented approximation rather than a union: whichever layer FIRST has
   * anything under the prefix wins outright, so an app that COPYs into the same
   * directory twice sees only the newer COPY. Overlay whiteouts are not
   * interpreted either. Both are fine for a directory one build step fills.
   */
  async function scanLayers (label, inspect) {
    const layers = (manifest.layers ?? []).filter(layer => isReadableLayer(layer.mediaType))
    for (const [index, layer] of [...layers].reverse().entries()) {
      const position = `${layers.length - index}/${layers.length}`
      if (layer.size > MAX_LAYER_BLOB_BYTES) {
        core.info(
          `skipping layer ${position} (${layer.digest}): ` +
          `${layer.size} bytes, over the ${MAX_LAYER_BLOB_BYTES}-byte limit`
        )
        continue
      }
      const found = inspect(await layerTar(layer))
      if (found !== null) {
        core.info(`found ${label} in layer ${position} (${layer.digest})`)
        return found
      }
    }
    return null
  }

  return {
    labels: config.config?.Labels ?? {},

    /** Contents of one file, or null when no layer contains the path. */
    readFile (path) {
      return scanLayers(path, tar => findInTar(tar, path))
    },

    /**
     * Every regular file under `prefix`, as tar.js's
     * `[{ path, name, size, contents }]`. `[]` when no layer has anything there.
     */
    async readDir (prefix, { maxBytes } = {}) {
      const found = await scanLayers(prefix, tar => {
        const files = listInTar(tar, prefix, maxBytes === undefined ? {} : { maxBytes })
        return files.length > 0 ? files : null
      })
      return found ?? []
    }
  }
}
