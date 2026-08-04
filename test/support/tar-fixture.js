// Builds tar archives for the src/v2/tar.js + src/v2/oci.js tests. Writes the
// ustar header fields the reader actually looks at (name, size, typeflag,
// prefix) and zero-fills the rest — the reader does not verify checksums.
//
// Not a *.test.js file, so vitest does not collect it.

const BLOCK = 512

function octalField (value, length) {
  // POSIX: octal digits, zero-padded, NUL-terminated.
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

/**
 * One tar entry (header + NUL-padded body).
 *
 * @param {string} name    entry name (<=100 chars, or pass `prefix` to split)
 * @param {string|Buffer} contents
 * @param {{prefix?: string, type?: string}} [options] `type` defaults to '0'
 *   (regular file); pass 'x' for a PAX record, '5' for a directory, etc.
 */
export function tarEntry (name, contents, { prefix = '', type = '0' } = {}) {
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  const header = Buffer.alloc(BLOCK)

  header.write(name, 0, 100, 'ascii')
  header.write(octalField(0o644, 8), 100, 8, 'ascii') // mode
  header.write(octalField(body.length, 12), 124, 12, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  if (prefix !== '') header.write(prefix, 345, 155, 'ascii')

  const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK)
  body.copy(padded)
  return Buffer.concat([header, padded])
}

/** Concatenate entries and append the two-zero-block end-of-archive marker. */
export function tarArchive (...entries) {
  return Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)])
}
