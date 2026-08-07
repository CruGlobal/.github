// Minimal read-only tar reader, enough to pull one known file out of a
// container image layer. Deliberately not a dependency: the only caller
// (src/v2/oci.js) wants a single file at a fixed, short, conventional path, and
// a shared actions repo pays for every new transitive dep in review surface.
//
// Supports the ustar layout every image builder emits (docker, buildkit, kaniko,
// ko): 512-byte header blocks, octal sizes, optional `prefix` for long names.
// PAX (`x`/`g`) and GNU long-name (`L`) records are SKIPPED, not interpreted —
// so a target whose stored name needs one of those (>100 chars, or >255 with
// prefix) will not be found. That is fine by construction: the sign-in page path
// is a fixed 22-character convention. Skipping keeps the stream aligned, so
// entries after a PAX record still parse correctly.

const BLOCK = 512

// Hard cap on a single extracted entry. The sign-in page is an inlined-CSS HTML
// document — ~100KB in practice — so this is two orders of magnitude of headroom
// and still bounds what a malformed or hostile image can make us allocate.
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

// Header field offsets/lengths (POSIX ustar).
const NAME = [0, 100]
const SIZE = [124, 12]
const TYPE = 156
const PREFIX = [345, 155]

// Typeflags that denote a regular file. '\0' is the pre-POSIX spelling of '0'
// and is still emitted by some writers.
const REGULAR = new Set(['0', '\0'])

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
 * Find one regular file in an uncompressed tar archive.
 *
 * Returns its contents as a Buffer, or null when the archive does not contain
 * it (the normal case — the caller scans several layers looking for one file).
 * Throws when the match is larger than `maxBytes` — nothing we read at this path
 * should be big, and the caller treats a throw as a warning, not an outage.
 */
export function findInTar (archive, target, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  const wanted = normalizeTarPath(target)
  let offset = 0

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    const name = field(header, NAME)
    // A zero-filled block is the end-of-archive marker. Trailing garbage after
    // it (some writers pad generously) is not our problem.
    if (name === '') return null

    const size = octal(header, SIZE)
    const type = String.fromCharCode(header[TYPE])
    const prefix = field(header, PREFIX)
    const path = normalizeTarPath(prefix === '' ? name : `${prefix}/${name}`)
    const data = offset + BLOCK

    if (REGULAR.has(type) && path === wanted) {
      if (size > maxBytes) {
        throw new Error(`Tar entry "${path}" is ${size} bytes, over the ${maxBytes}-byte limit`)
      }
      // Copy rather than return a view: the caller holds this long after the
      // (much larger) decompressed layer should be collectable.
      return Buffer.from(archive.subarray(data, data + size))
    }

    offset = data + padded(size)
  }

  return null
}
