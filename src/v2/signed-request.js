import { createPublicKey, verify } from 'node:crypto'

// The deploy gate's signed request: proof that the deploy gate approved one
// production change, for one app, at one moment. authorize-actor accepts it
// only on a run attempt that the gate's own machine account started
// (src/authorize-actor.js), so a copied request is no use to anyone else.
//
// Another service signs what this module verifies, so the format is written
// out here in full. Anything not described here is refused.
//
// FORMAT
//
// A compact JWS (RFC 7515), the same shape as a JWT:
//
//   BASE64URL(header) "." BASE64URL(payload) "." BASE64URL(signature)
//
// Each part is unpadded base64url (no "=", no "+" or "/", no whitespace). The
// whole request is at most 8192 characters.
//
// Header, a JSON object with exactly these members:
//   alg  "ES256", always. Any other value is refused, including "none", the
//        HS* and RS* families and ES384/ES512.
//   typ  "JWT".
//   kid  Optional. A string naming the signing key, for logs only. It never
//        picks the key: every configured key is tried.
// Any other header member is refused, "crit" included, so a request cannot
// ask for a key from a URL (jku, x5u) or carry its own (jwk, x5c).
//
// Signature: ECDSA on the P-256 curve with SHA-256, over the ASCII bytes of
// BASE64URL(header) "." BASE64URL(payload), exactly as they appear in the
// request. The signature part is the raw 64-byte r || s pair (IEEE P1363,
// each half 32 bytes, big-endian, left-padded with zeros), as JWS requires.
// A KMS signer (for example AWS KMS Sign with ECDSA_SHA_256) returns an ASN.1
// DER sequence instead, about 70 to 72 bytes. The signer must convert that to
// r || s before encoding it; a DER signature is refused here.
//
// Payload, a JSON object. Every claim below is required:
//   iss          string, must equal the gate-issuer input.
//   aud          string, must equal the gate-audience input. A single string,
//                not an array.
//   sub          string, the email of the person who asked the gate for the
//                change. Logged with the request id.
//   app          string, the project name. Must equal the expected-app input.
//   action       "promote", "rollback" or "hotfix". Must equal the
//                expected-action input.
//   target       string, what the action applies: the candidate tag for a
//                promote, the release tag for a rollback, the commit sha for a
//                hotfix. Must equal the expected-target input exactly.
//   environment  "production".
//   jti          string, a unique id for this request (a UUID fits): 1 to 128
//                letters, digits, ".", "_", ":" or "-".
//   iat          integer, seconds since the Unix epoch, when it was signed.
//   exp          integer, seconds since the Unix epoch, when it expires.
// Optional:
//   nbf          integer seconds. When present, the request is refused before
//                this time.
// Any other claim is ignored, so the gate can add one without breaking runs
// on an older release of this code.
//
// TIME RULES, with now taken from the runner's clock:
//   - exp must be after iat, and exp - iat at most 300 seconds.
//   - 60 seconds of clock skew is allowed each way, because the gate's clock
//     and the runner's are not the same clock.
//   - iat may not be more than 60 seconds in the future.
//   - The request is expired, and refused, once now is 60 seconds past exp.
//
// PUBLIC KEYS: the gate-public-keys input holds one or more PEM public keys
// ("-----BEGIN PUBLIC KEY-----", SubjectPublicKeyInfo), P-256 only, one after
// another. During a key rotation it holds the old key and the new one, and a
// request signed by either passes. Anything else in the input (a certificate,
// a private key, stray text) is refused, so a pasting mistake is found at once
// rather than when the next request fails.
//
// NOT DONE HERE: a request id (jti) is not yet remembered, so this module on
// its own does not stop the same request from being presented twice within
// its lifetime. See the one-time id hook in src/authorize-actor.js.

export const SIGNED_REQUEST_ALG = 'ES256'
export const MAX_LIFETIME_SECONDS = 300
export const CLOCK_SKEW_SECONDS = 60
export const MAX_REQUEST_LENGTH = 8192
export const GATE_ACTIONS = ['promote', 'rollback', 'hotfix']
export const GATE_ENVIRONMENT = 'production'

const HEADER_MEMBERS = ['alg', 'typ', 'kid']
const SEGMENT = /^[A-Za-z0-9_-]+$/
const PEM_BLOCK = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/g
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
// The email is logged, so nothing that could start a new log line or hide in
// one: no whitespace and no control characters.
// eslint-disable-next-line no-control-regex
const EMAIL = /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/

