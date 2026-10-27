import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import {
  connect as connectDb,
  disconnect as disconnectDb,
  getDb,
  isConnected as dbConnected,
  ping as pingDb,
  redactMongoUri,
} from './db.js'
import { createAccountsRouter, resolveAccountFromCookie } from './accounts.js'
import { createFileUserStore, createMongoUserStore } from './userStore.js'
import { ACCOUNT_COOKIE_NAME } from './cookies.js'
import { initWebRTCSignaling } from './webrtc.js'
import {
  DEFAULT_CLIENT_ORIGIN,
  parseClientOrigins,
  validateClientOrigins,
  parseAllowedRooms,
  isRoomAllowed,
  sanitizeDisplayName,
  sanitizeRoomId,
  parseTrustProxyHops,
  isOriginAllowed,
  isLoopbackOrigin,
} from './config.js'
import {
  createAuthConfig,
  issueSession,
  verifySessionToken,
  verifyJoinCode,
  createRevocationStore,
  AUTH_CODES,
} from './auth.js'
import { buildIceConfiguration } from './ice.js'

const PORT = Number(process.env.PORT) || 4000
const NODE_ENV = process.env.NODE_ENV || 'development'
const PRODUCTION = NODE_ENV === 'production'

// CLIENT_ORIGIN accepts a comma-separated list so a deployment can serve an apex
// and a www host (or the dev server plus the browser-test preview server) without
// widening CORS to `*`.
const CLIENT_ORIGIN_RAW = process.env.CLIENT_ORIGIN || DEFAULT_CLIENT_ORIGIN
const CLIENT_ORIGINS = parseClientOrigins(CLIENT_ORIGIN_RAW)
const originError = validateClientOrigins(CLIENT_ORIGIN_RAW, NODE_ENV)
if (originError) {
  console.error(
    `FATAL: ${originError}. ` +
      'Set CLIENT_ORIGIN to your frontend URL (e.g. https://proxispeak.example.com).'
  )
  process.exit(1)
}

// Authentication settings. Production fails closed here: no signing secret means
// no server, rather than an implicitly unsigned/dev-keyed deployment.
const authConfig = createAuthConfig(process.env)
if (authConfig.error) {
  console.error(`FATAL: ${authConfig.error}`)
  process.exit(1)
}
for (const warning of authConfig.warnings) {
  console.warn(`WARNING: ${warning}`)
}
if (PRODUCTION && authConfig.joinCode && authConfig.developmentFallback) {
  console.warn('WARNING: a join code is configured but the session secret is the development fallback.')
}

// ICE configuration is validated once at startup. A TURN misconfiguration in
// production is fatal instead of silently degrading every call to STUN-only.
const iceValidationError = buildIceConfiguration(process.env).error
if (iceValidationError) {
  if (PRODUCTION) {
    console.error(`FATAL: ${iceValidationError}`)
    process.exit(1)
  }
  console.warn(`WARNING: ${iceValidationError}`)
}

// Reverse-proxy trust. X-Forwarded-For / X-Forwarded-Proto are attacker-
// controlled unless a specific number of proxy hops is declared, so this is off
// by default and rejected outright if it is not a hop count. A production
// misconfiguration is fatal: guessing here would either spoof client IPs (and
// the auth rate limit) or pretend plaintext requests were HTTPS.
const trustProxy = parseTrustProxyHops(process.env.TRUST_PROXY)
if (trustProxy.error) {
  console.error(`FATAL: ${trustProxy.error}`)
  process.exit(1)
}

// HTTPS enforcement. TLS is normally terminated by the reverse proxy; in that
// deployment set TRUST_PROXY=1 so `req.secure` reflects X-Forwarded-Proto from
// exactly that hop. The escape hatch is the same explicit opt-in used for an
// isolated http-only pilot, never a silent default.
const ALLOW_HTTP = process.env.PROXISPEAK_ALLOW_HTTP_ORIGIN === 'true'
const REQUIRE_HTTPS =
  PRODUCTION && !ALLOW_HTTP && process.env.REQUIRE_HTTPS !== 'false'

