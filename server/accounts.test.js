// Account system tests: password hashing, persistence, cookie sessions, room
// tokens, Socket.IO authorization, logout revocation, and rate limiting.
//
// The integration suite spawns the REAL server entrypoint with a temporary
// file-backed account store, so it exercises the same code paths a local
// deployment uses. MongoDB-specific behaviour is covered by db.live.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioc } from 'socket.io-client'
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  validateEmail,
  validateName,
  sanitizeName,
  normalizeEmail,
} from './passwords.js'
import {
  AUTH_CODES,
  createRevocationStore,
  issueAccountSession,
  issueSession,
  verifyAccountSession,
  verifySessionToken,
} from './auth.js'
import { createFileUserStore, DuplicateEmailError } from './userStore.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js')
const TEST_SECRET = 'accounts-test-secret-0123456789-abcdefghijklmnop'
const PASSWORD = 'correct-horse-1'

// ---------------------------------------------------------------------------
// Password hashing and validation
// ---------------------------------------------------------------------------
describe('password hashing', () => {
  it('stores a salted scrypt hash, never the password', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true)
    expect(hash).not.toContain(PASSWORD)
    expect(await verifyPassword(PASSWORD, hash)).toBe(true)
    expect(await verifyPassword('wrong-password-1', hash)).toBe(false)
  })

  it('produces a different hash for the same password every time', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)])
    expect(first).not.toBe(second)
    expect(await verifyPassword(PASSWORD, first)).toBe(true)
    expect(await verifyPassword(PASSWORD, second)).toBe(true)
  })

  it('rejects malformed or truncated stored hashes without throwing', async () => {
    for (const stored of [null, '', 'bcrypt$x', 'scrypt$16384$8$1$onlyfive', 'scrypt$0$8$1$a$b']) {
      expect(await verifyPassword(PASSWORD, stored)).toBe(false)
    }
  })

  it('enforces the documented password policy', () => {
    expect(validatePassword('').code).toBe('PASSWORD_REQUIRED')
    expect(validatePassword('short1').code).toBe('PASSWORD_TOO_SHORT')
    expect(validatePassword('allletterspassword').code).toBe('PASSWORD_TOO_WEAK')
    expect(validatePassword('1234567890').code).toBe('PASSWORD_TOO_WEAK')
    expect(validatePassword('x'.repeat(201) + '1').code).toBe('PASSWORD_TOO_LONG')
    expect(validatePassword(PASSWORD).ok).toBe(true)
  })

  it('normalizes emails and rejects malformed addresses', () => {
    expect(normalizeEmail('  ADA@Example.COM ')).toBe('ada@example.com')
    expect(validateEmail('ada@example.com').email).toBe('ada@example.com')
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'a b@example.com', 'ada@example', 'ada@.com', 'ada@example..com']) {
      expect(validateEmail(bad).ok, bad).toBe(false)
    }
  })

  it('sanitizes display names', () => {
    expect(sanitizeName('  Ada\n\tLovelace  ')).toBe('Ada Lovelace')
    expect(validateName('   ').code).toBe('NAME_REQUIRED')
    expect(validateName('A').code).toBe('NAME_TOO_SHORT')
    expect(validateName('Ada Lovelace').ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Account session tokens
// ---------------------------------------------------------------------------
describe('account session tokens', () => {
  it('issues a verifiable account session', () => {
    const { token, claims } = issueAccountSession({
      userId: 'account-1',
      name: 'Ada',
      secret: TEST_SECRET,
    })
    expect(token.startsWith('v2.')).toBe(true)
    expect(claims.typ).toBe('account')
    expect(claims.exp).toBeGreaterThan(claims.iat)

    const verified = verifyAccountSession(token, TEST_SECRET)
    expect(verified.ok).toBe(true)
    expect(verified.claims.sub).toBe('account-1')
  })

  it('cannot be confused with a room token in either direction', () => {
    const account = issueAccountSession({ userId: 'a', name: 'Ada', secret: TEST_SECRET })
    const room = issueSession({ subject: 'a', name: 'Ada', room: 'design-team', secret: TEST_SECRET })

    expect(verifySessionToken(account.token, TEST_SECRET).ok).toBe(false)
    expect(verifyAccountSession(room.token, TEST_SECRET).ok).toBe(false)
  })

  it('rejects tampering, expiry and a missing token', () => {
    const { token } = issueAccountSession({ userId: 'a', name: 'Ada', secret: TEST_SECRET })
    const [version, body, signature] = token.split('.')
    const tampered = `${version}.${body}.${signature.slice(0, -2)}AA`
    expect(verifyAccountSession(tampered, TEST_SECRET).ok).toBe(false)
    expect(verifyAccountSession(undefined, TEST_SECRET).code).toBe(AUTH_CODES.REQUIRED)
    expect(verifyAccountSession(token, 'another-secret-that-is-long-enough-0000').ok).toBe(false)

    const expired = issueAccountSession({
      userId: 'a',
      name: 'Ada',
      secret: TEST_SECRET,
      now: Date.now() - 10 * 24 * 60 * 60 * 1000,
      ttlSeconds: 60,
    })
    expect(verifyAccountSession(expired.token, TEST_SECRET).code).toBe(AUTH_CODES.EXPIRED)
  })

  it('revokes all tokens issued to a subject before logout', () => {
    const store = createRevocationStore()
    const now = Date.now()
    const { token } = issueAccountSession({ userId: 'subject-x', name: 'Ada', secret: TEST_SECRET, now })

    expect(verifyAccountSession(token, TEST_SECRET, { now }).ok).toBe(true)
    store.revokeSubject('subject-x', now)

    const claims = verifyAccountSession(token, TEST_SECRET, { now }).claims
    expect(store.isSubjectRevoked('subject-x', claims.iat, now)).toBe(true)
    expect(store.isSubjectRevoked('someone-else', claims.iat, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// File-backed store (the local deployment driver)
// ---------------------------------------------------------------------------
describe('file account store', () => {
  it('persists users with a unique, case-normalized email', async () => {
    const file = path.join(os.tmpdir(), `ps-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    const store = createFileUserStore({ filePath: file })

    const user = await store.createUser({
      email: 'ada@example.com',
      name: 'Ada',
      passwordHash: await hashPassword(PASSWORD),
    })
    expect(user).not.toHaveProperty('passwordHash')

    await expect(
      store.createUser({ email: 'ada@example.com', name: 'Impostor', passwordHash: 'x' }),
    ).rejects.toBeInstanceOf(DuplicateEmailError)

    // A new store instance reads the same file: this is real persistence.
    const reopened = createFileUserStore({ filePath: file })
    const stored = await reopened.findByEmail('ada@example.com')
    expect(stored.id).toBe(user.id)
    expect(await verifyPassword(PASSWORD, stored.passwordHash)).toBe(true)

    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(onDisk.users[0].passwordHash.startsWith('scrypt$')).toBe(true)
    expect(await fs.readFile(file, 'utf8')).not.toContain(`"password":"${PASSWORD}"`)

    await fs.rm(file, { force: true })
  })

  it('serializes concurrent duplicate signups instead of racing', async () => {
    const file = path.join(os.tmpdir(), `ps-store-race-${Date.now()}.json`)
    const store = createFileUserStore({ filePath: file })
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        store.createUser({ email: 'race@example.com', name: `Racer ${index}`, passwordHash: 'hash' }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4)
    await fs.rm(file, { force: true })
  })
})

// ---------------------------------------------------------------------------
// Real server integration
// ---------------------------------------------------------------------------
const PORT = '4410'
const BASE_URL = `http://127.0.0.1:${PORT}`
const STORE_FILE = path.join(
  os.tmpdir(),
  `ps-accounts-integration-${process.pid}-${Date.now()}.json`,
)

let server

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const key of [
      'MONGODB_URI',
      'JOIN_CODE',
      'AUTH_ALLOW_ANONYMOUS',
      'ALLOWED_ROOMS',
      'NODE_ENV',
      'CLIENT_ORIGIN',
      'SESSION_SECRET',
      'USER_STORE_FILE',
      'ACCOUNT_STORE',
    ]) {
      delete env[key]
    }

    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: {
        ...env,
        NODE_ENV: 'development',
        PORT,
        SESSION_SECRET: TEST_SECRET,
        CLIENT_ORIGIN: 'http://localhost:5173',
        USER_STORE_FILE: STORE_FILE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not start\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 20_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.includes('listening')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
  })
}

function setCookieOf(response) {
  const values = response.headers.getSetCookie?.() || []
  const raw = values[0] || response.headers.get('set-cookie')
  return raw ? raw.split(';')[0] : null
}

async function api(pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json().catch(() => null)
  return {
    status: response.status,
    body: json,
    cookie: setCookieOf(response),
    setCookie: response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie') || '',
  }
}

let emailCounter = 0
function nextEmail(label = 'user') {
  emailCounter += 1
  return `${label}${emailCounter}-${Date.now()}@example.com`
}

async function signupAccount({ name = 'Test User', email = nextEmail(), password = PASSWORD } = {}) {
  return api('/api/auth/signup', {
    method: 'POST',
    body: { name, email, password, confirmPassword: password },
  })
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const client = ioc(BASE_URL, {
      reconnection: false,
      transports: ['websocket'],
      auth: token ? { token } : {},
    })
    const timer = setTimeout(() => {
      client.disconnect()
      reject(new Error('socket connect timeout'))
    }, 8000)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.once('connect_error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout)
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

describe('account HTTP API and office authorization', () => {
  beforeAll(async () => {
    server = await startServer()
  }, 30_000)

  afterAll(async () => {
    server?.kill()
    await fs.rm(STORE_FILE, { force: true })
  })

  it('creates a real account and sets an HttpOnly session cookie', async () => {
    const email = nextEmail('signup')
    const result = await signupAccount({ name: 'Ada Lovelace', email, password: PASSWORD })

    expect(result.status).toBe(201)
    expect(result.body.ok).toBe(true)
    expect(result.body.user.email).toBe(email)
    // The hash must never cross the HTTP boundary.
    expect(JSON.stringify(result.body)).not.toContain('scrypt$')
    expect(result.body.user.passwordHash).toBeUndefined()

    const setCookie = result.setCookie.toLowerCase()
    expect(setCookie).toContain('ps_account=')
    expect(setCookie).toContain('httponly')
    expect(setCookie).toContain('samesite=lax')
    expect(setCookie).toContain('path=/')
    expect(setCookie).toContain('max-age=')
  })

  it('normalizes the email and rejects a duplicate account with 409', async () => {
    const email = nextEmail('dupe')
    const first = await signupAccount({ email: `  ${email.toUpperCase()} ` })
    expect(first.status).toBe(201)

    const second = await signupAccount({ email: email.toLowerCase() })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('EMAIL_TAKEN')
  })

  it('rejects invalid signup input on the server', async () => {
    const cases = [
      { body: { name: '', email: nextEmail(), password: PASSWORD }, code: 'NAME_REQUIRED' },
      { body: { name: 'A', email: nextEmail(), password: PASSWORD }, code: 'NAME_TOO_SHORT' },
      { body: { name: 'Valid', email: 'not-an-email', password: PASSWORD }, code: 'EMAIL_INVALID' },
      { body: { name: 'Valid', email: nextEmail(), password: 'short1' }, code: 'PASSWORD_TOO_SHORT' },
      {
        body: { name: 'Valid', email: nextEmail(), password: PASSWORD, confirmPassword: 'different-pass-1' },
        code: 'PASSWORD_MISMATCH',
      },
    ]

    for (const testCase of cases) {
      const result = await api('/api/auth/signup', { method: 'POST', body: testCase.body })
      expect(result.status, testCase.code).toBe(400)
      expect(result.body.error.code).toBe(testCase.code)
    }
  })

  it('returns one generic error for both a wrong password and an unknown account', async () => {
    const email = nextEmail('generic')
    expect((await signupAccount({ email })).status).toBe(201)

    const wrongPassword = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'definitely-wrong-1' },
    })
    const unknownAccount = await api('/api/auth/login', {
      method: 'POST',
      body: { email: nextEmail('missing'), password: 'definitely-wrong-1' },
    })

    expect(wrongPassword.status).toBe(401)
    expect(unknownAccount.status).toBe(401)
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS')
    expect(unknownAccount.body.error.code).toBe('INVALID_CREDENTIALS')
    expect(wrongPassword.body).toEqual(unknownAccount.body)
  })

  it('logs in with stored credentials and can resolve the current account', async () => {
    const email = nextEmail('login')
    await signupAccount({ email, name: 'Grace Hopper' })

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: email.toUpperCase(), password: PASSWORD },
    })
    expect(login.status).toBe(200)
    expect(login.body.user.name).toBe('Grace Hopper')
    expect(login.cookie).toContain('ps_account=')

    const me = await api('/api/auth/me', { cookie: login.cookie })
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
    expect(me.body.user.passwordHash).toBeUndefined()

    const anonymous = await api('/api/auth/me')
    expect(anonymous.status).toBe(401)
  })

  it('refuses a room token without a signed-in account', async () => {
    const result = await api('/api/auth/session', {
      method: 'POST',
      body: { roomId: 'design-team', name: 'Mallory' },
    })
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe(AUTH_CODES.REQUIRED)
  })

  it('binds the room token and socket identity to the account, not the payload', async () => {
    const email = nextEmail('identity')
    const account = await signupAccount({ email, name: 'Real Name' })

    const session = await api('/api/auth/session', {
      method: 'POST',
      cookie: account.cookie,
      body: { roomId: 'design-team', name: 'Mallory Impostor' },
    })
    expect(session.status).toBe(200)
    // The client-supplied name is ignored.
    expect(session.body.name).toBe('Real Name')

    const claims = verifySessionToken(session.body.token, TEST_SECRET).claims
    expect(claims.sub).toBe(account.body.user.id)
    expect(claims.name).toBe('Real Name')

    const socket = await connectSocket(session.body.token)
    try {
      socket.emit('office:join', { roomId: 'design-team', user: { name: 'Mallory Impostor' } })
      const joined = await once(socket, 'office:joined')
      expect(joined.roomId).toBe('design-team')
      expect(joined.name).toBeUndefined()
    } finally {
      socket.disconnect()
    }
  })

  it('uses the account display name in presence broadcasts', async () => {
    const alice = await signupAccount({ name: 'Alice Account' })
    const bob = await signupAccount({ name: 'Bob Account' })

    const aliceSession = await api('/api/auth/session', {
      method: 'POST',
      cookie: alice.cookie,
      body: { roomId: 'design-team' },
    })
    const bobSession = await api('/api/auth/session', {
      method: 'POST',
      cookie: bob.cookie,
      body: { roomId: 'design-team' },
    })

    const aliceSocket = await connectSocket(aliceSession.body.token)
    try {
      aliceSocket.emit('office:join', { roomId: 'design-team' })
      await once(aliceSocket, 'office:joined')

      const bobSocket = await connectSocket(bobSession.body.token)
      try {
        // Register the listener before Bob joins so the broadcast cannot be missed.
        const presencePromise = once(aliceSocket, 'presence:joined')
        // Bob claims a different name in the payload; the server signs his real one.
        bobSocket.emit('office:join', { roomId: 'design-team', user: { name: 'Carlos' } })
        await once(bobSocket, 'office:joined')
        const presence = await presencePromise
        expect(presence.name).toBe('Bob Account')
      } finally {
        bobSocket.disconnect()
      }
    } finally {
      aliceSocket.disconnect()
    }
  })

  it('rejects a socket without a room token', async () => {
    await expect(connectSocket(null)).rejects.toMatchObject({
      data: { code: AUTH_CODES.REQUIRED },
    })
  })

  it('updates the display name and preferred room on the account', async () => {
    const account = await signupAccount({ name: 'Before Name' })

    const updated = await api('/api/auth/me', {
      method: 'PATCH',
      cookie: account.cookie,
      body: { name: 'After Name', preferences: { defaultRoom: 'ops' } },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.user.name).toBe('After Name')
    expect(updated.body.user.preferences.defaultRoom).toBe('ops')

    // The next room token carries the new name, proving it is read from the store.
    const session = await api('/api/auth/session', {
      method: 'POST',
      cookie: account.cookie,
      body: { roomId: 'ops' },
    })
    expect(session.body.name).toBe('After Name')

    const rejected = await api('/api/auth/me', {
      method: 'PATCH',
      cookie: account.cookie,
      body: { preferences: { defaultRoom: 'not a room!' } },
    })
    expect(rejected.status).toBe(400)
  })

  it('logout clears the cookie and invalidates the account and its room tokens', async () => {
    const account = await signupAccount({ name: 'Logout User' })
    const session = await api('/api/auth/session', {
      method: 'POST',
      cookie: account.cookie,
      body: { roomId: 'design-team' },
    })
    const token = session.body.token

    const socket = await connectSocket(token)
    socket.emit('office:join', { roomId: 'design-team' })
    await once(socket, 'office:joined')

    const disconnected = once(socket, 'disconnect')
    const logout = await api('/api/auth/logout', { method: 'POST', cookie: account.cookie })
    expect(logout.status).toBe(200)
    expect(logout.setCookie.toLowerCase()).toContain('max-age=0')

    // The live socket for this account is closed by the server.
    await disconnected

    // The cookie no longer resolves.
    expect((await api('/api/auth/me', { cookie: account.cookie })).status).toBe(401)

    // A room token issued before logout cannot reconnect.
    await expect(connectSocket(token)).rejects.toMatchObject({
      data: { code: AUTH_CODES.REVOKED },
    })

    // Nor can it fetch ICE credentials.
    const ice = await api('/api/ice', { headers: { authorization: `Bearer ${token}` } })
    expect(ice.status).toBe(401)
  })

  it('rate limits repeated password guesses for one account', async () => {
    const email = nextEmail('ratelimit')
    await signupAccount({ email })

    let lastStatus = 0
    let lastCode = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: { email, password: 'wrong-password-1' },
      })
      lastStatus = result.status
      lastCode = result.body?.error?.code
      if (lastStatus === 429) break
    }

    expect(lastStatus).toBe(429)
    expect(lastCode).toBe('RATE_LIMITED')
  })
})
