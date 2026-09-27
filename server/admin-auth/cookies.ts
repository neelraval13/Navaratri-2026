import { ADMIN_SESSION_TTL_SECONDS } from './session.js'

/**
 * A DIFFERENT cookie from the operator session, deliberately.
 *
 * An authenticated event device must never be an Admin, and an Admin must
 * never inherit operator access. Separate names mean neither realm can be
 * satisfied by the other's credential.
 *
 * The `__Host-` prefix is browser-enforced: it refuses the cookie unless it is
 * Secure, has `Path=/`, and carries no `Domain`.
 */
export const ADMIN_SESSION_COOKIE = '__Host-navaratri_admin_session'

const BASE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict'

export const serializeAdminSessionCookie = (token: string): string => {
  return `${ADMIN_SESSION_COOKIE}=${token}; Max-Age=${String(ADMIN_SESSION_TTL_SECONDS)}; ${BASE_ATTRIBUTES}`
}

export const serializeClearedAdminSessionCookie = (): string => {
  return `${ADMIN_SESSION_COOKIE}=; Max-Age=0; ${BASE_ATTRIBUTES}`
}

/** Reads the admin cookie out of a raw `Cookie` header. Never throws. */
export const readAdminSessionCookie = (
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

    if (part.slice(0, separator).trim() === ADMIN_SESSION_COOKIE) {
      return part.slice(separator + 1).trim()
    }
  }

  return undefined
}
