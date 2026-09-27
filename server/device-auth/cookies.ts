import { DEVICE_SESSION_TTL_SECONDS } from './session.js'

/**
 * A DIFFERENT cookie from both the operator session and the Admin session,
 * deliberately.
 *
 * An authenticated device must never be an Admin, and neither an operator nor
 * an Admin may become a device. Separate names mean no realm can be satisfied
 * by another realm's credential, independently of the signing separation.
 *
 * The `__Host-` prefix is browser-enforced: it refuses the cookie unless it is
 * Secure, has `Path=/`, and carries no `Domain`.
 */
export const DEVICE_SESSION_COOKIE = '__Host-navaratri_device_session'

const BASE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict'

export const serializeDeviceSessionCookie = (token: string): string => {
  return `${DEVICE_SESSION_COOKIE}=${token}; Max-Age=${String(DEVICE_SESSION_TTL_SECONDS)}; ${BASE_ATTRIBUTES}`
}

/** Same name, path and security scope, so the browser replaces the real one. */
export const serializeClearedDeviceSessionCookie = (): string => {
  return `${DEVICE_SESSION_COOKIE}=; Max-Age=0; ${BASE_ATTRIBUTES}`
}

/** Reads the device cookie out of a raw `Cookie` header. Never throws. */
export const readDeviceSessionCookie = (
  cookieHeader: string | null,
): string | undefined => {
  if (cookieHeader === null || cookieHeader === '') {
    return undefined
  }

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')

    if (separator === -1) {
      continue
    }

    if (part.slice(0, separator).trim() === DEVICE_SESSION_COOKIE) {
      return part.slice(separator + 1).trim()
    }
  }

  return undefined
}
