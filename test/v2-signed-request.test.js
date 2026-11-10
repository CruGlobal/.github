import { describe, it, expect } from 'vitest'
import { createHmac, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  CLOCK_SKEW_SECONDS,
  GATE_ACTIONS,
  InvalidSignedRequest,
  MAX_LIFETIME_SECONDS,
  parsePublicKeys,
  verifySignedRequest
} from '../src/v2/signed-request.js'

// Keys are made here, per test run, and requests are signed the way the gate
// must sign them: ES256 with the raw 64-byte r || s signature.
const gateKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const otherKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pem = ({ publicKey }) => publicKey.export({ type: 'spki', format: 'pem' })

const NOW = 1800000000
const now = NOW * 1000
const ISSUER = 'https://deploy-gate.example.com'
const AUDIENCE = 'example-org/deploy'
const expected = { app: 'example-app', action: 'promote', target: 'candidate-12345' }

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

function claims (overrides = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'requester@example.com',
    app: 'example-app',
    action: 'promote',
    target: 'candidate-12345',
    environment: 'production',
    jti: '0b6f2a1e-5c3d-4e2f-9a7b-1c2d3e4f5a6b',
    iat: NOW,
    exp: NOW + 300,
    ...overrides
  }
}

function signRequest ({
  header = { alg: 'ES256', typ: 'JWT', kid: 'gate-1' },
  payload = claims(),
  privateKey = gateKeys.privateKey,
  dsaEncoding = 'ieee-p1363'
} = {}) {
  const data = `${b64(header)}.${b64(payload)}`
  const signature = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding })
  return `${data}.${signature.toString('base64url')}`
}

const keys = parsePublicKeys(pem(gateKeys))
const check = (token, options = {}) => verifySignedRequest(token, { keys, issuer: ISSUER, audience: AUDIENCE, expected, now, ...options })

describe('verifySignedRequest: a good request', () => {
  it('passes and returns the claims, the kid and which configured key verified it', () => {
    const { kid, claims: verified, expired, keyNumber, keyCount } = check(signRequest())
    expect(kid).toBe('gate-1')
    expect(verified).toMatchObject({ sub: 'requester@example.com', jti: '0b6f2a1e-5c3d-4e2f-9a7b-1c2d3e4f5a6b', app: 'example-app', action: 'promote', target: 'candidate-12345' })
    expect(expired).toBe(false)
    expect({ keyNumber, keyCount }).toEqual({ keyNumber: 1, keyCount: 1 })
  })

  it.each(GATE_ACTIONS)('passes for action %s', (action) => {
    const token = signRequest({ payload: claims({ action, target: 'abc123' }) })
    expect(check(token, { expected: { app: 'example-app', action, target: 'abc123' } }).claims.action).toBe(action)
  })

  it('passes with no kid and ignores claims it does not know', () => {
    const token = signRequest({ header: { alg: 'ES256', typ: 'JWT' }, payload: { ...claims(), reason: 'scheduled' } })
    expect(check(token).kid).toBe('')
  })

  it('tries every key, so a request signed by the second of two keys passes, and says it was the second', () => {
    const both = parsePublicKeys(pem(otherKeys) + pem(gateKeys))
    expect(both).toHaveLength(2)
    expect(check(signRequest(), { keys: both })).toMatchObject({ claims: { sub: 'requester@example.com' }, keyNumber: 2, keyCount: 2, kid: 'gate-1' })
  })
})

