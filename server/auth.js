// Session authentication for ProxiSpeak.
//
// What this is: a server-issued, HMAC-SHA256 signed, expiring **application
// session token**. It proves that the bearer obtained a session from this server
// and fixes which office room that session may join. The subject id is generated
// by the server, never supplied by the client, so a client cannot claim to be
// another participant by editing a socket id, participant id, or display name.
//
// What this is NOT: an account system or an identity provider. There is no
// password, email verification, SSO, or user directory. Anybody who can obtain a
// session (in development: anybody; in production: anybody with the deployment's
// join code, or the token minted by an upstream identity provider once one is
// wired in) can join the office the token names. It protects the office boundary
// and the wire identity; it does not tell you *who* a human is.
//
// Token format: `v1.<base64url(claims JSON)>.<base64url(HMAC-SHA256)>`
// Claims: { v, sub, name, room, jti, iat, exp }
//
// Secrets come from the environment only. There is no hardcoded production
// secret: if NODE_ENV=production and SESSION_SECRET is missing or too short, the
// server refuses to start (see createAuthConfig).

import crypto from 'node:crypto'
import { sanitizeDisplayName } from './config.js'

export const TOKEN_VERSION = 'v1'
// Account sessions (the HttpOnly cookie) use a distinct version and claim set so
// a room token can never be replayed as an account session, or vice versa.
export const ACCOUNT_TOKEN_VERSION = 'v2'
export const ACCOUNT_TOKEN_TYPE = 'account'
export const MIN_SESSION_SECRET_LENGTH = 32
export const MAX_TOKEN_LENGTH = 4096
export const DEFAULT_SESSION_TTL_SECONDS = 3600
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60
export const DEFAULT_ACCOUNT_TTL_SECONDS = 7 * 24 * 60 * 60
export const MAX_ACCOUNT_TTL_SECONDS = 30 * 24 * 60 * 60
export const CLOCK_SKEW_SECONDS = 30

// Development-only fallback. It is deliberately recognizable and is refused in
// production, so it can never quietly become a deployed secret.
export const DEV_SESSION_SECRET =
  'proxispeak-development-only-session-secret-never-use-in-production'

// Stable machine-readable rejection codes. They are safe to return to a client:
// none of them reveals the token, the secret, or why the signature failed.
export const AUTH_CODES = {
  REQUIRED: 'AUTH_REQUIRED',
  MALFORMED: 'AUTH_MALFORMED',
  INVALID_SIGNATURE: 'AUTH_INVALID_SIGNATURE',
  EXPIRED: 'AUTH_EXPIRED',
  NOT_YET_VALID: 'AUTH_NOT_YET_VALID',
  NOT_CONFIGURED: 'AUTH_NOT_CONFIGURED',
  REVOKED: 'AUTH_REVOKED',
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

// Strict base64url decode: Buffer's decoder silently ignores invalid characters,
// which would make two different strings verify as the same signature. Re-encoding
// and comparing rejects that class of malleability.
function decodeBase64url(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const buffer = Buffer.from(value, 'base64url')
  if (buffer.length === 0 || buffer.toString('base64url') !== value) return null
  return buffer
}

export function signSessionBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest()
}

export function issueSession({
  subject,
  name,
  room,
  secret,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  now = Date.now(),
}) {
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error('Session secret is not configured')
  }
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('Session subject is required')
  }
  if (typeof room !== 'string' || room.length === 0) {
    throw new Error('Session room is required')
  }

  const issuedAt = Math.floor(now / 1000)
  const ttl = Math.max(
    1,
    Math.min(MAX_SESSION_TTL_SECONDS, Math.floor(Number(ttlSeconds) || DEFAULT_SESSION_TTL_SECONDS)),
  )
  const claims = {
    v: 1,
    sub: subject,
    name: sanitizeDisplayName(name),
    room,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ttl,
  }
  const body = base64url(Buffer.from(JSON.stringify(claims), 'utf8'))
  const signature = base64url(signSessionBody(`${TOKEN_VERSION}.${body}`, secret))
  return { token: `${TOKEN_VERSION}.${body}.${signature}`, claims }
}

// Verify a raw token. Returns `{ ok: true, claims }` or `{ ok: false, code }`.
// The rejection reasons never include the token, the secret, or a signature byte.
export function verifySessionToken(
  token,
  secret,
  { now = Date.now(), clockSkewSeconds = CLOCK_SKEW_SECONDS } = {},
) {
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    return { ok: false, code: AUTH_CODES.NOT_CONFIGURED, reason: 'session secret is not configured' }
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: AUTH_CODES.REQUIRED, reason: 'missing session token' }
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session token is too large' }
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session token has an unexpected format' }
  }

  const body = `${parts[0]}.${parts[1]}`
  const provided = decodeBase64url(parts[2])
  if (!provided) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session token signature is not valid base64url' }
  }
  const expected = signSessionBody(body, secret)
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, code: AUTH_CODES.INVALID_SIGNATURE, reason: 'session token signature is invalid' }
  }

  const payloadBytes = decodeBase64url(parts[1])
  if (!payloadBytes) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session claims are not valid base64url' }
  }

  let claims
  try {
    claims = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session claims are not valid JSON' }
  }

  if (
    !claims ||
    typeof claims !== 'object' ||
    claims.v !== 1 ||
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    typeof claims.room !== 'string' ||
    claims.room.length === 0 ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp)
  ) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session claims are incomplete' }
  }

  const nowSeconds = Math.floor(now / 1000)
  if (nowSeconds > claims.exp) {
    return { ok: false, code: AUTH_CODES.EXPIRED, reason: 'session token has expired' }
  }
  if (claims.iat > nowSeconds + clockSkewSeconds) {
    return { ok: false, code: AUTH_CODES.NOT_YET_VALID, reason: 'session token is not valid yet' }
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_SESSION_TTL_SECONDS) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'session lifetime is out of bounds' }
  }

  return { ok: true, claims }
}

