// Minimal read-only tar reader, enough to pull known files out of a container
// image layer. Deliberately not a dependency: the callers (src/v2/oci.js) want
// one file at a fixed, short, conventional path, or every file under a fixed,
// short, conventional prefix — and a shared actions repo pays for every new
// transitive dep in review surface.
//
// Supports the ustar layout every image builder emits (docker, buildkit, kaniko,
// ko): 512-byte header blocks, octal sizes, optional `prefix` for long names.
// Names are read as UTF-8, so a name the header holds in UTF-8 reads as it was
// written, and bytes that are not UTF-8 read as U+FFFD for a caller to refuse.
// PAX (`x`) records ARE interpreted, but only their `path` and `linkpath` keys:
// see the comment on parsePaxRecords for why. GNU long-name (`L`) and
// long-link-name (`K`) records are interpreted too, for the same reason: GNU
// tar writes a long name there instead of in a PAX record. Everything else in a
// PAX record, and PAX global (`g`) records, are SKIPPED, not interpreted.
// Skipping keeps the stream aligned, so entries after such a record still parse
// correctly.

const BLOCK = 512

// Hard cap on a single extracted entry. The sign-in page is an inlined-CSS HTML
// document — ~100KB in practice — so this is two orders of magnitude of headroom
// and still bounds what a malformed or hostile image can make us allocate.
// Callers reading something bigger by nature (browser source maps) pass their
// own `maxBytes`.
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

// Header field offsets/lengths (POSIX ustar).
const NAME = [0, 100]
const SIZE = [124, 12]
const TYPE = 156
const LINKNAME = [157, 100]
const PREFIX = [345, 155]

// Typeflags that denote a regular file. '\0' is the pre-POSIX spelling of '0'
// and is still emitted by some writers. '7' is a "contiguous" file, which POSIX
// and every reader treat as a regular file.
const REGULAR = new Set(['0', '\0', '7'])
const HARDLINK = '1'
const SYMLINK = '2'
const DIRECTORY = '5'

// PAX extended header, scoped to the NEXT entry in the stream.
const PAX_EXTENDED = 'x'

// GNU records holding the NEXT entry's long name, and its long link name.
const GNU_LONG_NAME = 'L'
const GNU_LONG_LINK = 'K'

// The bytes of a NUL- or space-padded header field, up to the first NUL.
function rawField (block, [offset, length]) {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end)
}

// Read a NUL- or space-padded ASCII header field (the numeric ones).
function field (block, spec) {
  return rawField(block, spec).toString('ascii').trim()
}

// Read a name field as UTF-8. Reading it as ASCII would drop the high bit of
// every byte, turning a UTF-8 name into a different name without a word.
function textField (block, spec) {
  return rawField(block, spec).toString('utf8').trim()
}

// The text of a GNU long-name record's body, which ends with a NUL.
function cString (body) {
  const end = body.indexOf(0)
  return body.subarray(0, end === -1 ? body.length : end).toString('utf8')
}

