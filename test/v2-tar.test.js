import { describe, it, expect } from 'vitest'
import { findInTar, listInTar, MAX_ENTRY_BYTES, normalizeTarPath, parsePaxRecords } from '../src/v2/tar.js'
import { paxEntry, paxRecord, tarArchive, tarEntry } from './support/tar-fixture.js'

const PAGE = '<!DOCTYPE html><title>Sign in</title>'

describe('normalizeTarPath', () => {
  it('strips leading slashes and ./ prefixes so all spellings compare equal', () => {
    expect(normalizeTarPath('cru/iap-signin/signin')).toBe('cru/iap-signin/signin')
    expect(normalizeTarPath('/cru/iap-signin/signin')).toBe('cru/iap-signin/signin')
    expect(normalizeTarPath('./cru/iap-signin/signin')).toBe('cru/iap-signin/signin')
    expect(normalizeTarPath('.//cru/iap-signin/signin')).toBe('cru/iap-signin/signin')
  })

  it('leaves interior dots alone', () => {
    expect(normalizeTarPath('app/.next/static')).toBe('app/.next/static')
  })
})

describe('findInTar', () => {
  it('finds a file by absolute path in a relatively-stored archive', () => {
    const archive = tarArchive(
      tarEntry('etc/passwd', 'root:x:0:0'),
      tarEntry('cru/iap-signin/signin', PAGE)
    )
    expect(findInTar(archive, '/cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('finds a file stored with a ./ prefix', () => {
    const archive = tarArchive(tarEntry('./cru/iap-signin/signin', PAGE))
    expect(findInTar(archive, '/cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('returns null when the archive does not contain the path', () => {
    const archive = tarArchive(tarEntry('app/server.js', 'console.log(1)'))
    expect(findInTar(archive, '/cru/iap-signin/signin')).toBeNull()
  })

  it('returns null for an empty archive (end-of-archive marker only)', () => {
    expect(findInTar(tarArchive(), '/cru/iap-signin/signin')).toBeNull()
  })

  it('reassembles names split across the ustar prefix field', () => {
    const archive = tarArchive(
      tarEntry('signin', PAGE, { prefix: 'cru/iap-signin' })
    )
    expect(findInTar(archive, '/cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('preserves exact bytes, including a body that fills its last block', () => {
    const exact = Buffer.alloc(1024, 0x61)
    const archive = tarArchive(tarEntry('cru/iap-signin/signin', exact))
    const found = findInTar(archive, 'cru/iap-signin/signin')
    expect(found.length).toBe(1024)
    expect(found.equals(exact)).toBe(true)
  })

  it('walks past entries whose bodies span many blocks', () => {
    const archive = tarArchive(
      tarEntry('app/big.bin', Buffer.alloc(4097, 0x7a)),
      tarEntry('cru/iap-signin/signin', PAGE)
    )
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('ignores a directory entry sharing the target path', () => {
    const archive = tarArchive(
      tarEntry('cru/iap-signin/signin', '', { type: '5' }),
      tarEntry('cru/iap-signin/signin', PAGE)
    )
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('accepts the pre-POSIX NUL typeflag for a regular file', () => {
    const archive = tarArchive(tarEntry('cru/iap-signin/signin', PAGE, { type: '\0' }))
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('skips a PAX record without losing stream alignment', () => {
    // A PAX extended header precedes the entry it describes. We do not
    // interpret it, but skipping it must leave the next header aligned.
    const archive = tarArchive(
      tarEntry('PaxHeaders/0/app', '30 mtime=1700000000.5\n', { type: 'x' }),
      tarEntry('app/server.js', 'console.log(1)'),
      tarEntry('cru/iap-signin/signin', PAGE)
    )
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('returns the first match when a path appears twice in one archive', () => {
    const archive = tarArchive(
      tarEntry('cru/iap-signin/signin', 'first'),
      tarEntry('cru/iap-signin/signin', 'second')
    )
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe('first')
  })

  it('rejects a match larger than the byte cap', () => {
    const archive = tarArchive(tarEntry('cru/iap-signin/signin', Buffer.alloc(2048, 0x61)))
    expect(() => findInTar(archive, 'cru/iap-signin/signin', { maxBytes: 1024 }))
      .toThrow(/is 2048 bytes, over the 1024-byte limit/)
  })

  it('applies the cap only to the match, walking past larger entries', () => {
    const archive = tarArchive(
      tarEntry('app/big.bin', Buffer.alloc(4096, 0x7a)),
      tarEntry('cru/iap-signin/signin', PAGE)
    )
    expect(findInTar(archive, 'cru/iap-signin/signin', { maxBytes: 1024 }).toString()).toBe(PAGE)
  })

  it('defaults to a cap that comfortably fits a real sign-in page', () => {
    expect(MAX_ENTRY_BYTES).toBeGreaterThan(1024 * 1024)
    const archive = tarArchive(tarEntry('cru/iap-signin/signin', Buffer.alloc(512 * 1024, 0x61)))
    expect(findInTar(archive, 'cru/iap-signin/signin').length).toBe(512 * 1024)
  })

  it('rejects a malformed size field rather than mis-seeking', () => {
    const entry = tarEntry('cru/iap-signin/signin', PAGE)
    entry.write('not-octal\0', 124, 12, 'ascii')
    expect(() => findInTar(tarArchive(entry), 'x')).toThrow(/Malformed tar numeric field/)
  })
})

describe('parsePaxRecords', () => {
  it('reads a single record', () => {
    expect(parsePaxRecords(paxRecord('path', 'cru/sourcemaps/a.js.map')))
      .toEqual({ path: 'cru/sourcemaps/a.js.map' })
  })

  it('reads several records in one header', () => {
    const body = Buffer.concat([
      paxRecord('mtime', '1758000000'),
      paxRecord('path', 'cru/sourcemaps/b.js.map'),
      paxRecord('uid', '0')
    ])
    expect(parsePaxRecords(body)).toEqual({
      mtime: '1758000000',
      path: 'cru/sourcemaps/b.js.map',
      uid: '0'
    })
  })

  it('reads a record long enough that its own length field grows', () => {
    // The 100-digit boundary is where a naive "length of the rest" is off by one.
    const long = `cru/sourcemaps/${'x'.repeat(120)}.js.map`
    expect(parsePaxRecords(paxRecord('path', long))).toEqual({ path: long })
  })

  it('decodes values as UTF-8, which is why they need a record at all', () => {
    const name = 'cru/sourcemaps/café.js.map'
    expect(parsePaxRecords(paxRecord('path', name))).toEqual({ path: name })
  })

  it('keeps what it parsed and stops at a record it cannot frame', () => {
    const body = Buffer.concat([paxRecord('path', 'a/b.js.map'), Buffer.from('9999 mtime=1\n')])
    expect(parsePaxRecords(body)).toEqual({ path: 'a/b.js.map' })
  })

  it('returns nothing for an empty header', () => {
    expect(parsePaxRecords(Buffer.alloc(0))).toEqual({})
  })
})

describe('findInTar with PAX records', () => {
  it('finds an entry whose real name lives in a PAX path record', () => {
    // Without PAX parsing this entry is INVISIBLE: the ustar header carries a
    // placeholder, so the reader would only ever see the wrong name.
    const archive = tarArchive(paxEntry('cru/iap-signin/signin', PAGE))
    expect(findInTar(archive, '/cru/iap-signin/signin').toString()).toBe(PAGE)
  })

  it('does not match the placeholder the PAX record overrides', () => {
    const archive = tarArchive(paxEntry('cru/iap-signin/signin', PAGE, { placeholder: 'wrong/name' }))
    expect(findInTar(archive, 'wrong/name')).toBeNull()
  })

  it('applies a PAX record to the next entry only', () => {
    const archive = tarArchive(
      paxEntry('cru/iap-signin/signin', PAGE),
      tarEntry('app/server.js', 'console.log(1)')
    )
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe(PAGE)
    expect(findInTar(archive, 'app/server.js').toString()).toBe('console.log(1)')
  })

  it('falls back to the ustar name when the record carries no path', () => {
    const archive = tarArchive(
      tarEntry('PaxHeaders.0/x', paxRecord('mtime', '1758000000'), { type: 'x' }),
      tarEntry('cru/iap-signin/signin', PAGE)
    )
    expect(findInTar(archive, 'cru/iap-signin/signin').toString()).toBe(PAGE)
  })
})

describe('listInTar', () => {
  const MAP_A = '{"version":3,"file":"a.js"}'
  const MAP_B = '{"version":3,"file":"b.js"}'

  it('returns every regular file under the prefix, named relative to it', () => {
    const archive = tarArchive(
      tarEntry('app/server.js', 'console.log(1)'),
      tarEntry('cru/sourcemaps/main.js.map', MAP_A),
      tarEntry('cru/sourcemaps/_next/static/chunks/abc.js.map', MAP_B)
    )
    expect(listInTar(archive, '/cru/sourcemaps')).toEqual([
      { path: 'cru/sourcemaps/main.js.map', name: 'main.js.map', size: MAP_A.length, contents: Buffer.from(MAP_A) },
      {
        path: 'cru/sourcemaps/_next/static/chunks/abc.js.map',
        name: '_next/static/chunks/abc.js.map',
        size: MAP_B.length,
        contents: Buffer.from(MAP_B)
      }
    ])
  })

  it('accepts the prefix with or without leading and trailing slashes', () => {
    const archive = tarArchive(tarEntry('cru/sourcemaps/main.js.map', MAP_A))
    for (const prefix of ['/cru/sourcemaps', 'cru/sourcemaps', '/cru/sourcemaps/', './cru/sourcemaps']) {
      expect(listInTar(archive, prefix).map(file => file.name)).toEqual(['main.js.map'])
    }
  })

  it('returns [] when nothing lives under the prefix', () => {
    const archive = tarArchive(tarEntry('app/server.js', 'x'))
    expect(listInTar(archive, '/cru/sourcemaps')).toEqual([])
  })

  it('does not treat a prefix as a bare string match', () => {
    // cru/sourcemaps-old is a different directory, not a longer file name.
    const archive = tarArchive(tarEntry('cru/sourcemaps-old/main.js.map', MAP_A))
    expect(listInTar(archive, '/cru/sourcemaps')).toEqual([])
  })

  it('skips directories, symlinks and hardlinks', () => {
    const archive = tarArchive(
      tarEntry('cru/sourcemaps/', '', { type: '5' }),
      tarEntry('cru/sourcemaps/link.js.map', '', { type: '2' }),
      tarEntry('cru/sourcemaps/main.js.map', MAP_A)
    )
    expect(listInTar(archive, '/cru/sourcemaps').map(file => file.name)).toEqual(['main.js.map'])
  })

  it('finds entries whose names need a PAX record — the reason PAX is parsed', () => {
    // A hashed chunk name easily exceeds the 100-byte ustar name field. In a
    // single-file read a miss is loud; enumerating a directory, a missed map
    // is SILENT, and the stack frame simply never resolves.
    const long = `_next/static/chunks/${'a'.repeat(120)}.js.map`
    const archive = tarArchive(paxEntry(`cru/sourcemaps/${long}`, MAP_A))
    expect(listInTar(archive, '/cru/sourcemaps').map(file => file.name)).toEqual([long])
  })

  it('reports an over-cap entry with null contents instead of throwing', () => {
    // Enumeration is best effort: one oversized file must not cost the rest.
    const archive = tarArchive(
      tarEntry('cru/sourcemaps/huge.js.map', Buffer.alloc(2048, 0x61)),
      tarEntry('cru/sourcemaps/main.js.map', MAP_A)
    )
    expect(listInTar(archive, '/cru/sourcemaps', { maxBytes: 1024 })).toEqual([
      { path: 'cru/sourcemaps/huge.js.map', name: 'huge.js.map', size: 2048, contents: null },
      { path: 'cru/sourcemaps/main.js.map', name: 'main.js.map', size: MAP_A.length, contents: Buffer.from(MAP_A) }
    ])
  })

  it('lists the whole archive for an empty prefix', () => {
    const archive = tarArchive(tarEntry('a.js.map', MAP_A), tarEntry('b/c.js.map', MAP_B))
    expect(listInTar(archive, '').map(file => file.name)).toEqual(['a.js.map', 'b/c.js.map'])
  })
})
