import { isDatabaseConfigured } from '../server/db/client.js'
import { loadDeviceSessionContext } from '../server/device-auth/authenticate.js'
import {
  readDeviceSessionCookie,
  serializeClearedDeviceSessionCookie,
} from '../server/device-auth/cookies.js'
import {
  DEVICE_AUTH_LOG_MESSAGES,
  readDeviceAuthEnvironment,
} from '../server/device-auth/environment.js'
import { deviceJson } from '../server/device-auth/http.js'
import { verifyDeviceSessionToken } from '../server/device-auth/session.js'

/** One answer for every invalidation, so none of them is distinguishable. */
const UNAUTHENTICATED = { authenticated: false, configured: true } as const

/**
 * Whether this browser currently holds a valid central-device session, and
 * what that device's CURRENT central state is.
 *
 * A valid signature is not enough. The token proves only that this server
 * issued it; whether the device may still act is re-read from Postgres on
 * every call: it must still exist, still belong to the event the token names,
 * still match `session_version`, still be enabled, still have provisioned
 * credentials, and its event must still be active.
 *
 * Attributes and the active badge range are returned FRESH, never from token
 * claims, so an Admin change is reflected on the next check without a new
 * cookie and without a password reset.
 *
 * It reads ONLY the device cookie. An operator or Admin cookie is not
 * consulted and cannot authenticate anything here.
 *
 * `last_seen_at` is deliberately NOT touched: a UI checking its own session
 * is not evidence of device activity, and there is no heartbeat in 9C-B.
 */
export async function GET(request: Request): Promise<Response> {
  const configuration = readDeviceAuthEnvironment()

  if (!configuration.ok) {
    console.error(
      `Navaratri device auth: unavailable. ${DEVICE_AUTH_LOG_MESSAGES[configuration.reason]}`,
    )

    return deviceJson({ authenticated: false, configured: false }, 503)
  }

  if (!isDatabaseConfigured()) {
    return deviceJson({ authenticated: false, configured: false }, 503)
  }

  const token = readDeviceSessionCookie(request.headers.get('cookie'))

  if (token === undefined) {
    return deviceJson(UNAUTHENTICATED, 200)
  }

  const claims = verifyDeviceSessionToken(token, configuration.environment.sessionSecret)

  /**
   * A cookie was supplied and is not usable, so it is cleared. The caller is
   * never told which condition failed — expired, tampered, revoked by a
   * password reset, disabled device or deactivated event all look identical.
   */
  if (claims === null) {
    return deviceJson(UNAUTHENTICATED, 200, serializeClearedDeviceSessionCookie())
  }

  try {
    const context = await loadDeviceSessionContext({
      deviceId: claims.deviceId,
      eventId: claims.eventId,
      sessionVersion: claims.sv,
    })

    if (context === null) {
      return deviceJson(UNAUTHENTICATED, 200, serializeClearedDeviceSessionCookie())
    }

    return deviceJson({ authenticated: true, configured: true, ...context }, 200)
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown'

    console.error(`Navaratri device auth: session check failed (SQLSTATE ${code}).`)

    // A database failure is not proof of a bad session, so the cookie stays.
    return deviceJson({ authenticated: false, configured: true }, 200)
  }
}
