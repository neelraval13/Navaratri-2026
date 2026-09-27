/**
 * Exact same-origin check for the device auth endpoints.
 *
 * These endpoints support no CORS at all: a browser request from this
 * application always carries an `Origin` matching the request's own origin,
 * and anything else is refused. Combined with `SameSite=Strict` on the device
 * cookie, a cross-site page cannot drive them.
 *
 * This is NOT authentication — any direct HTTP client can set an Origin
 * header. The signed device cookie plus the `session_version` check is the
 * auth boundary; this only closes the browser-driven cross-site path.
 */
export const isSameOriginDeviceRequest = (request: Request): boolean => {
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