describe('verifySignedRequest: time', () => {
  it('refuses an expired request', () => {
    const token = signRequest({ payload: claims({ iat: NOW - 400, exp: NOW - 100 }) })
    expect(() => check(token)).toThrow('the signed request expired 100 seconds ago')
  })

  it('allows 60 seconds of clock skew past exp, and no more', () => {
    const token = signRequest({ payload: claims({ iat: NOW - 330, exp: NOW - 30 }) })
    expect(check(token).claims.exp).toBe(NOW - 30)
    const late = signRequest({ payload: claims({ iat: NOW - 360, exp: NOW - CLOCK_SKEW_SECONDS }) })
    expect(() => check(late)).toThrow(/expired 60 seconds ago/)
  })

  it('refuses a request issued in the future beyond the skew', () => {
    const token = signRequest({ payload: claims({ iat: NOW + 61, exp: NOW + 200 }) })
    expect(() => check(token)).toThrow('the signed request was issued 61 seconds in the future')
  })

  it('accepts a request issued up to 60 seconds in the future', () => {
    const token = signRequest({ payload: claims({ iat: NOW + 60, exp: NOW + 200 }) })
    expect(check(token).claims.iat).toBe(NOW + 60)
  })

  it('refuses a lifetime over 300 seconds, and accepts exactly 300', () => {
    expect(() => check(signRequest({ payload: claims({ exp: NOW + MAX_LIFETIME_SECONDS + 1 }) })))
      .toThrow('the signed request is valid for 301 seconds; at most 300 is allowed')
    expect(check(signRequest({ payload: claims({ exp: NOW + MAX_LIFETIME_SECONDS }) })).claims.exp).toBe(NOW + 300)
  })

  it('refuses exp at or before iat', () => {
    expect(() => check(signRequest({ payload: claims({ exp: NOW }) }))).toThrow(/exp is not after iat/)
  })

  it.each([
    ['iat', { iat: '1800000000' }],
    ['iat', { iat: NOW + 0.5 }],
    ['exp', { exp: undefined }],
    ['exp', { exp: -1 }]
  ])('refuses a %s that is not whole seconds (%j)', (name, override) => {
    expect(() => check(signRequest({ payload: claims(override) }))).toThrow(`${name} claim is not a whole number of seconds`)
  })

  it('refuses a request whose nbf is in the future', () => {
    expect(() => check(signRequest({ payload: claims({ nbf: NOW + 120 }) }))).toThrow(/not valid for another 120 seconds/)
  })
})

describe('verifySignedRequest: allowExpired', () => {
  const expiredAt = (seconds) => signRequest({ payload: claims({ iat: NOW - seconds - 300, exp: NOW - seconds }) })

  it('returns an expired request, saying how long ago it expired, instead of refusing it', () => {
    const result = check(expiredAt(4000), { allowExpired: true })
    expect(result).toMatchObject({ expired: true, secondsPastExpiry: 4000, kid: 'gate-1', keyNumber: 1, keyCount: 1 })
    expect(result.claims.jti).toBe('0b6f2a1e-5c3d-4e2f-9a7b-1c2d3e4f5a6b')
    expect(() => check(expiredAt(4000))).toThrow('the signed request expired 4000 seconds ago')
  })

  it('counts a request as expired from 60 seconds past exp, as without it', () => {
    expect(check(expiredAt(59), { allowExpired: true })).toMatchObject({ expired: false })
    expect(check(expiredAt(59), { allowExpired: true })).not.toHaveProperty('secondsPastExpiry')
    expect(check(expiredAt(60), { allowExpired: true })).toMatchObject({ expired: true, secondsPastExpiry: 60 })
  })

  it('returns a fresh request as not expired', () => {
    expect(check(signRequest(), { allowExpired: true })).toMatchObject({ expired: false })
  })

  it.each([
    ['another key\'s signature', { privateKey: otherKeys.privateKey }, /signature does not match/],
    ['another target', { payload: claims({ target: 'candidate-99999', iat: NOW - 4300, exp: NOW - 4000 }) }, /for target 'candidate-99999'/],
    ['another issuer', { payload: claims({ iss: 'https://other.example.com', iat: NOW - 4300, exp: NOW - 4000 }) }, /issued by/],
    ['a lifetime over 300 seconds', { payload: claims({ iat: NOW - 4400, exp: NOW - 4000 }) }, /valid for 400 seconds/],
    ['an nbf that is not a number', { payload: claims({ nbf: 'soon', iat: NOW - 4300, exp: NOW - 4000 }) }, /nbf claim is not a whole number/],
    ['alg none', { header: { alg: 'none', typ: 'JWT' }, payload: claims({ iat: NOW - 4300, exp: NOW - 4000 }) }, /uses alg "none"/]
  ])('still refuses an expired request with %s', (_label, options, message) => {
    expect(() => check(signRequest(options), { allowExpired: true })).toThrow(message)
  })
})

