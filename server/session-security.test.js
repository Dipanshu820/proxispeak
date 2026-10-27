// Session-security integration tests against the real entrypoint.
//
// These cover controls that cannot be exercised through the pure modules:
//  - strict Origin validation on state-changing HTTP requests,
//  - immediate (node-local) session revocation via POST /api/auth/revoke,
//  - expiry being enforced for the lifetime of an already-connected socket,
//  - `office:leave` as a real state transition (not a no-op event),
//  - HTTPS enforcement and the trusted-proxy boundary.
//
// As in auth.test.js, servers are spawned as real processes so startup config
// and the production guard are what actually runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioc } from 'socket.io-client'
import {
  issueSession,
  verifySessionToken,
  createRevocationStore,
  AUTH_CODES,
} from './auth.js'
import { parseTrustProxyHops, isOriginAllowed, isLoopbackOrigin } from './config.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js')
const TEST_SECRET = 'session-security-test-secret-0123456789-abcdef'

function cleanEnv(overrides) {
  const env = {
    ...process.env,
    USER_STORE_FILE: path.join(os.tmpdir(), `ps-sec-test-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    PROXISPEAK_ALLOW_FILE_ACCOUNT_STORE: 'true',
  }
  for (const key of [
    'CLIENT_ORIGIN',
    'MONGODB_URI',
    'NODE_ENV',
    'SESSION_SECRET',
    'JOIN_CODE',
    'ALLOWED_ROOMS',
    'AUTH_ALLOW_ANONYMOUS',
    'HEALTH_TOKEN',
    'TURN_URLS',
    'TURN_SECRET',
    'TURN_USERNAME',
    'TURN_CREDENTIAL',
    'STUN_URLS',
    'TRUST_PROXY',
    'REQUIRE_HTTPS',
    'PROXISPEAK_ALLOW_HTTP_ORIGIN',
  ]) {
    delete env[key]
  }
  const merged = { ...env, ...overrides }
  if (merged.NODE_ENV !== 'production' && merged.AUTH_ALLOW_ANONYMOUS === undefined) {
    merged.AUTH_ALLOW_ANONYMOUS = 'true'
  }
  return merged
}

function startServer(overrides, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: cleanEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = { stdout: '', stderr: '' }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not start\nstdout: ${output.stdout}\nstderr: ${output.stderr}`))
    }, timeout)

    child.stdout.on('data', chunk => {
      output.stdout += chunk.toString()
      if (output.stdout.includes('listening')) {
        clearTimeout(timer)
        resolve({ child, output, baseUrl: `http://127.0.0.1:${overrides.PORT}` })
      }
    })
    child.stderr.on('data', chunk => { output.stderr += chunk.toString() })
    child.once('error', reject)
  })
}

function runServerToExit(overrides, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: cleanEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not exit\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeout)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.once('error', reject)
  })
}

function connectSocket(baseUrl, token, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const client = ioc(baseUrl, {
      reconnection: false,
      transports: ['websocket'],
      auth: token ? { token } : {},
    })
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), timeout)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.once('connect_error', error => {
      clearTimeout(timer)
      const wrapped = new Error(error.message)
      wrapped.code = error.data?.code
      reject(wrapped)
    })
  })
}

