import * as core from '@actions/core'
import { open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_ENDPOINT,
  MAX_MAP_BYTES,
  MAX_VERSION_LENGTH,
  UPLOAD_PATH,
  decodeSegment,
  isUsableCodeVersion,
  publicUrl,
  uploadMaps
} from './sourcemap-upload.js'

// flightdeck-sourcemaps: upload the browser source maps in a directory of
// built files to Flightdeck, for an app that builds and deploys in its own
// workflow (a sync to a bucket, say) instead of through pipeline v2. Pipeline
// v2 uploads the maps an app image carries, at deploy time
// (src/v2/sourcemaps.js). An app with no image has its built files right here
// in the job instead. The upload itself is shared with pipeline v2
// (src/sourcemap-upload.js); this file decides which maps go, under which URL,
// and with which bytes.
//
// Three rules, each there because breaking it fails SILENTLY. Flightdeck
// accepts a well-formed map under any URL, so a mistake here still reads as a
// clean upload:
//
//   1. PAIRING. A map belongs to the chunk whose trailing
//      `//# sourceMappingURL=` comment names it, resolved against that chunk
//      the way a browser resolves it. A map's own file name says nothing about
//      which chunk it maps: some bundlers (Turbopack, for one) hash a chunk
//      and its map separately, so `a1.js` is mapped by `b2.js.map`.
//   2. URL. A map is uploaded under its CHUNK's public URL, base-url plus the
//      chunk's path in the directory, because that is the URL a stack frame
//      from the chunk carries.
//   3. BYTES. `sourcesContent` is stripped before upload, and the strip gives
//      the same bytes for the same map every time. Flightdeck resolves
//      positions and never shows source text, so the field is only weight and
//      source text its store need not hold. And Flightdeck treats an upload
//      whose bytes it already holds as unchanged; a strip that wrote different
//      bytes each run would make every re-run a replace, which resets the
//      map's applied count, the one number that says the map is being used.
//
// Then, by default, every map in the directory is deleted, uploaded or not, so
// that syncing the directory to a public site does not publish them.
//
// The directory is the app's build output, but it is still read with care: a
// symbolic link is never followed out of it, nothing but a regular file is
// opened, and no file's contents are repeated in a log line.
//
// Telemetry policy, the same as pipeline v2's upload: this NEVER fails the job.
// Every problem is a warning, and the outputs count what landed.

/** Files read as chunks: the scripts a browser loads. */
const CHUNK = /\.m?js$/

/**
 * Files deleted as maps, whatever their case. A compression step (a gzip or
 * brotli plugin, say) writes a compressed copy beside each map by default, and
 * a sync publishes that copy just the same.
 */
const MAP = /\.map(\.(gz|br|zst))?$/i

/** Maps a chunk is likely to name; used to spot a build that drops the comment. */
const SCRIPT_MAP = /\.m?js\.map$/i

/**
 * Folders whose presence means `directory` was set too high: a build's output
 * holds neither.
 */
const TOO_HIGH = ['node_modules', '.git']

/**
 * Largest map file read at all. The upload limit (MAX_MAP_BYTES) applies to
 * the bytes sent, after the strip, and `sourcesContent` is often most of a map,
 * so a map well over the upload limit on disk can still fit under it.
 */
export const MAX_READ_BYTES = 8 * MAX_MAP_BYTES

/**
 * How much of the end of a chunk is read. The sourceMappingURL comment is the
 * last thing in the file, so this is plenty, and a chunk can be megabytes.
 */
export const TAIL_BYTES = 8 * 1024

/** File names a summary line lists before it says how many more there are. */
const LISTED = 10

/** Longest piece of a sourceMappingURL repeated in a log line. */
const SHOWN = 200

/**
 * The base URL used to find the files chunks name when base-url itself is
 * unusable, so that the deletion can still find a map with an unusual name.
 * Nothing is uploaded under it.
 */
const PLACEHOLDER_BASE = 'https://directory.invalid/'

