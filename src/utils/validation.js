// Client-side form validation.
//
// This duplicates the server policy deliberately: the server is authoritative,
// but the form should not send a request it already knows will be rejected, and
// users get immediate field-level feedback. The codes match the API's error
// codes so both paths render through the same message map.

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 200
export const MIN_NAME_LENGTH = 2
export const MAX_NAME_LENGTH = 40

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function validateEmail(value) {
  const email = normalizeEmail(value)
  if (email.length === 0) return 'EMAIL_REQUIRED'
  if (email.length > 254) return 'EMAIL_TOO_LONG'
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return 'EMAIL_INVALID'
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length === 0 || local.length > 64) return 'EMAIL_INVALID'
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return 'EMAIL_INVALID'
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return 'EMAIL_INVALID'
  return null
}

export function validateName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (name.length === 0) return 'NAME_REQUIRED'
  if (name.length < MIN_NAME_LENGTH) return 'NAME_TOO_SHORT'
  if (name.length > MAX_NAME_LENGTH) return 'NAME_TOO_LONG'
  return null
}

export function validatePassword(value, { required = true } = {}) {
  if (typeof value !== 'string' || value.length === 0) return required ? 'PASSWORD_REQUIRED' : null
  if (value.length < MIN_PASSWORD_LENGTH) return 'PASSWORD_TOO_SHORT'
  if (value.length > MAX_PASSWORD_LENGTH) return 'PASSWORD_TOO_LONG'
  if (!/\p{L}/u.test(value) || !/\p{N}/u.test(value)) return 'PASSWORD_TOO_WEAK'
  return null
}

export function validateConfirmPassword(password, confirmation) {
  if (typeof confirmation !== 'string' || confirmation.length === 0) return 'PASSWORD_MISMATCH'
  return password === confirmation ? null : 'PASSWORD_MISMATCH'
}

// Human-readable copy for every code the API can return. Codes are stable and
// safe to surface; internal exception text never reaches this map.
export const MESSAGES = {
  EMAIL_REQUIRED: 'Enter your email address.',
  EMAIL_INVALID: 'That email address does not look valid.',
  EMAIL_TOO_LONG: 'That email address is too long.',
  EMAIL_TAKEN: 'An account with that email already exists. Try signing in instead.',
  PASSWORD_REQUIRED: 'Enter your password.',
  PASSWORD_TOO_SHORT: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  PASSWORD_TOO_LONG: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
  PASSWORD_TOO_WEAK: 'Include at least one letter and one number.',
  PASSWORD_MISMATCH: 'The passwords do not match.',
  NAME_REQUIRED: 'Enter your name.',
  NAME_TOO_SHORT: 'Your name is too short.',
  NAME_TOO_LONG: `Use at most ${MAX_NAME_LENGTH} characters.`,
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  USER_NOT_FOUND: 'Email or password is incorrect.',
  NOTHING_TO_UPDATE: 'Change something before saving.',
  INVALID_ROOM: 'Enter a room name using letters, numbers, dots, dashes or underscores.',
  INVALID_THEME: 'Choose a supported theme.',
  INVALID_PREFERENCES: 'Those preferences are not valid.',
  NETWORK_ERROR: 'Could not reach the server. Check that it is running and try again.',
  REQUEST_TIMEOUT: 'The server took too long to respond. Try again.',
  AUTH_UNAVAILABLE: 'Authentication is unavailable right now.',
  AUTH_REQUIRED: 'Please sign in to continue.',
  AUTH_EXPIRED: 'Your session expired. Please sign in again.',
  AUTH_REVOKED: 'Your session is no longer valid. Please sign in again.',
  ACCOUNT_STORE_UNAVAILABLE: 'Account storage is unavailable. Please try again shortly.',
  HTTPS_REQUIRED: 'This server requires HTTPS for sign-in.',
  ORIGIN_FORBIDDEN: 'This origin is not allowed to sign in.',
}

export function messageFor(code) {
  if (!code) return 'Something went wrong. Please try again.'
  return MESSAGES[code] || 'Something went wrong. Please try again.'
}
