import * as core from '@actions/core'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
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
// Then, by default, every .map file in the directory is deleted, uploaded or
// not, so that syncing the directory to a public site does not publish them.
//
// Telemetry policy, the same as pipeline v2's upload: this NEVER fails the job.
// Every problem is a warning, and the outputs count what landed.

/** Files read as chunks: the scripts a browser loads. */
const CHUNK = /\.m?js$/

/** Files deleted from the directory. */
const MAP = /\.map$/

/** Maps a chunk is likely to name; used to spot a build that drops the comment. */
const SCRIPT_MAP = /\.m?js\.map$/

/**
 * Largest map file read at all. The upload limit (MAX_MAP_BYTES) applies to
 * the bytes sent, after the strip, and `sourcesContent` is often most of a map,
 * so a map well over the upload limit on disk can still fit under it.
 */
export const MAX_READ_BYTES = 8 * MAX_MAP_BYTES

/** File names a summary line lists before it says how many more there are. */
const LISTED = 10

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
 * Upload the maps in `directory`, then delete its .map files when `deleteMaps`.
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
 * the maps are just as public after a sync either way.
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
  const files = await listFiles(root)

  try {
    Object.assign(counts, await uploadFrom({ directory, root, files, baseUrl, version, token, endpoint, maxMapBytes, tuning }))
  } catch (error) {
    // Not an expected condition, but the deletion below still has to run.
    core.warning(`source maps not uploaded (job unaffected): ${error.message}`)
  }

  const maps = files.filter(file => MAP.test(file))
  if (deleteMaps) {
    await deleteFiles(directory, root, maps)
  } else if (maps.length > 0) {
    core.info(`left ${maps.length} .map file(s) in ${directory} (delete-maps is off): a sync of it as it stands publishes them`)
  }
  return counts
}

async function uploadFrom ({ directory, root, files, baseUrl, version, token, endpoint, maxMapBytes, tuning }) {
  const counts = { uploaded: 0, unchanged: 0, failed: 0 }
  const skip = message => {
    core.warning(`source maps not uploaded (job unaffected): ${message}`)
    return counts
  }

  if (!token) return skip('no token was given.')
  const codeVersion = (version || '').trim()
  if (!isUsableCodeVersion(codeVersion)) {
    return skip(
      `version "${codeVersion}" is not a usable code version. It must be the code_version the browser SDK ` +
      `reports: 1-${MAX_VERSION_LENGTH} characters with no whitespace or control characters.`
    )
  }
  let base, url
  try {
    base = normalizeBaseUrl(baseUrl)
    url = uploadEndpoint(endpoint)
  } catch (error) {
    return skip(error.message)
  }

  const paired = await pairMaps({ directory, root, files, baseUrl: base, maxMapBytes })
  counts.failed += paired.failed
  reportPairing(directory, paired)
  if (paired.maps.length === 0) {
    core.info(`no source maps to upload from ${directory}`)
    return counts
  }

  const upload = await uploadMaps(paired.maps, { endpoint: url, token, version: codeVersion, readResult: true, ...tuning })
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
  return counts
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
    core.info(`${orphans.length} .map file(s) are named by no chunk and were not uploaded: ${listed(orphans)}`)
  }
}

function listed (names) {
  const shown = names.slice(0, LISTED).join(', ')
  return names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown
}

/**
 * Pair each chunk in the directory with the map its sourceMappingURL names,
 * and prepare the upload for it.
 *
 * `files` is every file below `root`, as sorted POSIX paths relative to it.
 * Returns the uploads, how many named maps cannot be uploaded (each one already
 * warned about), and the chunks and maps that needed no upload.
 */
export async function pairMaps ({ directory, root, files, baseUrl, maxMapBytes = MAX_MAP_BYTES }) {
  const present = new Set(files)
  // Two chunks may name one map; it is read and stripped once.
  const prepared = new Map()
  const referenced = new Set()
  const maps = []
  const unmapped = []
  const inline = []
  let failed = 0

  for (const chunk of files.filter(file => CHUNK.test(file))) {
    let text
    try {
      text = await readFile(path.join(root, chunk), 'utf8')
    } catch (error) {
      core.warning(`could not read ${chunk} to find its source map: ${error.message}`)
      continue
    }

    const reference = sourceMappingUrl(text)
    if (reference === null) {
      unmapped.push(chunk)
      continue
    }
    if (/^data:/i.test(reference)) {
      inline.push(chunk)
      core.info(`skipping ${chunk}: its source map is inline (a data: URL), so there is no map file to upload`)
      continue
    }

    const fail = message => {
      core.warning(`skipping ${chunk}: ${message}`)
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
      fail(`its sourceMappingURL names ${located.path}, which is not in ${directory}`)
      continue
    }
    referenced.add(located.path)

    if (!prepared.has(located.path)) prepared.set(located.path, prepareMap(path.join(root, located.path), maxMapBytes))
    const map = await prepared.get(located.path)
    if (map.problem) {
      fail(`${located.path} ${map.problem}`)
      continue
    }
    maps.push({
      minified: chunkUrl,
      name: path.posix.basename(located.path),
      contents: map.contents,
      file: `${located.path} (for ${chunk})`
    })
  }

  const orphans = files.filter(file => MAP.test(file) && !referenced.has(file))
  return { maps, failed, unmapped, inline, orphans }
}