// Parse an octal numeric header field. Empty means zero (some writers leave
// size blank for non-file entries).
function octal (block, spec) {
  const text = field(block, spec)
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Malformed tar numeric field: "${text}"`)
  }
  return value
}

/**
 * Parse a PAX extended header body into its records.
 *
 * The format is a sequence of `"<len> <key>=<value>\n"` chunks where `<len>` is
 * the byte length of the whole chunk, its own digits included. Values are UTF-8.
 *
 * Only `path` and `linkpath` are acted on by this module. `linkpath` is the
 * same thing for a link's target, which a hard link in a static site needs.
 * `path` is the reason PAX is parsed at all: when an entry's name does not fit
 * the ustar header (>100 bytes, or >255
 * split across `prefix`), or contains non-ASCII bytes, buildkit stores the real
 * name here and leaves a truncated placeholder in the header. For one fixed
 * 22-character path that never happened. For an enumerated directory of
 * bundler-generated chunk names it happens, and an unparsed record would make
 * a map SILENTLY invisible — no error, just a stack frame that never resolves.
 *
 * A malformed record ends parsing rather than throwing: what we already read is
 * still usable, and the walker recovers by falling back to the ustar name.
 */
export function parsePaxRecords (body) {
  const records = {}
  let offset = 0

  while (offset < body.length) {
    const space = body.indexOf(0x20, offset) // ' '
    if (space === -1) break
    const length = Number.parseInt(body.subarray(offset, space).toString('ascii'), 10)
    // A length that does not cover its own header, or runs off the end, means
    // we have lost the frame and cannot find the next record boundary.
    if (!Number.isFinite(length) || length <= space - offset || offset + length > body.length) break

    // The chunk ends with a newline; the key/value pair is everything between
    // the space and it.
    const pair = body.subarray(space + 1, offset + length - 1)
    const equals = pair.indexOf(0x3d) // '='
    if (equals !== -1) {
      records[pair.subarray(0, equals).toString('utf8')] = pair.subarray(equals + 1).toString('utf8')
    }
    offset += length
  }

  return records
}

// Layer entries are normally stored relative ("cru/iap-signin/signin"), but some
// writers prefix "./" and callers naturally pass an absolute path. Compare on a
// single normalized form so all three spellings agree.
export function normalizeTarPath (path) {
  return path.replace(/^(?:\.?\/)+/, '')
}

function nonEmpty (value) {
  return typeof value === 'string' && value !== '' ? value : null
}

// Round a byte count up to the next 512-byte block boundary.
function padded (size) {
  return Math.ceil(size / BLOCK) * BLOCK
}

/**
 * Walk an uncompressed tar archive, yielding one descriptor per entry:
 * `{ path, type, size, offset, linkname }` where `offset` is where the body
 * starts and `linkname` is what a link entry points at.
 *
 * PAX `x` records and GNU `L`/`K` records are consumed rather than yielded:
 * each overrides the name (or link name) of the single entry that follows it,
 * as POSIX and GNU tar specify, PAX first when both are there. Any other
 * record type is yielded as-is and callers filter on `type`.
 */
function * walkTar (archive) {
  let offset = 0
  let pax = {}
  let longName = null
  let longLink = null

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    const name = textField(header, NAME)
    // A zero-filled block is the end-of-archive marker. Trailing garbage after
    // it (some writers pad generously) is not our problem.
    if (name === '') return

    const size = octal(header, SIZE)
    const type = String.fromCharCode(header[TYPE])
    const body = offset + BLOCK
    const next = body + padded(size)

    if (type === PAX_EXTENDED) {
      const records = parsePaxRecords(archive.subarray(body, body + size))
      pax = { path: nonEmpty(records.path), linkpath: nonEmpty(records.linkpath) }
      offset = next
      continue
    }
    if (type === GNU_LONG_NAME || type === GNU_LONG_LINK) {
      const value = nonEmpty(cString(archive.subarray(body, body + size)))
      if (type === GNU_LONG_NAME) longName = value
      else longLink = value
      offset = next
      continue
    }

    const prefix = textField(header, PREFIX)
    const stored = prefix === '' ? name : `${prefix}/${name}`
    yield {
      path: normalizeTarPath(pax.path ?? longName ?? stored),
      type,
      size,
      offset: body,
      linkname: pax.linkpath ?? longLink ?? textField(header, LINKNAME)
    }

    // A PAX or GNU record applies to exactly one entry, whatever that entry
    // turned out to be.
    pax = {}
    longName = null
    longLink = null
    offset = next
  }
}

// Copy an entry's body out of the archive. Copy rather than return a view: the
// caller holds this long after the (much larger) decompressed layer should be
// collectable.
function readEntry (archive, entry) {
  return Buffer.from(archive.subarray(entry.offset, entry.offset + entry.size))
}

/**
 * Find one regular file in an uncompressed tar archive.
 *
 * Returns its contents as a Buffer, or null when the archive does not contain
 * it (the normal case — the caller scans several layers looking for one file).
 * Throws when the match is larger than `maxBytes` — nothing we read at this path
 * should be big, and the caller treats a throw as a warning, not an outage.
 */
export function findInTar (archive, target, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  const wanted = normalizeTarPath(target)

  for (const entry of walkTar(archive)) {
    if (!REGULAR.has(entry.type) || entry.path !== wanted) continue
    if (entry.size > maxBytes) {
      throw new Error(`Tar entry "${entry.path}" is ${entry.size} bytes, over the ${maxBytes}-byte limit`)
    }
    return readEntry(archive, entry)
  }

  return null
}

/**
 * List every regular file under a directory prefix in an uncompressed tar
 * archive.
 *
 * Returns `[{ path, name, size, contents }]` where `path` is the normalized
 * archive path, `name` is the part BELOW the prefix (so a caller can map it onto
 * a URL or an output tree), and `contents` is a Buffer.
 *
 * Unlike findInTar, an over-cap entry does NOT throw: `contents` is null and
 * `size` still says how big it was. Enumeration is best-effort by nature — one
 * oversized file among forty must not cost the other thirty-nine — so the
 * decision of what to do about it belongs to the caller, which has the context
 * to warn usefully. Nothing over the cap is ever copied out of the archive.
 *
 * Directories, symlinks and anything else that is not a file are skipped: only
 * real bytes are returned. A hard link to a file earlier in the archive is
 * returned with that file's bytes; one whose target is not there is skipped.
 * Order is archive order.
 */
export function listInTar (archive, prefix, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  return listTreeInTar(archive, prefix, { maxBytes }).files
}

/**
 * listInTar, plus what it leaves out under the prefix.
 *
 * Returns `{ files, links, others }`:
 *
 *   files   exactly what listInTar returns. A hard link whose target is an
 *           earlier regular file in the same archive is a file too, with its
 *           target's bytes and `linkTo` naming the target: a hard link is the
 *           same file under a second name.
 *   links   `[{ path, name, type, target }]` for each symbolic link, and each
 *           hard link whose target this archive does not hold.
 *   others  `[{ path, name, type }]` for every other entry that is not a
 *           directory: a FIFO, a device, or a type this reader does not know.
 *
 * A caller that must copy a whole tree (a static site) needs to know about
 * links and others, because skipping one quietly would leave a file missing
 * from what it serves.
 */
export function listTreeInTar (archive, prefix, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  // "/cru/sourcemaps", "cru/sourcemaps" and "cru/sourcemaps/" all mean the same
  // directory. An empty prefix lists the whole archive.
  const base = normalizeTarPath(prefix).replace(/\/+$/, '')
  const dir = base === '' ? '' : `${base}/`

  const files = []
  const links = []
  const others = []
  // Every regular file read so far, anywhere in the archive, by path. A hard
  // link names an earlier entry, which need not be under the prefix.
  const regular = new Map()
  for (const entry of walkTar(archive)) {
    const target = entry.type === HARDLINK ? normalizeTarPath(entry.linkname) : null
    const source = REGULAR.has(entry.type) ? entry : (target === null ? null : regular.get(target) ?? null)
    if (source) regular.set(entry.path, source)
    if (!entry.path.startsWith(dir)) continue

    const name = entry.path.slice(dir.length)
    if (source) {
      files.push({
        path: entry.path,
        name,
        size: source.size,
        contents: source.size > maxBytes ? null : readEntry(archive, source),
        ...(target === null ? {} : { linkTo: target })
      })
    } else if (entry.type === HARDLINK || entry.type === SYMLINK) {
      links.push({ path: entry.path, name, type: entry.type, target: entry.linkname })
    } else if (entry.type !== DIRECTORY) {
      others.push({ path: entry.path, name, type: entry.type })
    }
  }
  return { files, links, others }
}
