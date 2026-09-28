import { serializeAdminSessionCookie } from '../server/admin-auth/cookies.js'
import {
  ADMIN_AUTH_LOG_MESSAGES,
  readAdminAuthEnvironment,
} from '../server/admin-auth/environment.js'
import { isSameOriginAdminRequest } from '../server/admin-auth/same-origin.js'
import {
  createAdminSessionToken,
  isAdminAccessCodeValid,
} from '../server/admin-auth/session.js'

const MAX_BODY_BYTES = 2 * 1024

/** Blunts naive guessing. The real protection is a 16+ character passphrase. */
const INVALID_CODE_DELAY_MS = 750

const jsonResponse = (body: unknown, status: number, cookie?: string): Response => {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })

  if (cookie !== undefined) {
    headers.append('set-cookie', cookie)
  }

  return new Response(JSON.stringify(body), { status, headers })
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Exchanges the Admin access code for a 12-hour admin session cookie.
 *
 * A separate realm from Operator Access: unlocking Admin grants no operator
 * access, and an operator session grants no Admin. The submitted code is
 * never logged, echoed or stored, and the response carries no token.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginAdminRequest(request)) {
    return jsonResponse({ ok: false, message: 'Origin is not allowed.' }, 403)
  }

  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ ok: false, message: 'Content-Type must be application/json.' }, 415)
  }

  let rawBody: string

  try {
    rawBody = await request.text()
  } catch {
    return jsonResponse({ ok: false, message: 'Request body could not be read.' }, 400)
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, message: 'Request body is too large.' }, 413)
  }

  let parsedBody: unknown

  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ ok: false, message: 'Request body is not valid JSON.' }, 400)
  }

  if (
    typeof parsedBody !== 'object' ||
    parsedBody === null ||
    Array.isArray(parsedBody) ||
    typeof (parsedBody as Record<string, unknown>).accessCode !== 'string'
  ) {
    return jsonResponse({ ok: false, message: 'An access code is required.' }, 400)
  }

  const accessCode = (parsedBody as Record<string, unknown>).accessCode as string

  const configuration = readAdminAuthEnvironment()

  if (configuration.ok === false) {
    console.error(
      `Navaratri admin login: refused. ${ADMIN_AUTH_LOG_MESSAGES[configuration.reason]}`,
    )

    return jsonResponse(
      { ok: false, configured: false, message: 'Admin access is not configured on this deployment.' },
      503,
    )
  }

  if (!isAdminAccessCodeValid(accessCode, configuration.environment.accessCode)) {
    await delay(INVALID_CODE_DELAY_MS)

    return jsonResponse({ ok: false, message: 'Access code is incorrect.' }, 401)
  }

  return jsonResponse(
    { ok: true, authenticated: true },
    200,
    serializeAdminSessionCookie(
      createAdminSessionToken(configuration.environment.sessionSecret),
    ),
  )
}
