// Startup configuration validation.
//
// Kept in its own module (no server imports, no side effects) so the production
// guards can be unit tested without booting Express/Socket.io.

export const DEFAULT_CLIENT_ORIGIN = 'http://localhost:5173'

// Validate CLIENT_ORIGIN for production. In development the default is correct
// (the Vite dev server runs on 5173), but in production a left-at-default origin
// would either reject the real frontend or, worse, be widened later by mistake.
// A wildcard or a malformed value is just as unsafe: `*` would let any site open
// a socket and send position/speaking/signaling messages as that user.
//
// Returns a human-readable reason when the value is unacceptable, or null when it
// is fine.
export const MAX_DISPLAY_NAME_LENGTH = 40
export const MAX_ROOM_ID_LENGTH = 64

// Room ids are used as Socket.io room names and as a claim inside a session
// token, so they are restricted to a conservative, log-safe character set. This
// does not provide authorization by itself (the token does), but it stops a
// client from requesting a room whose id contains separators or control text.
export function sanitizeRoomId(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_ROOM_ID_LENGTH) return null
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null
  return trimmed
}

// Optional room allowlist. `ALLOWED_ROOMS="design-team,ops"` makes office:join
// reject any other room id. An empty list keeps the historical behaviour (any
// room id is joinable), which is why this is a deployment control and not an
// authentication mechanism: it stops a client from inventing room ids, but it
// does not prove who the client is.
export function parseAllowedRooms(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(room => room.trim())
    .filter(Boolean)
}

export function isRoomAllowed(roomId, allowedRooms) {
  if (!Array.isArray(allowedRooms) || allowedRooms.length === 0) return true
  return typeof roomId === 'string' && allowedRooms.includes(roomId)
}

// The display name is client-supplied text, never proof of identity. The server
// still normalizes it so a client cannot inject control characters, unbounded
// length, or blank/whitespace-only names into presence broadcasts and other
// participants' UIs. Identity itself stays bound to the server-assigned socket id.
export function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') return 'Guest'
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
  return cleaned.length > 0 ? cleaned : 'Guest'
}

// A deployment can legitimately serve more than one frontend origin (for
// example an apex domain and a www host, or the dev server plus the preview
// server used by the browser tests). CLIENT_ORIGIN accepts a comma-separated
// list; a single value keeps working exactly as before.
// Trusted reverse-proxy configuration.
//
// Express' `trust proxy` setting is how `req.ip` and `req.secure` learn about
// X-Forwarded-* headers. Turning it on unconditionally would let any client forge
// `X-Forwarded-For` (spoofing the per-IP auth rate limit) or `X-Forwarded-Proto`
// (pretending a plaintext request was HTTPS). It therefore defaults to OFF and,
// when enabled, accepts only an explicit hop count — never `true`, never a
// wildcard, never a hostname list that could be satisfied by a header.
export const MAX_TRUST_PROXY_HOPS = 3

export function parseTrustProxyHops(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'false' || raw === '0') {
    return { hops: 0, error: null }
  }
  if (!/^[0-9]+$/.test(String(raw).trim())) {
    return { hops: 0, error: 'TRUST_PROXY must be an integer hop count (0-3), not a host or wildcard' }
  }
  const hops = Number(raw)
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_TRUST_PROXY_HOPS) {
    return { hops: 0, error: `TRUST_PROXY must be between 0 and ${MAX_TRUST_PROXY_HOPS} hops` }
  }
  return { hops, error: null }
}

// Exact-match origin check used for state-changing HTTP requests. CORS decides
// whether a browser may READ a response; it does not stop a cross-site request
// from being SENT and processed. This check does, which is why it is applied to
// POST/PUT/PATCH/DELETE in addition to CORS.
export function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  return Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)
}

// Development-only convenience: the Vite dev server (5173), `vite preview`
// (4173) and the browser test suites are all loopback origins on different
// ports. Requiring every port to be listed would make `npm run preview` fail
// closed against the backend's default CLIENT_ORIGIN. Only loopback http origins
// are accepted, and only when NODE_ENV is not production, so this cannot widen a
// deployed deployment.
export function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:') return false
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return false
  return parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
}

export function parseClientOrigins(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

export function validateClientOrigins(raw, env = process.env.NODE_ENV) {
  if (env !== 'production') return null
  const origins = parseClientOrigins(raw)
  if (origins.length === 0) return 'CLIENT_ORIGIN is not configured for production'
  if (origins.length > 8) return 'CLIENT_ORIGIN lists more than 8 origins'
  for (const origin of origins) {
    const error = validateClientOrigin(origin, env)
    if (error) return error
  }
  return null
}

export function validateClientOrigin(origin, env = process.env.NODE_ENV) {
  if (env !== 'production') return null
  if (!origin || origin === DEFAULT_CLIENT_ORIGIN) {
    return 'CLIENT_ORIGIN is not configured for production'
  }
  if (origin.trim() === '*' || origin.includes('*')) {
    return 'CLIENT_ORIGIN must not contain a wildcard'
  }
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return 'CLIENT_ORIGIN is not a valid absolute URL'
  }
  if (parsed.protocol !== 'https:') {
    if (env === 'production' && process.env.PROXISPEAK_ALLOW_HTTP_ORIGIN !== 'true') {
      return 'CLIENT_ORIGIN must use https: in production (set PROXISPEAK_ALLOW_HTTP_ORIGIN=true only for explicitly trusted internal/http pilots)'
    }
    // For non-production and explicitly opted-in environments, http: remains usable.
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return 'CLIENT_ORIGIN must be a bare origin (no path, query, or fragment)'
  }
  return null
}
