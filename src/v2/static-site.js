import * as core from '@actions/core'
import { appInfoItem, s3HeadObject } from './aws'
import { legacyEnvironment } from './env'

// What a static site's deploy and resolve share: where the site lives (from
// app-info), how the bucket records which release is live, and how each file
// is uploaded.
//
// The image contract. A static site's candidate is an OCI image in the app's
// ECR repository, built by the app's own build.sh exactly like an ECS image:
//
//   FROM scratch
//   COPY <built site> /site/                     one COPY, so one layer
//   COPY <built maps> /cru/sourcemaps/           optional, see ./sourcemaps.js
//   LABEL org.cru.sourcemaps=<code_version>      optional, see ./sourcemaps.js
//
// /site must hold index.html at its root. Everything under /site is served
// from the root of the bucket: /site/assets/app-1a2b3c4d.js becomes the object
// assets/app-1a2b3c4d.js.

/** Directory in the image that holds the site. */
export const SITE_DIR = '/site'

/** The object that records which release is live, and the last one written. */
export const INDEX_KEY = 'index.html'

// User metadata on index.html. S3 sends them as x-amz-meta-<key> and lowercases
// the keys, so they are spelled lowercase here.
export const DIGEST_METADATA = 'cru-digest'
export const REVISION_METADATA = 'cru-revision'
export const SHA_METADATA = 'cru-sha'

const DIGEST = /^sha256:[0-9a-f]{64}$/

// S3's own rules for a bucket name, and the shape of a CloudFront distribution
// id. Checked so a typo in app-info fails here, by name, rather than as an
// S3 error about a bucket nobody meant.
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const DISTRIBUTION_ID = /^[A-Z0-9]{1,64}$/

/**
 * The site's bucket and CloudFront distribution in one environment, read from
 * the app's CruApplicationInfo row for it. The static app module writes Bucket
 * and DistributionId on that row.
 *
 * Throws when the row, or either value, is missing or malformed. Every caller
 * asks before anything changes, so the message says nothing was changed.
 */
export async function staticSiteTarget (projectName, environment) {
  const legacy = legacyEnvironment(environment)
  const item = await appInfoItem(projectName, legacy)
  if (!item) {
    throw new Error(
      `No CruApplicationInfo row for ${projectName} in '${legacy}' (${environment}), so there is no bucket to ` +
      'deploy the site to. Nothing was changed.'
    )
  }
  const bucket = (item.Bucket ?? '').trim()
  const distributionId = (item.DistributionId ?? '').trim()
  const missing = [!bucket && 'Bucket', !distributionId && 'DistributionId'].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(
      `${projectName}'s CruApplicationInfo row for '${legacy}' has no ${missing.join(' and no ')}. A static site ` +
      'deploys to the S3 bucket and CloudFront distribution its app module writes there as Bucket and ' +
      'DistributionId. Nothing was changed.'
    )
  }
  if (!BUCKET_NAME.test(bucket)) {
    throw new Error(`${projectName}'s CruApplicationInfo row for '${legacy}' names Bucket "${bucket}", which is not an S3 bucket name. Nothing was changed.`)
  }
  if (!DISTRIBUTION_ID.test(distributionId)) {
    throw new Error(`${projectName}'s CruApplicationInfo row for '${legacy}' names DistributionId "${distributionId}", which is not a CloudFront distribution id. Nothing was changed.`)
  }
  return { bucket, distributionId }
}

/**
 * Which release the bucket serves, as index.html's metadata says:
 * `{ digest, revision, sha }`, or null when there is no index.html at all.
 *
 * `digest` is '' when index.html carries no usable cru-digest, which means
 * pipeline v2 did not write it (a site that deployed itself before, or a hand
 * upload). The caller decides what that means.
 */
export async function readLiveRelease (bucket) {
  const head = await s3HeadObject(bucket, INDEX_KEY)
  if (!head) return null
  const metadata = head.metadata ?? {}
  const raw = (metadata[DIGEST_METADATA] ?? '').trim()
  if (raw && !DIGEST.test(raw)) {
    core.warning(`s3://${bucket}/${INDEX_KEY} has ${DIGEST_METADATA} "${raw}", which is not a sha256 digest; it is ignored`)
  }
  return {
    digest: DIGEST.test(raw) ? raw : '',
    revision: (metadata[REVISION_METADATA] ?? '').trim(),
    sha: (metadata[SHA_METADATA] ?? '').trim()
  }
}

// Metadata travels as HTTP headers, so only printable ASCII survives the
// trip. A value that is not is left off rather than sent mangled.
const HEADER_VALUE = /^[\x21-\x7e]{1,256}$/