// Server-side session invalidation.
//
// This is a bounded, node-local revocation list keyed by the token's `jti`. It
// exists so logout (or an operator action) can invalidate a token BEFORE its
// expiry instead of leaving a stolen token usable for the rest of its lifetime.
//
// It also supports revoking every token for one account subject. Logout uses
// that so any room token already issued to the browser (which may still be
// sitting in memory) stops being accepted, not just the account cookie.
//
// Important limitations, stated plainly:
//  - It lives in this process' memory. A multi-instance deployment must share
//    the list (Redis/DB) or revoke at the load balancer; otherwise a token
//    revoked on one instance is still accepted by another.
//  - A restart forgets revocations. Tokens are still bounded by `exp`, so the
//    worst case is the configured TTL, not permanent access.
// Entries are pruned once the token expires anyway, so the list cannot grow
// without bound.
export function createRevocationStore({ now = () => Date.now() } = {}) {
  const revoked = new Map() // jti -> exp (epoch seconds)
  const revokedSubjects = new Map() // subject -> revokedAt (epoch seconds)

  function prune(at = now()) {
    for (const [jti, exp] of revoked) {
      if (!Number.isFinite(exp) || exp * 1000 <= at) revoked.delete(jti)
    }
    const atSeconds = Math.floor(at / 1000)
    for (const [subject, revokedAt] of revokedSubjects) {
      // No token issued before `revokedAt` can still be valid after the longest
      // supported lifetime, so the entry is no longer needed.
      if (atSeconds - revokedAt > MAX_ACCOUNT_TTL_SECONDS) revokedSubjects.delete(subject)
    }
  }

  return {
    revoke(claims) {
      if (!claims || typeof claims.jti !== 'string' || claims.jti.length === 0) return false
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false
      revoked.set(claims.jti, claims.exp)
      prune()
      return true
    },
    isRevoked(jti, at = now()) {
      prune(at)
      return typeof jti === 'string' && jti.length > 0 && revoked.has(jti)
    },
    // Invalidate every token issued to this subject at or before `at` (seconds).
    revokeSubject(subject, at = now()) {
      if (typeof subject !== 'string' || subject.length === 0) return false
      revokedSubjects.set(subject, Math.floor(at / 1000))
      prune(at)
      return true
    },
    isSubjectRevoked(subject, issuedAtSeconds, at = now()) {
      prune(at)
      if (typeof subject !== 'string' || subject.length === 0) return false
      const revokedAt = revokedSubjects.get(subject)
      if (revokedAt === undefined) return false
      if (typeof issuedAtSeconds !== 'number' || !Number.isFinite(issuedAtSeconds)) return true
      return issuedAtSeconds <= revokedAt
    },
    get size() {
      prune()
      return revoked.size
    },
  }
}

// ---------------------------------------------------------------------------
// Account sessions (HttpOnly cookie)
// ---------------------------------------------------------------------------
// A signed token identifying a real account. Unlike the room token, this is
// carried in an HttpOnly cookie, so page JavaScript cannot read it. The account
// is still resolved from the store on every request: a token proves the server
// issued the session, it is not a substitute for an existing account row.
export function issueAccountSession({
  userId,
  name,
  secret,
  ttlSeconds = DEFAULT_ACCOUNT_TTL_SECONDS,
  now = Date.now(),
}) {
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error('Session secret is not configured')
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('Account id is required')
  }

  const issuedAt = Math.floor(now / 1000)
  const ttl = Math.max(
    60,
    Math.min(MAX_ACCOUNT_TTL_SECONDS, Math.floor(Number(ttlSeconds) || DEFAULT_ACCOUNT_TTL_SECONDS)),
  )
  const claims = {
    v: 2,
    typ: ACCOUNT_TOKEN_TYPE,
    sub: userId,
    name: sanitizeDisplayName(name),
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ttl,
  }
  const body = base64url(Buffer.from(JSON.stringify(claims), 'utf8'))
  const signature = base64url(signSessionBody(`${ACCOUNT_TOKEN_VERSION}.${body}`, secret))
  return { token: `${ACCOUNT_TOKEN_VERSION}.${body}.${signature}`, claims }
}

