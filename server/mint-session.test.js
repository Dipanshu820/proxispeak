// The identity-provider integration boundary.
//
// There is no IdP in this repository, so these tests do NOT prove that a human
// was authenticated. They prove the contract an upstream issuer must satisfy:
// what it hands over, what the server will accept, and what it refuses to mint.
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintSession, DEFAULT_ISSUER_TTL_SECONDS } from './mint-session.js'
import { verifySessionToken, MIN_SESSION_SECRET_LENGTH } from './auth.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(SERVER_DIR, 'mint-session.js')
const TEST_SECRET = 'mint-session-test-secret-0123456789-abcdefgh'

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, SESSION_SECRET: TEST_SECRET, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('exit', code => resolve({ code, stdout, stderr }))
    child.once('error', reject)
  })
}

describe('trusted-issuer session minting', () => {
  it('mints a token the verifier accepts, bound to one room', () => {
    const result = mintSession({
      secret: TEST_SECRET,
      subject: 'idp-user-42',
      name: '  Alice   Smith ',
      room: 'design-team',
      ttlSeconds: 600,
    })

    expect(result.roomId).toBe('design-team')
    expect(result.name).toBe('Alice Smith')
    expect(result.subject).toBe('idp-user-42')

    const verified = verifySessionToken(result.token, TEST_SECRET)
    expect(verified.ok).toBe(true)
    expect(verified.claims.sub).toBe('idp-user-42')
    expect(verified.claims.room).toBe('design-team')
    expect(verified.claims.jti).toBeTruthy()
    expect(verified.claims.exp - verified.claims.iat).toBe(600)
  })

  it('generates a non-identifying subject when the issuer omits one', () => {
    const first = mintSession({ secret: TEST_SECRET, room: 'ops', name: 'Guest' })
    const second = mintSession({ secret: TEST_SECRET, room: 'ops', name: 'Guest' })

    expect(first.subject).toMatch(/^[0-9a-f-]{36}$/)
    // Two sessions must never share a subject: the server evicts the older
    // socket when it sees the same subject twice.
    expect(second.subject).not.toBe(first.subject)
  })

  it('defaults the lifetime and refuses a weak signing secret', () => {
    const result = mintSession({ secret: TEST_SECRET, room: 'ops', name: 'Guest' })
    const verified = verifySessionToken(result.token, TEST_SECRET)
    expect(verified.claims.exp - verified.claims.iat).toBe(DEFAULT_ISSUER_TTL_SECONDS)

    expect(() => mintSession({ secret: 'too-short', room: 'ops', name: 'Guest' }))
      .toThrow(new RegExp(String(MIN_SESSION_SECRET_LENGTH)))
    expect(() => mintSession({ room: 'ops', name: 'Guest' })).toThrow(/SESSION_SECRET/)
  })

  it('refuses an unsafe or missing room instead of minting a broad token', () => {
    expect(() => mintSession({ secret: TEST_SECRET, name: 'Guest' })).toThrow(/room/)
    expect(() => mintSession({ secret: TEST_SECRET, room: 'room/../other', name: 'Guest' }))
      .toThrow(/room/)
    expect(() => mintSession({ secret: TEST_SECRET, room: 'x'.repeat(65), name: 'Guest' }))
      .toThrow(/room/)
  })

  it('sanitizes the display name instead of trusting issuer input', () => {
    const result = mintSession({
      secret: TEST_SECRET,
      room: 'ops',
      name: 'Ali\u0000ce\n\tSmith',
    })
    expect(result.name).toBe('Ali ce Smith')
  })

  it('issues a usable token from the CLI and never prints the signing secret', async () => {
    const { code, stdout, stderr } = await runCli([
      '--room', 'design-team', '--name', 'Alice', '--subject', 'idp-7', '--ttl', '120',
    ])

    expect(code).toBe(0)
    expect(stderr).toBe('')

    const payload = JSON.parse(stdout)
    expect(payload.roomId).toBe('design-team')
    expect(payload.subject).toBe('idp-7')
    const verified = verifySessionToken(payload.token, TEST_SECRET)
    expect(verified.ok).toBe(true)
    expect(verified.claims.exp - verified.claims.iat).toBe(120)

    // The output is a credential, but it must never contain the signing secret.
    expect(stdout).not.toContain(TEST_SECRET)
  })

  it('exits nonzero with a clear message when misconfigured', async () => {
    const noRoom = await runCli(['--name', 'Alice'])
    expect(noRoom.code).toBe(2)
    expect(noRoom.stderr).toMatch(/--room is required/)

    const weakSecret = await runCli(['--room', 'ops'], { SESSION_SECRET: 'short' })
    expect(weakSecret.code).toBe(1)
    expect(weakSecret.stderr).toMatch(/at least/)
    expect(weakSecret.stdout).toBe('')

    const badRoom = await runCli(['--room', 'bad room'])
    expect(badRoom.code).toBe(1)
    expect(badRoom.stdout).toBe('')
  })
})