export async function run () {
  let counts = { uploaded: 0, unchanged: 0, failed: 0 }
  try {
    counts = await publishDirectory({
      directory: core.getInput('directory'),
      baseUrl: core.getInput('base-url'),
      version: core.getInput('version'),
      token: core.getInput('token'),
      endpoint: core.getInput('endpoint'),
      deleteMaps: deleteMapsInput(core.getInput('delete-maps'))
    })
  } catch (error) {
    core.warning(`source maps not uploaded (job unaffected): ${error.message}`)
  }

  try {
    core.setOutput('uploaded', String(counts.uploaded))
    core.setOutput('unchanged', String(counts.unchanged))
    core.setOutput('failed', String(counts.failed))
  } catch (error) {
    core.warning(`source map counts not recorded as step outputs: ${error.message}`)
  }
}

/**
 * Read delete-maps. Anything but a plain "false" deletes: deleting maps someone
 * meant to keep costs a re-run, while publishing maps someone meant to hide
 * cannot be taken back.
 */
export function deleteMapsInput (raw) {
  const value = (raw || '').trim().toLowerCase()
  if (value === 'false') return false
  if (value !== '' && value !== 'true') {
    core.warning(`delete-maps="${raw}" is not true or false, so the maps are deleted, which is the default.`)
  }
  return true
}

/**
 * Upload the maps in `directory`, then delete its maps when `deleteMaps`.
 *
 * Returns { uploaded, unchanged, failed }:
 *   uploaded   maps Flightdeck stored, new or replacing different bytes
 *   unchanged  maps Flightdeck already held byte for byte
 *   failed     maps a chunk names that did not land: the upload failed, was
 *              never attempted because a rejected token or the time budget
 *              stopped the run, or the named map is missing or unusable
 * A chunk with no sourceMappingURL comment, or with an inline data: map, is
 * logged and not counted.
 *
 * The deletion runs whatever happened to the upload, a skipped one included:
 * the maps are just as public after a sync either way. It deletes every file
 * MAP matches, and every other file a chunk names that reads as a source map.
 */
export async function publishDirectory ({
  directory,
  baseUrl,
  version,
  token,
  endpoint,
  deleteMaps = true,
  maxMapBytes = MAX_MAP_BYTES,
  ...tuning
}) {
  // Before anything that could put it in a log line, an error message or an
  // annotation. Everything below this line is allowed to be loud.
  if (token) core.setSecret(token)
  const counts = { uploaded: 0, unchanged: 0, failed: 0 }

  if (!directory) {
    core.warning('source maps not uploaded (job unaffected): no directory was given.')
    return counts
  }
  const root = path.resolve(directory)
  if (!(await isDirectory(root))) {
    core.warning(`source maps not uploaded (job unaffected): ${directory} is not a directory.`)
    return counts
  }
  const tree = await walk(directory, root)

  let named = []
  try {
    const result = await uploadFrom({ directory, root, tree, baseUrl, version, token, endpoint, deleteMaps, maxMapBytes, tuning })
    Object.assign(counts, result.counts)
    named = result.named
  } catch (error) {
    // Not an expected condition, but the deletion below still has to run.
    core.warning(`source maps not uploaded (job unaffected): ${error.message}`)
  }

  const maps = [...new Set([...tree.files.filter(file => MAP.test(file)), ...named])].sort()
  if (deleteMaps) {
    await deleteFiles(directory, root, maps, tree)
  } else if (maps.length > 0) {
    core.info(`left ${maps.length} map file(s) in ${directory} (delete-maps is off): a sync of it as it stands publishes them`)
  }
  return counts
}

