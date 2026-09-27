/**
 * Device identity primitives, shared by the browser and the server.
 *
 * Framework-free on purpose: no React, no Dexie, no Node or DOM APIs, so the
 * local writer and the wire validator apply exactly the same rules and cannot
 * drift apart.
 */
export const DEVICE_NAME_MAX_LENGTH = 64

/**
 * Conservative UUID shape. New ids come from `crypto.randomUUID()`, which emits
 * a lowercase v4 UUID; the check stays deliberately narrow because a device id
 * is never typed by a human and never needs to accept anything else.
 */
const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Null, C0 and C1 controls. A device name is a label, never a payload. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

export const isValidDeviceId = (value: unknown): value is string => {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value)
}

/**
 * Outer whitespace is trimmed; normal internal spacing is preserved, so
 * `Main Gate 1` stays exactly that.
 */
export const normalizeDeviceName = (value: string): string => {
  return value.trim()
}

/**
 * Validates an ALREADY-NORMALIZED name, which is the form that gets stored and
 * sent. A value with outer whitespace is therefore invalid on the wire: the
 * writer normalizes first, so anything else means the snapshot was not produced
 * by this application.
 */
export const isValidDeviceName = (value: unknown): value is string => {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value !== '' &&
    value.length <= DEVICE_NAME_MAX_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  )
}

/** Whether a raw operator-typed name can become a valid device name. */
export const isAcceptableDeviceNameInput = (value: string): boolean => {
  return isValidDeviceName(normalizeDeviceName(value))
}

export type DeviceProvenanceCheck =
  | { ok: true }
  | { ok: false; message: string }

/**
 * The legacy rule, in one place.
 *
 * A snapshot either carries BOTH device fields or NEITHER. Exactly one present
 * means something built a partial snapshot, which is a bug rather than an old
 * record, so it is rejected rather than half-accepted.
 */
export const checkDeviceProvenance = (
  deviceId: unknown,
  deviceName: unknown,
): DeviceProvenanceCheck => {
  const hasId = deviceId !== undefined
  const hasName = deviceName !== undefined

  if (!hasId && !hasName) {
    // A pre-Phase-7 snapshot. Accepted, and written with blank device cells.
    return { ok: true }
  }

  if (hasId !== hasName) {
    return {
      ok: false,
      message: 'payload.deviceId and payload.deviceName must be present together.',
    }
  }

  if (!isValidDeviceId(deviceId)) {
    return { ok: false, message: 'payload.deviceId must be a UUID.' }
  }

  if (!isValidDeviceName(deviceName)) {
    return {
      ok: false,
      message: `payload.deviceName must be a trimmed string of 1-${String(DEVICE_NAME_MAX_LENGTH)} characters.`,
    }
  }

  return { ok: true }
}
