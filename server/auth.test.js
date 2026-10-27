// Authentication and room-authorization tests.
//
// Unit tests cover the signer/verifier directly. The integration tests spawn the
// REAL `server.js` entrypoint and use real HTTP + Socket.io clients, so they also
// prove that the middleware is wired into the handshake and that `office:join`,
// movement, and WebRTC signaling all require a verified session.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioc } from 'socket.io-client'
import {
  AUTH_CODES,
  DEV_SESSION_SECRET,
  MIN_SESSION_SECRET_LENGTH,
  createAuthConfig,
  issueSession,
  verifyJoinCode,
  verifySessionToken,
} from './auth.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js')
const TEST_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const TEST_JOIN_CODE = 'test-join-code-123'

// ---------------------------------------------------------------------------
// Token unit tests
// ---------------------------------------------------------------------------
describe('session token signing and verification', () => {
  it('issues a verifiable token with a server-generated subject and a room claim', () => {
    const { token, claims } = issueSession({
      subject: 'subject-1',
      name: '  Alice  ',
      room: 'design-team',
      secret: TEST_SECRET,
    })

    expect(token.split('.')).toHaveLength(3)
    expect(claims.sub).toBe('subject-1')
    expect(claims.name).toBe('Alice')
    expect(claims.room).toBe('design-team')
    expect(claims.exp).toBeGreaterThan(claims.iat)

    const verified = verifySessionToken(token, TEST_SECRET)
    expect(verified.ok).toBe(true)
    expect(verified.claims.sub).toBe('subject-1')
    expect(verified.claims.room).toBe('design-team')
  })

  it('rejects a missing token', () => {
    for (const token of [undefined, null, '', 42]) {
      const result = verifySessionToken(token, TEST_SECRET)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(AUTH_CODES.REQUIRED)
    }
  })

  it('rejects a tampered payload even though the signature is well formed', () => {
    const { token } = issueSession({ subject: 's', name: 'Alice', room: 'design-team', secret: TEST_SECRET })
    const [version, body, signature] = token.split('.')
    // Replace the encoded claims with a different, valid JSON document claiming
    // another room and subject, keeping the original signature.
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 1, sub: 'someone-else', name: 'Mallory', room: 'ops', jti: 'x', iat: 1, exp: 9999999999 }),
    ).toString('base64url')
    const result = verifySessionToken(`${version}.${forgedBody}.${signature}`, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(AUTH_CODES.INVALID_SIGNATURE)
    expect(body).not.toBe(forgedBody)
  })

  it('rejects a tampered signature', () => {
    const { token } = issueSession({ subject: 's', name: 'Alice', room: 'design-team', secret: TEST_SECRET })
    const parts = token.split('.')
    const signature = parts[2]
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
    const result = verifySessionToken(`${parts[0]}.${parts[1]}.${flipped}`, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(AUTH_CODES.INVALID_SIGNATURE)
  })

  it('rejects a token signed with a different secret', () => {
    const { token } = issueSession({
      subject: 's',
      name: 'Alice',
      room: 'design-team',
      secret: 'another-secret-0123456789-abcdefghijklmnop',
    })
    const result = verifySessionToken(token, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(AUTH_CODES.INVALID_SIGNATURE)
  })

  it('rejects an expired token', () => {
    const now = Date.now()
    const { token } = issueSession({
      subject: 's',
      name: 'Alice',
      room: 'design-team',
      secret: TEST_SECRET,
      now: now - 10 * 60 * 1000,
      ttlSeconds: 60,
    })
    const result = verifySessionToken(token, TEST_SECRET, { now })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(AUTH_CODES.EXPIRED)
  })

  it('rejects a token whose issued-at time is in the future', () => {
    const now = Date.now()
    const { token } = issueSession({
      subject: 's',
      name: 'Alice',
      room: 'design-team',
      secret: TEST_SECRET,
      now: now + 10 * 60 * 1000,
      ttlSeconds: 120,
    })
    const result = verifySessionToken(token, TEST_SECRET, { now })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(AUTH_CODES.NOT_YET_VALID)
  })

  it('rejects malformed tokens without throwing', () => {
    for (const token of ['', 'x', 'v1', 'v1..', 'v2.abc.def', 'v1.!!!.???', 'v1.' + 'A'.repeat(5000) + '.x']) {
      const result = verifySessionToken(token, TEST_SECRET)
      expect(result.ok).toBe(false)
      expect([AUTH_CODES.MALFORMED, AUTH_CODES.REQUIRED]).toContain(result.code)
    }
  })

  it('never includes the token or the secret in a rejection reason', () => {
    const { token } = issueSession({ subject: 's', name: 'Alice', room: 'design-team', secret: TEST_SECRET })
    const bad = token.slice(0, -2) + 'zz'
    const result = verifySessionToken(bad, TEST_SECRET)
    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(TEST_SECRET)
    expect(serialized).not.toContain(bad)
  })

  it('refuses to verify when the verifier secret itself is missing or weak', () => {
    const { token } = issueSession({ subject: 's', name: 'Alice', room: 'design-team', secret: TEST_SECRET })
    const result = verifySessionToken(token, 'short')
    expect(result.ok).toBe(false)
    expect(result.code).toBe(AUTH_CODES.NOT_CONFIGURED)
  })

  it('produces different tokens for otherwise identical claims (unique jti)', () => {
    const a = issueSession({ subject: 's', name: 'Alice', room: 'r', secret: TEST_SECRET })
    const b = issueSession({ subject: 's', name: 'Alice', room: 'r', secret: TEST_SECRET })
    expect(a.claims.jti).not.toBe(b.claims.jti)
    expect(a.token).not.toBe(b.token)
  })
})

