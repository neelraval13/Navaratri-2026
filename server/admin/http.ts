import { readAdminSessionCookie } from '../admin-auth/cookies.js'
import {
  ADMIN_AUTH_LOG_MESSAGES,
  readAdminAuthEnvironment,
} from '../admin-auth/environment.js'
import { isSameOriginAdminRequest } from '../admin-auth/same-origin.js'
import { verifyAdminSessionToken } from '../admin-auth/session.js'
import { isDatabaseConfigured } from '../db/client.js'
import { ADMIN_CONFLICT_MESSAGES, type AdminConflict } from './errors.js'

/** One registration snapshot is small; so is every Admin request. */
export const MAX_ADMIN_BODY_BYTES = 8 * 1024

/**
 * Registry data is operational state. It must never sit in a CDN or browser
 * HTTP cache, and the answer depends on the admin cookie.
 */
export const adminJson = (body: unknown, status: number, cookie?: string): Response => {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    vary: 'Cookie',
  })

  if (cookie !== undefined) {
    headers.append('set-cookie', cookie)
  }

  return new Response(JSON.stringify(body), { status, headers })
}

export const adminError = (message: string, status: number): Response => {
  return adminJson({ ok: false, message }, status)
}

export const adminConflict = (conflict: AdminConflict): Response => {
  return adminJson(
    { ok: false, conflict, message: ADMIN_CONFLICT_MESSAGES[conflict] },
    409,
  )
}

export type AdminGuardResult = { ok: true } | { ok: false; response: Response }

/**
 * The single entry check for every central-data endpoint.
 *
 * ORDER MATTERS and is deliberate:
 *
 * 1. admin session   — an unauthenticated caller learns nothing else
 * 2. mutation origin — cross-site writes are refused
 * 3. database        — only then is configuration even consulted
 *
 * Authorizing before touching the database means an anonymous request can
 * never probe whether a database exists, let alone reach it.
 */
export const guardAdminRequest = (
  request: Request,
  options: { mutating: boolean; requiresDatabase: boolean },
): AdminGuardResult => {
  const configuration = readAdminAuthEnvironment()

  if (configuration.ok === false) {
    console.error(
      `Navaratri admin: refused. ${ADMIN_AUTH_LOG_MESSAGES[configuration.reason]}`,
    )

    // Same answer as a bad session: configuration state is not probeable.
    return { ok: false, response: adminError('Admin access is not available.', 401) }
  }

  const token = readAdminSessionCookie(request.headers.get('cookie'))

  if (!verifyAdminSessionToken(token, configuration.environment.sessionSecret)) {
    return { ok: false, response: adminError('Admin session required.', 401) }
  }

  if (options.mutating && !isSameOriginAdminRequest(request)) {
    return { ok: false, response: adminError('Origin is not allowed.', 403) }
  }

  if (options.requiresDatabase && !isDatabaseConfigured()) {
    return {
      ok: false,
      response: adminJson(
        { ok: false, configured: false, message: 'The central database is not configured.' },
        503,
      ),
    }
  }

  return { ok: true }
}

export type BodyResult = { ok: true; body: unknown } | { ok: false; response: Response }

export const readAdminBody = async (request: Request): Promise<BodyResult> => {
  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, response: adminError('Content-Type must be application/json.', 415) }
  }

  let raw: string

  try {
    raw = await request.text()
  } catch {
    return { ok: false, response: adminError('Request body could not be read.', 400) }
  }

  if (raw.length > MAX_ADMIN_BODY_BYTES) {
    return { ok: false, response: adminError('Request body is too large.', 413) }
  }

  try {
    return { ok: true, body: JSON.parse(raw) }
  } catch {
    return { ok: false, response: adminError('Request body is not valid JSON.', 400) }
  }
}

/**
 * An unexpected database failure. The operator gets a generic message; the
 * server log gets the operation name and, where available, the SQLSTATE —
 * never the connection string, the driver object or a full stack.
 */
export const adminUnexpected = (operation: string, error: unknown): Response => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'unknown'

  console.error(`Navaratri admin: ${operation} failed (SQLSTATE ${code}).`)

  return adminError('That could not be completed. Try again.', 500)
}
