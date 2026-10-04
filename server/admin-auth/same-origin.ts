/**
 * Exact same-origin check for the Admin endpoints.
 *
 * Its own copy rather than a shared helper: the other realm is live in
 * production, and a change made here must not be able to alter its behaviour.
 *
 * This is NOT authentication — any direct HTTP client can set an Origin
 * header. The signed admin cookie is the auth boundary; this closes the
 * browser-driven cross-site path.
 */
export const isSameOriginAdminRequest = (request: Request): boolean => {
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
