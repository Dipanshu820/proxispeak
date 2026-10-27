import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_STUN_SERVERS,
  buildIceConfiguration,
  createTurnCredentials,
  parseIceTransportPolicy,
  parseStunUrls,
  parseTurnUrls,
  validateTurnConfig,
} from './ice.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js')
const TEST_SECRET = 'ice-test-session-secret-0123456789-abcdefghijk'
const TURN_SECRET = 'turn-shared-secret-0123456789'

describe('ICE URL parsing', () => {
  it('parses comma-separated TURN urls and trims whitespace', () => {
    expect(parseTurnUrls('turn:turn.example.com:3478, turns:turn.example.com:5349').urls).toEqual([
      'turn:turn.example.com:3478',
      'turns:turn.example.com:5349',
    ])
  })

  it('rejects non-TURN urls instead of silently accepting them', () => {
    expect(parseTurnUrls('stun:stun.example.com:3478').error).toMatch(/not a turn/)
    expect(parseTurnUrls('http://example.com').error).toMatch(/not a turn/)
  })

  it('treats unset or blank configuration as no TURN', () => {
    expect(parseTurnUrls(undefined)).toEqual({ urls: [], error: null })
    expect(parseTurnUrls('  ')).toEqual({ urls: [], error: null })
  })

  it('parses STUN overrides and rejects malformed ones', () => {
    expect(parseStunUrls('stun:stun.example.com:3478').urls).toEqual(['stun:stun.example.com:3478'])
    expect(parseStunUrls('turn:turn.example.com').error).toMatch(/not a stun/)
  })
})

describe('TURN credential generation', () => {
  it('matches the coturn use-auth-secret formula and expires', () => {
    const now = 1_700_000_000_000
    const credentials = createTurnCredentials({ secret: TURN_SECRET, subject: 'subject-1', ttlSeconds: 600, now })
    const expiry = Math.floor(now / 1000) + 600

    expect(credentials.username).toBe(`${expiry}:subject-1`)
    expect(credentials.expiresAt).toBe(expiry * 1000)
    const expected = crypto
      .createHmac('sha1', TURN_SECRET)
      .update(credentials.username, 'utf8')
      .digest('base64')
    expect(credentials.credential).toBe(expected)
  })

  it('never returns the shared secret itself', () => {
    const credentials = createTurnCredentials({ secret: TURN_SECRET, subject: 's' })
    expect(JSON.stringify(credentials)).not.toContain(TURN_SECRET)
  })
})

describe('buildIceConfiguration', () => {
  it('returns STUN only when TURN is not configured', () => {
    const result = buildIceConfiguration({})
    expect(result.error).toBeUndefined()
    expect(result.turnEnabled).toBe(false)
    expect(result.iceServers).toEqual(DEFAULT_STUN_SERVERS)
  })

  it('adds ephemeral TURN credentials when TURN_URLS and TURN_SECRET are set', () => {
    const result = buildIceConfiguration({
      TURN_URLS: 'turn:turn.example.com:3478',
      TURN_SECRET,
      TURN_TTL_SECONDS: '120',
    })
    expect(result.error).toBeUndefined()
    expect(result.turnEnabled).toBe(true)
    const turn = result.iceServers.find(server => String(server.urls).startsWith('turn:'))
    expect(turn).toBeTruthy()
    expect(turn.username).toMatch(/^\d+:guest$/)
    expect(typeof turn.credential).toBe('string')
    expect(JSON.stringify(result.iceServers)).not.toContain(TURN_SECRET)
  })

  it('supports static credentials but warns that they are not ephemeral', () => {
    const result = buildIceConfiguration({
      TURN_URLS: 'turns:turn.example.com:5349',
      TURN_USERNAME: 'static-user',
      TURN_CREDENTIAL: 'static-pass',
    })
    expect(result.turnEnabled).toBe(true)
    expect(result.ephemeral).toBe(false)
    expect(result.warnings.join(' ')).toMatch(/static TURN credentials/i)
  })

  it('reports an error when TURN urls have no credentials', () => {
    const result = buildIceConfiguration({ TURN_URLS: 'turn:turn.example.com:3478' })
    expect(result.turnEnabled).toBe(false)
    expect(result.error).toMatch(/neither TURN_SECRET nor TURN_USERNAME/)
    expect(validateTurnConfig({ TURN_URLS: 'turn:turn.example.com:3478' })).toMatch(/neither/)
  })

  it('rejects a weak TURN secret', () => {
    const result = buildIceConfiguration({ TURN_URLS: 'turn:x.example.com', TURN_SECRET: 'short' })
    expect(result.error).toMatch(/at least/)
  })
})