export function verifyAccountSession(
  token,
  secret,
  { now = Date.now(), clockSkewSeconds = CLOCK_SKEW_SECONDS } = {},
) {
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    return { ok: false, code: AUTH_CODES.NOT_CONFIGURED, reason: 'session secret is not configured' }
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: AUTH_CODES.REQUIRED, reason: 'missing account session' }
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session is too large' }
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== ACCOUNT_TOKEN_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session has an unexpected format' }
  }

  const body = `${parts[0]}.${parts[1]}`
  const provided = decodeBase64url(parts[2])
  if (!provided) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session signature is not valid base64url' }
  }
  const expected = signSessionBody(body, secret)
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, code: AUTH_CODES.INVALID_SIGNATURE, reason: 'account session signature is invalid' }
  }

  const payloadBytes = decodeBase64url(parts[1])
  if (!payloadBytes) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session claims are not valid base64url' }
  }

  let claims
  try {
    claims = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session claims are not valid JSON' }
  }

  if (
    !claims ||
    typeof claims !== 'object' ||
    claims.v !== 2 ||
    claims.typ !== ACCOUNT_TOKEN_TYPE ||
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    typeof claims.jti !== 'string' ||
    claims.jti.length === 0 ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp)
  ) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session claims are incomplete' }
  }

  const nowSeconds = Math.floor(now / 1000)
  if (nowSeconds > claims.exp) {
    return { ok: false, code: AUTH_CODES.EXPIRED, reason: 'account session has expired' }
  }
  if (claims.iat > nowSeconds + clockSkewSeconds) {
    return { ok: false, code: AUTH_CODES.NOT_YET_VALID, reason: 'account session is not valid yet' }
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_ACCOUNT_TTL_SECONDS) {
    return { ok: false, code: AUTH_CODES.MALFORMED, reason: 'account session lifetime is out of bounds' }
  }

  return { ok: true, claims }
}

// Constant-time join-code check. Hashing both sides first makes the comparison
// length-independent, so a wrong code cannot be recovered from timing.
export function verifyJoinCode(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

// Resolve authentication settings from the environment. In production this fails
// closed (returns `{ error }` and the caller exits) when the signing secret is
// absent, too short, or when a configured join code is too weak. In development a
// clearly-labelled fallback secret keeps `npm run dev` usable.
export function createAuthConfig(env = process.env) {
  const production = env.NODE_ENV === 'production'
  const warnings = []
  let secret = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET : ''
  let developmentFallback = false

  if (!secret) {
    if (production) {
      return {
        error:
          'SESSION_SECRET is required in production. Generate one with: ' +
          'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
      }
    }
    secret = DEV_SESSION_SECRET
    developmentFallback = true
    warnings.push(
      'SESSION_SECRET is not set; using the built-in development-only secret. ' +
        'Sessions are NOT secure with this value.',
    )
  } else if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    if (production) {
      return {
        error: `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production`,
      }
    }
    warnings.push(
      `SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters; development only.`,
    )
  }

  const joinCode = typeof env.JOIN_CODE === 'string' && env.JOIN_CODE.length > 0 ? env.JOIN_CODE : null
  if (joinCode && joinCode.length < 12) {
    if (production) {
      return { error: 'JOIN_CODE must be at least 12 characters in production' }
    }
    warnings.push('JOIN_CODE is shorter than 12 characters; development only.')
  }

  // Anonymous room-token issuance is a development/conformance-testing escape
  // hatch only. Accounts are the default everywhere, and production refuses to
  // start with the escape hatch enabled — otherwise `/api/auth/session` would
  // hand an office token to anyone who asked, which is exactly the hole the
  // account system exists to close.
  if (production && env.AUTH_ALLOW_ANONYMOUS === 'true') {
    return {
      error:
        'AUTH_ALLOW_ANONYMOUS cannot be enabled in production; office sessions require a signed-in account',
    }
  }
  const allowAnonymous = env.AUTH_ALLOW_ANONYMOUS === 'true'
  if (allowAnonymous) {
    warnings.push(
      'AUTH_ALLOW_ANONYMOUS=true: /api/auth/session issues room tokens without an account. ' +
        'Development and conformance tests only.',
    )
  }

  const requestedTtl = Number(env.SESSION_TTL_SECONDS)
  const ttlSeconds =
    Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(MAX_SESSION_TTL_SECONDS, Math.max(60, Math.floor(requestedTtl)))
      : DEFAULT_SESSION_TTL_SECONDS

  const requestedAccountTtl = Number(env.ACCOUNT_SESSION_TTL_SECONDS)
  const accountTtlSeconds =
    Number.isFinite(requestedAccountTtl) && requestedAccountTtl > 60
      ? Math.min(MAX_ACCOUNT_TTL_SECONDS, Math.floor(requestedAccountTtl))
      : DEFAULT_ACCOUNT_TTL_SECONDS

  return {
    production,
    secret,
    developmentFallback,
    joinCode,
    allowAnonymous,
    ttlSeconds,
    accountTtlSeconds,
    warnings,
    // Room tokens are always issuable for an authenticated account; anonymous
    // issuance needs the explicit escape hatch above.
    canIssueSessions: true,
  }
}