export class InvalidSignedRequest extends Error {}

// Strict base64url: Node's decoder skips characters it does not know, so the
// text is checked first and must also round-trip, which refuses padding and
// a final character with stray low bits.
function decodeSegment (segment, what) {
  if (!SEGMENT.test(segment)) {
    throw new InvalidSignedRequest(`the signed request's ${what} is not base64url`)
  }
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) {
    throw new InvalidSignedRequest(`the signed request's ${what} is not base64url`)
  }
  return bytes
}

function decodeJsonObject (segment, what) {
  let value
  try {
    value = JSON.parse(decodeSegment(segment, what).toString('utf8'))
  } catch (error) {
    if (error instanceof InvalidSignedRequest) throw error
    throw new InvalidSignedRequest(`the signed request's ${what} is not JSON`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSignedRequest(`the signed request's ${what} is not a JSON object`)
  }
  return value
}

// Read the gate-public-keys input. Throws InvalidSignedRequest on anything it
// cannot use, so a bad key list is a refusal with a reason, never a pass.
export function parsePublicKeys (raw) {
  const text = String(raw ?? '')
  const keys = []
  for (const match of text.matchAll(PEM_BLOCK)) {
    let key
    try {
      key = createPublicKey({ key: match[0], format: 'pem' })
    } catch (error) {
      throw new InvalidSignedRequest(`gate-public-keys: key ${keys.length + 1} is not a readable PEM public key (${error.message})`)
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new InvalidSignedRequest(`gate-public-keys: key ${keys.length + 1} is not a P-256 key, and ES256 needs one`)
    }
    keys.push(key)
  }
  if (text.replace(PEM_BLOCK, '').trim() !== '') {
    throw new InvalidSignedRequest('gate-public-keys holds something other than PEM public keys ("-----BEGIN PUBLIC KEY-----"); a certificate or a private key does not belong there')
  }
  if (keys.length === 0) {
    throw new InvalidSignedRequest('gate-public-keys holds no public key')
  }
  return keys
}

const isSeconds = (value) => Number.isSafeInteger(value) && value >= 0

function requireString (claims, name) {
  const value = claims[name]
  if (typeof value !== 'string' || value === '') {
    throw new InvalidSignedRequest(`the signed request has no ${name} claim`)
  }
  return value
}

// Check every claim against what this run expects. The claims come from a
// request whose signature already verified, so their values can be named in
// a refusal.
function checkClaims (claims, { issuer, audience, expected, nowSeconds }) {
  const iss = requireString(claims, 'iss')
  if (iss !== issuer) throw new InvalidSignedRequest(`the signed request was issued by '${iss}', not '${issuer}'`)
  if (typeof claims.aud !== 'string') throw new InvalidSignedRequest('the signed request\'s aud claim is not a single string')
  if (claims.aud !== audience) throw new InvalidSignedRequest(`the signed request is for audience '${claims.aud}', not '${audience}'`)

  const sub = requireString(claims, 'sub')
  if (!EMAIL.test(sub)) throw new InvalidSignedRequest('the signed request\'s sub claim is not an email address')

  const jti = requireString(claims, 'jti')
  if (!REQUEST_ID.test(jti)) throw new InvalidSignedRequest('the signed request\'s jti claim is not 1 to 128 letters, digits, ".", "_", ":" or "-"')

  const environment = requireString(claims, 'environment')
  if (environment !== GATE_ENVIRONMENT) throw new InvalidSignedRequest(`the signed request is for environment '${environment}', not '${GATE_ENVIRONMENT}'`)

  const action = requireString(claims, 'action')
  if (!GATE_ACTIONS.includes(action)) throw new InvalidSignedRequest(`the signed request's action '${action}' is not one of ${GATE_ACTIONS.join(', ')}`)
  for (const name of ['app', 'action', 'target']) {
    const value = requireString(claims, name)
    if (value !== expected[name]) {
      throw new InvalidSignedRequest(`the signed request is for ${name} '${value}', but this run is for ${name} '${expected[name]}'`)
    }
  }

  const { iat, exp, nbf } = claims
  if (!isSeconds(iat)) throw new InvalidSignedRequest('the signed request\'s iat claim is not a whole number of seconds')
  if (!isSeconds(exp)) throw new InvalidSignedRequest('the signed request\'s exp claim is not a whole number of seconds')
  if (exp <= iat) throw new InvalidSignedRequest('the signed request expires before it was issued (exp is not after iat)')
  if (exp - iat > MAX_LIFETIME_SECONDS) {
    throw new InvalidSignedRequest(`the signed request is valid for ${exp - iat} seconds; at most ${MAX_LIFETIME_SECONDS} is allowed`)
  }
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new InvalidSignedRequest(`the signed request was issued ${iat - nowSeconds} seconds in the future; at most ${CLOCK_SKEW_SECONDS} seconds of clock skew is allowed`)
  }
  if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) {
    throw new InvalidSignedRequest(`the signed request expired ${nowSeconds - exp} seconds ago`)
  }
  if (nbf !== undefined) {
    if (!isSeconds(nbf)) throw new InvalidSignedRequest('the signed request\'s nbf claim is not a whole number of seconds')
    if (nbf > nowSeconds + CLOCK_SKEW_SECONDS) throw new InvalidSignedRequest(`the signed request is not valid for another ${nbf - nowSeconds} seconds`)
  }
  return { sub, jti, app: claims.app, action, target: claims.target, environment, iat, exp }
}

