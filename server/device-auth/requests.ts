import { parseBadgeRange } from '../badge-assignments/range.js'

/**
 * Device request shapes.
 *
 * Deliberately its own validators rather than a reuse of the Admin ones: the
 * realms must stay independently changeable, and these have a different job —
 * they validate what a DEVICE submits, not what an Admin submits.
 *
 * The one thing they do share is the badge RANGE model, which is neither
 * realm's: both reserve rows in the same table under the same database
 * constraints, so both must accept exactly the same mathematics.
 */

const MAX_SLUG_LENGTH = 64
const MAX_LOGIN_NAME_LENGTH = 64

/** Lowercase, hyphen-separated, no leading, trailing or doubled hyphen. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The same shape a login name is stored in. */
const LOGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface DeviceLoginInput {
  eventSlug: string
  loginName: string
  /** EXACTLY as submitted: never trimmed, case folded or normalised. */
  password: string
}

export type DeviceLoginInputResult =
  | { ok: true; value: DeviceLoginInput }
  | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validates the SHAPE of a login request, not the credentials.
 *
 * `eventSlug` and `loginName` are trimmed and shape-checked, because a
 * malformed identifier is a broken request rather than a wrong guess, and
 * refusing it reveals nothing about which events or devices exist.
 *
 * The password is only required to be a string. Its LENGTH POLICY is not
 * enforced here, because a policy failure must be indistinguishable from a
 * wrong password — see `authenticateDevice`. It is never trimmed: a
 * passphrase with a leading or trailing space is a different password.
 */
export const parseDeviceLoginInput = (body: unknown): DeviceLoginInputResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const eventSlug = typeof body.eventSlug === 'string' ? body.eventSlug.trim() : null

  if (
    eventSlug === null ||
    eventSlug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(eventSlug)
  ) {
    return { ok: false, message: 'eventSlug is required.' }
  }

  const loginName = typeof body.loginName === 'string' ? body.loginName.trim() : null

  if (
    loginName === null ||
    loginName.length > MAX_LOGIN_NAME_LENGTH ||
    !LOGIN_NAME_PATTERN.test(loginName)
  ) {
    return { ok: false, message: 'loginName is required.' }
  }

  if (typeof body.password !== 'string') {
    return { ok: false, message: 'password is required.' }
  }

  return { ok: true, value: { eventSlug, loginName, password: body.password } }
}

export interface DeviceBadgeClaimInput {
  rangeStart: number
  rangeEnd: number
}

export type DeviceBadgeClaimInputResult =
  | { ok: true; value: DeviceBadgeClaimInput }
  | { ok: false; message: string }

/**
 * Identity fields a claim must never carry.
 *
 * The authenticated session decides which device and event a claim belongs
 * to. Accepting any of these — even to ignore them — would invite a caller to
 * believe it can choose, and would leave a field that a later refactor might
 * start reading. They are refused outright rather than dropped.
 */
export const FORBIDDEN_CLAIM_FIELDS = [
  'deviceId',
  'eventId',
  'eventSlug',
  'loginName',
] as const

/**
 * Validates a badge-range self-claim.
 *
 * The range model is the SHARED one, so a device cannot claim a range Admin
 * could not assign and vice versa.
 *
 * `physicalStackConfirmed` must be exactly `true`. The server cannot verify
 * that physical badges are on the table — only the operator can — but
 * requiring the flag means a buggy or bypassed client cannot reserve a range
 * centrally without that deliberate action having been taken. It is a
 * mutation guard and is never persisted.
 */
export const parseDeviceBadgeClaimInput = (
  body: unknown,
): DeviceBadgeClaimInputResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  for (const field of FORBIDDEN_CLAIM_FIELDS) {
    if (field in body) {
      return {
        ok: false,
        message: `${field} is not accepted; the device session identifies the device.`,
      }
    }
  }

  if (body.physicalStackConfirmed !== true) {
    return {
      ok: false,
      message: 'Confirm the physical badges are at this device before claiming a range.',
    }
  }

  const range = parseBadgeRange(body)

  if (range.ok === false) {
    return range
  }

  return { ok: true, value: range.value }
}

export interface DeviceBadgeRefillInput {
  /** The range end the caller believes is current. A compare-and-set key. */
  expectedRangeEnd: number
  newRangeEnd: number
}

export type DeviceBadgeRefillInputResult =
  | { ok: true; value: DeviceBadgeRefillInput }
  | { ok: false; message: string }

/**
 * Fields a REFILL must never carry, on top of the identity ones.
 *
 * `rangeStart` is refused because a refill cannot choose one: the new batch
 * begins exactly one after the current end, derived by the server. Accepting
 * it would invite a caller to believe it could move the start of a range
 * badges have already been issued from.
 *
 * `nextBadge` is refused because it is purely local. Central owns the RANGE
 * and never a counter, and a field the server could start reading is a field
 * that would eventually be read.
 */
export const FORBIDDEN_REFILL_FIELDS = [
  ...FORBIDDEN_CLAIM_FIELDS,
  'rangeStart',
  'nextBadge',
] as const

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/**
 * Validates a CONTIGUOUS REFILL of the device's existing badge range.
 *
 * The operator chooses only the new END. `expectedRangeEnd` is not a choice
 * either — it is what the browser last saw, carried so the server can refuse
 * a stale caller rather than overwrite a range that moved underneath it.
 *
 * `newRangeEnd > expectedRangeEnd` is required here rather than left to the
 * database: equality is a no-op dressed as a refill, and anything smaller
 * would be a shrink. Neither is a thing this endpoint does.
 *
 * `physicalStackConfirmed` must be exactly `true`, for the same reason the
 * first claim requires it: the server cannot see the new badges, and only the
 * person standing at the desk can say they arrived. It is a mutation guard
 * and is never persisted.
 */
export const parseDeviceBadgeRefillInput = (
  body: unknown,
): DeviceBadgeRefillInputResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  for (const field of FORBIDDEN_REFILL_FIELDS) {
    if (field in body) {
      return {
        ok: false,
        message: `${field} is not accepted; a refill extends the existing range.`,
      }
    }
  }

  if (body.physicalStackConfirmed !== true) {
    return {
      ok: false,
      message: 'Confirm the additional physical badges are at this device first.',
    }
  }

  const { expectedRangeEnd, newRangeEnd } = body

  if (!isPositiveInteger(expectedRangeEnd) || !isPositiveInteger(newRangeEnd)) {
    return { ok: false, message: 'Badge numbers must be positive whole numbers.' }
  }

  if (newRangeEnd <= expectedRangeEnd) {
    return {
      ok: false,
      message: 'The new last badge must be higher than the current last badge.',
    }
  }

  return { ok: true, value: { expectedRangeEnd, newRangeEnd } }
}