const MONGODB_URI = process.env.MONGODB_URI
const ALLOWED_ROOMS = parseAllowedRooms(process.env.ALLOWED_ROOMS)
const HEALTH_TOKEN = process.env.HEALTH_TOKEN || null

// Session invalidation list (see auth.js for its scope and limitations).
const revokedSessions = createRevocationStore()

// ---------------------------------------------------------------------------
// Account persistence
// ---------------------------------------------------------------------------
// MongoDB when configured, otherwise an atomic JSON file. Both persist real
// accounts with hashed passwords; the file store is explicitly single-instance
// and development-oriented, so production refuses to use it unless an operator
// opts in for a known single-instance pilot.
const ACCOUNT_STORE_KIND =
  process.env.ACCOUNT_STORE === 'mongodb' || process.env.ACCOUNT_STORE === 'file'
    ? process.env.ACCOUNT_STORE
    : MONGODB_URI
      ? 'mongodb'
      : 'file'
const ACCOUNT_STORE_FILE =
  process.env.USER_STORE_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '.data', 'users.json')

if (PRODUCTION && ACCOUNT_STORE_KIND === 'file' && process.env.PROXISPEAK_ALLOW_FILE_ACCOUNT_STORE !== 'true') {
  console.error(
    'FATAL: accounts require MongoDB in production. Set MONGODB_URI, or start with ' +
      'PROXISPEAK_ALLOW_FILE_ACCOUNT_STORE=true only for a known single-instance pilot.',
  )
  process.exit(1)
}

const userStore =
  ACCOUNT_STORE_KIND === 'mongodb'
    ? createMongoUserStore({ getDb, isConnected: dbConnected })
    : createFileUserStore({ filePath: ACCOUNT_STORE_FILE })

userStore
  .init()
  .catch((error) => {
    console.error('WARNING: account store initialization failed:', error?.message || error)
  })
console.log(`Account store: ${userStore.describe()}`)

const app = express()
app.disable('x-powered-by')
if (trustProxy.hops > 0) app.set('trust proxy', trustProxy.hops)

// Conservative response headers that do not depend on the reverse proxy.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('X-Frame-Options', 'DENY')
  if (PRODUCTION) {
    // Only meaningful over TLS; browsers ignore it on plaintext responses.
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

// Credentials are enabled because the account session is an HttpOnly cookie. The
// origin allowlist (never `*`) is what stops an arbitrary site from reading
// responses; the strict Origin check below additionally stops it from causing
// state changes.
app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }))
app.use(express.json({ limit: '16kb' }))

// Strict Origin validation for state-changing requests. A browser always sends
// Origin on POST/PUT/PATCH/DELETE, so a request that carries an Origin the
// deployment does not serve is cross-site and is rejected before routing. Non-
// browser callers (curl, the load test, server-to-server) send no Origin and are
// unaffected; they were never CSRF-able in the first place.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
  const origin = req.get('origin')
  const allowed = isOriginAllowed(origin, CLIENT_ORIGINS)
    || (!PRODUCTION && isLoopbackOrigin(origin))
  if (origin && !allowed) {
    return res.status(403).json({ ok: false, error: { code: 'ORIGIN_FORBIDDEN' } })
  }
  next()
})

// Token-bearing endpoints must not be reachable over plaintext in production.
// `req.secure` is only trustworthy when TRUST_PROXY describes the real proxy
// hop; without it this check fails closed, which is the safe direction.
function requireHttps(req, res, next) {
  if (!REQUIRE_HTTPS || req.secure) return next()
  res.set('Cache-Control', 'no-store')
  return res.status(403).json({ ok: false, error: { code: 'HTTPS_REQUIRED' } })
}

function bearerToken(req) {
  const header = req.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a, 'utf8').digest(),
    crypto.createHash('sha256').update(b, 'utf8').digest(),
  )
}