function once(socket, event, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout)
    socket.once(event, payload => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

function sessionHeaders(token) {
  return { authorization: `Bearer ${token}` }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('trusted proxy configuration', () => {
  it('is off unless an explicit hop count is configured', () => {
    expect(parseTrustProxyHops(undefined)).toEqual({ hops: 0, error: null })
    expect(parseTrustProxyHops('')).toEqual({ hops: 0, error: null })
    expect(parseTrustProxyHops('false')).toEqual({ hops: 0, error: null })
    expect(parseTrustProxyHops('0')).toEqual({ hops: 0, error: null })
  })

  it('accepts a bounded hop count', () => {
    expect(parseTrustProxyHops('1')).toEqual({ hops: 1, error: null })
    expect(parseTrustProxyHops('2')).toEqual({ hops: 2, error: null })
  })

  it('rejects names, wildcards and out-of-range values', () => {
    expect(parseTrustProxyHops('true').error).toMatch(/integer hop count/)
    expect(parseTrustProxyHops('loopback').error).toMatch(/integer hop count/)
    expect(parseTrustProxyHops('*').error).toMatch(/integer hop count/)
    expect(parseTrustProxyHops('9').error).toMatch(/between 0 and 3/)

    // A production process refuses to start on a rejected value instead of
    // silently trusting every hop.
    expect(parseTrustProxyHops('unbounded').error).toBeTruthy()
  })
})

describe('origin allowlisting', () => {
  it('recognizes loopback origins for development only', () => {
    expect(isLoopbackOrigin('http://localhost:4173')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isLoopbackOrigin('http://localhost.evil.example')).toBe(false)
    expect(isLoopbackOrigin('https://localhost:4173')).toBe(false)
    expect(isLoopbackOrigin('http://localhost.evil.example:4173')).toBe(false)
    expect(isLoopbackOrigin('not-a-url')).toBe(false)
  })

  it('matches only exact configured origins', () => {
    const allowed = ['https://proxispeak.example.com']
    expect(isOriginAllowed('https://proxispeak.example.com', allowed)).toBe(true)
    expect(isOriginAllowed('https://proxispeak.example.com.evil.test', allowed)).toBe(false)
    expect(isOriginAllowed('http://proxispeak.example.com', allowed)).toBe(false)
    expect(isOriginAllowed('null', allowed)).toBe(false)
    expect(isOriginAllowed(undefined, allowed)).toBe(false)
    expect(isOriginAllowed('https://proxispeak.example.com', [])).toBe(false)
  })
})

describe('revocation store', () => {
  it('revokes a jti until its token would have expired anyway', () => {
    let now = 1_700_000_000_000
    const store = createRevocationStore({ now: () => now })
    const claims = { jti: 'abc', exp: Math.floor(now / 1000) + 60 }

    expect(store.isRevoked('abc')).toBe(false)
    expect(store.revoke(claims)).toBe(true)
    expect(store.isRevoked('abc')).toBe(true)
    expect(store.size).toBe(1)

    // Once the token is expired the entry is irrelevant and is pruned.
    now += 61_000
    expect(store.isRevoked('abc')).toBe(false)
    expect(store.size).toBe(0)
  })

  it('ignores claims without a jti or exp', () => {
    const store = createRevocationStore()
    expect(store.revoke({ exp: 1 })).toBe(false)
    expect(store.revoke({ jti: 'x' })).toBe(false)
    expect(store.revoke(null)).toBe(false)
    expect(store.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Real server (development profile)
// ---------------------------------------------------------------------------

describe('HTTP and socket session security (real server)', () => {
  const PORT = '4440'
  const baseUrl = `http://127.0.0.1:${PORT}`
  let server
  const sockets = []

  beforeAll(async () => {
    server = await startServer({
      NODE_ENV: 'development',
      PORT,
      CLIENT_ORIGIN: 'http://localhost:5173',
      SESSION_SECRET: TEST_SECRET,
      ALLOWED_ROOMS: 'design-team,ops',
    })
  }, 30_000)

  afterAll(() => {
    for (const socket of sockets) socket.disconnect()
    server?.child.kill()
  })

  async function issue(roomId = 'design-team', name = 'Alice') {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, name }),
    })
    expect(res.status).toBe(200)
    return res.json()
  }

  it('rejects a state-changing request from an unlisted Origin', async () => {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ roomId: 'design-team', name: 'Mallory' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('ORIGIN_FORBIDDEN')
  })

  it('accepts a state-changing request from a configured Origin', async () => {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ roomId: 'design-team', name: 'Alice' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('allows a loopback preview origin in development without listing its port', async () => {
    // `vite preview` serves the built app on 4173 and proxies /api, so the
    // browser sends Origin: http://localhost:4173. Production never takes this
    // path (see the production suite below).
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:4173',
      },
      body: JSON.stringify({ roomId: 'design-team', name: 'Preview' }),
    })
    expect(res.status).toBe(200)
  })

  it('does not let CORS headers alone stand in for authorization', async () => {
    // A plain form-style POST (no preflight) still reaches middleware; the
    // Origin guard is what rejects it.
    const res = await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('ORIGIN_FORBIDDEN')
  })

  it('revokes a session token and disconnects the live socket using it', async () => {
    const { token } = await issue()
    const socket = await connectSocket(baseUrl, token)
    sockets.push(socket)

    const disconnected = once(socket, 'disconnect')
    const res = await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: sessionHeaders(token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, revoked: true, disconnected: 1 })

    await disconnected

    // The revoked token is now refused at both entry points.
    const ice = await fetch(`${baseUrl}/api/ice`, { headers: sessionHeaders(token) })
    expect(ice.status).toBe(401)
    expect((await ice.json()).error.code).toBe(AUTH_CODES.REVOKED)
    await expect(connectSocket(baseUrl, token)).rejects.toMatchObject({
      code: AUTH_CODES.REVOKED,
    })
  })

  it('refuses to revoke without a valid bearer token', async () => {
    const missing = await fetch(`${baseUrl}/api/auth/revoke`, { method: 'POST' })
    expect(missing.status).toBe(401)
    expect((await missing.json()).error.code).toBe(AUTH_CODES.REQUIRED)

    const tampered = await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: sessionHeaders('v1.abc.def'),
    })
    expect(tampered.status).toBe(401)
  })

  it('disconnects a socket when its token expires, not only at the handshake', async () => {
    const { token, claims } = issueSession({
      subject: 'short-lived-subject',
      name: 'Short Lived',
      room: 'design-team',
      secret: TEST_SECRET,
      ttlSeconds: 2,
    })
    expect(verifySessionToken(token, TEST_SECRET).ok).toBe(true)

    const socket = await connectSocket(baseUrl, token)
    sockets.push(socket)

    const expired = once(socket, 'session:expired', 6000)
    const disconnected = once(socket, 'disconnect', 6000)
    await expired
    await disconnected
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })

  it('treats office:leave as a real state transition', async () => {
    const { token } = await issue('design-team', 'Leaver')
    const socket = await connectSocket(baseUrl, token)
    sockets.push(socket)

    const joined = once(socket, 'office:joined')
    socket.emit('office:join', { roomId: 'design-team' })
    await joined

    const left = once(socket, 'office:left')
    socket.emit('office:leave')
    expect((await left).roomId).toBe('design-team')

    // After leaving, room-scoped events are rejected exactly like a socket that
    // never joined.
    const ack = await new Promise(resolve => {
      socket.emit('position:update', { x: 10, y: 10 }, resolve)
    })
    expect(ack).toEqual({ ok: false, code: 'NOT_IN_ROOM' })
  })

  it('keeps room isolation after a leave/rejoin cycle', async () => {
    const { token } = await issue('design-team', 'Rejoiner')
    const socket = await connectSocket(baseUrl, token)
    sockets.push(socket)

    const joined = once(socket, 'office:joined')
    socket.emit('office:join', { roomId: 'design-team' })
    await joined

    socket.emit('office:leave')
    await once(socket, 'office:left')

    // A token bound to design-team still cannot enter the other allowed room.
    const forbidden = once(socket, 'error')
    socket.emit('office:join', { roomId: 'ops' })
    expect((await forbidden).code).toBe('ROOM_FORBIDDEN')
  })
})

