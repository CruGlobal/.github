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
 * @param {string|Buffer} name    entry name (<=100 bytes, or pass `prefix` to
 *   split). A string is written as UTF-8; a Buffer is written as its bytes, for
 *   a name that is not valid UTF-8.
 * @param {string|Buffer} contents
 * @param {{prefix?: string, type?: string, linkname?: string}} [options] `type`
 *   defaults to '0' (regular file); pass 'x' for a PAX record, '5' for a
 *   directory, '1' for a hard link (with `linkname`), etc.
 */
export function tarEntry (name, contents, { prefix = '', type = '0', linkname = '' } = {}) {
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  const header = Buffer.alloc(BLOCK)

  if (Buffer.isBuffer(name)) name.copy(header, 0, 0, 100)
  else header.write(name, 0, 100, 'utf8')
  if (linkname !== '') header.write(linkname, 157, 100, 'utf8')
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

/**
 * A PAX extended header carrying `path`, plus the entry it applies to.
 *
 * Mirrors what buildkit emits for a name that does not fit the ustar header:
 * the real name lives in the record, and the header itself carries a
 * placeholder the reader must ignore.
 *
 * @param {string} path      the real entry name
 * @param {string|Buffer} contents
 * @param {{placeholder?: string}} [options] name left in the ustar header
 */
export function paxEntry (path, contents, { placeholder = 'PaxHeaders/entry' } = {}) {
  const record = paxRecord('path', path)
  return Buffer.concat([
    tarEntry(`PaxHeaders.0/${placeholder}`, record, { type: 'x' }),
    tarEntry(placeholder, contents)
  ])
}

/**
 * A GNU long-name record (type L, or K for a long link name) carrying `value`,
 * the way GNU tar writes a name that does not fit the header. Put it right
 * before the entry it names.
 */
export function gnuLongRecord (value, type = 'L') {
  return tarEntry('././@LongLink', Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]), { type })
}

/**
 * One PAX record: "<len> <key>=<value>\n", where <len> counts its own digits.
 * Solved rather than guessed, since the length changes the length.
 */
export function paxRecord (key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body, 'utf8')
  for (;;) {
    const candidate = Buffer.from(`${length}${body}`, 'utf8')
    if (candidate.length === length) return candidate
    length = candidate.length
  }
}

/** Concatenate entries and append the two-zero-block end-of-archive marker. */
export function tarArchive (...entries) {
  return Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)])
}