// ---------------------------------------------------------------------------
// Accounts: signup, login, logout, current user, preferences
// ---------------------------------------------------------------------------
// Mounted before the office-token routes so `/api/auth/*` is handled in one
// place. The router is stateless apart from the shared stores.
const accountsRouter = createAccountsRouter({
  store: userStore,
  secret: authConfig.secret,
  ttlSeconds: authConfig.accountTtlSeconds,
  // Secure cookies only where the browser is actually talking TLS. In
  // production the token endpoints already require HTTPS (below); a plain-http
  // pilot that explicitly opted in must not set a Secure cookie it could never
  // read back.
  secureCookies: PRODUCTION && !ALLOW_HTTP,
  requireHttps,
  revocation: revokedSessions,
  allowedRooms: ALLOWED_ROOMS,
  // Assigned once the Socket.io server exists (below).
  onLogout: (userId) => disconnectSocketsForSubject(userId),
})
app.use('/api/auth', accountsRouter)

// A logout must also end live office sockets for that account. The socket layer
// is created further below; this indirection keeps the router independent of it.
let disconnectSocketsForSubject = () => {}

// MongoDB availability watchdog.
//
// The database is optional: presence and signaling work without it. What this
// watchdog guarantees is that `mongodb` status in /api/health reflects reality
// (a dead server is detected by ping, not assumed from a stale client handle) and
// that the server reconnects on its own once MongoDB comes back.
let mongoStatus = MONGODB_URI ? 'connecting' : 'disabled'
let mongoLastErrorAt = 0
let mongoBusy = false
const MONGO_WATCHDOG_MS = Math.max(1000, Number(process.env.MONGODB_WATCHDOG_MS) || 5000)

async function monitorMongo() {
  if (!MONGODB_URI || mongoBusy) return
  mongoBusy = true
  try {
    if (await pingDb()) {
      if (mongoStatus !== 'connected') console.log('MongoDB connected')
      mongoStatus = 'connected'
      return
    }
    await disconnectDb().catch(() => {})
    await connectDb(MONGODB_URI)
    mongoStatus = 'connected'
    mongoLastErrorAt = 0
    console.log('MongoDB connected')
  } catch (error) {
    mongoStatus = 'error'
    // Log at most once per 30 s so an unreachable database cannot flood the log.
    const now = Date.now()
    if (now - mongoLastErrorAt > 30_000) {
      mongoLastErrorAt = now
      console.error(
        'MongoDB unavailable; continuing without persistence:',
        redactMongoUri(error?.message || 'unknown error'),
      )
    }
  } finally {
    mongoBusy = false
  }
}

const mongoWatchdog = MONGODB_URI
  ? setInterval(monitorMongo, MONGO_WATCHDOG_MS)
  : null
if (mongoWatchdog) mongoWatchdog.unref()

// Per-IP limiter for session issuance. A join code is a low-entropy secret, so
// guessing it must be slow without locking out a legitimate office load test.
const authAttempts = new Map() // ip -> { count, windowStart }
const AUTH_WINDOW_MS = 60_000
const AUTH_MAX_ATTEMPTS = 240

function allowAuthAttempt(ip) {
  const now = Date.now()
  const entry = authAttempts.get(ip)
  if (!entry || now - entry.windowStart > AUTH_WINDOW_MS) {
    authAttempts.set(ip, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= AUTH_MAX_ATTEMPTS) return false
  entry.count += 1
  return true
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of authAttempts) {
    if (now - entry.windowStart > AUTH_WINDOW_MS) authAttempts.delete(ip)
  }
}, AUTH_WINDOW_MS).unref()

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