describe('join code comparison', () => {
  it('accepts only the exact code', () => {
    expect(verifyJoinCode(TEST_JOIN_CODE, TEST_JOIN_CODE)).toBe(true)
    expect(verifyJoinCode(TEST_JOIN_CODE + 'x', TEST_JOIN_CODE)).toBe(false)
    expect(verifyJoinCode('', TEST_JOIN_CODE)).toBe(false)
    expect(verifyJoinCode(undefined, TEST_JOIN_CODE)).toBe(false)
    expect(verifyJoinCode(TEST_JOIN_CODE, '')).toBe(false)
  })
})

describe('auth configuration', () => {
  it('fails closed in production when SESSION_SECRET is missing', () => {
    const config = createAuthConfig({ NODE_ENV: 'production' })
    expect(config.error).toMatch(/SESSION_SECRET is required/)
  })

  it('fails closed in production when SESSION_SECRET is too short', () => {
    const config = createAuthConfig({ NODE_ENV: 'production', SESSION_SECRET: 'too-short' })
    expect(config.error).toMatch(new RegExp(String(MIN_SESSION_SECRET_LENGTH)))
  })

  it('uses a labelled development fallback outside production', () => {
    const config = createAuthConfig({ NODE_ENV: 'development' })
    expect(config.error).toBeUndefined()
    expect(config.developmentFallback).toBe(true)
    expect(config.secret).toBe(DEV_SESSION_SECRET)
    expect(config.warnings.join(' ')).toMatch(/development-only/i)
    // Accounts are the default everywhere; anonymous room tokens require an
    // explicit opt-in even in development.
    expect(config.allowAnonymous).toBe(false)
  })

  it('requires accounts in development unless anonymous issuance is explicitly enabled', () => {
    const byDefault = createAuthConfig({ NODE_ENV: 'development' })
    expect(byDefault.allowAnonymous).toBe(false)

    const optedIn = createAuthConfig({ NODE_ENV: 'development', AUTH_ALLOW_ANONYMOUS: 'true' })
    expect(optedIn.allowAnonymous).toBe(true)
    expect(optedIn.warnings.join(' ')).toMatch(/AUTH_ALLOW_ANONYMOUS/)
  })

  it('refuses to start in production with anonymous issuance enabled', () => {
    const config = createAuthConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: TEST_SECRET,
      AUTH_ALLOW_ANONYMOUS: 'true',
    })
    expect(config.error).toMatch(/AUTH_ALLOW_ANONYMOUS/)
  })

  it('allows production issuance only with a join code', () => {
    const config = createAuthConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: TEST_SECRET,
      JOIN_CODE: TEST_JOIN_CODE,
    })
    expect(config.error).toBeUndefined()
    expect(config.canIssueSessions).toBe(true)
    expect(config.allowAnonymous).toBe(false)
  })

  it('rejects a weak join code in production', () => {
    const config = createAuthConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: TEST_SECRET,
      JOIN_CODE: 'short',
    })
    expect(config.error).toMatch(/JOIN_CODE/)
  })

  it('exposes no secret values through its warning text', () => {
    const config = createAuthConfig({ NODE_ENV: 'development' })
    const serialized = JSON.stringify({ ...config, secret: undefined })
    expect(serialized).not.toContain(config.secret)
  })
})