async function uploadFrom ({ directory, root, tree, baseUrl, version, token, endpoint, deleteMaps, maxMapBytes, tuning }) {
  const counts = { uploaded: 0, unchanged: 0, failed: 0 }
  const plan = uploadPlan({ token, version, baseUrl, endpoint })

  if (plan.problem) {
    core.warning(`source maps not uploaded (job unaffected): ${plan.problem}`)
    // Still find the files the chunks name, quietly, so that a map with an
    // unusual name is deleted along with the rest.
    if (!deleteMaps) return { counts, named: [] }
    const paired = await pairMaps({ directory, root, tree, baseUrl: plan.base ?? PLACEHOLDER_BASE, maxMapBytes, quiet: true })
    return { counts, named: paired.named }
  }

  const paired = await pairMaps({ directory, root, tree, baseUrl: plan.base, maxMapBytes })
  counts.failed += paired.failed
  reportPairing(directory, paired)
  if (paired.maps.length === 0) {
    core.info(`no source maps to upload from ${directory}`)
    return { counts, named: paired.named }
  }

  const upload = await uploadMaps(paired.maps, { endpoint: plan.url, token, version: plan.version, readResult: true, ...tuning })
  counts.uploaded = upload.landed - upload.unchanged
  counts.unchanged = upload.unchanged
  counts.failed += upload.failed + upload.notAttempted
  core.info(`source maps: ${counts.uploaded} uploaded, ${counts.unchanged} unchanged, ${counts.failed} failed`)
  if (upload.landed > 0) {
    core.info(
      'Flightdeck accepts a well-formed map under any URL and version, so a clean upload does not prove a map ' +
      'will be used. Once errors arrive, look at applied_count for these maps in the Flightdeck project\'s ' +
      'source map settings: applied_count staying at 0 is the only sign a well-formed upload matched nothing, ' +
      'which means base-url or version does not match what the browser reports.'
    )
  }
  return { counts, named: paired.named }
}

// Everything an upload needs, checked, or the first reason there can be none.
// `base` comes back whenever base-url is usable, even with another problem,
// because the deletion uses it to find the files chunks name.
function uploadPlan ({ token, version, baseUrl, endpoint }) {
  let base
  try {
    base = normalizeBaseUrl(baseUrl)
  } catch (error) {
    return { problem: error.message }
  }
  if (!token) return { base, problem: 'no token was given.' }
  const codeVersion = (version || '').trim()
  if (!isUsableCodeVersion(codeVersion)) {
    return {
      base,
      problem: `version "${codeVersion}" is not a usable code version. It must be the code_version the browser ` +
        `SDK reports: 1-${MAX_VERSION_LENGTH} characters with no whitespace or control characters.`
    }
  }
  try {
    return { base, url: uploadEndpoint(endpoint), version: codeVersion }
  } catch (error) {
    return { base, problem: error.message }
  }
}

function reportPairing (directory, { maps, failed, unmapped, inline, orphans }) {
  if (unmapped.length > 0) {
    core.info(
      `${unmapped.length} chunk(s) carry no sourceMappingURL comment, so there is no map to upload for them: ` +
      listed(unmapped)
    )
  }
  if (inline.length > 0) {
    core.warning(
      `${inline.length} chunk(s) carry an inline data: source map, which is not uploaded: ${listed(inline)}. ` +
      'Frames from them stay minified, and an inline map publishes the source along with the chunk. Have the ' +
      'bundler write separate .map files instead.'
    )
  }
  const scriptOrphans = orphans.filter(file => SCRIPT_MAP.test(file))
  if (maps.length === 0 && failed === 0 && scriptOrphans.length > 0) {
    core.warning(
      `${directory} holds ${scriptOrphans.length} script .map file(s), but no chunk names one in a ` +
      'sourceMappingURL comment, so none was uploaded. A "hidden" source map setting leaves that comment out. ' +
      'This action pairs a map with its chunk only through that comment, because a map\'s own file name does ' +
      'not say which chunk it belongs to.'
    )
  } else if (orphans.length > 0) {
    core.info(`${orphans.length} map file(s) are named by no chunk and were not uploaded: ${listed(orphans)}`)
  }
}

function listed (names) {
  const shown = names.slice(0, LISTED).join(', ')
  return names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown
}

