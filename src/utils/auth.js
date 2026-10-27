// Client-side session bootstrap for ProxiSpeak.
//
// The browser never invents an identity. It asks the backend for a signed,
// expiring session token bound to one office room, then presents that token in
// the Socket.io handshake. The token lives in memory only (never localStorage), so
// an XSS payload cannot lift it out of persistent storage.
//
// API_BASE is empty by default, which means "same origin": the Vite dev/preview
// server proxies /api to the backend, and a production deployment is expected to
// serve the frontend and API from one origin. Set VITE_API_URL at build time only
// when they genuinely live on different hosts (and then CLIENT_ORIGIN/CORS must
// match).

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

// Optional header for closed deployments. Bundled only when a build explicitly
// sets VITE_JOIN_CODE; prefer a real identity provider for anything public.
const JOIN_CODE = import.meta.env.VITE_JOIN_CODE || ''

let session = null

export class AuthError extends Error {
  constructor(code, status = 0) {
    super(`Authentication failed: ${code}`)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

export function getSession() {
  return session
}

export function getSessionToken() {
  return session?.token || null
}

export function setSessionToken(token, extra = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    session = null
    return null
  }
  session = { token, ...extra }
  return session
}

export function clearSession() {
  session = null
}

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function makeSignal(timeoutMs) {
  if (typeof AbortController === 'undefined') return { signal: undefined, cancel: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

// Obtain a signed session for `roomId`. Never logs or echoes the token.
export async function requestSession({
  roomId,
  name = 'Guest',
  joinCode = JOIN_CODE,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new AuthError('AUTH_UNAVAILABLE')
  }

  const { signal, cancel } = makeSignal(timeoutMs)
  try {
    const response = await fetchImpl(apiUrl('/api/auth/session'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(joinCode ? { 'x-proxispeak-join-code': joinCode } : {}),
      },
      body: JSON.stringify({ roomId, name }),
      // The room token is issued to a signed-in account. The HttpOnly account
      // cookie travels with this same-origin request; it is never read by JS.
      credentials: 'include',
      signal,
    })

    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.token) {
      throw new AuthError(body?.error?.code || `HTTP_${response.status}`, response.status)
    }

    session = {
      token: body.token,
      expiresAt: body.expiresAt,
      roomId: body.roomId,
      name: body.name,
    }
    return session
  } catch (error) {
    if (error instanceof AuthError) throw error
    if (error?.name === 'AbortError') throw new AuthError('AUTH_TIMEOUT')
    throw new AuthError('AUTH_UNAVAILABLE')
  } finally {
    cancel()
  }
}

// Fetch ICE servers (STUN + optional short-lived TURN credentials) for this
// session. Returns null on any failure; callers keep the built-in STUN defaults,
// which are not a security downgrade, only a connectivity one.
// ---------------------------------------------------------------------------
// Account API
// ---------------------------------------------------------------------------
// All account calls use the HttpOnly session cookie (`credentials: 'include'`).
// No account token is stored in JavaScript, localStorage, or sessionStorage.
export class ApiError extends Error {
  constructor(code, status = 0) {
    super(`Request failed: ${code}`)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

async function apiRequest(path, { method = 'GET', body, timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new ApiError('AUTH_UNAVAILABLE')
  const { signal, cancel } = makeSignal(timeoutMs)

  try {
    const response = await fetchImpl(apiUrl(path), {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) {
      throw new ApiError(payload?.error?.code || `HTTP_${response.status}`, response.status)
    }
    return payload
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error?.name === 'AbortError') throw new ApiError('REQUEST_TIMEOUT')
    throw new ApiError('NETWORK_ERROR')
  } finally {
    cancel()
  }
}

export function signupAccount({ name, email, password, confirmPassword }) {
  return apiRequest('/api/auth/signup', {
    method: 'POST',
    body: { name, email, password, confirmPassword },
  })
}

export function loginAccount({ email, password }) {
  return apiRequest('/api/auth/login', { method: 'POST', body: { email, password } })
}

export function logoutAccount() {
  return apiRequest('/api/auth/logout', { method: 'POST' })
}

// Resolve the current account from the cookie. Returns null for an anonymous
// visitor instead of throwing, because that is an expected state on the landing
// and login pages.
export async function getCurrentAccount({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const payload = await apiRequest('/api/auth/me', { fetchImpl })
    return payload?.user || null
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null
    if (error instanceof ApiError && error.code === 'NETWORK_ERROR') return null
    throw error
  }
}

export function updateAccount({ name, preferences }) {
  const body = {}
  if (name !== undefined) body.name = name
  if (preferences !== undefined) body.preferences = preferences
  return apiRequest('/api/auth/me', { method: 'PATCH', body })
}

export async function fetchIceServers({
  token = session?.token,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!token || typeof fetchImpl !== 'function') return null

  const { signal, cancel } = makeSignal(timeoutMs)
  try {
    const response = await fetchImpl(apiUrl('/api/ice'), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      credentials: 'include',
      signal,
    })
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    if (!body?.ok || !Array.isArray(body.iceServers) || body.iceServers.length === 0) return null
    return {
      iceServers: body.iceServers,
      turnEnabled: Boolean(body.turnEnabled),
      iceTransportPolicy: body.iceTransportPolicy === 'relay' ? 'relay' : 'all',
    }
  } catch {
    return null
  } finally {
    cancel()
  }
}
