import { serializeClearedAdminSessionCookie } from '../server/admin-auth/cookies.js'
import { isSameOriginAdminRequest } from '../server/admin-auth/same-origin.js'

/**
 * Ends the ADMIN session on this browser.
 *
 * It expires only the admin cookie: the operator session is a separate realm
 * and is left exactly as it was. It performs NO database mutation, and it
 * deliberately does not require a valid session — clearing a credential must
 * work even when it is already broken.
 */
export function POST(request: Request): Response {
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
