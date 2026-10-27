// ICE server configuration (STUN + optional TURN) for ProxiSpeak.
//
// STUN lets two peers discover their public addresses. It is not enough when
// either peer sits behind a symmetric NAT or a restrictive firewall: those need a
// TURN relay. TURN is optional and configured entirely from the environment; no
// credentials are hardcoded here or in the client.
//
// Supported environment variables:
//   STUN_URLS        comma-separated stun:/stuns: URLs (defaults to Google STUN)
//   TURN_URLS        comma-separated turn:/turns: URLs
//   TURN_SECRET      shared secret for ephemeral credentials (coturn
//                    `use-auth-secret` / TURN REST API style). Preferred.
//   TURN_USERNAME    static TURN username (only if TURN_SECRET is absent)
//   TURN_CREDENTIAL  static TURN credential
//   TURN_TTL_SECONDS lifetime of ephemeral credentials (default 3600)
//
// The credentials are handed to authenticated clients through GET /api/ice, not
// compiled into the frontend bundle, so rotating them does not require a rebuild.

import crypto from 'node:crypto'

export const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export const DEFAULT_TURN_TTL_SECONDS = 3600
export const MIN_TURN_SECRET_LENGTH = 16

function splitUrls(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

export function parseStunUrls(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { urls: [], error: null }
  const urls = splitUrls(raw)
  for (const url of urls) {
    if (!/^stuns?:[^\s,]+$/i.test(url)) {
      return { urls: [], error: `STUN_URLS entry is not a stun:/stuns: URL: ${url}` }
    }
  }
  return { urls, error: null }
}

// ICE transport policy is how a relay-only verification run is expressed. The
// default is 'all' (host/srflx/relay), which is what a normal deployment wants.
// 'relay' is only meaningful with a working TURN server: without one the agent
// has no candidate to use, so the configuration is rejected instead of producing
// a connection that silently never establishes.
export const ICE_TRANSPORT_POLICIES = ['all', 'relay']

export function parseIceTransportPolicy(raw) {
  if (raw === undefined || raw === null || raw === '') return { policy: 'all', error: null }
  const policy = String(raw).trim().toLowerCase()
  if (!ICE_TRANSPORT_POLICIES.includes(policy)) {
    return { policy: 'all', error: `ICE_TRANSPORT_POLICY must be "all" or "relay"` }
  }
  return { policy, error: null }
}

export function parseTurnUrls(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { urls: [], error: null }
  const urls = splitUrls(raw)
  for (const url of urls) {
    if (!/^turns?:[^\s,]+$/i.test(url)) {
      return { urls: [], error: `TURN_URLS entry is not a turn:/turns: URL: ${url}` }
    }
  }
  return { urls, error: null }
}

// coturn `use-auth-secret` credentials: username is "<expiry>:<subject>" and the
// credential is base64(HMAC-SHA1(username, secret)). They expire on their own, so
// a leaked credential is useless after the TTL.
export function createTurnCredentials({
  secret,
  subject = 'guest',
  ttlSeconds = DEFAULT_TURN_TTL_SECONDS,
  now = Date.now(),
}) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('TURN secret is required')
  }
  const ttl = Math.max(60, Math.min(24 * 60 * 60, Math.floor(Number(ttlSeconds) || DEFAULT_TURN_TTL_SECONDS)))
  const expiresAt = Math.floor(now / 1000) + ttl
  const username = `${expiresAt}:${subject}`
  const credential = crypto.createHmac('sha1', secret).update(username, 'utf8').digest('base64')
  return { username, credential, expiresAt: expiresAt * 1000 }
}

// Build the ICE server list a client should use. Returns `{ iceServers,
// turnEnabled, warnings, error }`; `error` describes configuration that cannot be
// used, and the caller decides whether that is fatal (production) or a warning
// (development).
export function buildIceConfiguration(env = process.env, { subject = 'guest', now = Date.now() } = {}) {
  const warnings = []

  const transport = parseIceTransportPolicy(env.ICE_TRANSPORT_POLICY)
  if (transport.error) {
    return { iceServers: [], turnEnabled: false, warnings, error: transport.error }
  }

  const stun = parseStunUrls(env.STUN_URLS)
  if (stun.error) {
    return { iceServers: [], turnEnabled: false, warnings, error: stun.error }
  }
  const iceServers =
    stun.urls.length > 0
      ? stun.urls.map(urls => ({ urls }))
      : DEFAULT_STUN_SERVERS.map(server => ({ ...server }))

  const turn = parseTurnUrls(env.TURN_URLS)
  if (turn.error) {
    return { iceServers, turnEnabled: false, warnings, error: turn.error }
  }
  if (turn.urls.length === 0) {
    if (transport.policy === 'relay') {
      return {
        iceServers,
        turnEnabled: false,
        warnings,
        error: 'ICE_TRANSPORT_POLICY=relay requires TURN_URLS and valid TURN credentials',
      }
    }
    return { iceServers, turnEnabled: false, iceTransportPolicy: transport.policy, warnings }
  }

  const secret = env.TURN_SECRET
  if (typeof secret === 'string' && secret.length > 0) {
    if (secret.length < MIN_TURN_SECRET_LENGTH) {
      return {
        iceServers,
        turnEnabled: false,
        warnings,
        error: `TURN_SECRET must be at least ${MIN_TURN_SECRET_LENGTH} characters`,
      }
    }
    const requestedTtl = Number(env.TURN_TTL_SECONDS)
    const credentials = createTurnCredentials({
      secret,
      subject,
      ttlSeconds: Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl : DEFAULT_TURN_TTL_SECONDS,
      now,
    })
    iceServers.push({
      urls: turn.urls,
      username: credentials.username,
      credential: credentials.credential,
    })
    return {
      iceServers,
      turnEnabled: true,
      ephemeral: true,
      iceTransportPolicy: transport.policy,
      turnCredentialExpiresAt: credentials.expiresAt,
      warnings,
    }
  }

  if (typeof env.TURN_USERNAME === 'string' && env.TURN_USERNAME.length > 0 &&
      typeof env.TURN_CREDENTIAL === 'string' && env.TURN_CREDENTIAL.length > 0) {
    warnings.push('Using static TURN credentials; prefer TURN_SECRET with ephemeral credentials.')
    iceServers.push({
      urls: turn.urls,
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL,
    })
    return {
      iceServers,
      turnEnabled: true,
      ephemeral: false,
      iceTransportPolicy: transport.policy,
      warnings,
    }
  }

  return {
    iceServers,
    turnEnabled: false,
    iceTransportPolicy: transport.policy,
    warnings,
    error: 'TURN_URLS is set but neither TURN_SECRET nor TURN_USERNAME/TURN_CREDENTIAL is configured',
  }
}

// Convenience for startup validation: a non-null return is a configuration error.
export function validateTurnConfig(env = process.env) {
  return buildIceConfiguration(env).error || null
}
