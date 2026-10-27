#!/usr/bin/env node
// Trusted-issuer session minting (the identity-provider integration boundary).
//
// ProxiSpeak does not ship an identity provider. What it ships is the *boundary*
// an identity provider plugs into: a session token signed with SESSION_SECRET,
// carrying a server-chosen subject, a normalised display name and exactly one
// room. An upstream service that authenticates a real human (SSO, LDAP, an
// internal directory) mints that token here and hands it to the browser, which
// presents it in the Socket.IO handshake. The server then verifies the signature
// and enforces the room binding exactly as it does for its own issuer.
//
// The right way to wire a real IdP is to call the exported function, not the CLI:
//
//   import { mintSession } from './session-issuer.js'
//   const { token, claims } = mintSession({ secret, subject, name, room, ttlSeconds })
//
// `subject` MUST be the stable identifier from the IdP (user id, not email, not a
// client-supplied string). Once that is in place the development issuer in
// server.js can be disabled with AUTH_ALLOW_ANONYMOUS=false and no JOIN_CODE.
//
// This CLI exists for operators and for tests, so a pilot can hand-provision a
// session without writing code.
//
// Usage
//   SESSION_SECRET=<>=32 chars> node mint-session.js \
//     --room design-team --name "Alice" [--subject <idp-user-id>] [--ttl 3600]
//
// Output: a single JSON object on stdout with `token`, `roomId`, `name`,
// `subject` and `expiresAt`. The token IS a credential — treat stdout as a
// secret, never paste it into a ticket, log aggregator, or report. The signing
// secret itself is never printed.

import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { issueSession, MIN_SESSION_SECRET_LENGTH } from './auth.js'
import { sanitizeRoomId, sanitizeDisplayName } from './config.js'

export const DEFAULT_ISSUER_TTL_SECONDS = 3600

function arg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined ? fallback : value
}

// Mint one session token. Throws on any invalid input so a caller cannot
// accidentally issue a session with a weak secret, an unsafe room id, or a
// client-supplied identity pretending to be the issuer.
export function mintSession({
  secret,
  subject,
  name,
  room,
  ttlSeconds = DEFAULT_ISSUER_TTL_SECONDS,
  now = Date.now(),
} = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters to mint a session`,
    )
  }

  const roomId = sanitizeRoomId(room)
  if (!roomId) {
    throw new Error('--room must be a valid room id (letters, digits, ".", "_", "-", max 64 chars)')
  }

  // The subject is the identity. If the operator does not supply one we generate
  // a non-identifying id rather than inventing a person.
  const resolvedSubject =
    typeof subject === 'string' && subject.trim().length > 0
      ? subject.trim().slice(0, 128)
      : crypto.randomUUID()

  const { token, claims } = issueSession({
    subject: resolvedSubject,
    name: sanitizeDisplayName(name),
    room: roomId,
    secret,
    ttlSeconds,
    now,
  })

  return {
    token,
    roomId: claims.room,
    name: claims.name,
    subject: claims.sub,
    expiresAt: claims.exp * 1000,
  }
}

function main(argv = process.argv.slice(2)) {
  const secret = process.env.SESSION_SECRET
  const room = arg(argv, 'room', process.env.PROXISPEAK_ROOM)
  const name = arg(argv, 'name', process.env.PROXISPEAK_NAME)
  const subject = arg(argv, 'subject', process.env.PROXISPEAK_SUBJECT)
  const ttl = Number(arg(argv, 'ttl', process.env.PROXISPEAK_TTL))

  if (!room) {
    console.error('FATAL: --room is required (the token is bound to exactly one room).')
    process.exit(2)
  }

  try {
    const result = mintSession({
      secret,
      subject,
      name,
      room,
      ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ISSUER_TTL_SECONDS,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    console.error(`FATAL: ${error.message}`)
    process.exit(1)
  }
}

// Only run as a CLI when executed directly (importing the module must not exit).
// pathToFileURL handles Windows drive letters and spaces in the repo path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