// A sourceMappingURL in a log line, cut short: it is enough to recognize, and
// a longer one is not a reference anyone wrote on purpose.
function shown (text) {
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text
}

/**
 * Pair each chunk in the directory with the map its sourceMappingURL names,
 * and prepare the upload for it.
 *
 * `tree` is walk()'s answer. Returns the uploads, how many named maps cannot
 * be uploaded (each one already warned about), the chunks and maps that
 * needed no upload, and `named`: every file a chunk names that reads as a
 * source map, for the deletion. With `quiet`, nothing is logged, because the
 * caller only wants `named`.
 */
export async function pairMaps ({ directory, root, tree, baseUrl, maxMapBytes = MAX_MAP_BYTES, quiet = false }) {
  const warn = quiet ? () => {} : core.warning
  const info = quiet ? () => {} : core.info
  const present = new Set(tree.files)
  // Two chunks may name one map; it is read and stripped once.
  const prepared = new Map()
  const referenced = new Set()
  const named = new Set()
  const maps = []
  const unmapped = []
  const inline = []
  let failed = 0

  for (const chunk of tree.files.filter(file => CHUNK.test(file))) {
    const opened = await regularFileInside(root, tree.real, chunk)
    if (opened.problem) {
      warn(`skipping ${chunk}: it ${opened.problem}`)
      continue
    }
    let tail
    try {
      tail = await readTail(opened.real, opened.size)
    } catch (error) {
      warn(`could not read ${chunk} to find its source map: ${error.message}`)
      continue
    }

    const reference = sourceMappingUrl(tail.text, { partial: tail.partial })
    if (reference === null) {
      unmapped.push(chunk)
      continue
    }
    if (/^data:/i.test(reference)) {
      inline.push(chunk)
      info(`skipping ${chunk}: its source map is inline (a data: URL), so there is no map file to upload`)
      continue
    }

    const fail = message => {
      warn(`skipping ${chunk}: ${message}`)
      failed++
    }
    let chunkUrl
    try {
      chunkUrl = publicUrl(baseUrl, urlPath(chunk), chunk)
    } catch (error) {
      fail(error.message)
      continue
    }
    const located = mapPath(reference, chunkUrl, baseUrl)
    if (located.problem) {
      fail(located.problem)
      continue
    }
    if (!present.has(located.path)) {
      fail(`its sourceMappingURL names ${shown(located.path)}, which is not in ${directory}`)
      continue
    }
    referenced.add(located.path)

    if (!prepared.has(located.path)) prepared.set(located.path, prepareMap(root, tree.real, located.path, maxMapBytes))
    const map = await prepared.get(located.path)
    if (map.problem) {
      fail(`${located.path} ${map.problem}`)
      continue
    }
    named.add(located.path)
    maps.push({
      minified: chunkUrl,
      name: path.posix.basename(located.path),
      contents: map.contents,
      file: `${located.path} (for ${chunk})`
    })
  }

  const orphans = tree.files.filter(file => MAP.test(file) && !referenced.has(file))
  return { maps, failed, unmapped, inline, orphans, named: [...named] }
}

/**
 * The URL in a chunk's trailing `//# sourceMappingURL=` comment, or null.
 *
 * Only the comments at the END of the file count, read from the last line up.
 * A bundle can carry the same text earlier, in a string or in a library that
 * writes such comments itself, and that one names nothing. The older `//@`
 * spelling is accepted, and other trailing line comments (a debug id, say) are
 * stepped over.
 *
 * `partial` says `text` is only the end of the file, so its first line may be
 * cut. The comment holding an inline data: map can be megabytes long, so only
 * its end is in `text`; a cut line that is nothing but base64 is taken to be
 * one, and comes back as "data:" so the caller reads it as inline.
 */
export function sourceMappingUrl (text, { partial = false } = {}) {
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (line === '') continue
    if (partial && index === 0) return /^[A-Za-z0-9+/]+=*$/.test(line) ? 'data:' : null
    if (!line.startsWith('//')) return null
    const match = /^\/\/[#@]\s*sourceMappingURL=(\S+)$/.exec(line)
    if (match) return match[1]
  }
  return null
}

