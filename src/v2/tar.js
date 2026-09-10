// Minimal read-only tar reader, enough to pull known files out of a container
// image layer. Deliberately not a dependency: the callers (src/v2/oci.js) want
// one file at a fixed, short, conventional path, or every file under a fixed,
// short, conventional prefix — and a shared actions repo pays for every new
// transitive dep in review surface.
//
// Supports the ustar layout every image builder emits (docker, buildkit, kaniko,
// ko): 512-byte header blocks, octal sizes, optional `prefix` for long names.
// PAX (`x`) records ARE interpreted, but only their `path` key — see the comment
// on parsePaxRecords for why that one matters. Everything else in a PAX record,
// PAX global (`g`) records and GNU long-name (`L`) records are SKIPPED, not
// interpreted. Skipping keeps the stream aligned, so entries after such a record
// still parse correctly.

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
const PREFIX = [345, 155]

// Typeflags that denote a regular file. '\0' is the pre-POSIX spelling of '0'
// and is still emitted by some writers.
const REGULAR = new Set(['0', '\0'])

// PAX extended header, scoped to the NEXT entry in the stream.
const PAX_EXTENDED = 'x'

// Read a NUL- or space-padded ASCII header field.
function field (block, [offset, length]) {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('ascii').trim()
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
 * Only `path` is acted on by this module, and it is the reason PAX is parsed at
 * all: when an entry's name does not fit the ustar header (>100 bytes, or >255
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

// Round a byte count up to the next 512-byte block boundary.
function padded (size) {
  return Math.ceil(size / BLOCK) * BLOCK
}

/**
 * Walk an uncompressed tar archive, yielding one descriptor per entry:
 * `{ path, type, size, offset }` where `offset` is where the body starts.
 *
 * PAX `x` records are consumed rather than yielded: a `path` record overrides
 * the ustar name of the single entry that follows it, exactly as POSIX
 * specifies. Any other record type is yielded as-is and callers filter on
 * `type`.
 */
function * walkTar (archive) {
  let offset = 0
  let overridePath = null

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    const name = field(header, NAME)
    // A zero-filled block is the end-of-archive marker. Trailing garbage after
    // it (some writers pad generously) is not our problem.
    if (name === '') return

    const size = octal(header, SIZE)
    const type = String.fromCharCode(header[TYPE])
    const body = offset + BLOCK
    const next = body + padded(size)

    if (type === PAX_EXTENDED) {
      const { path } = parsePaxRecords(archive.subarray(body, body + size))
      overridePath = typeof path === 'string' && path !== '' ? path : null
      offset = next
      continue
    }

    const prefix = field(header, PREFIX)
    const stored = prefix === '' ? name : `${prefix}/${name}`
    yield { path: normalizeTarPath(overridePath ?? stored), type, size, offset: body }

    // A PAX record applies to exactly one entry, whatever that entry turned
    // out to be.
    overridePath = null
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
 * Directories, symlinks and hardlinks under the prefix are skipped: only real
 * bytes are returned. Order is archive order.
 */
export function listInTar (archive, prefix, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  // "/cru/sourcemaps", "cru/sourcemaps" and "cru/sourcemaps/" all mean the same
  // directory. An empty prefix lists the whole archive.
  const base = normalizeTarPath(prefix).replace(/\/+$/, '')
  const dir = base === '' ? '' : `${base}/`

  const files = []
  for (const entry of walkTar(archive)) {
    if (!REGULAR.has(entry.type)) continue
    if (!entry.path.startsWith(dir)) continue
    files.push({
      path: entry.path,
      name: entry.path.slice(dir.length),
      size: entry.size,
      contents: entry.size > maxBytes ? null : readEntry(archive, entry)
    })
  }
  return files
}
