import { SESSION_TTL_SECONDS } from './operator-session.js'

/**
 * The `__Host-` prefix is enforced by the browser: it refuses the cookie unless
 * it is Secure, has `Path=/`, and carries NO `Domain`. That makes it impossible
 * for a sibling subdomain to set or overwrite this session.
 */
export const OPERATOR_SESSION_COOKIE = '__Host-navaratri_operator_session'

/**
 * `HttpOnly` keeps the token out of `document.cookie`, so no client script —
 * including this application's own — can read or copy it.
 *
 * `SameSite=Strict` means it is never attached to a cross-site navigation or
 * request, which is what makes the same-origin API endpoints safe from CSRF.
 */
const BASE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict'

export const serializeOperatorSessionCookie = (token: string): string => {
  return `${OPERATOR_SESSION_COOKIE}=${token}; Max-Age=${String(SESSION_TTL_SECONDS)}; ${BASE_ATTRIBUTES}`
}

/**
 * There is no server-side session store, so logging out means expiring the
 * browser's copy. The attributes must match the ones it was set with or the
 * browser will keep the original cookie.
 */
export const serializeClearedOperatorSessionCookie = (): string => {
  return `${OPERATOR_SESSION_COOKIE}=; Max-Age=0; ${BASE_ATTRIBUTES}`
}

/** Reads the session cookie out of a raw `Cookie` header. Never throws. */
export const readOperatorSessionCookie = (
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

    if (part.slice(0, separator).trim() === OPERATOR_SESSION_COOKIE) {
      return part.slice(separator + 1).trim()
    }
  }

  return undefined
}
