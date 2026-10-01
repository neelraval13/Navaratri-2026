import {
  readAdminSessionCookie,
  serializeAdminSessionCookie,
  serializeClearedAdminSessionCookie,
} from '../server/admin-auth/cookies.js'
import {
  ADMIN_AUTH_LOG_MESSAGES,
  readAdminAuthEnvironment,
} from '../server/admin-auth/environment.js'
import { isSameOriginAdminRequest } from '../server/admin-auth/same-origin.js'
import {
  createAdminSessionToken,
  isAdminAccessCodeValid,
  verifyAdminSessionToken,
} from '../server/admin-auth/session.js'
import { isDatabaseConfigured } from '../server/db/client.js'

/**
 * The ADMIN authentication realm, as one endpoint.
 *
 *   POST   /api/admin-auth  — sign in
 *   GET    /api/admin-auth  — introspect the current session
 *   DELETE /api/admin-auth  — sign out
 *
 * The three used to be `admin-login`, `admin-session` and `admin-logout`.
 * Every file under `api/` becomes its own deployment Function, and the Hobby
 * plan allows twelve; three separate files for one credential's lifecycle
 * spent three of them. The HTTP METHOD is the dispatcher — there is no
 * `?action=` and no `"action"` field in a body, because the method already
 * says which of the three this is.
 *
 * The behaviour of each is unchanged, including status codes, bodies, headers,
 * cookie attributes and the wrong-code delay. Only the path and, for sign-out,
 * the method have moved.
 *
 * This is the Admin realm ONLY. It never reads a device or operator cookie,
 * and neither of those realms authorizes anything here. Device authentication
 * is a separate Function (`api/device-auth.ts`) with its own secret, cookie
 * and signing context — merging the two would put two different threat
 * surfaces and two different rate limits behind one path.
 */

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

/**
 * Whether this browser holds a valid ADMIN session, and whether the control
 * plane has what it needs to work.
 *
 * It never explains why a token was rejected — missing, malformed, expired and
 * tampered are one indistinguishable answer.
 */
export function GET(request: Request): Response {
  const configuration = readAdminAuthEnvironment()

  if (configuration.ok === false) {
    return new Response(JSON.stringify({ authenticated: false, configured: false }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        vary: 'Cookie',
      },
    })
  }

  const token = readAdminSessionCookie(request.headers.get('cookie'))

  const authenticated = verifyAdminSessionToken(
    token,
    configuration.environment.sessionSecret,
  )

  // Reported so the UI can fail closed with a clear message rather than
  // letting every registry call 503 one at a time.
  return new Response(
    JSON.stringify({
      authenticated,
      configured: true,
      databaseConfigured: isDatabaseConfigured(),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        vary: 'Cookie',
      },
    },
  )
}

/**
 * Ends the ADMIN session on this browser.
 *
 * It expires only the admin cookie: the operator session is a separate realm
 * and is left exactly as it was. It performs NO database mutation, and it
 * deliberately does not require a valid session — clearing a credential must
 * work even when it is already broken.
 */
export function DELETE(request: Request): Response {
  if (!isSameOriginAdminRequest(request)) {
    return new Response(JSON.stringify({ ok: false, message: 'Origin is not allowed.' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })

  headers.append('set-cookie', serializeClearedAdminSessionCookie())

  return new Response(JSON.stringify({ ok: true, authenticated: false }), {
    status: 200,
    headers,
  })
}