/**
 * The directory path of the file a chunk's sourceMappingURL names, found the
 * way a browser finds it: the reference resolved against the chunk's own URL.
 * That one rule covers a sibling file name, a ../ path, a root-relative path
 * and a full URL alike. Anything that resolves outside `baseUrl` is a map this
 * directory does not hold.
 *
 * Returns { path } or { problem }.
 */
export function mapPath (reference, chunkUrl, baseUrl) {
  let resolved
  try {
    resolved = new URL(reference, chunkUrl)
  } catch {
    return { problem: `its sourceMappingURL "${shown(reference)}" is not a URL` }
  }
  // Query and fragment dropped: a file is looked up by its path alone.
  const target = `${resolved.origin}${resolved.pathname}`
  if (!target.startsWith(baseUrl)) {
    return {
      problem: `its sourceMappingURL "${shown(reference)}" resolves to ${shown(target)}, outside ${baseUrl}, so the ` +
        'map is not in this directory'
    }
  }
  const segments = target.slice(baseUrl.length).split('/').map(decodeSegment)
  const invalid = segments.some(segment =>
    segment === null || segment === '' || segment === '.' || segment === '..' ||
    segment.includes('/') || segment.includes('\\')
  )
  if (invalid) return { problem: `its sourceMappingURL "${shown(reference)}" does not name a file` }
  return { path: segments.join('/') }
}

// A file's path in the directory, written as a URL path. Escapes the three
// characters URL() would otherwise read as syntax rather than as part of a
// name, as a browser fetching the file has them escaped; URL() escapes the
// rest (spaces, say) itself.
function urlPath (file) {
  return file.replace(/[%?#]/g, character => encodeURIComponent(character))
}

// Where a file in the directory really is, and how big, provided it is a
// regular file that is really inside the directory. A symbolic link that
// leads out of it is refused rather than read: whatever it points at is not
// part of the build, and its bytes would go to Flightdeck. Anything but a
// regular file (a FIFO would block the read forever) is refused too.
// Returns { real, size } or { problem }, the problem worded to follow "it".
async function regularFileInside (root, rootReal, file) {
  let real
  try {
    real = await realpath(path.join(root, file))
  } catch (error) {
    return { problem: `could not be resolved (${error.code ?? error.message})` }
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { problem: 'is a link to a file outside the directory, so it was not read' }
  }
  const info = await stat(real).catch(() => null)
  if (!info?.isFile()) return { problem: 'is not a regular file, so it was not read' }
  return { real, size: info.size }
}

// The last TAIL_BYTES of a file, and whether that is all of it.
async function readTail (file, size) {
  const length = Math.min(size, TAIL_BYTES)
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), partial: length < size }
  } finally {
    await handle.close()
  }
}

async function prepareMap (root, rootReal, file, maxMapBytes) {
  const opened = await regularFileInside(root, rootReal, file)
  if (opened.problem) return { problem: opened.problem }
  if (opened.size > MAX_READ_BYTES) {
    return { problem: `is ${opened.size} bytes, too big to read (the limit is ${MAX_READ_BYTES})` }
  }
  let contents
  try {
    contents = stripSourcesContent(await readFile(opened.real))
  } catch (error) {
    return { problem: `is not a usable source map: ${describe(error)}` }
  }
  if (contents.length > maxMapBytes) {
    return { problem: `is ${contents.length} bytes without sourcesContent, over the ${maxMapBytes}-byte upload limit` }
  }
  return { contents }
}

// A JSON.parse error repeats the start of the text it could not parse, and
// that text is the file's contents, which have no place in a log line. Only
// where it went wrong is kept.
function describe (error) {
  if (!(error instanceof SyntaxError)) return error.message
  const position = /position (\d+)/.exec(error.message)?.[1]
  return position ? `it is not valid JSON (at character ${position})` : 'it is not valid JSON'
}

