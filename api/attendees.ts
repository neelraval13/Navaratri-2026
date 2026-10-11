import { ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE } from '../src/shared/device-attributes.js'
import { readAttendeeRegister } from '../server/attendees/register.js'
import { authorizeDeviceRequest } from '../server/device-auth/authorize.js'
import { deviceJson } from '../server/device-auth/http.js'
import {
  SYNC_DISABLED_LOG_MESSAGES,
  readSyncEnvironment,
} from '../server/sync/environment.js'

/**
 * THE READ-ONLY ATTENDEE DIRECTORY — Phase A1.
 *
 *   GET /api/attendees   every registered attendee, badge-ascending
 *
 * And nothing else. `POST`, `PUT`, `PATCH` and `DELETE` answer `405` with an
 * `Allow: GET` header rather than being left unexported: a reader that
 * returns a deliberate refusal is a reader somebody can prove is read-only,
 * and an unexported method only produces whatever the platform decides.
 *
 * THERE IS NO MUTATION API FOR THIS FEATURE. This file opens no database
 * client, imports no writer, reads no body and performs no `batchUpdate` on
 * the Sheet. Correcting an attendee is still the registration desk's job.
 *
 * IT KEEPS THE PRIVACY BOUNDARY, exactly as `/api/prizes` does, and through
 * the SAME reader: `server/attendees/register.ts` projects badge number,
 * name, age and gender, and the phone column and the WhatsApp link are never
 * read into a variable. There is deliberately no central attendee table to
 * read instead — Postgres has held no attendee PII since Phase 9A, and a
 * convenience copy for a directory screen would be the second source of truth
 * that ends that.
 *
 * ONLINE ONLY. Nothing here is cached, queued or persisted, and the browser
 * keeps no roster: a directory showing a stale list as current is worse than
 * one that says it cannot reach the server.
 *
 * AUTHORIZATION IS A LIVE DEVICE SESSION with the CURRENT `attendees`
 * attribute, re-read from Postgres on every request through the same
 * primitives `GET /api/device-auth` uses. It needs no `registration`, no
 * `prizes`, no badge range and no badge binding. `prizes` is NOT accepted in
 * its place — the prize desk lists attendees as part of awarding a prize,
 * while browsing the whole register is separately granted. An Admin cookie
 * authorizes nothing here, and this file imports no Admin code.
 */

const MESSAGES = {
  attendeesRequired:
    'This device does not have Attendees access, so it cannot view the directory.',
  registerUnavailable:
    'The attendee register could not be read right now. Try again in a moment.',
  readOnly: 'The attendee directory is read-only.',
  unexpected: 'The attendee directory could not be loaded. Try again.',
} as const

/**
 * `405`, with the one method that exists.
 *
 * Built here rather than through `deviceJson` because `Allow` is part of the
 * answer: a client that asked for a mutation is told exactly what this
 * endpoint does support. The cache headers match every other device response.
 */
const methodNotAllowed = (): Response =>
  new Response(JSON.stringify({ ok: false, message: MESSAGES.readOnly }), {
    status: 405,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      allow: 'GET',
      vary: 'Cookie',
    },
  })

export async function GET(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: false })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device } = authorized.context

  /**
   * The CURRENT central attribute set, re-read with the session. An Admin may
   * have removed `attendees` after this page was opened, and an anonymous
   * caller never reaches here at all — so no unauthenticated request can
   * learn whether an event, a register or a database exists.
   */
  if (!device.attributes.includes(ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE)) {
    return deviceJson(
      {
        ok: false,
        blocked: 'attendees-required',
        message: MESSAGES.attendeesRequired,
      },
      403,
    )
  }

  /**
   * The Sheet credentials, behind the EXISTING release interlock — the same
   * one `/api/prizes` reuses, and for the same reasons. It is evaluated
   * BEFORE any credential is read, so a deployment with writes disabled never
   * handles a private key; and a register is only meaningful when THIS
   * deployment is the one writing that ledger, because reading a Badge
   * Register this runtime may not write would show somebody else's attendees.
   */
  const environment = readSyncEnvironment()

  if (environment.ok === false) {
    // Names the reason, never a value.
    console.error(
      `Navaratri attendees: refused. ${SYNC_DISABLED_LOG_MESSAGES[environment.reason]}`,
    )

    return deviceJson(
      {
        ok: false,
        reason: 'register-unavailable',
        message: MESSAGES.registerUnavailable,
      },
      503,
    )
  }

  try {
    const register = await readAttendeeRegister(environment.environment)

    /**
     * FAIL CLOSED. An unreadable register is NOT an empty event: returning
     * `[]` would tell a volunteer that nobody has registered, which is a
     * different and alarming fact. Neither is a partial list offered.
     */
    if (register.ok === false) {
      return deviceJson(
        {
          ok: false,
          reason: 'register-unavailable',
          message: MESSAGES.registerUnavailable,
        },
        503,
      )
    }

    /**
     * Badge-ascending, which the reader already guarantees and which is the
     * order an operator scans a stack of badges in. The count is the array's
     * length; a separate count field would be a second thing that can
     * disagree with the list.
     */
    return deviceJson({ ok: true, attendees: register.attendees }, 200)
  } catch (error: unknown) {
    /** The operation, and nothing from the error itself. */
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown'

    console.error(`Navaratri attendees: register read failed (${code}).`)

    return deviceJson({ ok: false, message: MESSAGES.unexpected }, 500)
  }
}

export function POST(): Response {
  return methodNotAllowed()
}

export function PUT(): Response {
  return methodNotAllowed()
}

export function PATCH(): Response {
  return methodNotAllowed()
}

export function DELETE(): Response {
  return methodNotAllowed()
}