// Health check. In production only the aggregate status is exposed, optionally
// gated by HEALTH_TOKEN. The `port`/memory fields are development diagnostics.
app.get('/api/health', async (req, res) => {
  if (HEALTH_TOKEN && !safeEqual(bearerToken(req), HEALTH_TOKEN)) {
    return res.status(401).json({ ok: false })
  }

  const mongodb = MONGODB_URI ? ((await pingDb()) ? 'connected' : 'error') : 'disabled'
  if (mongodb === 'connected') mongoStatus = 'connected'
  if (mongodb === 'error') mongoStatus = 'error'

  const health = {
    ok: mongodb !== 'error',
    service: 'proxispeak-server',
    mongodb,
  }
  if (MONGODB_URI) health.mongodbStatus = mongoStatus
  if (!PRODUCTION) {
    health.port = PORT
    const memory = process.memoryUsage()
    health.memory = {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
    }
    const cpu = process.cpuUsage()
    health.cpu = { userMicros: cpu.user, systemMicros: cpu.system }
    health.auth = {
      developmentFallbackSecret: authConfig.developmentFallback,
      anonymousSessions: authConfig.allowAnonymous,
      joinCodeRequired: Boolean(authConfig.joinCode),
      accountStore: userStore.kind,
      accountsRequired: !authConfig.allowAnonymous,
    }
  }
  res.json(health)
})

// Issue a signed, expiring room token bound to one office and one account.
//
// This is the second authentication layer: the HttpOnly account cookie proves
// who the human is, and the returned token is handed to Socket.io for the
// office. The subject and display name come from the stored account, never from
// the request body. (Anonymous issuance exists only behind the explicit
// development/test escape hatch and is refused in production.)
app.post('/api/auth/session', requireHttps, async (req, res) => {
  res.set('Cache-Control', 'no-store')

  if (!allowAuthAttempt(req.ip || 'unknown')) {
    return res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED' } })
  }

  const roomId = sanitizeRoomId(req.body?.roomId)
  if (!roomId) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_ROOM' } })
  }
  if (!isRoomAllowed(roomId, ALLOWED_ROOMS)) {
    return res.status(403).json({ ok: false, error: { code: 'ROOM_FORBIDDEN' } })
  }
  if (authConfig.joinCode && !verifyJoinCode(req.get('x-proxispeak-join-code'), authConfig.joinCode)) {
    return res.status(401).json({ ok: false, error: { code: 'INVALID_JOIN_CODE' } })
  }

  let account = null
  if (!authConfig.allowAnonymous) {
    let resolved
    try {
      resolved = await resolveAccountFromCookie({
        cookieHeader: req.get('cookie'),
        secret: authConfig.secret,
        store: userStore,
        revocation: revokedSessions,
      })
    } catch (error) {
      console.error('Account lookup failed:', error?.message || error)
      return res.status(503).json({ ok: false, error: { code: 'ACCOUNT_STORE_UNAVAILABLE' } })
    }
    if (!resolved.user) {
      const status = resolved.code === 'ACCOUNT_STORE_UNAVAILABLE' ? 503 : 401
      return res.status(status).json({
        ok: false,
        error: { code: resolved.code || AUTH_CODES.REQUIRED },
      })
    }
    account = resolved.user
  }

  const { token, claims } = issueSession({
    subject: account ? account.id : crypto.randomUUID(),
    name: account ? account.name : sanitizeDisplayName(req.body?.name),
    room: roomId,
    secret: authConfig.secret,
    ttlSeconds: authConfig.ttlSeconds,
  })

  res.json({
    ok: true,
    token,
    expiresAt: claims.exp * 1000,
    roomId: claims.room,
    name: claims.name,
    // Never the account id: the socket derives identity from the verified token.
  })
})

// Revoke the presented session token and disconnect every live socket that is
// using it. This is immediate revocation for this server process: the token is
// added to the in-memory list (checked at the socket handshake and by /api/ice)
// and matching sockets are closed. Multi-instance deployments must share the
// list; see createRevocationStore.
app.post('/api/auth/revoke', requireHttps, (req, res) => {
  res.set('Cache-Control', 'no-store')
  const verification = verifySessionToken(bearerToken(req), authConfig.secret)
  if (!verification.ok) {
    return res.status(401).json({ ok: false, error: { code: verification.code } })
  }

  revokedSessions.revoke(verification.claims)

  let disconnected = 0
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.session?.jti === verification.claims.jti) {
      socket.emit('error', { code: AUTH_CODES.REVOKED })
      socket.disconnect(true)
      disconnected += 1
    }
  }

  res.json({ ok: true, revoked: true, disconnected })
})

