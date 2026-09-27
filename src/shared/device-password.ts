/**
 * The device password POLICY, shared by the Admin browser form and the
 * server.
 *
 * Framework-free and crypto-free on purpose: the browser needs the rules to
 * show an inline error before submitting, and the server needs the same rules
 * to enforce them. One implementation means the instant feedback and the
 * actual refusal can never disagree.
 *
 * Hashing lives in `server/device-auth/password.ts` and never comes near the
 * browser. The browser sends the plaintext over HTTPS and the server hashes
 * it; hashing in the browser instead would only turn the digest into a
 * reusable password equivalent.
 */

export const DEVICE_PASSWORD_MIN_LENGTH = 8
export const DEVICE_PASSWORD_MAX_LENGTH = 128

export type PasswordValidation =
  | { ok: true; password: string }
  | { ok: false; message: string }

/**
 * Length only, in Phase 9C-A. No required character classes, so a long
 * passphrase is welcome.
 *
 * The value is taken EXACTLY: never trimmed, never case-folded, never Unicode
 * normalised. Spaces are ordinary characters, so a passphrase with a leading
 * or trailing space is a different password from one without. Silently
 * "helping" here would lock someone out of a desk on event day.
 *
 * Length is counted in JavaScript string units — the same units the input
 * field the operator typed into counts.
 */
export const validateDevicePassword = (value: unknown): PasswordValidation => {
  if (typeof value !== 'string') {
    return { ok: false, message: 'A device password is required.' }
  }

  if (
    value.length < DEVICE_PASSWORD_MIN_LENGTH ||
    value.length > DEVICE_PASSWORD_MAX_LENGTH
  ) {
    return {
      ok: false,
      message: `The device password must be ${String(DEVICE_PASSWORD_MIN_LENGTH)}-${String(DEVICE_PASSWORD_MAX_LENGTH)} characters.`,
    }
  }

  return { ok: true, password: value }
}

export type PasswordPairResult =
  | { ok: true; password: string | null }
  | { ok: false; message: string }

/**
 * Checks a password and its confirmation together.
 *
 * An absent or empty password means NO CREDENTIALS. A device may be created
 * as inventory and provisioned later, so that is a valid outcome wherever
 * credentials are optional — but a confirmation typed with nothing to confirm
 * is a half-filled form, not an empty one.
 *
 * Credentials require a login name. The pair is what a future device login
 * will present, and a login name is never invented to make a request succeed.
 */
export const checkPasswordPair = (input: {
  password: unknown
  confirmPassword: unknown
  hasLoginName: boolean
  required: boolean
}): PasswordPairResult => {
  const supplied =
    input.password !== undefined && input.password !== null && input.password !== ''
  const confirmation =
    input.confirmPassword === undefined || input.confirmPassword === null
      ? ''
      : input.confirmPassword

  if (!supplied) {
    if (input.required) {
      return { ok: false, message: 'A device password is required.' }
    }

    if (confirmation !== '') {
      return { ok: false, message: 'Enter the device password as well as the confirmation.' }
    }

    return { ok: true, password: null }
  }

  if (!input.hasLoginName) {
    return {
      ok: false,
      message: 'Give this device a login name before setting a device password.',
    }
  }

  const password = validateDevicePassword(input.password)

  if (!password.ok) {
    return password
  }

  // Compared EXACTLY, like the password itself: no trimming, no case folding.
  if (confirmation !== password.password) {
    return { ok: false, message: 'The two passwords do not match.' }
  }

  return { ok: true, password: password.password }
}
