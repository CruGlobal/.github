// The link check a static site's stage-less verify runs: every local link and
// asset in the site's HTML must name a file the deploy will put in the bucket.
// No browser, no network: the pages are read out of the candidate image and
// each href and src is resolved the way a browser would, then looked up in the
// site's own file list.
//
// WHAT COUNTS AS LOCAL. A value with a scheme (https:, mailto:, tel:, data:,
// javascript: and the rest) or one that starts with // points somewhere else,
// and is not checked. Nor is a fragment on its own (#top), an empty value, or
// one that holds a template placeholder ({{ ... }}), which is not a link until
// some script fills it in. A <base href> on the page is honored the way a
// browser honors it: relative links resolve against it, and when it points at
// another host, every relative link on the page does too.
//
// HOW A LINK BECOMES A FILE. The query string and the fragment are dropped,
// since the bucket serves a file by its path alone. The path is percent-decoded
// segment by segment, because S3 names the object by the decoded key.
//
//   /x/ (or /)   x/index.html (or index.html)
//   /x.css       x.css
//   /x           x, or else x/index.html when the last segment has no dot
//
// The last two rules are how the sites we host serve a directory: CloudFront
// serves index.html for the root, and the edge function in front of a
// multi-page site maps /x/ to /x/index.html and redirects an extensionless /x
// to /x/. A site with no such function serves /x as the file x instead. The
// check cannot tell which a site has, so for /x it takes either: a link that
// works on one of them is not called broken, at the cost of missing the rare
// link to an extensionless file on a site that redirects. Paths are compared
// as they are, case and all, since S3 keys are.
//
// A site whose CloudFront answers every missing path with index.html (an SPA
// fallback) and whose HTML links to its own client-side routes fails this
// check, since those routes are not files.
//
// WHAT IS NOT CHECKED. Links in srcset, in a <meta http-equiv="refresh">, in
// CSS (url(...)) or in scripts; xlink:href; links to the site's own host
// written out in full (https://the-site/x). These all point at real files on
// a real site, but each one is a parser of its own, and a gate that refuses a
// good release on a misread is worse than one that says what it skipped.
import { shown } from './static-site'

// The host a page is placed on to resolve its links. Never contacted: it only
// gives the URL parser an origin, so a link that leaves it is one that points
// somewhere else.
const SITE_ORIGIN = 'https://site.invalid'

// HTML's own whitespace, which is narrower than JavaScript's \s.
const SPACE = '\\t\\n\\f\\r '
const TAG_NAME = new RegExp(`[A-Za-z][^${SPACE}/>]*`, 'y')
const BETWEEN_ATTRIBUTES = new RegExp(`[${SPACE}/]*`, 'y')
const ATTRIBUTE = new RegExp(
  `([^${SPACE}/>][^${SPACE}/>=]*)(?:[${SPACE}]*=[${SPACE}]*(?:"([^"]*)"|'([^']*)'|([^${SPACE}>]*)))?`,
  'y'
)

// Elements whose content is text, not markup, so a "<a href" inside one (a
// script that builds a link, say) is not a link on the page.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'])

const LINK_ATTRIBUTES = new Set(['href', 'src'])

// The character references a URL in an attribute is likely to hold. A named
// one is decoded only with its semicolon; the long tail of named references
// does not turn up in a path.
const NAMED_REFERENCES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function codePoint (value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '�'
  return String.fromCodePoint(value)
}

export function decodeReferences (value) {
  return value.replace(/&(?:#([0-9]{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([A-Za-z][A-Za-z0-9]*);)/g, (match, decimal, hex, name) => {
    if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10))
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16))
    return NAMED_REFERENCES[name] ?? match
  })
}

// 1-based line of each offset, for messages a person can find in the page.
function lineCounter (text) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return offset => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}

/**
 * The href and src values in an HTML page, in order, and its <base href>.
 *
 * Returns `{ base, references }`, where `base` is the first <base> element's
 * href (null without one) and each reference is `{ tag, attribute, value,
 * line }`, with character references in the value decoded. A tag's first
 * href or src wins, as in a browser. Comments, doctypes, CDATA sections and
 * the content of raw text elements (see RAW_TEXT) are skipped.
 *
 * A small tokenizer rather than a full HTML parser: it reads tags and their
 * attributes the way the HTML standard does, and does not build a tree.
 */
