import * as core from '@actions/core'
import { logSiteMaps, planImageSite } from './deploy-static'
import { assertDigestRef } from './image-ref'
import { openImage } from './oci'
import { brokenLinksMessage, checkSiteLinks } from './site-links'
import { DEFAULT_CONTENT_TYPE, SITE_DIR, isSourceMap, shown } from './static-site'

// Stage-less verify for a static site (app-info RcMode "verify"). A site with
// no stage environment has no stage bucket to deploy its candidate to, so its
// release-candidate gate is this check of the candidate image instead, and
// deploy-candidate then writes the same release-candidate ledger row a stage
// deploy writes.
//
// What it proves:
//
//   1. The deploy would take the site. It reads the image with the deploy's
//      own code (planImageSite in ./deploy-static.js): /site in one layer,
//      index.html at its root, nothing the deploy cannot copy to a bucket
//      (links, devices, names that cannot be object keys, a name twice, a file
//      over the size limit). A site that fails here would fail at promote,
//      with production untouched; this says so a release earlier.
//   2. The site is whole. Every local href and src in its HTML names a file
//      the deploy will upload (./site-links.js has the rules).
//
// What it does not prove: that the site renders in a browser, that its
// scripts run, or that its external links work. That is the honest trade for
// a site with no stage, as a boot check is for an ECS app with none.
//
// It touches no bucket and no CloudFront distribution, and uploads no source
// maps; those go up at promote, as they do for every static site. It reads the
// image through the ECR API the deploy uses (./oci.js), so it needs no docker
// and no registry login, only the static deploy role's ECR read.
//
// Two things are warnings rather than failures, because the deploy takes a site
// with either and a site can mean either: a linked file the deploy will serve
// as application/octet-stream (a browser downloads it rather than show it), and,
// when the image serves its source maps, a .map file under /site with no file
// next to it for it to map.

// How many files a warning names one by one.
const NAMED = 5

function listed (keys) {
  return `${keys.slice(0, NAMED).map(shown).join(', ')}${keys.length > NAMED ? ` and ${keys.length - NAMED} more` : ''}`
}

// Did reading the image fail on the way, rather than find something wrong
// with the site? An ECR call that failed carries the SDK's $metadata, a layer
// download that failed carries its HTTP status, one that timed out is an
// abort, and one that lost its connection is fetch's own "fetch failed". Every
// check of the site itself throws a plain Error. Told apart so the person
// reading a failed run knows whether to fix the site or run it again.
export function isReadError (error) {
  return error?.$metadata !== undefined ||
    error?.status !== undefined ||
    ['AbortError', 'TimeoutError'].includes(error?.name) ||
    (error?.name === 'TypeError' && error?.message === 'fetch failed')
}

/**
 * Verify a static site's candidate image. Throws, saying why, when the deploy
 * would refuse it or a local link in it is broken; returns `{ pages, links,
 * files }` otherwise.
 */
export async function verifyStatic ({ image }) {
  assertDigestRef(image)

  let handle
  try {
    handle = await openImage(image)
  } catch (error) {
    throw new Error(`Could not read the image ${image}: ${error.message}`, { cause: error })
  }

  let site
  try {
    site = await planImageSite(handle, image)
  } catch (error) {
    if (isReadError(error)) {
      throw new Error(
        `Could not read the site in ${image}: ${error.message.replace(/\.$/, '')}. That is a failed read, not a ` +
        'problem found in the site, so running the verify again may pass',
        { cause: error }
      )
    }
    throw new Error(`The deploy would refuse the site in ${image}: ${error.message}`, { cause: error })
  }
  logSiteMaps(handle.labels, site)

  const uploaded = [...site.hashed, ...site.unhashedMaps, ...site.unhashed, ...site.html, site.index]
  const served = new Set(uploaded.map(file => file.key))
  const pages = [site.index, ...site.html]
  core.info(`${SITE_DIR} holds ${served.size} files the deploy would upload, ${pages.length} of them HTML pages`)

  const result = checkSiteLinks({ pages, served })
  if (result.broken.length > 0) {
    core.startGroup(`${result.broken.length} broken local links`)
    for (const link of result.broken) {
      core.info(
        `${shown(link.page)} line ${link.line}: <${link.tag} ${link.attribute}=${shown(JSON.stringify(link.value))}> ` +
        `wants ${link.wanted.map(shown).join(' or ')}`
      )
    }
    core.endGroup()
    throw new Error(brokenLinksMessage(result))
  }
  core.info(`all ${result.links} local links in ${result.pages} HTML pages name a file in the site`)

  if (result.elsewhere.length > 0) {
    core.warning(
      `${result.elsewhere.length} HTML pages have a <base href> on another host, so their relative links point there ` +
      `and were not checked: ${listed(result.elsewhere)}`
    )
  }

  const octetStream = uploaded
    .filter(file => file.contentType === DEFAULT_CONTENT_TYPE && result.targets.has(file.key))
    .map(file => file.key)
  if (octetStream.length > 0) {
    core.warning(
      `the site's pages link to ${octetStream.length} files the deploy will serve as ${DEFAULT_CONTENT_TYPE}, which a ` +
      `browser downloads rather than shows: ${listed(octetStream)}. That is right for a download; for anything a ` +
      'page shows or runs, give the file an extension the deploy knows'
    )
  }

  const unpaired = uploaded
    .filter(file => isSourceMap(file.key) && !served.has(file.key.slice(0, -'.map'.length)))
    .map(file => file.key)
  if (unpaired.length > 0) {
    core.warning(
      `the image serves its source maps, but ${unpaired.length} .map files under ${SITE_DIR} have no file next to ` +
      `them to map, so dev tools will never ask for them: ${listed(unpaired)}. Each map goes up at its own path, ` +
      'so it must sit beside the file it maps'
    )
  }

  return { pages: result.pages, links: result.links, files: served.size }
}