/**
 * The URL in a chunk's trailing `//# sourceMappingURL=` comment, or null.
 *
 * Only the comments at the END of the file count, read from the last line up.
 * A bundle can carry the same text earlier, in a string or in a library that
 * writes such comments itself, and that one names nothing. The older `//@`
 * spelling is accepted, and other trailing line comments (a debug id, say) are
 * stepped over.
 */
export function sourceMappingUrl (text) {
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (line === '') continue
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
    return { problem: `its sourceMappingURL "${reference}" is not a URL` }
  }
  // Query and fragment dropped: a file is looked up by its path alone.
  const target = `${resolved.origin}${resolved.pathname}`
  if (!target.startsWith(baseUrl)) {
    return {
      problem: `its sourceMappingURL "${reference}" resolves to ${target}, outside ${baseUrl}, so the map is not ` +
        'in this directory'
    }
  }
  const segments = target.slice(baseUrl.length).split('/').map(decodeSegment)
  const invalid = segments.some(segment =>
    segment === null || segment === '' || segment === '.' || segment === '..' ||
    segment.includes('/') || segment.includes('\\')
  )
  if (invalid) return { problem: `its sourceMappingURL "${reference}" does not name a file` }
  return { path: segments.join('/') }
}

// A file's path in the directory, written as a URL path. Escapes the three
// characters URL() would otherwise read as syntax rather than as part of a
// name, as a browser fetching the file has them escaped; URL() escapes the
// rest (spaces, say) itself.
function urlPath (file) {
  return file.replace(/[%?#]/g, character => encodeURIComponent(character))
}

async function prepareMap (file, maxMapBytes) {
  try {
    const { size } = await stat(file)
    if (size > MAX_READ_BYTES) return { problem: `is ${size} bytes, too big to read (the limit is ${MAX_READ_BYTES})` }
    const contents = stripSourcesContent(await readFile(file))
    if (contents.length > maxMapBytes) {
      return { problem: `is ${contents.length} bytes without sourcesContent, over the ${maxMapBytes}-byte upload limit` }
    }
    return { contents }
  } catch (error) {
    return { problem: `is not a usable source map: ${error.message}` }
  }
}

/**
 * The bytes to upload for a map: the map without `sourcesContent`, at the top
 * level and in each section of an index map (the sectioned form some bundlers,
 * Turbopack among them, write).
 *
 * The same input always gives the same bytes, because Flightdeck compares them
 * to decide whether an upload is unchanged. JSON.parse and JSON.stringify keep
 * key order, so the round trip is stable. A map with no `sourcesContent` to
 * remove is returned as the very bytes it came in as.
 *
 * Throws on bytes that are not a JSON object.
 */
export function stripSourcesContent (bytes) {
  const map = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('not a JSON object')
  if (!removeSourcesContent(map)) return Buffer.from(bytes)
  return Buffer.from(JSON.stringify(map))
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
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`base-url "${value}" is not an http or https URL.`)
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`base-url "${value}" has a query, fragment or credentials; it should be only the URL the directory is served from.`)
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

// Every file below `root`, as sorted POSIX paths relative to it. A symbolic
// link counts as a file: a sync follows it, so a linked map is published just
// like a real one.
async function listFiles (root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() || entry.isSymbolicLink())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

async function deleteFiles (directory, root, maps) {
  let deleted = 0
  for (const map of maps) {
    try {
      await unlink(path.join(root, map))
      deleted++
    } catch (error) {
      core.warning(`could not delete ${map} from ${directory}: ${error.message}. A sync of the directory will publish it.`)
    }
  }
  if (maps.length > 0) core.info(`deleted ${deleted} .map file(s) from ${directory}, so a sync of it does not publish them`)
  return deleted
}
