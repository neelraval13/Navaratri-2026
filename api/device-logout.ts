import { serializeClearedDeviceSessionCookie } from '../server/device-auth/cookies.js'
import { deviceJson } from '../server/device-auth/http.js'
import { isSameOriginDeviceRequest } from '../server/device-auth/same-origin.js'

/**
 * Ends the DEVICE session on this browser.
 *
 * Auth only. It expires `__Host-navaratri_device_session` and nothing else:
 * the Admin cookie and the operator cookie are untouched, no row is written,
 * no IndexedDB is opened, and the local trusted-device marker is left alone.
 *
 * No database configuration is consulted, because clearing a cookie needs
 * none — a logout must work even when the central database is unreachable.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginDeviceRequest(request)) {
    return deviceJson({ ok: false, message: 'Origin is not allowed.' }, 403)
  }

  return Promise.resolve(
    deviceJson({ ok: true, authenticated: false }, 200, serializeClearedDeviceSessionCookie()),
  )
}
