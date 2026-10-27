import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioc } from 'socket.io-client'
import {
  DEFAULT_CLIENT_ORIGIN,
  MAX_DISPLAY_NAME_LENGTH,
  isRoomAllowed,
  parseAllowedRooms,
  parseClientOrigins,
  sanitizeDisplayName,
  sanitizeRoomId,
  validateClientOrigin,
  validateClientOrigins,
} from './config.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js')

// ---------------------------------------------------------------------------
// Pure guard: what counts as an acceptable production CLIENT_ORIGIN
// ---------------------------------------------------------------------------
describe('validateClientOrigin', () => {
  it('allows the default origin in development and test', () => {
    expect(validateClientOrigin(DEFAULT_CLIENT_ORIGIN, 'development')).toBeNull()
    expect(validateClientOrigin(undefined, 'test')).toBeNull()
  })

  it('rejects a missing origin in production', () => {
    expect(validateClientOrigin(undefined, 'production')).toMatch(/not configured/)
    expect(validateClientOrigin('', 'production')).toMatch(/not configured/)
  })

  it('rejects the development default in production', () => {
    expect(validateClientOrigin(DEFAULT_CLIENT_ORIGIN, 'production')).toMatch(/not configured/)
  })

  it('rejects a wildcard origin in production', () => {
    expect(validateClientOrigin('*', 'production')).toMatch(/wildcard/)
    expect(validateClientOrigin('https://*.example.com', 'production')).toMatch(/wildcard/)
  })

  it('rejects a malformed origin in production', () => {
    expect(validateClientOrigin('not-a-url', 'production')).toMatch(/not a valid absolute URL/)
    expect(validateClientOrigin('proxispeak.example.com', 'production')).toMatch(/not a valid absolute URL/)
  })

  it('rejects non-https schemes in production by default', () => {
    expect(validateClientOrigin('ftp://proxispeak.example.com', 'production')).toMatch(/must use https:/)
    expect(validateClientOrigin('file:///c:/app', 'production')).toMatch(/must use https:/)
  })

  it('still accepts http: origins in production when explicitly opted in', () => {
    // Production default is https only. A deployment that legitimately cannot use TLS
    // (for example a fully isolated/internal pilot) can opt in explicitly rather than
    // silently allowing http: everywhere.
    const orig = process.env.PROXISPEAK_ALLOW_HTTP_ORIGIN
    try {
      process.env.PROXISPEAK_ALLOW_HTTP_ORIGIN = 'true'
      expect(validateClientOrigin('http://proxispeak.example.com', 'production')).toBeNull()
      expect(validateClientOrigin('http://192.0.2.10:8080', 'production')).toBeNull()
    } finally {
      if (orig === undefined) delete process.env.PROXISPEAK_ALLOW_HTTP_ORIGIN
      else process.env.PROXISPEAK_ALLOW_HTTP_ORIGIN = orig
    }
  })

  it('rejects an origin that carries a path, query, or fragment', () => {
    expect(validateClientOrigin('https://proxispeak.example.com/app', 'production')).toMatch(/bare origin/)
    expect(validateClientOrigin('https://proxispeak.example.com/?x=1', 'production')).toMatch(/bare origin/)
    expect(validateClientOrigin('https://proxispeak.example.com/#x', 'production')).toMatch(/bare origin/)
  })

  it('accepts a legitimate absolute origin in production', () => {
    expect(validateClientOrigin('https://proxispeak.example.com', 'production')).toBeNull()
    expect(validateClientOrigin('https://proxispeak.example.com/', 'production')).toBeNull()
    // Plaintext http: origins are rejected in production by default; a trusted internal
    // pilot that cannot use TLS must opt in explicitly (see the http: opt-in test).
    expect(validateClientOrigin('http://192.0.2.10:8080', 'production')).toMatch(/must use https:/)
  })
})

