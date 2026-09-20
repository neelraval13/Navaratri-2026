/**
 * Exact same-origin check for the operator auth endpoints.
 *
 * These endpoints support no CORS at all: a browser request from this
 * application always carries an `Origin` matching the request's own origin, and
 * anything else is refused. Combined with `SameSite=Strict` on the session
 * cookie, a cross-site page cannot drive them.
 *
 * Like `SYNC_ALLOWED_ORIGIN`, this is NOT authentication — any direct HTTP
 * client can set an Origin header. The signed session cookie is the auth
 * boundary; this only closes the browser-driven cross-site path.
 */
export const isSameOriginRequest = (request: Request): boolean => {
  const origin = request.headers.get('origin')

  if (origin === null || origin === '') {
    return false
  }

  try {
    return origin === new URL(request.url).origin
  } catch {
    return false
  }
}