describe('verifySignedRequest: claims must match this run', () => {
  it.each([
    ['iss', { iss: 'https://other.example.com' }, "issued by 'https://other.example.com', not 'https://deploy-gate.example.com'"],
    ['aud', { aud: 'example-org/other' }, "for audience 'example-org/other', not 'example-org/deploy'"],
    ['aud as an array', { aud: [AUDIENCE] }, 'aud claim is not a single string'],
    ['app', { app: 'other-app' }, "for app 'other-app', but this run is for app 'example-app'"],
    ['action', { action: 'rollback' }, "for action 'rollback', but this run is for action 'promote'"],
    ['an unknown action', { action: 'destroy' }, "action 'destroy' is not one of promote, rollback, hotfix"],
    ['target', { target: 'candidate-99999' }, "for target 'candidate-99999', but this run is for target 'candidate-12345'"],
    ['target, by case', { target: 'Candidate-12345' }, "for target 'Candidate-12345'"],
    ['environment', { environment: 'stage' }, "for environment 'stage', not 'production'"],
    ['a missing sub', { sub: undefined }, 'has no sub claim'],
    ['a sub that is not an email', { sub: 'someone' }, 'sub claim is not an email address'],
    ['a sub with a newline', { sub: 'a@example.com\n::error::x' }, 'sub claim is not an email address'],
    ['a missing jti', { jti: undefined }, 'has no jti claim'],
    ['a jti with spaces', { jti: 'one two' }, 'jti claim is not 1 to 128']
  ])('refuses a wrong %s', (_label, override, message) => {
    expect(() => check(signRequest({ payload: claims(override) }))).toThrow(message)
  })

  it.each(['app', 'action', 'target'])('refuses when the run gives no expected %s', (name) => {
    expect(() => check(signRequest(), { expected: { ...expected, [name]: '  ' } }))
      .toThrow(`no expected-${name} was given`)
  })

  it.each([
    ['issuer', { issuer: '' }, 'no gate-issuer was given'],
    ['audience', { audience: undefined }, 'no gate-audience was given'],
    ['keys', { keys: [] }, 'no gate public key was given']
  ])('refuses when no %s is configured', (_label, options, message) => {
    expect(() => check(signRequest(), options)).toThrow(message)
  })
})