/** index.html's metadata for a release, leaving out empty or unsendable values. */
export function releaseMetadata ({ digest, revision, sha }) {
  const metadata = {}
  for (const [key, value] of [[DIGEST_METADATA, digest], [REVISION_METADATA, revision], [SHA_METADATA, sha]]) {
    if (typeof value === 'string' && HEADER_VALUE.test(value)) metadata[key] = value
  }
  return metadata
}

// --- How each file is uploaded ---------------------------------------------

// Content-Type by extension. Text types say utf-8, since that is what every
// bundler writes. Anything not listed is sent as bytes, which a browser will
// download rather than guess at.
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  zip: 'application/zip'
}
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

export const HTML_CACHE_CONTROL = 'no-cache'
export const HASHED_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const DEFAULT_CACHE_CONTROL = 'public, max-age=300'

function extensionOf (key) {
  const base = key.split('/').pop()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function contentTypeFor (key) {
  return CONTENT_TYPES[extensionOf(key)] ?? DEFAULT_CONTENT_TYPE
}

export function isHtml (key) {
  return ['html', 'htm'].includes(extensionOf(key))
}

export function isSourceMap (key) {
  return extensionOf(key) === 'map'
}

// A content hash in a file's name, the way webpack ([name].[contenthash].js)
// and Vite ([name]-[hash].js) write it: a run of 8 or more lowercase hex
// characters between the name's separators.
//
// The run must hold a digit AND a letter. A year-month-day (20261104) or a word
// spelled in a-f (deadbeef) is 8 hex characters too, and marking such a file
// immutable would pin a stale copy in browsers for a year once it changes under
// the same name. A real hash with no letter, or no digit, just gets the short
// cache, which only costs a revalidation.
const HASH_SEGMENT = /^(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{8,}$/

export function isContentHashed (key) {
  const base = key.split('/').pop()
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.split(/[.\-_]/).some(segment => HASH_SEGMENT.test(segment))
}

/** Cache-Control for an object: HTML always revalidates, hashed names never change. */
export function cacheControlFor (key) {
  if (isHtml(key)) return HTML_CACHE_CONTROL
  return isContentHashed(key) ? HASHED_CACHE_CONTROL : DEFAULT_CACHE_CONTROL
}

/**
 * Sort a site's files into what is uploaded when, and check the site is one
 * the deploy can serve. `tree` is what readTree returned for SITE_DIR.
 *
 * Returns `{ assets, html, index, maps }`. `assets` is every other file, each
 * `{ key, contents, contentType, cacheControl, immutable }`; `html` is every
 * HTML file but the root index.html, which is `index`; `maps` names the .map
 * files under the site, which are never uploaded to the bucket (the deploy
 * sends the maps under /cru/sourcemaps to Flightdeck instead).
 *
 * Throws, naming the file, for a link (the tree cannot be copied whole), a
 * file over `maxBytes`, an empty site, or one with no index.html.
 */
export function planSite (tree, { maxBytes, image }) {
  const files = tree?.files ?? []
  const links = tree?.links ?? []
  if (links.length > 0) {
    throw new Error(
      `${SITE_DIR} in ${image} holds links, which the deploy cannot copy to a bucket: ` +
      `${links.slice(0, 5).map(link => link.path).join(', ')}${links.length > 5 ? ` and ${links.length - 5} more` : ''}. ` +
      `Copy the files themselves into ${SITE_DIR}`
    )
  }
  const oversized = files.filter(file => file.contents === null)
  if (oversized.length > 0) {
    throw new Error(
      `the site is too big to deploy: ${oversized.slice(0, 5).map(file => `${file.path} (${file.size} bytes)`).join(', ')}` +
      `${oversized.length > 5 ? ` and ${oversized.length - 5} more` : ''} ${oversized.length === 1 ? 'is' : 'are'} over ` +
      `the ${maxBytes}-byte limit for one file`
    )
  }
  if (files.length === 0) {
    throw new Error(`${image} has nothing under ${SITE_DIR}. A static site's image copies the built site there`)
  }

  const assets = []
  const html = []
  const maps = []
  let index = null
  for (const file of files) {
    const key = file.name
    if (key === '' || key.endsWith('/')) continue
    if (isSourceMap(key)) {
      maps.push(key)
      continue
    }
    const entry = {
      key,
      contents: file.contents,
      contentType: contentTypeFor(key),
      cacheControl: cacheControlFor(key),
      immutable: !isHtml(key) && isContentHashed(key)
    }
    if (key === INDEX_KEY) index = entry
    else if (isHtml(key)) html.push(entry)
    else assets.push(entry)
  }
  if (!index) {
    throw new Error(
      `${image} has no ${SITE_DIR}/${INDEX_KEY}. A static site needs one at its root: the deploy writes it last ` +
      'and records on it which release is live'
    )
  }
  return { assets, html, index, maps }
}