// ---------------------------------------------------------------------------
// Production HTTPS / trusted-proxy boundary
// ---------------------------------------------------------------------------

describe('production HTTPS enforcement (real server)', () => {
  const PORT = '4441'
  const baseUrl = `http://127.0.0.1:${PORT}`
  const HTTPS_ORIGIN = 'https://proxispeak.example.com'
  let server

  beforeAll(async () => {
    server = await startServer({
      NODE_ENV: 'production',
      PORT,
      CLIENT_ORIGIN: HTTPS_ORIGIN,
      SESSION_SECRET: TEST_SECRET,
      TRUST_PROXY: '1',
    })
  }, 30_000)

  afterAll(() => {
    server?.child.kill()
  })

  it('keeps the health probe available inside the network', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.service).toBe('proxispeak-server')
    // Production does not leak memory/CPU diagnostics.
    expect(body.memory).toBeUndefined()
    expect(body.port).toBeUndefined()
  })

  it('refuses a login over plaintext HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: HTTPS_ORIGIN },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse-1' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('HTTPS_REQUIRED')
  })

  it('accepts signup + session issuance when the trusted proxy reports HTTPS', async () => {
    const signup = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: HTTPS_ORIGIN,
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'correct-horse-1',
        confirmPassword: 'correct-horse-1',
      }),
    })
    expect(signup.status).toBe(201)
    const cookie = signup.headers.getSetCookie?.()[0] || signup.headers.get('set-cookie')
    expect(cookie).toContain('ps_account=')
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('secure')

    const res = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: HTTPS_ORIGIN,
        'x-forwarded-proto': 'https',
        cookie: cookie.split(';')[0],
      },
      body: JSON.stringify({ roomId: 'design-team' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Identity came from the account, not from the request body.
    expect(body.name).toBe('Alice')

    // The token it issued is usable for ICE over the same trusted path.
    const ice = await fetch(`${baseUrl}/api/ice`, {
      headers: { ...sessionHeaders(body.token), 'x-forwarded-proto': 'https' },
    })
    expect(ice.status).toBe(200)
  })

  it('rejects a loopback origin in production', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:4173',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse-1' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('ORIGIN_FORBIDDEN')
  })

  it('adds HSTS in production', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('exits nonzero when TRUST_PROXY is not a hop count', async () => {
    const result = await runServerToExit({
      NODE_ENV: 'production',
      PORT: '4442',
      CLIENT_ORIGIN: HTTPS_ORIGIN,
      SESSION_SECRET: TEST_SECRET,
      TRUST_PROXY: 'true',
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('TRUST_PROXY')
  }, 30_000)
})

describe('untrusted forwarded headers (real server)', () => {
  const PORT = '4443'
  const baseUrl = `http://127.0.0.1:${PORT}`
  const HTTPS_ORIGIN = 'https://proxispeak.example.com'
  let server

  beforeAll(async () => {
    // Production profile with NO proxy declared: X-Forwarded-Proto is just an
    // attacker-supplied header here and must not upgrade the request.
    server = await startServer({
      NODE_ENV: 'production',
      PORT,
      CLIENT_ORIGIN: HTTPS_ORIGIN,
      SESSION_SECRET: TEST_SECRET,
    })
  }, 30_000)

  afterAll(() => {
    server?.child.kill()
  })

  it('does not trust X-Forwarded-Proto when no proxy hop is configured', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: HTTPS_ORIGIN,
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse-1' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('HTTPS_REQUIRED')
  })
})