describe('verifySignedRequest: algorithm and signature', () => {
  it('refuses alg none, with or without a signature', () => {
    const data = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}`
    expect(() => check(`${data}.`)).toThrow('the signed request uses alg "none"; only ES256 is accepted')
    expect(() => check(`${data}.${b64('x'.repeat(64))}`)).toThrow(/uses alg "none"/)
  })

  it('refuses HS256, even when keyed with the gate public key', () => {
    // The classic confusion: an HMAC whose secret is the public key PEM.
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims())}`
    const mac = createHmac('sha256', pem(gateKeys)).update(data).digest('base64url')
    expect(() => check(`${data}.${mac}`)).toThrow('uses alg "HS256"; only ES256 is accepted')
  })

  it('refuses RS256', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims())}`
    const signature = sign('sha256', Buffer.from(data), rsa.privateKey).toString('base64url')
    expect(() => check(`${data}.${signature}`)).toThrow('uses alg "RS256"')
  })

  it('refuses a request with no alg', () => {
    expect(() => check(signRequest({ header: { typ: 'JWT' } }))).toThrow('uses alg null')
  })

  it.each([
    ['crit', { crit: ['exp'] }],
    ['jku', { jku: 'https://keys.example.com' }],
    ['jwk', { jwk: { kty: 'EC' } }],
    ['x5c', { x5c: [] }]
  ])('refuses a %s header', (name, extra) => {
    expect(() => check(signRequest({ header: { alg: 'ES256', typ: 'JWT', ...extra } })))
      .toThrow(`header has members this check does not accept: ${name}`)
  })

  it('refuses a header whose typ is not JWT', () => {
    expect(() => check(signRequest({ header: { alg: 'ES256' } }))).toThrow('typ is not "JWT"')
  })

  it('refuses a tampered payload', () => {
    const [header, , signature] = signRequest().split('.')
    const tampered = `${header}.${b64(claims({ target: 'candidate-99999' }))}.${signature}`
    expect(() => check(tampered)).toThrow("signature does not match any of the 1 gate public key(s)")
  })

  it('refuses a request signed by another key', () => {
    expect(() => check(signRequest({ privateKey: otherKeys.privateKey }))).toThrow(/signature does not match/)
  })

  it('refuses a DER signature and says to convert it', () => {
    expect(() => check(signRequest({ dsaEncoding: 'der' }))).toThrow(/not the 64-byte r \|\| s form ES256 uses \(a DER signature from a KMS must be converted first\)/)
  })

  it.each([
    ['empty', '', 'no signed request was given'],
    ['two parts', 'a.b', 'not a compact JWS'],
    ['four parts', 'a.b.c.d', 'not a compact JWS'],
    ['padding', `${b64({ alg: 'ES256', typ: 'JWT' })}=.${b64(claims())}.${b64('x'.repeat(64))}`, "header is not base64url"],
    ['a header that is not JSON', `${b64('not json')}.${b64(claims())}.${b64('x'.repeat(64))}`, 'header is not JSON'],
    ['a header that is an array', `${b64(['ES256'])}.${b64(claims())}.${b64('x'.repeat(64))}`, 'header is not a JSON object'],
    ['a request that is too long', 'a'.repeat(9000), 'longer than 8192 characters']
  ])('refuses a malformed request: %s', (_label, token, message) => {
    expect(() => check(token)).toThrow(message)
  })

  it('refuses a payload that is not a JSON object, even when signed', () => {
    const header = b64({ alg: 'ES256', typ: 'JWT' })
    const payload = b64('[1,2,3]')
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: gateKeys.privateKey, dsaEncoding: 'ieee-p1363' })
    expect(() => check(`${header}.${payload}.${signature.toString('base64url')}`)).toThrow('payload is not a JSON object')
  })

  it('throws only InvalidSignedRequest for a bad request', () => {
    expect(() => check('a.b.c')).toThrow(InvalidSignedRequest)
  })

  it('refuses a __proto__ header member, which JSON.parse keeps as an ordinary member', () => {
    expect(() => check(signRequest({ header: '{"alg":"ES256","typ":"JWT","__proto__":{"x":1}}' }))).toThrow('header has members this check does not accept: __proto__')
  })

  it('does not take a missing claim from a __proto__ member of the payload', () => {
    const { app, ...rest } = claims()
    expect(app).toBe('example-app')
    const payload = JSON.stringify(rest).replace('{', '{"__proto__":{"app":"example-app"},')
    expect(() => check(signRequest({ payload }))).toThrow('the signed request has no app claim')
  })

  it('refuses a signature whose last character carries stray low bits', () => {
    const [header, payload, signature] = signRequest().split('.')
    // 64 bytes is 86 characters, and the last one has 2 bits to spare.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const bumped = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)) ^ 1]
    expect(Buffer.from(bumped, 'base64url')).toEqual(Buffer.from(signature, 'base64url'))
    expect(() => check(`${header}.${payload}.${bumped}`)).toThrow("the signed request's signature is not base64url")
  })

  it('accepts the high-S twin of a signature, so a replay record must be keyed on jti, not on the request text', () => {
    // A KMS signer does not normalize s, so high-S signatures are genuine.
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
    const token = signRequest()
    const [header, payload, signature] = token.split('.')
    const raw = Buffer.from(signature, 'base64url')
    const s = BigInt(`0x${raw.subarray(32).toString('hex')}`)
    const twin = Buffer.concat([raw.subarray(0, 32), Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex')])
    const other = `${header}.${payload}.${twin.toString('base64url')}`
    expect(other).not.toBe(token)
    expect(check(other).claims.jti).toBe(check(token).claims.jti)
  })
})

describe('verifySignedRequest: keys handed to it directly', () => {
  it('refuses an RSA key, whose 64-byte signature Node would verify under an ES256 header', () => {
    // dsaEncoding means nothing to an RSA key, and a 512-bit RSA key makes a
    // signature of exactly 64 bytes.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 512 })
    const data = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(claims())}`
    const signature = sign('sha256', Buffer.from(data), rsa.privateKey)
    expect(signature).toHaveLength(64)
    expect(verify('sha256', Buffer.from(data), { key: rsa.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
    expect(() => check(`${data}.${signature.toString('base64url')}`, { keys: [rsa.publicKey] }))
      .toThrow('gate public key 1 is not a P-256 public key, and ES256 needs one')
  })

  it.each([
    ['a P-384 key', () => generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey],
    ['an Ed25519 key', () => generateKeyPairSync('ed25519').publicKey],
    ['a P-256 private key', () => gateKeys.privateKey],
    ['a PEM string', () => pem(gateKeys)],
    ['nothing', () => undefined]
  ])('refuses %s', (_label, make) => {
    expect(() => check(signRequest(), { keys: [make()] })).toThrow('gate public key 1 is not a P-256 public key')
  })

  it('refuses the whole list when any key in it is not P-256, and names which', () => {
    const keysWithOneBad = [createPublicKey(pem(gateKeys)), generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey]
    expect(() => check(signRequest(), { keys: keysWithOneBad })).toThrow('gate public key 2 is not a P-256 public key')
  })
})

