import { readOperatorAuthEnvironment } from '../server/auth/environment.js'
import { readOperatorSessionCookie } from '../server/auth/cookies.js'
import { verifyOperatorSessionToken } from '../server/auth/operator-session.js'

const jsonResponse = (body: unknown, status: number): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // The answer depends entirely on the session cookie, so it must never be
      // served from a shared cache keyed on the URL alone.
      vary: 'Cookie',
    },
  })
}

/**
 * Reports whether this browser currently holds a valid operator session.
 *
 * It never explains WHY a token was rejected — missing, malformed, expired and
 * tampered are one indistinguishable answer.
 */
export function GET(request: Request): Response {
  const configuration = readOperatorAuthEnvironment()

  if (!configuration.ok) {
    return jsonResponse({ authenticated: false, configured: false }, 503)
  }

  const token = readOperatorSessionCookie(request.headers.get('cookie'))

  const authenticated = verifyOperatorSessionToken(
    token,
    configuration.environment.sessionSecret,
  )

  return jsonResponse({ authenticated }, 200)
}
