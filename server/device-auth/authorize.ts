import { isDatabaseConfigured } from '../db/client.js'
import {
  loadDeviceSessionContext,
  type AuthenticatedDeviceContext,
} from './authenticate.js'
import { readDeviceSessionCookie } from './cookies.js'
import {
  DEVICE_AUTH_LOG_MESSAGES,
  readDeviceAuthEnvironment,
} from './environment.js'
import { deviceJson } from './http.js'
import { isSameOriginDeviceRequest } from './same-origin.js'
import { verifyDeviceSessionToken } from './session.js'

/**
 * The entry check for a device endpoint that is NOT the auth endpoint itself.
 *
 * It answers exactly the question `GET /api/device-auth` answers, with the
 * same primitives and the same outcome: the cookie must verify AND the device
 * must still be allowed to act according to CURRENT Postgres state —
 * `session_version` unchanged, device enabled, credentials provisioned, event
 * active. Verifying the HMAC alone is not authorization.
 *
 * No device identifier is ever accepted from the caller. Identity comes from
 * the signed cookie and nothing else.
 *
 * ORDER:
 *
 * 1. same-origin, for a mutation — a cross-site page cannot drive this
 * 2. configuration — answered identically to the device auth endpoint, which
 *    already reports `configured: false` to an anonymous caller, so nothing
 *    new becomes probeable
 * 3. the session — everything after this point is for an authenticated device
 */
export type DeviceAuthorization =
  | { ok: true; context: AuthenticatedDeviceContext }
  | { ok: false; response: Response }

const UNAUTHORIZED = {
  ok: false,
  authenticated: false,
  message: 'Device session required.',
} as const

export const authorizeDeviceRequest = async (
  request: Request,
  options: { mutating: boolean },
): Promise<DeviceAuthorization> => {
  if (options.mutating && !isSameOriginDeviceRequest(request)) {
    return {
      ok: false,
      response: deviceJson({ ok: false, message: 'Origin is not allowed.' }, 403),
    }
  }

  const configuration = readDeviceAuthEnvironment()

  if (configuration.ok === false) {
    // Names the variable, never its value.
    console.error(
      `Navaratri device auth: refused. ${DEVICE_AUTH_LOG_MESSAGES[configuration.reason]}`,
    )

    return {
      ok: false,
      response: deviceJson(
        { ok: false, configured: false, message: 'Device access is not available.' },
        503,
      ),
    }
  }

  if (!isDatabaseConfigured()) {
    return {
      ok: false,
      response: deviceJson(
        { ok: false, configured: false, message: 'The central database is not configured.' },
        503,
      ),
    }
  }

  const token = readDeviceSessionCookie(request.headers.get('cookie'))

  if (token === undefined) {
    return { ok: false, response: deviceJson(UNAUTHORIZED, 401) }
  }

  const claims = verifyDeviceSessionToken(token, configuration.environment.sessionSecret)

  if (claims === null) {
    return { ok: false, response: deviceJson(UNAUTHORIZED, 401) }
  }

  /**
   * The signature proved only that this server issued the token. Whether the
   * device may still act is re-read from Postgres on EVERY request, so an
   * Admin disabling it, resetting its password or deactivating the event
   * takes effect without waiting for the cookie to expire.
   */
  const context = await loadDeviceSessionContext({
    deviceId: claims.deviceId,
    eventId: claims.eventId,
    sessionVersion: claims.sv,
  })

  if (context === null) {
    return { ok: false, response: deviceJson(UNAUTHORIZED, 401) }
  }

  return { ok: true, context }
}