describe('verifySignedRequest: what ends up in a log line', () => {
  it.each([
    ['a right-to-left override', '\u202e'],
    ['a zero-width space', '\u200b'],
    ['a byte order mark', '\ufeff'],
    ['a C1 control', '\u0085'],
    ['another C1 control', '\u009b'],
    ['a line separator', '\u2028'],
    ['a lone surrogate', '\ud800']
  ])('refuses a sub with %s', (_label, char) => {
    expect(() => check(signRequest({ payload: claims({ sub: `requester${char}@example.com` }) }))).toThrow('sub claim is not an email address')
  })

  it.each(['iss', 'aud', 'app', 'action', 'target', 'environment'])('refuses a %s claim with a format or C1 character, without showing it', (name) => {
    for (const char of ['\u202e', '\u0085']) {
      let message
      try {
        check(signRequest({ payload: claims({ [name]: `x${char}y` }) }))
      } catch (error) {
        message = error.message
      }
      expect(message).toBe(`the signed request's ${name} claim holds a control or format character`)
    }
  })

  it('refuses a header kid with a format character', () => {
    expect(() => check(signRequest({ header: { alg: 'ES256', typ: 'JWT', kid: 'gate-1\u202e' } }))).toThrow("the signed request's header kid holds a control or format character")
  })

  it('writes the control and format characters of header member names as code points', () => {
    const header = { alg: 'ES256', typ: 'JWT', 'x\n::error::fake': 1, 'y\u202ez': 1 }
    expect(() => check(signRequest({ header }))).toThrow("the signed request's header has members this check does not accept: x\\u{a}::error::fake, y\\u{202e}z")
  })

  it('writes the control and format characters of an alg it refuses as code points', () => {
    expect(() => check(signRequest({ header: { alg: 'ES256\u202e', typ: 'JWT' } }))).toThrow('the signed request uses alg "ES256\\u{202e}"; only ES256 is accepted')
  })
})

describe('parsePublicKeys', () => {
  it('reads one or more P-256 public keys, with text around them trimmed', () => {
    expect(parsePublicKeys(`\n${pem(gateKeys)}\n\n${pem(otherKeys)}  `)).toHaveLength(2)
  })

  it.each([
    ['nothing', '', 'holds no public key'],
    ['whitespace', '  \n', 'holds no public key'],
    ['stray text', `${pem(gateKeys)}\nnot a key`, 'holds something other than PEM public keys'],
    ['a private key', gateKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'holds something other than PEM public keys'],
    ['a broken key', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', 'key 1 is not a readable PEM public key']
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parsePublicKeys(raw)).toThrow(message)
  })

  it.each([
    ['an RSA key', () => generateKeyPairSync('rsa', { modulusLength: 2048 })],
    ['a P-384 key', () => generateKeyPairSync('ec', { namedCurve: 'secp384r1' })],
    ['an Ed25519 key', () => generateKeyPairSync('ed25519')]
  ])('refuses %s', (_label, make) => {
    expect(() => parsePublicKeys(pem(make()))).toThrow('key 1 is not a P-256 key')
  })
})
