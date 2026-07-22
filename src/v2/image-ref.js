// Provider-neutral container-image reference helpers shared by the Cloud Run
// (Artifact Registry) and ECS/Lambda (ECR) v2 modules. These are pure string
// helpers with no cloud SDK dependencies, so both src/v2/gcp.js and
// src/v2/aws.js can import them without pulling in the other provider's SDKs.

// Parse a container image reference into its parts. Handles both digest refs
// (name@sha256:...) and tag refs (name:tag). The registry hosts we deal with
// (Artifact Registry, ECR) never carry a port, so the final ':' after the last
// '/' is always a tag separator.
//
//   parseImageRef('host/p/r/i@sha256:abc') -> {name:'host/p/r/i', digest:'sha256:abc', tag:null}
//   parseImageRef('host/p/r/i:candidate-1') -> {name:'host/p/r/i', digest:null, tag:'candidate-1'}
//   parseImageRef('host/p/r/i')             -> {name:'host/p/r/i', digest:null, tag:null}
export function parseImageRef (ref) {
  const at = ref.indexOf('@')
  if (at !== -1) {
    return { name: ref.slice(0, at), digest: ref.slice(at + 1), tag: null }
  }
  const lastSlash = ref.lastIndexOf('/')
  const lastColon = ref.lastIndexOf(':')
  if (lastColon > lastSlash) {
    return { name: ref.slice(0, lastColon), digest: null, tag: ref.slice(lastColon + 1) }
  }
  return { name: ref, digest: null, tag: null }
}

// True when a reference is pinned to a digest (name@sha256:...).
export function isDigestRef (ref) {
  return parseImageRef(ref).digest !== null
}

// True when a reference is pinned to a tag (name:tag), not a digest.
export function isTagRef (ref) {
  const { digest, tag } = parseImageRef(ref)
  return digest === null && tag !== null
}

// Enforce the v2 deploy invariant: what runs in an environment is always pinned
// by digest, never by a mutable tag. Throws with a clear message otherwise.
export function assertDigestRef (ref) {
  if (!isDigestRef(ref)) {
    throw new Error(
      `Expected a digest-pinned image reference (name@sha256:...) but got "${ref}". ` +
      'v2 deploys digests, never tags — resolve the tag to a digest first.'
    )
  }
}