/**
 * The bytes to upload for a map: the map without `sourcesContent`, at the top
 * level and in each section of an index map (the sectioned form some bundlers,
 * Turbopack among them, write).
 *
 * The same input always gives the same bytes, because Flightdeck compares them
 * to decide whether an upload is unchanged. JSON.parse and JSON.stringify keep
 * key order, so the round trip is stable. A map with no `sourcesContent` to
 * remove is sent as the very bytes it came in as, less any prefix (below).
 *
 * Throws on bytes that are not a version 3 source map.
 */
export function stripSourcesContent (bytes) {
  const raw = Buffer.from(bytes)
  const body = raw.subarray(prefixLength(raw))
  const map = JSON.parse(body.toString('utf8'))
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('it is not a JSON object')
  if (String(map.version) !== '3' || (typeof map.mappings !== 'string' && !Array.isArray(map.sections))) {
    throw new Error('it is not a version 3 source map with mappings or sections')
  }
  if (!removeSourcesContent(map)) return Buffer.from(body)
  return Buffer.from(JSON.stringify(map))
}

// How many bytes come before the JSON. A map may begin with a UTF-8 byte order
// mark, and the source map spec lets it begin with a `)]}'` line, which stops
// the file running as a script. Flightdeck parses the bytes as plain JSON and
// would refuse either, so neither is sent.
function prefixLength (bytes) {
  let start = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
  if (bytes.subarray(start, start + 4).toString('latin1') === ')]}\'') {
    const newline = bytes.indexOf(0x0a, start)
    start = newline === -1 ? start + 4 : newline + 1
  }
  return start
}

function removeSourcesContent (map) {
  let removed = false
  if (Object.prototype.hasOwnProperty.call(map, 'sourcesContent')) {
    delete map.sourcesContent
    removed = true
  }
  if (Array.isArray(map.sections)) {
    for (const section of map.sections) {
      const inner = section?.map
      if (inner && typeof inner === 'object' && removeSourcesContent(inner)) removed = true
    }
  }
  return removed
}

/**
 * Where uploads go. Only the ORIGIN of the input is kept, as pipeline v2 does
 * with an app's ROLLBAR_ENDPOINT, so the Flightdeck base URL and the app's own
 * item endpoint both work. Unlike pipeline v2, a value that is not a URL is
 * refused instead of replaced with the default: it is the caller's own input,
 * and sending the token somewhere the caller did not name is the wrong guess.
 */
export function uploadEndpoint (raw) {
  const value = (raw || '').trim() || DEFAULT_ENDPOINT
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`endpoint "${value}" is not a URL.`)
  }
  // Not repeated in the message: the part before "@" may be a password. And
  // "https://flightdeck.example.org@other.example" goes to other.example.
  if (url.username || url.password) {
    throw new Error('endpoint has a user name or password in it, before an "@", so the host is not the one it seems.')
  }
  if (url.protocol !== 'https:') {
    throw new Error(`endpoint "${value}" is not https, and the token must not be sent in the clear.`)
  }
  return `${url.origin}${UPLOAD_PATH}`
}

/**
 * The public URL the directory is served from, with a trailing slash, so a
 * chunk's path can be appended to it.
 */
export function normalizeBaseUrl (raw) {
  const value = (raw || '').trim()
  if (!value) throw new Error('no base-url was given, so the maps have no chunk URL to be uploaded under.')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`base-url "${value}" is not a URL.`)
  }
  // Not repeated in the message, since the part before "@" may be a password.
  if (url.username || url.password) {
    throw new Error('base-url has a user name or password in it; it should be only the URL the directory is served from.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`base-url "${value}" is not an http or https URL.`)
  }
  if (url.search || url.hash) {
    throw new Error(`base-url "${value}" has a query or fragment; it should be only the URL the directory is served from.`)
  }
  const base = `${url.origin}${url.pathname}`
  return base.endsWith('/') ? base : `${base}/`
}