// ---------------------------------------------------------------------------
// Relay-only verification mode
// ---------------------------------------------------------------------------
describe('ICE transport policy', () => {
  it('defaults to all and accepts the relay policy', () => {
    expect(parseIceTransportPolicy(undefined)).toEqual({ policy: 'all', error: null })
    expect(parseIceTransportPolicy('')).toEqual({ policy: 'all', error: null })
    expect(parseIceTransportPolicy('all')).toEqual({ policy: 'all', error: null })
    expect(parseIceTransportPolicy(' RELAY ')).toEqual({ policy: 'relay', error: null })
  })

  it('rejects unknown policies instead of falling back silently', () => {
    const result = parseIceTransportPolicy('host')
    expect(result.error).toMatch(/must be "all" or "relay"/)
    expect(buildIceConfiguration({ ICE_TRANSPORT_POLICY: 'host' }).error).toMatch(/must be/)
  })

  it('passes the relay policy through when TURN is configured', () => {
    const result = buildIceConfiguration({
      TURN_URLS: 'turn:turn.example.com:3478',
      TURN_SECRET,
      ICE_TRANSPORT_POLICY: 'relay',
    })
    expect(result.error).toBeUndefined()
    expect(result.turnEnabled).toBe(true)
    expect(result.iceTransportPolicy).toBe('relay')
  })

  it('refuses relay-only mode without a TURN server', () => {
    // Relay-only with STUN alone can never gather a usable candidate pair, so this
    // is a configuration error rather than a silent no-connect.
    const result = buildIceConfiguration({ ICE_TRANSPORT_POLICY: 'relay' })
    expect(result.error).toMatch(/requires TURN_URLS/)
    expect(validateTurnConfig({ ICE_TRANSPORT_POLICY: 'relay' })).toMatch(/requires TURN_URLS/)
  })
})

// ---------------------------------------------------------------------------
// Real server endpoint: TURN credentials are served to authenticated sessions and
// never baked into the frontend bundle.
// ---------------------------------------------------------------------------
function startServer(env, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    // This suite is about ICE credential issuance, so it explicitly opts in to
    // the development anonymous-token escape hatch.
    const childEnv = {
      ...process.env,
      ...env,
      AUTH_ALLOW_ANONYMOUS: 'true',
      USER_STORE_FILE: path.join(os.tmpdir(), `ps-ice-test-users-${process.pid}.json`),
    }
    for (const key of ['MONGODB_URI', 'JOIN_CODE', 'ALLOWED_ROOMS']) {
      delete childEnv[key]
    }
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not start\n${stdout}\n${stderr}`))
    }, timeout)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.includes('listening')) {
        clearTimeout(timer)
        resolve({ child, baseUrl: `http://127.0.0.1:${env.PORT}` })
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
  })
}

describe('GET /api/ice on the real server', () => {
  it('serves ephemeral TURN credentials to a session and refuses anonymous callers', async () => {
    const { child, baseUrl } = await startServer({
      NODE_ENV: 'development',
      PORT: '4350',
      SESSION_SECRET: TEST_SECRET,
      TURN_URLS: 'turn:turn.example.com:3478',
      TURN_SECRET,
      TURN_TTL_SECONDS: '300',
    })
    try {
      expect((await fetch(`${baseUrl}/api/ice`)).status).toBe(401)

      const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'design-team', name: 'Alice' }),
      })
      const { token } = await sessionRes.json()

      const res = await fetch(`${baseUrl}/api/ice`, { headers: { authorization: `Bearer ${token}` } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.turnEnabled).toBe(true)
      const turn = body.iceServers.find(server => String(server.urls).startsWith('turn:'))
      expect(turn.username).toMatch(/^\d+:[0-9a-f-]{36}$/)
      expect(turn.credential).toBeTruthy()
      expect(JSON.stringify(body)).not.toContain(TURN_SECRET)
      expect(res.headers.get('cache-control')).toContain('no-store')
    } finally {
      child.kill()
    }
  }, 30_000)
})
