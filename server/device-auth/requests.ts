/**
 * Device login request shape.
 *
 * Deliberately its own validator rather than a reuse of the Admin one: the
 * realms must stay independently changeable, and this one has a different
 * job — it validates what a DEVICE submits, not what an Admin submits.
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
