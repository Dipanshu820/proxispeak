// Account HTTP endpoints: signup, login, logout, current user, preferences.
//
// Security properties enforced here:
//   * Passwords are scrypt-hashed (see passwords.js); plaintext never persists.
//   * Emails are normalized (trim + lowercase) before lookup and storage.
//   * Login answers with one generic INVALID_CREDENTIALS code, and performs a
//     real hash verification for unknown emails, so neither the body nor the
//     response time reveals whether an account exists.
//   * The account session lives in an HttpOnly, SameSite=Lax cookie. It is a
//     signed token, not a client-supplied user id, and the account row is
//     re-read on every request.
//   * State-changing requests are already subject to the strict Origin check in
//     server.js; SameSite=Lax keeps the cookie off cross-site requests, so no
//     separate CSRF token is required for this design.
//   * Signup/login are rate limited per IP (and login per email).
//   * Logout revokes the session id AND every token already issued to the
//     subject, disconnects its live sockets, and clears the cookie.

import express from 'express'
import {
  hashPassword,
  verifyPassword,
  getDummyHash,
  validateEmail,
  validatePassword,
  validateName,
} from './passwords.js'
import { issueAccountSession, verifyAccountSession, AUTH_CODES } from './auth.js'
import { ACCOUNT_COOKIE_NAME, serializeCookie, clearCookie, parseCookies } from './cookies.js'
import { createRateLimiter } from './rateLimit.js'
import { DuplicateEmailError, UserStoreUnavailableError } from './userStore.js'
import { isRoomAllowed, sanitizeRoomId } from './config.js'

const MAX_PREFERENCE_ROOM_LENGTH = 64
const ALLOWED_THEMES = new Set(['dark', 'light'])

function fail(res, status, code, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, ...extra } })
}

// The single HTTP projection of an account. The internal record additionally
// carries `passwordHash` (needed only by the login comparison), which must never
// cross this boundary.
function publicAccount(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarColor: user.avatarColor,
    preferences: user.preferences,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store')
  next()
}

