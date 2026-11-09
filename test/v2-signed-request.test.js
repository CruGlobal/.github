import { describe, it, expect } from 'vitest'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
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
  it('passes and returns the claims and the key id', () => {
    const { kid, claims: verified } = check(signRequest())
    expect(kid).toBe('gate-1')
    expect(verified).toMatchObject({ sub: 'requester@example.com', jti: '0b6f2a1e-5c3d-4e2f-9a7b-1c2d3e4f5a6b', app: 'example-app', action: 'promote', target: 'candidate-12345' })
  })

  it.each(GATE_ACTIONS)('passes for action %s', (action) => {
    const token = signRequest({ payload: claims({ action, target: 'abc123' }) })
    expect(check(token, { expected: { app: 'example-app', action, target: 'abc123' } }).claims.action).toBe(action)
  })

  it('passes with no kid and ignores claims it does not know', () => {
    const token = signRequest({ header: { alg: 'ES256', typ: 'JWT' }, payload: { ...claims(), reason: 'scheduled' } })
    expect(check(token).kid).toBe('')
  })

  it('tries every key, so a request signed by the second of two keys passes', () => {
    const both = parsePublicKeys(pem(otherKeys) + pem(gateKeys))
    expect(both).toHaveLength(2)
    expect(check(signRequest(), { keys: both }).claims.sub).toBe('requester@example.com')
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
