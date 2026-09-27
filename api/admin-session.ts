import { readAdminSessionCookie } from '../server/admin-auth/cookies.js'
import { readAdminAuthEnvironment } from '../server/admin-auth/environment.js'
import { verifyAdminSessionToken } from '../server/admin-auth/session.js'
import { isDatabaseConfigured } from '../server/db/client.js'

const jsonResponse = (body: unknown, status: number): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      vary: 'Cookie',
    },
  })
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

  if (!configuration.ok) {
    return jsonResponse({ authenticated: false, configured: false }, 503)
  }

  const token = readAdminSessionCookie(request.headers.get('cookie'))

  const authenticated = verifyAdminSessionToken(
    token,
    configuration.environment.sessionSecret,
  )

  // Reported so the UI can fail closed with a clear message rather than
  // letting every registry call 503 one at a time.
  return jsonResponse(
    { authenticated, configured: true, databaseConfigured: isDatabaseConfigured() },
    200,
  )
}
