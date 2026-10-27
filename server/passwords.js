// Password hashing and password/email/name validation.
//
// Hashing uses scrypt from Node's built-in crypto module (OpenSSL). It is a
// memory-hard, salted KDF designed for exactly this purpose, and it ships with
// Node, so there is no native build step to fail on a contributor's machine.
//
// Stored format: `scrypt$<N>$<r>$<p>$<salt-b64url>$<key-b64url>`
// The parameters are stored with the hash so they can be raised later without
// invalidating existing accounts (verify reads them from the record). No
// plaintext password is ever logged, returned, or persisted.

import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(crypto.scrypt)

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 200
export const MAX_EMAIL_LENGTH = 254
export const MIN_NAME_LENGTH = 2
export const MAX_NAME_LENGTH = 40

// OWASP-recommended scrypt baseline (N=2^14, r=8, p=1). 128 * N * r = 16 MiB of
// memory per hash; maxmem is raised above the 32 MiB default guard so the
// parameters are accepted on every Node release.
export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 })
const SALT_BYTES = 16

export const PASSWORD_CODES = {
  REQUIRED: 'PASSWORD_REQUIRED',
  TOO_SHORT: 'PASSWORD_TOO_SHORT',
  TOO_LONG: 'PASSWORD_TOO_LONG',
  TOO_WEAK: 'PASSWORD_TOO_WEAK',
}

// Normalize before hashing so visually identical passwords (e.g. composed vs
// decomposed accents) verify consistently across devices.
function normalized(password) {
  return typeof password === 'string' ? password.normalize('NFKC') : ''
}

// Policy: 10-200 characters, at least one letter and one digit. Deliberately
// modest and documented rather than a hidden composition rule maze; the length
// floor is the part that actually matters.
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, code: PASSWORD_CODES.REQUIRED }
  }
  const value = normalized(password)
  if (value.length < MIN_PASSWORD_LENGTH) return { ok: false, code: PASSWORD_CODES.TOO_SHORT }
  if (value.length > MAX_PASSWORD_LENGTH) return { ok: false, code: PASSWORD_CODES.TOO_LONG }
  if (!/\p{L}/u.test(value) || !/\p{N}/u.test(value)) {
    return { ok: false, code: PASSWORD_CODES.TOO_WEAK }
  }
  return { ok: true }
}

export async function hashPassword(password) {
  const value = normalized(password)
  if (value.length === 0) throw new Error('Cannot hash an empty password')

  const salt = crypto.randomBytes(SALT_BYTES)
  const key = await scryptAsync(value, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  })

  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [, n, r, p, saltB64, keyB64] = parts
  const params = { N: Number(n), r: Number(r), p: Number(p) }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return null
  if (params.N < 1024 || params.N > 1 << 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) return null
  let salt
  let key
  try {
    salt = Buffer.from(saltB64, 'base64url')
    key = Buffer.from(keyB64, 'base64url')
  } catch {
    return null
  }
  if (salt.length < 8 || key.length < 16) return null
  return { ...params, salt, key }
}

// Constant-time verification. Any malformed/unrecognized hash is treated as a
// mismatch (not an exception), so a corrupted record cannot crash login.
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored)
  if (!parsed) return false
  if (typeof password !== 'string' || password.length === 0) return false

  try {
    const derived = await scryptAsync(normalized(password), parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    })
    if (derived.length !== parsed.key.length) return false
    return crypto.timingSafeEqual(derived, parsed.key)
  } catch {
    return false
  }
}

// A precomputed hash used to equalize the work done for an unknown email during
// login, so response timing does not reveal which addresses have accounts.
let dummyHashPromise = null
export function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('proxispeak-dummy-password-0')
  }
  return dummyHashPromise
}

// Lowercase + trim. Email local parts are technically case-sensitive, but every
// mainstream provider treats them as case-insensitive and users expect that;
// normalizing consistently also makes the unique index meaningful.
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
}

export const EMAIL_CODES = {
  INVALID: 'EMAIL_INVALID',
  TOO_LONG: 'EMAIL_TOO_LONG',
}

export function validateEmail(raw) {
  const email = normalizeEmail(raw)
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) {
    return { ok: false, code: email.length > MAX_EMAIL_LENGTH ? EMAIL_CODES.TOO_LONG : EMAIL_CODES.INVALID }
  }
  // Conservative, practical shape: no whitespace, one @, a local part, and a
  // dotted domain with a 2+ character TLD. Deliberately not a full RFC 5322
  // parser (those accept addresses no provider will deliver to).
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, code: EMAIL_CODES.INVALID }
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length === 0 || local.length > 64) return { ok: false, code: EMAIL_CODES.INVALID }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { ok: false, code: EMAIL_CODES.INVALID }
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) {
    return { ok: false, code: EMAIL_CODES.INVALID }
  }
  return { ok: true, email }
}

export const NAME_CODES = {
  REQUIRED: 'NAME_REQUIRED',
  TOO_SHORT: 'NAME_TOO_SHORT',
  TOO_LONG: 'NAME_TOO_LONG',
}

// Display names are plain text. Control characters are stripped (they would
// corrupt presence broadcasts and terminal logs), whitespace is collapsed.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validateName(raw) {
  const name = sanitizeName(raw)
  if (name.length === 0) return { ok: false, code: NAME_CODES.REQUIRED }
  if (name.length < MIN_NAME_LENGTH) return { ok: false, code: NAME_CODES.TOO_SHORT }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, code: NAME_CODES.TOO_LONG }
  return { ok: true, name }
}
