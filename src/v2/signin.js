// Publish the IAP friendly sign-in page that ships inside the app image.
//
// Background: with `iap.friendly_signin`, the gcp/cloudrun/app Terraform module
// puts a GCS-backed sign-in page in front of an otherwise-gated app. Terraform
// owns the bucket and the load-balancer routing; something has to own the bytes.
// That used to be a workflow in the app repo, which meant (a) production had no
// automated path at all under v2 — prod promotes an already-built image, so no
// app-repo workflow fires — and (b) a rollback re-deployed an old image behind a
// new page.
//
// So the page travels *in the image*, and the deploy publishes it. Same artifact,
// same digest, same guarantees as the app itself: promote and rollback carry the
// matching page for free, and the only identity that can write to this bucket is
// the deployer.
//
// Contract with the app image:
//   LABEL org.cru.iap-signin=<object key>     e.g. "signin", "sign_in"
//   COPY  <built page> /cru/iap-signin/<object key>
//
// The label is the single source of truth for the object key, so the image and
// the bucket cannot disagree about what to name the object. It must match the
// module's `iap.friendly_signin.path` minus its leading slash, or the load
// balancer serves a 404 for a page that uploaded successfully.
import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { authClient, findAppContainer } from './gcp'
import { openImage } from './oci'

/** Image label naming the sign-in object key. Absent = this app ships no page. */
export const SIGNIN_LABEL = 'org.cru.iap-signin'

/** Conventional directory the page is COPYed to inside the image. */
export const SIGNIN_IMAGE_DIR = '/cru/iap-signin'

/** Env var Terraform injects into the app container, naming the target bucket. */
export const SIGNIN_BUCKET_ENV = 'IAP_SIGNIN_BUCKET'

// Both matter. Without an explicit text/html the extensionless object serves as
// application/octet-stream and the browser downloads the page instead of
// rendering it; the 5 minutes is the upload-to-edge lag the module README
// documents.
const CONTENT_TYPE = 'text/html'
const CACHE_CONTROL = 'public, max-age=300'

// Upload POSTs are idempotent in effect — same key, same bytes, overwrite — so
// retrying one is safe. See ./oci.js for why the GCP REST paths need this.
const GAXIOS_RETRY = {
  retry: true,
  retryConfig: {
    retry: 5,
    retryDelay: 500,
    httpMethodsToRetry: ['POST'],
    statusCodesToRetry: [[429, 429], [500, 599]]
  }
}

/**
 * Read and validate the sign-in object key from an image's labels.
 *
 * Returns null when the image carries no sign-in label (the common case — most
 * apps have no sign-in page). Throws when the label is present but unusable:
 * the value becomes both a GCS object name and a path inside the image, so a
 * malformed one must fail loudly rather than write to a surprising place.
 */
export function signinObjectKey (labels) {
  const raw = labels?.[SIGNIN_LABEL]
  if (raw == null) return null

  const key = raw.trim()
  const invalid =
    key === '' ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (invalid) {
    throw new Error(
      `Image label ${SIGNIN_LABEL}="${raw}" is not a usable object key — ` +
      'expected a relative path with no empty, "." or ".." segments (e.g. "signin").'
    )
  }
  return key
}

/** Path the page is expected at inside the image, for a given object key. */
export function signinSourcePath (objectKey) {
  return `${SIGNIN_IMAGE_DIR}/${objectKey}`
}

/**
 * Find the sign-in bucket for this app by reading IAP_SIGNIN_BUCKET off the app
 * container of any Cloud Run service. Terraform injects it whenever
 * `iap.friendly_signin` is configured, so its presence IS the signal that this
 * environment expects a sign-in page — no extra input to plumb through, and no
 * registry read for the apps (most of them) that have no sign-in page.
 *
 * Read from the service as it exists *before* the deploy rewrites it; the bucket
 * name is Terraform-managed and does not change per deploy.
 */
export function signinBucket (services, repo) {
  for (const service of services) {
    const containers = service.template?.containers ?? []
    const app = findAppContainer(containers, repo)
    const bucket = app?.env?.find(entry => entry.name === SIGNIN_BUCKET_ENV)?.value
    if (bucket) return bucket
  }
  return null
}

// Upload one object with both its content type and cache control set, in a
// single request, via the GCS JSON API's multipart form.
//
// The MIME boundary is derived from a hash of the body so it is deterministic
// (testable) and cannot appear inside the body it delimits.
async function uploadObject ({ bucket, key, body, contentType, cacheControl }) {
  const boundary = `cru-${createHash('sha256').update(body).digest('hex').slice(0, 32)}`
  const metadata = JSON.stringify({ name: key, contentType, cacheControl })
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])

  const client = await authClient()
  await client.request({
    url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`,
    method: 'POST',
    params: { uploadType: 'multipart' },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: payload,
    ...GAXIOS_RETRY
  })
}

/**
 * Extract the sign-in page from a digest-pinned image and publish it to the
 * environment's sign-in bucket.
 *
 * Returns `{ published: false, reason: 'no-label' }` when the image ships no
 * page — legitimate during the rollout, and permanently legitimate when rolling
 * back to a release built before this contract existed. Throws on anything else
 * (label present but the file is missing, upload rejected); the caller decides
 * whether that is fatal.
 */
export async function publishSigninPage ({ image, bucket }) {
  if (!bucket) throw new Error('bucket is required to publish the sign-in page')

  const oci = await openImage(image)
  const objectKey = signinObjectKey(oci.labels)
  if (objectKey === null) return { published: false, reason: 'no-label' }

  const source = signinSourcePath(objectKey)
  core.info(`extracting ${source} from ${image}`)
  const body = await oci.readFile(source)
  if (!body) {
    throw new Error(
      `Image declares ${SIGNIN_LABEL}="${objectKey}" but has no file at ${source}. ` +
      'The Dockerfile must COPY the built page there.'
    )
  }

  await uploadObject({
    bucket,
    key: objectKey,
    body,
    contentType: CONTENT_TYPE,
    cacheControl: CACHE_CONTROL
  })

  return { published: true, bucket, objectKey, bytes: body.length }
}
