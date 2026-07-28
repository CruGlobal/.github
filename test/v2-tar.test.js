import { describe, it, expect } from 'vitest'
import { findInTar, normalizeTarPath } from '../src/v2/tar.js'
import { tarArchive, tarEntry } from './support/tar-fixture.js'

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

  it('rejects a malformed size field rather than mis-seeking', () => {
    const entry = tarEntry('cru/iap-signin/signin', PAGE)
    entry.write('not-octal\0', 124, 12, 'ascii')
    expect(() => findInTar(tarArchive(entry), 'x')).toThrow(/Malformed tar numeric field/)
  })
})
