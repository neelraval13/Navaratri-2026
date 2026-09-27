import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'
import { promisify } from 'node:util'

import {
  validateDevicePassword,
  type PasswordValidation,
} from '../../src/shared/device-password.js'

/**
 * Device password hashing.
 *
 * Pure crypto and policy: no HTTP, no database, no Admin rules. Node's own
 * `scrypt` does the work — no bcrypt, no argon2 native build, no hashing
 * service. A native addon would have to survive every Vercel runtime bump for
 * a feature that a built-in already covers.
 *
 * Nothing here is ever sent to a browser, written to IndexedDB, or logged.
 * A plaintext password exists only as an argument and is never persisted.
 *
 * Phase 9C-A STORES credentials. It does not authenticate anyone: there is no
 * device login endpoint, no device session and no cookie. `verifyDevicePassword`
 * exists so the stored format is proven round-trippable now, before anything
 * depends on it.
 */

/**
 * `promisify` cannot see the overload that takes cost parameters, so the
 * options form is declared here rather than lost to `any` at each call.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * Interactive-login parameters, chosen for a Vercel Node function rather than
 * for a benchmark. `N = 2^15` with `r = 8` costs about 32 MB and tens of
 * milliseconds per hash — comfortably inside the function's memory and far
 * inside its timeout, while being expensive enough that an offline attacker
 * cannot cheaply grind a stolen hash.
 *
 * They live in one place, and every encoded hash carries the values it was
 * produced with, so raising them later only affects new passwords.
 */
export const SCRYPT_PARAMETERS = {
  /** CPU/memory cost. Must be a power of two. */
  N: 32_768,
  /** Block size. */
  r: 8,
  /** Parallelisation. */
  p: 1,
  /** Derived key length, in bytes. */
  keyLength: 32,
  /** Salt length, in bytes. */
  saltLength: 16,
} as const

/**
 * The maximum memory any stored hash may ask for: `128 * N * r` bytes, which
 * is how scrypt's cost is defined. A hash read back from the database is
 * UNTRUSTED input — if the row were ever tampered with, absurd parameters
 * would otherwise let it allocate gigabytes or spin a function to its
 * timeout. Verification refuses those before doing any work.
 */
const MAX_SCRYPT_MEMORY_BYTES = 128 * 1_048_576

/**
 * Re-exported so server callers reach the policy through this module without
 * a second source of truth: the rules themselves live in the shared file that
 * the Admin browser form also reads.
 */
export { validateDevicePassword }
export type { PasswordValidation }

const HASH_ALGORITHM = 'scrypt'
const HASH_VERSION = 'v1'

const encodeKey = (value: Buffer): string => value.toString('base64url')

/**
 * Hashes a password into a SELF-DESCRIBING record:
 *
 * `scrypt$v1$<N>$<r>$<p>$<saltBase64url>$<keyBase64url>`
 *
 * The algorithm, the format version and every cost parameter travel with the
 * hash, so the verifier never assumes today's constants. Raising
 * `SCRYPT_PARAMETERS` later leaves existing rows verifiable.
 *
 * The salt is fresh `randomBytes` per password, so two devices sharing a
 * passphrase produce completely different records and neither can be found in
 * a precomputed table.
 */
export const hashDevicePassword = async (password: string): Promise<string> => {
  const { N, r, p, keyLength, saltLength } = SCRYPT_PARAMETERS
  const salt = randomBytes(saltLength)
  const derived = await scrypt(password, salt, keyLength, {
    N,
    r,
    p,
    maxmem: MAX_SCRYPT_MEMORY_BYTES,
  })

  return [
    HASH_ALGORITHM,
    HASH_VERSION,
    String(N),
    String(r),
    String(p),
    encodeKey(salt),
    encodeKey(derived),
  ].join('$')
}

interface ParsedHash {
  N: number
  r: number
  p: number
  salt: Buffer
  key: Buffer
}

const parsePositiveInteger = (value: string, max: number): number | null => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null
}

const decodeKey = (value: string): Buffer | null => {
  // base64url round-trip: a decoder that silently drops junk would accept a
  // corrupted field as a shorter valid one.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, 'base64url')

  return decoded.length === 0 || encodeKey(decoded) !== value ? null : decoded
}

/**
 * Reads a stored hash, failing closed on ANYTHING unexpected.
 *
 * A stored value is untrusted: it could be truncated, hand-edited, written by
 * a future version, or deliberately crafted. Every field is checked before
 * scrypt is asked to do a single byte of work.
 */
const parseStoredHash = (encoded: string): ParsedHash | null => {
  const parts = encoded.split('$')

  if (parts.length !== 7) {
    return null
  }

  const [algorithm, version, rawN, rawR, rawP, rawSalt, rawKey] = parts

  if (algorithm !== HASH_ALGORITHM || version !== HASH_VERSION) {
    return null
  }

  const N = parsePositiveInteger(rawN, MAX_SCRYPT_MEMORY_BYTES)
  const r = parsePositiveInteger(rawR, 1_024)
  const p = parsePositiveInteger(rawP, 16)

  if (N === null || r === null || p === null) {
    return null
  }

  // scrypt requires a power-of-two cost greater than one.
  if (N < 2 || (N & (N - 1)) !== 0) {
    return null
  }

  // The cost this record would impose, refused before it is incurred.
  if (128 * N * r > MAX_SCRYPT_MEMORY_BYTES) {
    return null
  }

  const salt = decodeKey(rawSalt)
  const key = decodeKey(rawKey)

  if (salt === null || key === null) {
    return null
  }

  return { N, r, p, salt, key }
}

/**
 * Whether a candidate password matches a stored hash.
 *
 * Returns FALSE for every ordinary failure — wrong password, malformed
 * encoding, unsupported version, impossible parameters — and never throws for
 * them. A caller must not have to tell "wrong password" apart from "this row
 * is damaged" by catching exceptions.
 *
 * The comparison is `timingSafeEqual` over equal-length buffers; a length
 * mismatch is rejected first, because that function throws on unequal lengths.
 */
export const verifyDevicePassword = async (
  password: unknown,
  encodedHash: unknown,
): Promise<boolean> => {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') {
    return false
  }

  const parsed = parseStoredHash(encodedHash)

  if (parsed === null) {
    return false
  }

  let derived: Buffer

  try {
    derived = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    })
  } catch {
    return false
  }

  return (
    derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key)
  )
}
