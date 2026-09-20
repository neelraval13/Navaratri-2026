import { serializeClearedOperatorSessionCookie } from '../server/auth/cookies.js'
import { isSameOriginRequest } from '../server/auth/same-origin.js'

/**
 * Ends the operator session on this device.
 *
 * There is no server-side session store, so logging out means expiring the
 * browser's cookie. It deliberately does not require a valid session: clearing
 * a credential must work even when it is already broken.
 *
 * This is auth only. It never touches IndexedDB, registrations, the outbox, the
 * event config or the PWA cache.
 */
export function POST(request: Request): Response {
  if (!isSameOriginRequest(request)) {
    return new Response(
      JSON.stringify({ ok: false, message: 'Origin is not allowed.' }),
      {
        status: 403,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    )
  }

  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })

  headers.append('set-cookie', serializeClearedOperatorSessionCookie())

  return new Response(JSON.stringify({ ok: true, authenticated: false }), {
    status: 200,
    headers,
  })
}
