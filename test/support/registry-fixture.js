// A canned shared registry for the Cloud Run resolver tests, served through the
// one mocked google-auth-library client: the Artifact Registry REST listing
// (the tags on each digest) and the Docker v2 manifest reads (image indexes).
// A digest in the listing with no index document reads as a single manifest.

const SINGLE = {
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: 'sha256:config' },
  layers: []
}

export function serveRegistry (requestMock, { images, indexes = {} }) {
  requestMock.mockImplementation(async ({ url }) => {
    if (url.includes('/dockerImages')) return { data: { dockerImages: images } }
    const manifest = url.match(/\/v2\/.+\/manifests\/(.+)$/)
    if (manifest) {
      const reference = manifest[1]
      if (indexes[reference]) return { data: JSON.stringify(indexes[reference]) }
      if (images.some(image => image.uri.endsWith(`@${reference}`))) return { data: JSON.stringify(SINGLE) }
    }
    throw Object.assign(new Error(`registry has no ${url}`), { response: { status: 404 } })
  })
}

// Every manifest the code under test read.
export function manifestReads (requestMock) {
  return requestMock.mock.calls.map(([options]) => options.url).filter(url => url.includes('/manifests/'))
}

// An image index for a multi-platform build: an arm64 child listed first, the
// linux/amd64 child Cloud Run runs, and an attestation manifest.
export function imageIndex (amd64) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      { digest: 'sha256:arm64child', platform: { os: 'linux', architecture: 'arm64' } },
      { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: 'sha256:attestation', platform: { os: 'unknown', architecture: 'unknown' } }
    ]
  }
}
