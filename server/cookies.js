// Cookie parsing/serialization for the account session.
//
// Only the attributes this application needs are supported. The cookie value is
// a signed token (see auth.js); it is never a bare user id, so a client cannot
// forge one by editing the cookie.

export const ACCOUNT_COOKIE_NAME = 'ps_account'

export function parseCookies(header) {
  const result = Object.create(null)
  if (typeof header !== 'string' || header.length === 0) return result

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    if (!name || result[name] !== undefined) continue // first wins, per RFC 6265
    let value = part.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }
    try {
      result[name] = decodeURIComponent(value)
    } catch {
      result[name] = value
    }
  }
  return result
}

export function serializeCookie(name, value, options = {}) {
  const {
    maxAgeSeconds,
    expires,
    path = '/',
    httpOnly = true,
    secure = false,
    sameSite = 'Lax',
  } = options

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`]
  if (typeof maxAgeSeconds === 'number' && Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`)
  }
  if (expires instanceof Date) parts.push(`Expires=${expires.toUTCString()}`)
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (sameSite) parts.push(`SameSite=${sameSite}`)
  return parts.join('; ')
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 })
}

// Socket.io handshakes from a browser carry the cookie header, so the same
// account session can authenticate the socket without exposing a token to
// JavaScript. (The office socket additionally presents its room-scoped token;
// this helper is used by the HTTP routes.)
export function cookieHeaderFromRequest(req) {
  return parseCookies(req.get?.('cookie'))
}