export function createAccountsRouter({
  store,
  secret,
  ttlSeconds,
  secureCookies = false,
  requireHttps = (_req, _res, next) => next(),
  revocation,
  allowedRooms = [],
  onLogout = () => {},
  logger = console,
} = {}) {
  if (!store) throw new Error('createAccountsRouter requires a user store')
  if (!revocation) throw new Error('createAccountsRouter requires a revocation store')

  const router = express.Router()
  router.use(noStore)

  // A legitimate office of 50 people signing in at 9am from one NATed office
  // would share an IP; these limits are generous for that, hostile for guessing.
  // The overrides exist for load tests and large test suites; they only raise a
  // per-process counter, never remove a check.
  const limitFromEnv = (name, fallback) => {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  }
  const ipLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: limitFromEnv('AUTH_SIGNUP_RATE_LIMIT', 60),
  })
  const loginIpLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: limitFromEnv('AUTH_LOGIN_IP_RATE_LIMIT', 30),
  })
  const emailLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: limitFromEnv('AUTH_LOGIN_EMAIL_RATE_LIMIT', 10),
  })

  function cookieOptions() {
    return {
      httpOnly: true,
      secure: Boolean(secureCookies),
      sameSite: 'Lax',
      path: '/',
    }
  }

  function setSessionCookie(res, token, claims) {
    res.set(
      'Set-Cookie',
      serializeCookie(ACCOUNT_COOKIE_NAME, token, {
        ...cookieOptions(),
        maxAgeSeconds: Math.max(1, claims.exp - claims.iat),
      }),
    )
  }

  function clearSessionCookie(res) {
    res.set('Set-Cookie', clearCookie(ACCOUNT_COOKIE_NAME, cookieOptions()))
  }

  // Resolve the account from the cookie. Returns `{ user }` or `{ code }`.
  // Never trusts a user id from the body.
  async function resolveAccount(req) {
    const token = parseCookies(req.get('cookie'))[ACCOUNT_COOKIE_NAME]
    if (!token) return { code: AUTH_CODES.REQUIRED }

    const verification = verifyAccountSession(token, secret)
    if (!verification.ok) return { code: verification.code }
    if (revocation.isRevoked(verification.claims.jti)) return { code: AUTH_CODES.REVOKED }
    if (revocation.isSubjectRevoked(verification.claims.sub, verification.claims.iat)) {
      return { code: AUTH_CODES.REVOKED }
    }

    let user
    try {
      user = await store.findById(verification.claims.sub)
    } catch (error) {
      if (error instanceof UserStoreUnavailableError) return { code: error.code }
      throw error
    }
    if (!user) return { code: AUTH_CODES.REVOKED }
    return { user, claims: verification.claims }
  }

  async function issueFor(res, user) {
    const { token, claims } = issueAccountSession({
      userId: user.id,
      name: user.name,
      secret,
      ttlSeconds,
    })
    setSessionCookie(res, token, claims)
    return claims
  }

  function requireAccount(req, res, next) {
    resolveAccount(req)
      .then((result) => {
        if (!result.user) {
          if (result.code !== AUTH_CODES.REQUIRED) clearSessionCookie(res)
          const status = result.code === 'ACCOUNT_STORE_UNAVAILABLE' ? 503 : 401
          return fail(res, status, result.code || AUTH_CODES.REQUIRED)
        }
        req.account = result.user
        req.accountClaims = result.claims
        next()
      })
      .catch(next)
  }

  // -------------------------------------------------------------------------
  // Signup
  // -------------------------------------------------------------------------
  router.post('/signup', requireHttps, async (req, res) => {
    const attempt = ipLimiter.check(req.ip || 'unknown')
    if (!attempt.allowed) {
      res.set('Retry-After', String(Math.ceil(attempt.retryAfterMs / 1000)))
      return fail(res, 429, 'RATE_LIMITED')
    }

    const body = req.body || {}
    const nameCheck = validateName(body.name)
    if (!nameCheck.ok) return fail(res, 400, nameCheck.code, { field: 'name' })

    const emailCheck = validateEmail(body.email)
    if (!emailCheck.ok) return fail(res, 400, emailCheck.code, { field: 'email' })

    const passwordCheck = validatePassword(body.password)
    if (!passwordCheck.ok) return fail(res, 400, passwordCheck.code, { field: 'password' })

    // The confirmation field is validated for symmetry with the form, but it is
    // never used to derive anything server-side.
    if (typeof body.confirmPassword === 'string' && body.confirmPassword !== body.password) {
      return fail(res, 400, 'PASSWORD_MISMATCH', { field: 'confirmPassword' })
    }

    const passwordHash = await hashPassword(body.password)

    let user
    try {
      user = await store.createUser({
        email: emailCheck.email,
        name: nameCheck.name,
        passwordHash,
      })
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        return fail(res, 409, 'EMAIL_TAKEN', { field: 'email' })
      }
      if (error instanceof UserStoreUnavailableError) {
        logger.error('Account store unavailable during signup:', error.cause?.message || error.message)
        return fail(res, 503, 'ACCOUNT_STORE_UNAVAILABLE')
      }
      throw error
    }

    await issueFor(res, user)
    return res.status(201).json({ ok: true, user: publicAccount(user) })
  })

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------
  router.post('/login', requireHttps, async (req, res) => {
    const ip = req.ip || 'unknown'
    const ipAttempt = loginIpLimiter.check(ip)
    if (!ipAttempt.allowed) {
      res.set('Retry-After', String(Math.ceil(ipAttempt.retryAfterMs / 1000)))
      return fail(res, 429, 'RATE_LIMITED')
    }

    const body = req.body || {}
    const emailCheck = validateEmail(body.email)
    // A malformed email is reported as invalid input; it does not reveal
    // whether some account exists because there is nothing to look up.
    if (!emailCheck.ok) return fail(res, 400, emailCheck.code, { field: 'email' })
    if (typeof body.password !== 'string' || body.password.length === 0) {
      return fail(res, 400, 'PASSWORD_REQUIRED', { field: 'password' })
    }

    const emailAttempt = emailLimiter.check(emailCheck.email)
    if (!emailAttempt.allowed) {
      res.set('Retry-After', String(Math.ceil(emailAttempt.retryAfterMs / 1000)))
      return fail(res, 429, 'RATE_LIMITED')
    }

    let user = null
    let storeError = null
    try {
      user = await store.findByEmail(emailCheck.email)
    } catch (error) {
      if (error instanceof UserStoreUnavailableError) storeError = error
      else throw error
    }
    if (storeError) {
      logger.error('Account store unavailable during login:', storeError.cause?.message || storeError.message)
      return fail(res, 503, 'ACCOUNT_STORE_UNAVAILABLE')
    }

    const storedHash = user?.passwordHash || (await getDummyHash())
    const matches = await verifyPassword(body.password, storedHash)

    if (!user || !user.passwordHash || !matches) {
      return fail(res, 401, 'INVALID_CREDENTIALS')
    }

    await store.recordLogin(user.id)
    // Never return the hash, even indirectly: `publicUser` does not include it.
    await issueFor(res, user)
    emailLimiter.reset(emailCheck.email)
    return res.json({ ok: true, user: publicAccount(user) })
  })

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------
  router.post('/logout', requireHttps, async (req, res) => {
    const token = parseCookies(req.get('cookie'))[ACCOUNT_COOKIE_NAME]
    const verification = verifyAccountSession(token, secret)

    if (verification.ok) {
      revocation.revoke(verification.claims)
      revocation.revokeSubject(verification.claims.sub)
      try {
        onLogout(verification.claims.sub)
      } catch {
        // A socket-layer failure must not prevent the cookie from clearing.
      }
    }
    clearSessionCookie(res)

    // Even with an expired/invalid cookie, clearing it makes the browser state
    // consistent; the response is deliberately identical either way.
    return res.json({ ok: true, loggedOut: true })
  })

  // -------------------------------------------------------------------------
  // Current account
  // -------------------------------------------------------------------------
  router.get('/me', requireHttps, requireAccount, (req, res) => {
    res.json({ ok: true, user: publicAccount(req.account) })
  })

  // -------------------------------------------------------------------------
  // Preferences / display name
  // -------------------------------------------------------------------------
  router.patch('/me', requireHttps, requireAccount, async (req, res) => {
    const body = req.body || {}
    const changes = {}

    if (body.name !== undefined) {
      const nameCheck = validateName(body.name)
      if (!nameCheck.ok) return fail(res, 400, nameCheck.code, { field: 'name' })
      changes.name = nameCheck.name
    }

    if (body.preferences !== undefined) {
      if (!body.preferences || typeof body.preferences !== 'object' || Array.isArray(body.preferences)) {
        return fail(res, 400, 'INVALID_PREFERENCES', { field: 'preferences' })
      }
      const preferences = {}
      const { theme, defaultRoom, mutedByDefault } = body.preferences
      if (theme !== undefined) {
        if (!ALLOWED_THEMES.has(theme)) return fail(res, 400, 'INVALID_THEME', { field: 'preferences.theme' })
        preferences.theme = theme
      }
      if (defaultRoom !== undefined) {
        const room = sanitizeRoomId(defaultRoom)
        if (!room || room.length > MAX_PREFERENCE_ROOM_LENGTH || !isRoomAllowed(room, allowedRooms)) {
          return fail(res, 400, 'INVALID_ROOM', { field: 'preferences.defaultRoom' })
        }
        preferences.defaultRoom = room
      }
      if (mutedByDefault !== undefined) {
        if (typeof mutedByDefault !== 'boolean') {
          return fail(res, 400, 'INVALID_PREFERENCES', { field: 'preferences.mutedByDefault' })
        }
        preferences.mutedByDefault = mutedByDefault
      }
      changes.preferences = preferences
    }

    if (Object.keys(changes).length === 0) {
      return fail(res, 400, 'NOTHING_TO_UPDATE')
    }

    let user
    try {
      user = await store.updateUser(req.account.id, changes)
    } catch (error) {
      if (error instanceof UserStoreUnavailableError) {
        logger.error('Account store unavailable during profile update:', error.cause?.message || error.message)
        return fail(res, 503, 'ACCOUNT_STORE_UNAVAILABLE')
      }
      throw error
    }
    if (!user) return fail(res, 404, 'ACCOUNT_NOT_FOUND')
    return res.json({ ok: true, user: publicAccount(user) })
  })

  return router
}

// Room-token issuance reads the account directly from the cookie. Kept here so
// the account logic (revocation, store errors) stays in one place.
export async function resolveAccountFromCookie({ cookieHeader, secret, store, revocation }) {
  const token = parseCookies(cookieHeader)[ACCOUNT_COOKIE_NAME]
  if (!token) return { code: AUTH_CODES.REQUIRED }
  const verification = verifyAccountSession(token, secret)
  if (!verification.ok) return { code: verification.code }
  if (revocation.isRevoked(verification.claims.jti)) return { code: AUTH_CODES.REVOKED }
  if (revocation.isSubjectRevoked(verification.claims.sub, verification.claims.iat)) {
    return { code: AUTH_CODES.REVOKED }
  }

  let user
  try {
    user = await store.findById(verification.claims.sub)
  } catch (error) {
    if (error instanceof UserStoreUnavailableError) return { code: error.code }
    throw error
  }
  if (!user) return { code: AUTH_CODES.REVOKED }
  return { user, claims: verification.claims }
}

export { ACCOUNT_COOKIE_NAME }
