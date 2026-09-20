/**
 * A NON-SECRET marker recording that this device has already completed a real
 * server-authenticated unlock.
 *
 * It is NOT authentication. It holds no token, no access code and no session,
 * and it grants no API authority whatsoever — every protected request is still
 * gated by the signed HttpOnly cookie the browser cannot read.
 *
 * Its only job is offline continuity: the session cookie cannot be inspected
 * while offline, and an event desk that has already been unlocked must be able
 * to reopen the installed PWA and keep registering with no network.
 */
const TRUSTED_DEVICE_KEY = 'navaratri-2026.operator-device-unlocked.v1'

const TRUSTED_VALUE = '1'

export const isDeviceTrusted = (): boolean => {
  try {
    return localStorage.getItem(TRUSTED_DEVICE_KEY) === TRUSTED_VALUE
  } catch {
    // Private mode, blocked storage, or no storage at all. Treat as untrusted:
    // the operator unlocks again, which is the safe direction.
    return false
  }
}

export const markDeviceTrusted = (): void => {
  try {
    localStorage.setItem(TRUSTED_DEVICE_KEY, TRUSTED_VALUE)
  } catch {
    // Non-fatal: the session cookie still works for as long as this tab lives.
  }
}

export const clearTrustedDevice = (): void => {
  try {
    localStorage.removeItem(TRUSTED_DEVICE_KEY)
  } catch {
    // Nothing to do; the marker was never readable in the first place.
  }
}