// ICE servers (STUN + optional TURN with short-lived credentials) for an
// authenticated session. Keeping this behind the bearer token means TURN
// credentials are not baked into the public JavaScript bundle.
app.get('/api/ice', requireHttps, (req, res) => {
  res.set('Cache-Control', 'no-store')
  const verification = verifySessionToken(bearerToken(req), authConfig.secret)
  if (!verification.ok) {
    return res.status(401).json({ ok: false, error: { code: verification.code } })
  }
  if (
    revokedSessions.isRevoked(verification.claims.jti) ||
    revokedSessions.isSubjectRevoked(verification.claims.sub, verification.claims.iat)
  ) {
    return res.status(401).json({ ok: false, error: { code: AUTH_CODES.REVOKED } })
  }
  const ice = buildIceConfiguration(process.env, { subject: verification.claims.sub })
  if (ice.error) {
    console.error('ICE configuration unavailable:', ice.error)
    return res.status(503).json({ ok: false, error: { code: 'ICE_NOT_CONFIGURED' } })
  }
  res.json({
    ok: true,
    iceServers: ice.iceServers,
    turnEnabled: ice.turnEnabled,
    // 'relay' only appears when the deployment deliberately configured a
    // relay-only verification run; the client applies it verbatim.
    iceTransportPolicy: ice.iceTransportPolicy || 'all',
  })
})

// 404 fallback
app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }))

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  maxHttpBufferSize: 256 * 1024,
})

// Logout ends every live office socket owned by that account, so a revoked
// account cannot keep signaling with a token it already obtained.
disconnectSocketsForSubject = (subject) => {
  let disconnected = 0
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.session?.subject === subject) {
      socket.emit('error', { code: AUTH_CODES.REVOKED })
      socket.disconnect(true)
      disconnected += 1
    }
  }
  return disconnected
}

// Every socket must present a valid, unexpired session token in the handshake.
// Rejected sockets never reach any room, presence, movement, or signaling handler.
io.use((socket, next) => {
  const verification = verifySessionToken(socket.handshake?.auth?.token, authConfig.secret)
  if (!verification.ok) {
    const error = new Error('Session rejected')
    error.data = { code: verification.code }
    return next(error)
  }
  if (
    revokedSessions.isRevoked(verification.claims.jti) ||
    revokedSessions.isSubjectRevoked(verification.claims.sub, verification.claims.iat)
  ) {
    const error = new Error('Session rejected')
    error.data = { code: AUTH_CODES.REVOKED }
    return next(error)
  }
  socket.data.session = {
    subject: verification.claims.sub,
    name: verification.claims.name,
    room: verification.claims.room,
    jti: verification.claims.jti,
    exp: verification.claims.exp,
  }
  socket.data.roomId = null
  socket.data.user = null
  next()
})

// Initialize WebRTC signaling (all handlers additionally require a session and a
// shared room; see server/webrtc.js).
initWebRTCSignaling(io)

// Presence tracking for cleanup on disconnect
const rooms = new Map() // roomId -> Map<socketId, userData>

// One live socket per session subject. If a token is replayed from a second
// client, the older socket is evicted so two connections can never act as the
// same participant at the same time. Normal reconnects are unaffected: the server
// removes the entry on disconnect before the client reconnects.
const sessionSockets = new Map() // subject -> socketId

function trackJoin(roomId, socketId, userData) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map())
  const room = rooms.get(roomId)
  room.set(socketId, userData)
  return room
}

function trackLeave(roomId, socketId) {
  const room = rooms.get(roomId)
  if (room) {
    room.delete(socketId)
    if (room.size === 0) rooms.delete(roomId)
  }
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId)
  if (!room) return []
  return Array.from(room.entries()).map(([id, data]) => ({ ...data, id }))
}

// Validation helpers
function isValidPosition(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return false
  if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return false
  return true
}