async function isDirectory (dir) {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every file below `root`, as sorted POSIX paths relative to it, found one
 * folder at a time so that a folder that cannot be read costs only itself.
 *
 * A symbolic link to a file is listed: a sync follows it, so a linked map is
 * published like any other, and deleting the link removes it from the site
 * without touching what it points at. A symbolic link to a FOLDER is not
 * followed, because the deletion must never reach outside the directory, but
 * a sync does follow it, so it is warned about. Anything that is not a file
 * or folder (a FIFO, a socket, a device) is skipped.
 *
 * Never throws. Returns { real, files, unreadable, linkedFolders }.
 */
async function walk (directory, root) {
  const files = []
  const unreadable = []
  const linkedFolders = []
  const special = []
  const tooHigh = new Map()

  let real
  try {
    real = await realpath(root)
  } catch {
    real = root
  }

  const pending = ['']
  while (pending.length > 0) {
    const folder = pending.shift()
    let entries
    try {
      entries = await readdir(path.join(root, folder), { withFileTypes: true })
    } catch (error) {
      unreadable.push(folder || '.')
      core.warning(
        `could not read the folder ${folder || '.'} in ${directory} (${error.code ?? error.message}), so nothing in ` +
        'it was uploaded or deleted.'
      )
      continue
    }
    for (const entry of entries) {
      const file = folder ? `${folder}/${entry.name}` : entry.name
      if (TOO_HIGH.includes(entry.name) && !tooHigh.has(entry.name)) tooHigh.set(entry.name, file)
      if (entry.isDirectory()) {
        pending.push(file)
      } else if (entry.isFile()) {
        files.push(file)
      } else if (entry.isSymbolicLink()) {
        const target = await stat(path.join(root, file)).catch(() => null)
        if (target?.isDirectory()) {
          linkedFolders.push(file)
        } else if (target === null || target.isFile()) {
          // A broken link is listed too: deleting one named like a map is harmless.
          files.push(file)
        } else {
          special.push(file)
        }
      } else {
        special.push(file)
      }
    }
  }

  for (const file of tooHigh.values()) {
    core.warning(
      `${directory} holds ${file}, so it is probably set too high. It should be the folder of built files as ` +
      'they are served, like dist.'
    )
  }
  if (linkedFolders.length > 0) {
    core.warning(
      `${linkedFolders.length} folder(s) in ${directory} are symbolic links, which were not followed: ` +
      `${listed(linkedFolders)}. Nothing under them was uploaded or deleted, but aws s3 sync follows links by ` +
      'default and will publish any map under them.'
    )
  }
  if (special.length > 0) {
    core.warning(`skipped ${special.length} item(s) in ${directory} that are not regular files: ${listed(special)}`)
  }
  return { real, files: files.sort(), unreadable, linkedFolders }
}

async function deleteFiles (directory, root, maps, tree) {
  const undeleted = []
  for (const map of maps) {
    try {
      await unlink(path.join(root, map))
    } catch (error) {
      undeleted.push(map)
      core.warning(`could not delete ${map} from ${directory}: ${error.message}`)
    }
  }
  const deleted = maps.length - undeleted.length
  if (maps.length > 0) core.info(`deleted ${deleted} map file(s) from ${directory}, so a sync of it does not publish them`)

  const gaps = []
  if (undeleted.length > 0) gaps.push(`${undeleted.length} could not be deleted (${listed(undeleted)})`)
  if (tree.unreadable.length > 0) gaps.push(`${tree.unreadable.length} folder(s) could not be read (${listed(tree.unreadable)})`)
  if (tree.linkedFolders.length > 0) {
    gaps.push(`${tree.linkedFolders.length} folder(s) are symbolic links that were not followed (${listed(tree.linkedFolders)})`)
  }
  if (gaps.length > 0) {
    core.warning(
      `Not every map was deleted from ${directory}: ${gaps.join('; ')}. Any map left there is NOT deleted, and a ` +
      'sync of the directory will publish it.'
    )
  }
  return deleted
}
