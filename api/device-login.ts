import { isDatabaseConfigured } from '../server/db/client.js'
import { authenticateDevice } from '../server/device-auth/authenticate.js'
import { serializeDeviceSessionCookie } from '../server/device-auth/cookies.js'
import {
  DEVICE_AUTH_LOG_MESSAGES,
  readDeviceAuthEnvironment,
} from '../server/device-auth/environment.js'
import { deviceJson, readDeviceBody } from '../server/device-auth/http.js'
import { parseDeviceLoginInput } from '../server/device-auth/requests.js'
import { isSameOriginDeviceRequest } from '../server/device-auth/same-origin.js'
import { createDeviceSessionToken } from '../server/device-auth/session.js'

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
      { ok: true, authenticated: true, ...result.context },
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