function clampPosition(x, y) {
  return {
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(100, y)),
  }
}

// Rate limiting state (simple in-memory, per socket)
const rateLimits = new Map() // socketId -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 1000
const RATE_LIMIT_MAX = 20

function checkRateLimit(socketId) {
  const now = Date.now()
  const entry = rateLimits.get(socketId)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(socketId, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= RATE_LIMIT_MAX) return false
  entry.count += 1
  return true
}

io.on('connection', socket => {
  const session = socket.data.session

  // Expiry is enforced for the LIFETIME of the socket, not only at the
  // handshake. Without this a client that connected one second before `exp`
  // stayed authenticated (and could keep signaling) indefinitely. The socket is
  // told first so the client can mint a fresh session and reconnect, then
  // disconnected; the client-side handler for `session:expired` does exactly
  // that.
  if (session) {
    let expiryTimer = null
    const enforceExpiry = () => {
      const stillValid = verifySessionToken(socket.handshake?.auth?.token, authConfig.secret)
      if (
        stillValid.ok &&
        !revokedSessions.isRevoked(stillValid.claims.jti) &&
        !revokedSessions.isSubjectRevoked(stillValid.claims.sub, stillValid.claims.iat)
      ) {
        // Still inside the window (clock skew): check again at the real expiry
        // instead of disconnecting a session that is still valid.
        const remaining = Math.max(0, stillValid.claims.exp * 1000 - Date.now()) + 250
        expiryTimer = setTimeout(enforceExpiry, remaining)
        expiryTimer.unref?.()
        return
      }
      socket.emit('session:expired', { code: AUTH_CODES.EXPIRED })
      const closeTimer = setTimeout(() => socket.disconnect(true), 100)
      closeTimer.unref?.()
    }
    expiryTimer = setTimeout(enforceExpiry, Math.max(0, session.exp * 1000 - Date.now()) + 250)
    expiryTimer.unref?.()
    socket.once('disconnect', () => clearTimeout(expiryTimer))
  }

  socket.on('office:join', ({ roomId } = {}) => {
    if (!session) {
      socket.emit('error', { code: AUTH_CODES.REQUIRED })
      return
    }

    const cleanRoomId = sanitizeRoomId(roomId)
    if (!cleanRoomId) {
      socket.emit('error', { code: 'INVALID_ROOM' })
      return
    }

    // Room authorization is the token's room. A session issued for `design-team`
    // cannot join `ops`, even if `ops` exists and is on the allowlist.
    if (cleanRoomId !== session.room) {
      socket.emit('error', { code: 'ROOM_FORBIDDEN' })
      return
    }
    if (!isRoomAllowed(cleanRoomId, ALLOWED_ROOMS)) {
      socket.emit('error', { code: 'ROOM_FORBIDDEN' })
      return
    }

    // If already in a room, leave it first
    if (socket.data.roomId) {
      trackLeave(socket.data.roomId, socket.id)
      socket.leave(socket.data.roomId)
    }

    // Evict any older socket holding this same session subject.
    const previousSocketId = sessionSockets.get(session.subject)
    if (previousSocketId && previousSocketId !== socket.id) {
      const previous = io.sockets.sockets.get(previousSocketId)
      previous?.disconnect(true)
    }
    sessionSockets.set(session.subject, socket.id)

    socket.join(cleanRoomId)
    socket.data.roomId = cleanRoomId
    // Identity comes from the verified token. The display name is normalised and
    // signed into the token at issuance, so a client cannot rename or impersonate
    // another participant here.
    socket.data.user = { id: socket.id, name: session.name }

    // Track this user in the room
    trackJoin(cleanRoomId, socket.id, socket.data.user)

    // Send existing users in the room to the joining client
    const existingUsers = getRoomUsers(cleanRoomId)
      .filter(u => u.id !== socket.id)  // Exclude self
      .map(u => ({ ...u, joinedAt: Date.now() }))
    socket.emit('presence:list', { users: existingUsers, roomId: cleanRoomId })

    // Notify other clients about the new user
    socket.to(cleanRoomId).emit('presence:joined', socket.data.user)

    // Confirm join to the client
    socket.emit('office:joined', { socketId: socket.id, roomId: cleanRoomId })
  })

  // Leaving the room is a real state transition, not a no-op. The client emits
  // this when it wants to stop participating; clearing socket.data.roomId here
  // means a later position/speaking/signaling event is rejected by the same
  // guards that protect a socket that never joined.
  socket.on('office:leave', () => {
    const roomId = socket.data.roomId
    if (!roomId) return
    trackLeave(roomId, socket.id)
    socket.leave(roomId)
    socket.to(roomId).emit('presence:left', { userId: socket.id })
    socket.data.roomId = null
    socket.data.user = null
    if (session && sessionSockets.get(session.subject) === socket.id) {
      sessionSockets.delete(session.subject)
    }
    socket.emit('office:left', { roomId })
  })

  socket.on('position:update', (position, ack) => {
    const reply = typeof ack === 'function' ? ack : null
    if (!socket.data.roomId) {
      reply?.({ ok: false, code: 'NOT_IN_ROOM' })
      return
    }
    if (!checkRateLimit(socket.id)) {
      socket.emit('error', { code: 'RATE_LIMITED' })
      reply?.({ ok: false, code: 'RATE_LIMITED' })
      return
    }
    if (!isValidPosition(position)) {
      socket.emit('error', { code: 'INVALID_POSITION' })
      reply?.({ ok: false, code: 'INVALID_POSITION' })
      return
    }
    const clamped = clampPosition(position.x, position.y)
    socket.to(socket.data.roomId).emit('position:update', {
      userId: socket.id,
      x: clamped.x,
      y: clamped.y,
      updatedAt: Date.now(),
    })
    // Acknowledgement lets a load test measure server-side latency without
    // changing the broadcast contract other clients already consume.
    reply?.({ ok: true })
  })

  socket.on('speaking:update', speaking => {
    if (!socket.data.roomId) return
    if (typeof speaking !== 'boolean') {
      socket.emit('error', { code: 'INVALID_SPEAKING' })
      return
    }
    socket.to(socket.data.roomId).emit('speaking:update', {
      userId: socket.id,
      speaking: Boolean(speaking),
    })
  })

  socket.on('disconnect', () => {
    if (socket.data.roomId) {
      socket.to(socket.data.roomId).emit('presence:left', { userId: socket.id })
      trackLeave(socket.data.roomId, socket.id)
    }
    if (session && sessionSockets.get(session.subject) === socket.id) {
      sessionSockets.delete(session.subject)
    }
    rateLimits.delete(socket.id)
  })
})

// Graceful shutdown
async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`)
  if (mongoWatchdog) clearInterval(mongoWatchdog)
  io.disconnectSockets(true)
  httpServer.close()
  await disconnectDb()
  // Force close after 10s if connections linger
  setTimeout(() => {
    console.log('Forcing shutdown after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (err) => {
  // Never print a stack containing handshake/auth material; the message alone is
  // enough to identify the fault, and the URI is redacted.
  console.error('Uncaught exception:', redactMongoUri(err.message))
  shutdown('uncaughtException').then(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error('Unhandled rejection:', redactMongoUri(message))
})

// Start persisting/health-monitoring MongoDB if configured. `monitorMongo` is
// safe to call before listen(): it never blocks the event loop and retries on its
// own, so an unavailable database cannot stop the office from working.
const serverStarted = httpServer.listen(PORT, async () => {
  console.log(`ProxiSpeak server listening at http://localhost:${PORT}`)
  if (MONGODB_URI) {
    await monitorMongo()
  }
})

if (MONGODB_URI) monitorMongo()

// Export for use in tests and frontend
const serverModule = {
  app,
  io,
  isValidPosition,
  clampPosition,
  serverStarted,
  authConfig,
}

export default serverModule
export { app, io, isValidPosition, clampPosition }
