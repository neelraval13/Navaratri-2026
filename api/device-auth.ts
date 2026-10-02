import { loadDeviceSessionContext, authenticateDevice } from '../server/device-auth/authenticate.js'
import { issueDeviceOfflineAuthorization } from '../server/device-auth/offline-authorization.js'
import {
  readDeviceSessionCookie,
  serializeClearedDeviceSessionCookie,
  serializeDeviceSessionCookie,
} from '../server/device-auth/cookies.js'
import {
  DEVICE_AUTH_LOG_MESSAGES,
  readDeviceAuthEnvironment,
} from '../server/device-auth/environment.js'
import { deviceJson, readDeviceBody } from '../server/device-auth/http.js'
import { parseDeviceLoginInput } from '../server/device-auth/requests.js'
import { isSameOriginDeviceRequest } from '../server/device-auth/same-origin.js'
import {
  createDeviceSessionToken,
  verifyDeviceSessionToken,
} from '../server/device-auth/session.js'
import { isDatabaseConfigured } from '../server/db/client.js'

/**
 * The DEVICE authentication realm, as one endpoint.
 *
 *   POST   /api/device-auth  — sign this browser in as a central device
 *   GET    /api/device-auth  — introspect the current device session
 *   DELETE /api/device-auth  — sign the device out
 *
 * The three used to be `device-login`, `device-session` and `device-logout`.
 * Every file under `api/` becomes its own deployment Function and the Hobby
 * plan allows twelve, so one credential's lifecycle no longer spends three of
 * them. The HTTP METHOD is the dispatcher — no `?action=`, no `"action"`
 * field in a body.
 *
 * Every behaviour proven in Phase 9C-B is unchanged: the event-scoped lookup,
 * the single generic 401 with comparable scrypt timing, the typed 403s that
 * only a proven password can reach, `session_version` revocation, the
 * enabled and event-active checks, the 14-day `__Host-` cookie and the safe
 * context. Only the path and, for sign-out, the method have moved.
 *
 * This is the Device realm ONLY. It never reads an Admin or operator cookie,
 * and neither authorizes anything here. Admin authentication is a separate
 * Function with its own secret, cookie and signing context.
 */

/**
 * ONE message for every credential failure. An unknown event, an unknown
 * login name, an unprovisioned device and a wrong password are
 * indistinguishable to the caller — in status, in body, and in the work done
 * before answering.
 */
const GENERIC_FAILURE = {
  ok: false,
  authenticated: false,
  message: 'Device login failed.',
} as const

const BLOCKED_MESSAGES = {
  'device-disabled': 'This device is disabled.',
  'event-inactive': 'This event is not active.',
} as const

/**
 * Exchanges `eventSlug` + `loginName` + `password` for a 14-day device
 * session cookie.
 *
 * A THIRD realm, independent of Operator Access and Admin. A device session
 * authorizes neither of them, and neither of them authorizes a device. The
 * submitted password is never logged, echoed or stored, and the response
 * carries no token — the session arrives as an HttpOnly cookie.
 *
 * Phase 9C-B: this realm exists but the event application does not use it.
 * `/`, `/badge-registration` and `/device-registration` still run on Operator
 * Access, and holding this cookie unlocks none of them.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginDeviceRequest(request)) {
    return deviceJson({ ok: false, message: 'Origin is not allowed.' }, 403)
  }

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const configuration = readDeviceAuthEnvironment()

  if (configuration.ok === false) {
    // Names the variable, never its value.
    console.error(
      `Navaratri device auth: refused. ${DEVICE_AUTH_LOG_MESSAGES[configuration.reason]}`,
    )

    return deviceJson(
      { ok: false, configured: false, message: 'Device login is not available.' },
      503,
    )
  }

  if (!isDatabaseConfigured()) {
    return deviceJson(
      { ok: false, configured: false, message: 'The central database is not configured.' },
      503,
    )
  }

  const input = parseDeviceLoginInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  try {
    const result = await authenticateDevice(input.value)

    if (result.ok === false) {
      if ('reason' in result) {
        return deviceJson(GENERIC_FAILURE, 401)
      }

      /**
       * Typed, because the caller has already PROVEN it knows the device
       * password. Naming the reason here enumerates nothing, and an operator
       * standing at a disabled desk needs to know why.
       */
      return deviceJson(
        { ok: false, blocked: result.blocked, message: BLOCKED_MESSAGES[result.blocked] },
        403,
      )
    }

    return deviceJson(
      {
        ok: true,
        authenticated: true,
        ...result.context,
        /**
         * A freshly signed OFFLINE AUTHORIZATION LEASE, beside — never
         * instead of — the session cookie. The cookie stays the online
         * credential; the lease authorizes local decisions during an outage
         * and is accepted by no endpoint.
         */
        offlineAuthorization: issueDeviceOfflineAuthorization({
          context: result.context,
          eventEndsAt: result.eventEndsAt,
        }),
      },
      200,
      serializeDeviceSessionCookie(
        createDeviceSessionToken(configuration.environment.sessionSecret, {
          deviceId: result.deviceId,
          eventId: result.eventId,
          sessionVersion: result.sessionVersion,
        }),
      ),
    )
  } catch (error: unknown) {
    // The operation and, where available, the SQLSTATE. Never the body.
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown'

    console.error(`Navaratri device auth: login failed (SQLSTATE ${code}).`)

    return deviceJson({ ok: false, message: 'Device login could not be completed.' }, 500)
  }
}

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

  if (configuration.ok === false) {
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
    const state = await loadDeviceSessionContext({
      deviceId: claims.deviceId,
      eventId: claims.eventId,
      sessionVersion: claims.sv,
    })

    if (state === null) {
      return deviceJson(UNAUTHENTICATED, 200, serializeClearedDeviceSessionCookie())
    }

    /**
     * Re-issued from CURRENT Postgres state on every check, so a changed
     * attribute set, a newly assigned badge range or an event that has since
     * ended are all reflected in the lease the browser caches next. There is
     * no timer behind this — it rides on checks the operator already causes.
     */
    return deviceJson(
      {
        authenticated: true,
        configured: true,
        ...state.context,
        offlineAuthorization: issueDeviceOfflineAuthorization({
          context: state.context,
          eventEndsAt: state.eventEndsAt,
        }),
      },
      200,
    )
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
export function DELETE(request: Request): Response {
  if (!isSameOriginDeviceRequest(request)) {
    return deviceJson({ ok: false, message: 'Origin is not allowed.' }, 403)
  }

  return deviceJson({ ok: true, authenticated: false }, 200, serializeClearedDeviceSessionCookie())
}