// ---------------------------------------------------------------------------
// Real server: HTTP issuance + Socket.io handshake + room authorization
// ---------------------------------------------------------------------------
function cleanEnv(overrides) {
  const env = {
    ...process.env,
    // Accounts are the default. These suites exercise the signaling/room layer
    // with anonymous room tokens, which is only possible behind the explicit
    // development escape hatch.
    USER_STORE_FILE: path.join(os.tmpdir(), `ps-auth-test-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
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
        resolve({
          child,
          output,
          baseUrl: `http://127.0.0.1:${overrides.PORT}`,
        })
      }
    })
    child.stderr.on('data', chunk => {
      output.stderr += chunk.toString()
    })
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

async function requestSession(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
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

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout)
    socket.once(event, payload => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

function join(socket, roomId, extra = {}) {
  const joined = once(socket, 'office:joined')
  socket.emit('office:join', { roomId, ...extra })
  return joined
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('real server authentication and room authorization', () => {
  const PORT = '4330'
  let server
  const baseUrl = `http://127.0.0.1:${PORT}`
  const sockets = []

  beforeAll(async () => {
    server = await startServer({
      NODE_ENV: 'development',
      PORT,
      CLIENT_ORIGIN: 'http://localhost:5173',
      SESSION_SECRET: TEST_SECRET,
      ALLOWED_ROOMS: 'design-team,ops,room-a,room-b',
    })
  }, 30_000)

  afterAll(() => {
    for (const socket of sockets) socket.disconnect()
    server?.child.kill()
  })

  afterEach(() => {
    while (sockets.length) sockets.pop().disconnect()
  })

  async function tokenFor(roomId = 'design-team', name = 'Alice') {
    const res = await requestSession(baseUrl, { roomId, name })
    expect(res.status).toBe(200)
    const body = await res.json()
    return body
  }

  it('issues a signed session with a server-chosen subject and normalized name', async () => {
    const body = await tokenFor('design-team', '  Alice\u0000 Smith  ')
    expect(body.ok).toBe(true)
    expect(body.roomId).toBe('design-team')
    expect(body.name).toBe('Alice Smith')
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    const verified = verifySessionToken(body.token, TEST_SECRET)
    expect(verified.ok).toBe(true)
    expect(verified.claims.room).toBe('design-team')
    // The subject is a server-generated UUID, not anything the client sent.
    expect(verified.claims.sub).toMatch(/^[0-9a-f-]{36}$/)

    const second = await tokenFor('design-team', 'Alice Smith')
    expect(verifySessionToken(second.token, TEST_SECRET).claims.sub).not.toBe(verified.claims.sub)
  })

  it('refuses a room that is not on the deployment allowlist', async () => {
    const res = await requestSession(baseUrl, { roomId: 'secret-room', name: 'Mallory' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('ROOM_FORBIDDEN')
  })

  it('rejects a socket with no token before any handler runs', async () => {
    await expect(connectSocket(baseUrl, null)).rejects.toMatchObject({ code: AUTH_CODES.REQUIRED })
  })

  it('rejects a tampered token at the handshake', async () => {
    const { token } = await tokenFor()
    const [version, body, signature] = token.split('.')
    const tampered = `${version}.${body.slice(0, -2)}aa.${signature}`
    await expect(connectSocket(baseUrl, tampered)).rejects.toMatchObject({
      code: AUTH_CODES.INVALID_SIGNATURE,
    })
  })

  it('rejects an expired token at the handshake', async () => {
    const expired = issueSession({
      subject: 'expired-subject',
      name: 'Alice',
      room: 'design-team',
      secret: TEST_SECRET,
      now: Date.now() - 60 * 60 * 1000,
      ttlSeconds: 60,
    }).token
    await expect(connectSocket(baseUrl, expired)).rejects.toMatchObject({ code: AUTH_CODES.EXPIRED })
  })

  it('binds the participant identity to the token name, ignoring a client-supplied name', async () => {
    const alice = await tokenFor('design-team', 'Alice')
    const bob = await tokenFor('design-team', 'Bob')
    const clientA = await connectSocket(baseUrl, alice.token)
    const clientB = await connectSocket(baseUrl, bob.token)
    sockets.push(clientA, clientB)

    const joinedA = join(clientA, 'design-team')
    const bJoins = once(clientA, 'presence:joined')
    const joinedB = join(clientB, 'design-team', { user: { name: 'Mallory', id: 'fake-id' } })
    await Promise.all([joinedA, joinedB])
    const announcement = await bJoins

    expect(announcement.name).toBe('Bob')
    expect(announcement.id).toBe(clientB.id)
  })

  it('forbids joining a room other than the one the token was issued for', async () => {
    const { token } = await tokenFor('design-team')
    const client = await connectSocket(baseUrl, token)
    sockets.push(client)
    const error = once(client, 'error')
    client.emit('office:join', { roomId: 'ops' })
    expect((await error).code).toBe('ROOM_FORBIDDEN')
    await wait(100)
    expect(client.connected).toBe(true)
  })

  it('rejects movement from a socket that has not joined a room', async () => {
    const { token } = await tokenFor()
    const client = await connectSocket(baseUrl, token)
    sockets.push(client)
    const ack = await new Promise(resolve => {
      client.emit('position:update', { x: 10, y: 10 }, resolve)
    })
    expect(ack).toEqual({ ok: false, code: 'NOT_IN_ROOM' })
  })

  it('accepts movement after an authorized join and acknowledges it', async () => {
    const { token } = await tokenFor()
    const client = await connectSocket(baseUrl, token)
    sockets.push(client)
    await join(client, 'design-team')
    const ack = await new Promise(resolve => {
      client.emit('position:update', { x: 10, y: 12.5 }, resolve)
    })
    expect(ack).toEqual({ ok: true })
  })

  it('prevents cross-room WebRTC signaling', async () => {
    const a = await tokenFor('room-a', 'Alice')
    const b = await tokenFor('room-b', 'Bob')
    const clientA = await connectSocket(baseUrl, a.token)
    const clientB = await connectSocket(baseUrl, b.token)
    sockets.push(clientA, clientB)
    await Promise.all([join(clientA, 'room-a'), join(clientB, 'room-b')])

    const error = once(clientA, 'error')
    let invite = null
    clientB.once('webrtc:invite', payload => { invite = payload })
    clientA.emit('webrtc:offer', { targetSocketId: clientB.id, sdp: { type: 'offer', sdp: 'v=0' } })

    expect((await error).code).toBe('NOT_IN_SAME_ROOM')
    await wait(200)
    expect(invite).toBeNull()
  })

  it('evicts an older socket when the same session is replayed', async () => {
    const { token } = await tokenFor()
    const first = await connectSocket(baseUrl, token)
    sockets.push(first)
    await join(first, 'design-team')

    const disconnected = once(first, 'disconnect', 5000)
    const second = await connectSocket(baseUrl, token)
    sockets.push(second)
    await join(second, 'design-team')

    await expect(disconnected).resolves.toBeDefined()
    await wait(150)
    expect(second.connected).toBe(true)
  })

  it('cleans the session entry up on disconnect so the token can reconnect', async () => {
    const { token } = await tokenFor()
    const first = await connectSocket(baseUrl, token)
    sockets.push(first)
    await join(first, 'design-team')
    first.disconnect()
    await wait(250)

    const second = await connectSocket(baseUrl, token)
    sockets.push(second)
    await expect(join(second, 'design-team')).resolves.toMatchObject({ roomId: 'design-team' })
  })

  it('serves ICE configuration only to an authenticated request', async () => {
    const anonymous = await fetch(`${baseUrl}/api/ice`)
    expect(anonymous.status).toBe(401)

    const { token } = await tokenFor()
    const authorized = await fetch(`${baseUrl}/api/ice`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(200)
    const body = await authorized.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.iceServers)).toBe(true)
    expect(body.iceServers.length).toBeGreaterThan(0)
    // No TURN configured in this environment: STUN only, and the response must not
    // invent credentials.
    expect(body.turnEnabled).toBe(false)
    expect(body.iceServers.every(server => !server.credential)).toBe(true)
  })

  it('never writes issued tokens or the signing secret to the server log', async () => {
    const { token } = await tokenFor()
    await connectSocket(baseUrl, token).then(socket => socket.disconnect())
    await wait(200)
    const logged = server.output.stdout + server.output.stderr
    expect(logged).not.toContain(token)
    expect(logged).not.toContain(TEST_SECRET)
  })

  it('does not expose secrets through the development health payload', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    const body = await res.json()
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(TEST_SECRET)
    expect(body.auth.anonymousSessions).toBe(true)
    expect(body.mongodb).toBe('disabled')
  })
})

// ---------------------------------------------------------------------------
// Production process behavior
// ---------------------------------------------------------------------------
describe('production authentication startup and issuance', () => {
  it('exits nonzero when SESSION_SECRET is missing', async () => {
    const result = await runServerToExit({
      NODE_ENV: 'production',
      PORT: '4340',
      CLIENT_ORIGIN: 'https://proxispeak.example.com',
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('FATAL')
    expect(result.stderr).toContain('SESSION_SECRET')
  }, 30_000)

  it('exits nonzero when SESSION_SECRET is too short', async () => {
    const result = await runServerToExit({
      NODE_ENV: 'production',
      PORT: '4341',
      CLIENT_ORIGIN: 'https://proxispeak.example.com',
      SESSION_SECRET: 'too-short',
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('at least')
  }, 30_000)

  it('requires a signed-in account before issuing a room token', async () => {
    const production = await startServer({
      NODE_ENV: 'production',
      PORT: '4342',
      CLIENT_ORIGIN: 'https://proxispeak.example.com',
      SESSION_SECRET: TEST_SECRET,
      // TLS terminates at the declared proxy hop for this profile.
      TRUST_PROXY: '1',
    })
    try {
      // Plaintext is refused before the endpoint reveals anything about its
      // configuration (Phase 4 HTTPS enforcement).
      const plaintext = await requestSession(production.baseUrl, {
        roomId: 'design-team',
        name: 'Alice',
      })
      expect(plaintext.status).toBe(403)
      expect((await plaintext.json()).error.code).toBe('HTTPS_REQUIRED')

      // Over the trusted HTTPS path the endpoint still refuses an anonymous
      // caller: production never issues room tokens without an account.
      const res = await requestSession(
        production.baseUrl,
        { roomId: 'design-team', name: 'Alice' },
        { 'x-forwarded-proto': 'https' },
      )
      expect(res.status).toBe(401)
      expect((await res.json()).error.code).toBe(AUTH_CODES.REQUIRED)
    } finally {
      production.child.kill()
    }
  }, 30_000)

  it('requires the configured join code before issuing a session', async () => {
    const production = await startServer({
      NODE_ENV: 'production',
      PORT: '4343',
      CLIENT_ORIGIN: 'https://proxispeak.example.com',
      SESSION_SECRET: TEST_SECRET,
      JOIN_CODE: TEST_JOIN_CODE,
      TRUST_PROXY: '1',
    })
    const https = { 'x-forwarded-proto': 'https' }
    try {
      const denied = await requestSession(
        production.baseUrl,
        { roomId: 'design-team', name: 'Alice' },
        https,
      )
      expect(denied.status).toBe(401)
      expect((await denied.json()).error.code).toBe('INVALID_JOIN_CODE')

      const wrong = await requestSession(
        production.baseUrl,
        { roomId: 'design-team', name: 'Alice' },
        { ...https, 'x-proxispeak-join-code': 'wrong-code' },
      )
      expect(wrong.status).toBe(401)

      // The correct join code passes the deployment gate, but the office token
      // still requires an account session, so an anonymous caller is refused.
      const allowed = await requestSession(
        production.baseUrl,
        { roomId: 'design-team', name: 'Alice' },
        { ...https, 'x-proxispeak-join-code': TEST_JOIN_CODE },
      )
      expect(allowed.status).toBe(401)
      expect((await allowed.json()).error.code).toBe(AUTH_CODES.REQUIRED)
    } finally {
      production.child.kill()
    }
  }, 30_000)
})