// ---------------------------------------------------------------------------
// Multiple allowed origins (apex + www, or dev + preview server)
// ---------------------------------------------------------------------------
describe('CLIENT_ORIGIN list', () => {
  it('parses and trims a comma-separated list', () => {
    expect(parseClientOrigins('https://a.example, https://b.example,,')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
    expect(parseClientOrigins(undefined)).toEqual([])
  })

  it('accepts several valid origins in production and rejects one bad entry', () => {
    expect(
      validateClientOrigins('https://proxispeak.example.com,https://www.proxispeak.example.com', 'production'),
    ).toBeNull()
    expect(
      validateClientOrigins('https://ok.example,not-a-url', 'production'),
    ).toMatch(/not a valid absolute URL/)
    expect(
      validateClientOrigins('https://ok.example,https://*.evil.example', 'production'),
    ).toMatch(/wildcard/)
    // A mixed https + plain-http production list is rejected unless explicitly opted in.
    expect(
      validateClientOrigins('https://ok.example,http://internal.example', 'production'),
    ).toMatch(/must use https:/)
  })

  it('fails closed on an empty list in production', () => {
    expect(validateClientOrigins('', 'production')).toMatch(/not configured/)
    expect(validateClientOrigins(' , ', 'production')).toMatch(/not configured/)
  })

  it('does not restrict origins outside production', () => {
    expect(validateClientOrigins('http://localhost:4173', 'development')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Room ids (session claim + socket room name)
// ---------------------------------------------------------------------------
describe('sanitizeRoomId', () => {
  it('accepts ordinary room ids and trims them', () => {
    expect(sanitizeRoomId('design-team')).toBe('design-team')
    expect(sanitizeRoomId('  ops_1 ')).toBe('ops_1')
  })

  it('rejects blank, oversized, or unsafe room ids', () => {
    expect(sanitizeRoomId('')).toBeNull()
    expect(sanitizeRoomId('   ')).toBeNull()
    expect(sanitizeRoomId(null)).toBeNull()
    expect(sanitizeRoomId('x'.repeat(65))).toBeNull()
    expect(sanitizeRoomId('room with spaces')).toBeNull()
    expect(sanitizeRoomId('room/../other')).toBeNull()
    expect(sanitizeRoomId('room\u0000')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Display names are untrusted text, not identity
// ---------------------------------------------------------------------------
describe('sanitizeDisplayName', () => {
  it('keeps ordinary names intact', () => {
    expect(sanitizeDisplayName('Alice')).toBe('Alice')
    expect(sanitizeDisplayName('  Alice Smith  ')).toBe('Alice Smith')
  })

  it('falls back to Guest for missing or blank input', () => {
    expect(sanitizeDisplayName(undefined)).toBe('Guest')
    expect(sanitizeDisplayName(null)).toBe('Guest')
    expect(sanitizeDisplayName(42)).toBe('Guest')
    expect(sanitizeDisplayName('')).toBe('Guest')
    expect(sanitizeDisplayName('   ')).toBe('Guest')
  })

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeDisplayName('Ali\u0000ce\n\tSmith')).toBe('Ali ce Smith')
    expect(sanitizeDisplayName('A   B')).toBe('A B')
  })

  it('caps the length so a client cannot flood presence payloads', () => {
    const long = 'x'.repeat(500)
    expect(sanitizeDisplayName(long)).toHaveLength(MAX_DISPLAY_NAME_LENGTH)
  })
})

// ---------------------------------------------------------------------------
// Room allowlist (deployment control, not authentication)
// ---------------------------------------------------------------------------
describe('room allowlist', () => {
  it('parses a comma-separated list and ignores whitespace/empties', () => {
    expect(parseAllowedRooms('design-team, ops ,,')).toEqual(['design-team', 'ops'])
    expect(parseAllowedRooms(undefined)).toEqual([])
    expect(parseAllowedRooms('')).toEqual([])
  })

  it('allows everything when the list is empty', () => {
    expect(isRoomAllowed('anything', [])).toBe(true)
    expect(isRoomAllowed('anything', undefined)).toBe(true)
  })

  it('allows only listed rooms when configured', () => {
    const allowed = parseAllowedRooms('design-team,ops')
    expect(isRoomAllowed('design-team', allowed)).toBe(true)
    expect(isRoomAllowed('ops', allowed)).toBe(true)
    expect(isRoomAllowed('secret-room', allowed)).toBe(false)
    expect(isRoomAllowed('', allowed)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real process: the guard must exit nonzero before the server listens
// ---------------------------------------------------------------------------
// Boot the real entrypoint and resolve once it reports that it is listening.
function startServer(overrides, timeout = 20_000) {
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
      reject(new Error(`server did not start in ${timeout}ms\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeout)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.includes('listening')) {
        clearTimeout(timer)
        resolve({ child, stdout, stderr })
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
  })
}

function cleanEnv(overrides) {
  const env = {
    ...process.env,
    USER_STORE_FILE: path.join(os.tmpdir(), `ps-startup-test-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
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

const TEST_SECRET = 'startup-test-secret-0123456789-abcdefghijklmnop'

// Spawn the real entrypoint. Resolves with the exit code and output. When
// `waitForListening` is set, resolves as soon as the server logs that it is
// listening (and then terminates it) instead of waiting for a natural exit.
function runServer(overrides, { waitForListening = false, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: cleanEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`server did not settle in ${timeout}ms\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeout)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (waitForListening && stdout.includes('listening')) {
        child.kill()
        finish({ code: null, signal: 'SIGTERM', stdout, stderr, started: true })
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('exit', code => {
      finish({ code, signal: null, stdout, stderr, started: stdout.includes('listening') })
    })
    child.once('error', reject)
  })
}

describe('production startup guard (real process exit codes)', () => {
  it('exits nonzero when CLIENT_ORIGIN is missing in production', async () => {
    const result = await runServer({ NODE_ENV: 'production', PORT: '4310' })
    expect(result.started).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('FATAL')
    expect(result.stderr).toContain('CLIENT_ORIGIN')
  }, 30_000)

  it('exits nonzero when CLIENT_ORIGIN is a wildcard in production', async () => {
    const result = await runServer({ NODE_ENV: 'production', PORT: '4311', CLIENT_ORIGIN: '*' })
    expect(result.started).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('wildcard')
  }, 30_000)

  it('exits nonzero when CLIENT_ORIGIN is malformed in production', async () => {
    const result = await runServer({ NODE_ENV: 'production', PORT: '4312', CLIENT_ORIGIN: 'not-a-url' })
    expect(result.started).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not a valid absolute URL')
  }, 30_000)

  it('starts when CLIENT_ORIGIN is a valid production origin', async () => {
    const result = await runServer(
      {
        NODE_ENV: 'production',
        PORT: '4313',
        CLIENT_ORIGIN: 'https://proxispeak.example.com',
        // Production requires a signing secret (Phase 3.10). Without it the
        // server now exits rather than issuing unsigned sessions.
        SESSION_SECRET: TEST_SECRET,
      },
      { waitForListening: true },
    )
    expect(result.started).toBe(true)
    expect(result.stdout).toContain('ProxiSpeak server listening')
  }, 30_000)

  it('enforces ALLOWED_ROOMS on the real server (issuance and join)', async () => {
    const baseUrl = 'http://127.0.0.1:4325'
    const { child } = await startServer({
      NODE_ENV: 'development',
      PORT: '4325',
      ALLOWED_ROOMS: 'design-team,ops',
      SESSION_SECRET: TEST_SECRET,
    })
    let client
    try {
      // A session for an unlisted room is refused at issuance.
      const forbidden = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'secret-room', name: 'Mallory' }),
      })
      expect(forbidden.status).toBe(403)
      expect((await forbidden.json()).error.code).toBe('ROOM_FORBIDDEN')

      const issued = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'design-team', name: 'Mallory' }),
      })
      expect(issued.status).toBe(200)
      const { token } = await issued.json()

      client = ioc(baseUrl, { reconnection: false, transports: ['websocket'], auth: { token } })
      await new Promise((resolve, reject) => {
        client.once('connect', resolve)
        client.once('connect_error', reject)
      })

      // A token for design-team cannot be used to enter the other listed room.
      const crossed = await new Promise(resolve => {
        client.once('error', resolve)
        client.emit('office:join', { roomId: 'ops' })
      })
      expect(crossed.code).toBe('ROOM_FORBIDDEN')

      const joined = await new Promise(resolve => {
        client.once('office:joined', resolve)
        client.emit('office:join', { roomId: 'design-team' })
      })
      expect(joined.roomId).toBe('design-team')
    } finally {
      client?.disconnect()
      child.kill()
    }
  }, 30_000)

  it('starts with a comma-separated origin list in production', async () => {
    const result = await runServer(
      {
        NODE_ENV: 'production',
        PORT: '4316',
        CLIENT_ORIGIN: 'https://proxispeak.example.com,https://www.proxispeak.example.com',
        SESSION_SECRET: TEST_SECRET,
      },
      { waitForListening: true },
    )
    expect(result.started).toBe(true)
  }, 30_000)

  it('starts with the development default when NODE_ENV is not production', async () => {
    const result = await runServer(
      { NODE_ENV: 'development', PORT: '4314', SESSION_SECRET: TEST_SECRET },
      { waitForListening: true },
    )
    expect(result.started).toBe(true)
    expect(result.stdout).toContain('ProxiSpeak server listening')
  }, 30_000)
})