export function htmlReferences (html) {
  const text = String(html)
  const lineOf = lineCounter(text)
  const references = []
  let base = null
  let at = 0
  while (at < text.length) {
    const open = text.indexOf('<', at)
    if (open === -1) break
    if (text.startsWith('<!--', open)) {
      // <!--> and <!---> are whole comments to a browser, empty ones, so what
      // follows them is markup again.
      if (text.startsWith('>', open + 4)) {
        at = open + 5
        continue
      }
      if (text.startsWith('->', open + 4)) {
        at = open + 6
        continue
      }
      const close = text.indexOf('-->', open + 4)
      at = close === -1 ? text.length : close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9)
      at = close === -1 ? text.length : close + 3
      continue
    }
    const next = text[open + 1]
    if (next === '!' || next === '?' || next === '/') {
      const close = text.indexOf('>', open + 2)
      at = close === -1 ? text.length : close + 1
      continue
    }
    TAG_NAME.lastIndex = open + 1
    const nameMatch = TAG_NAME.exec(text)
    if (!nameMatch) {
      at = open + 1
      continue
    }
    const tag = nameMatch[0].toLowerCase()
    at = TAG_NAME.lastIndex
    const seen = new Set()
    while (at < text.length) {
      BETWEEN_ATTRIBUTES.lastIndex = at
      BETWEEN_ATTRIBUTES.exec(text)
      at = BETWEEN_ATTRIBUTES.lastIndex
      if (at >= text.length) break
      if (text[at] === '>') {
        at++
        break
      }
      ATTRIBUTE.lastIndex = at
      const attribute = ATTRIBUTE.exec(text)
      if (!attribute || attribute[0] === '') {
        at++
        continue
      }
      const start = at
      at = ATTRIBUTE.lastIndex
      const name = attribute[1].toLowerCase()
      if (seen.has(name)) continue
      seen.add(name)
      const raw = attribute[2] ?? attribute[3] ?? attribute[4]
      if (raw === undefined || !LINK_ATTRIBUTES.has(name)) continue
      const value = decodeReferences(raw)
      if (tag === 'base') {
        if (name === 'href' && base === null) base = value
        continue
      }
      references.push({ tag, attribute: name, value, line: lineOf(start) })
    }
    if (RAW_TEXT.has(tag)) {
      const end = new RegExp(`</${tag}[${SPACE}/>]`, 'ig')
      end.lastIndex = at
      const close = end.exec(text)
      at = close ? close.index : text.length
    }
  }
  return { base, references }
}

// A page's own URL on SITE_ORIGIN. Setting pathname percent-encodes what needs
// it, so a page whose name holds a space or a # still resolves.
function pageUrl (pageKey) {
  const url = new URL(SITE_ORIGIN)
  url.pathname = `/${pageKey}`
  return url
}

/**
 * The URL a page's relative links resolve against: its <base href> when it
 * has one that parses, and its own URL otherwise.
 */
export function documentBase (pageKey, base) {
  const page = pageUrl(pageKey)
  if (base === null || base.trim() === '') return page
  try {
    return new URL(base, page)
  } catch {
    return page
  }
}

function decodeSegment (segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Not valid percent-encoding: the browser sends it as it is, and so the
    // bucket would be asked for exactly this.
    return segment
  }
}

/**
 * What a link asks the bucket for, as the object keys that would answer it,
 * best first; or null when the link does not point into the site (see the
 * rules at the top of this file). `base` is documentBase() of the page.
 */
export function siteKeysFor (value, base) {
  const trimmed = value.replace(/[\t\n\r]/g, '').trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.includes('{{')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return null
  if (/^[\\/]{2}/.test(trimmed)) return null
  let url
  try {
    url = new URL(trimmed, base)
  } catch {
    return null
  }
  if (url.origin !== SITE_ORIGIN) return null
  const path = url.pathname.split('/').map(decodeSegment).join('/').slice(1)
  if (path === '' || path.endsWith('/')) return [`${path}index.html`]
  if (!path.split('/').pop().includes('.')) return [path, `${path}/index.html`]
  return [path]
}

/**
 * Check every local link in a site's pages against the files it serves.
 *
 * `pages` is `[{ key, contents }]`, the HTML files (contents a Buffer or a
 * string). `served` is the set of every key the deploy uploads.
 *
 * Returns `{ pages, links, broken, targets, elsewhere }`: how many pages and
 * local links were checked, each broken link as `{ page, line, tag,
 * attribute, value, wanted }` (`wanted` the keys that would have answered
 * it), the key each good link resolved to, so a caller can look at the files
 * that are linked, and the pages whose <base href> names another host, whose
 * relative links point there and so were not checked.
 */
export function checkSiteLinks ({ pages, served }) {
  const broken = []
  const targets = new Set()
  const elsewhere = []
  let links = 0
  for (const page of pages) {
    const { base, references } = htmlReferences(page.contents.toString('utf8'))
    const resolveAgainst = documentBase(page.key, base)
    if (resolveAgainst.origin !== SITE_ORIGIN) elsewhere.push(page.key)
    for (const reference of references) {
      const wanted = siteKeysFor(reference.value, resolveAgainst)
      if (wanted === null) continue
      links++
      const found = wanted.find(key => served.has(key))
      if (found !== undefined) targets.add(found)
      else broken.push({ page: page.key, ...reference, wanted })
    }
  }
  return { pages: pages.length, links, broken, targets, elsewhere }
}

// How many broken links an error names one by one. The log lists them all.
export const BROKEN_LINKS_SHOWN = 10

/**
 * The error for a site with broken links: how many, then each missing file
 * once, with how many links ask for it and the first page that does. A nav
 * bar's bad link is on every page, and one line for it says more than a
 * hundred.
 */
export function brokenLinksMessage ({ broken, links, pages }) {
  const byKey = new Map()
  for (const link of broken) {
    const key = link.wanted[0]
    if (!byKey.has(key)) byKey.set(key, { first: link, count: 0 })
    byKey.get(key).count++
  }
  const missing = [...byKey.entries()]
  const listed = missing.slice(0, BROKEN_LINKS_SHOWN).map(([key, { first, count }]) =>
    `${shown(key)} (${count === 1 ? '1 link' : `${count} links`}, first ${shown(first.page)} line ${first.line}: ` +
    `${first.attribute}=${shown(JSON.stringify(first.value))})`
  )
  const more = missing.length > BROKEN_LINKS_SHOWN ? `, and ${missing.length - BROKEN_LINKS_SHOWN} more files` : ''
  return (
    `${broken.length} of the ${links} local links in the site's ${pages} HTML pages point at files that are not in the ` +
    `site, so those links would be broken once it is live. Missing: ${listed.join('; ')}${more}`
  )
}