// Verify one signed request. Returns { kid, claims } when it is good, and
// throws InvalidSignedRequest saying why when it is not.
//
// `keys` is what parsePublicKeys returns. `expected` is { app, action, target }
// for this run; each must be set, so a caller that forgets one is refused
// rather than matching an empty claim.
export function verifySignedRequest (token, { keys, issuer, audience, expected, now = Date.now() }) {
  issuer = String(issuer ?? '').trim()
  audience = String(audience ?? '').trim()
  if (!issuer) throw new InvalidSignedRequest('no gate-issuer was given, so the signed request cannot be checked')
  if (!audience) throw new InvalidSignedRequest('no gate-audience was given, so the signed request cannot be checked')
  if (!Array.isArray(keys) || keys.length === 0) throw new InvalidSignedRequest('no gate public key was given, so the signed request cannot be checked')
  const want = {}
  for (const name of ['app', 'action', 'target']) {
    want[name] = String(expected?.[name] ?? '').trim()
    if (!want[name]) throw new InvalidSignedRequest(`no expected-${name} was given, so the signed request cannot be matched to this run`)
  }

  const text = String(token ?? '').trim()
  if (text === '') throw new InvalidSignedRequest('no signed request was given')
  if (text.length > MAX_REQUEST_LENGTH) throw new InvalidSignedRequest(`the signed request is longer than ${MAX_REQUEST_LENGTH} characters`)
  const parts = text.split('.')
  if (parts.length !== 3) throw new InvalidSignedRequest('the signed request is not a compact JWS (three parts separated by dots)')
  const [headerPart, payloadPart, signaturePart] = parts

  const header = decodeJsonObject(headerPart, 'header')
  if (header.alg !== SIGNED_REQUEST_ALG) {
    throw new InvalidSignedRequest(`the signed request uses alg ${JSON.stringify(header.alg ?? null)}; only ${SIGNED_REQUEST_ALG} is accepted`)
  }
  if (header.typ !== 'JWT') throw new InvalidSignedRequest('the signed request\'s header typ is not "JWT"')
  if (header.kid !== undefined && typeof header.kid !== 'string') throw new InvalidSignedRequest('the signed request\'s header kid is not a string')
  const extra = Object.keys(header).filter((name) => !HEADER_MEMBERS.includes(name))
  if (extra.length > 0) {
    throw new InvalidSignedRequest(`the signed request's header has members this check does not accept: ${extra.join(', ')}`)
  }

  const signature = decodeSegment(signaturePart, 'signature')
  if (signature.length !== 64) {
    throw new InvalidSignedRequest(`the signed request's signature is ${signature.length} bytes, not the 64-byte r || s form ES256 uses (a DER signature from a KMS must be converted first)`)
  }
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii')
  const good = keys.some((key) => {
    try {
      return verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)
    } catch {
      return false
    }
  })
  if (!good) throw new InvalidSignedRequest(`the signed request's signature does not match any of the ${keys.length} gate public key(s)`)

  const claims = decodeJsonObject(payloadPart, 'payload')
  return {
    kid: typeof header.kid === 'string' ? header.kid : '',
    claims: checkClaims(claims, { issuer, audience, expected: want, nowSeconds: Math.floor(now / 1000) })
  }
}
