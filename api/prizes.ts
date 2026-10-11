import { PRIZE_REQUIRED_ATTRIBUTE } from '../src/shared/device-attributes.js'
import { authorizeDeviceRequest } from '../server/device-auth/authorize.js'
import { deviceJson, readDeviceBody } from '../server/device-auth/http.js'
import { composePrizeRoster } from '../server/prizes/eligibility.js'
import { readPrizeAwards, recordPrizeAward } from '../server/prizes/awards.js'
import { readAttendeeRegister } from '../server/attendees/register.js'
import { parsePrizeAwardInput } from '../server/prizes/requests.js'
import {
  SYNC_DISABLED_LOG_MESSAGES,
  readSyncEnvironment,
  type SyncEnvironment,
} from '../server/sync/environment.js'

/**
 * PRIZE DISTRIBUTION, as one Function.
 *
 *   GET  /api/prizes   every registered attendee, and the award history
 *   POST /api/prizes   award one prize to one badge
 *
 * The METHOD is the dispatcher. Separate list, history and award endpoints
 * would cost three deployment Functions out of twelve for one screen, and
 * they are the same resource read and written.
 *
 * IT STRADDLES THE PRIVACY BOUNDARY DELIBERATELY, AND KEEPS IT.
 *
 *   Google Sheets  the attendees — badge, name, age, gender, read per request
 *                  through the ONE Badge Register reader `/api/attendees`
 *                  also uses
 *   Postgres       the prize ledger — badge, prize, device, time, and nothing
 *                  about the person
 *
 * Nothing an attendee told the registration desk is written centrally here.
 * The screen needs a name beside a badge number, so the name is READ from the
 * Sheet and joined; it is never stored, and the phone number and the WhatsApp
 * link are never read at all.
 *
 * REPEAT PRIZES ARE LEGAL, since Phase P1.1. An attendee may win Best Dance
 * and Best Dress, or the same prize twice. `POST` therefore asks the ledger
 * NOTHING before inserting and can refuse nothing on those grounds: the only
 * attendee precondition is that the badge is in the current Badge Register.
 * Two desks awarding the same badge at the same moment both succeed, and both
 * rows are true.
 *
 * ONLINE ONLY. There is no offline prize queue, no optimistic local award, no
 * local authoritative prize state, no polling and no heartbeat. A prize that
 * survived a failed request would be an award nobody can account for, and the
 * ledger is the only thing that knows what has been given.
 *
 * AUTHORIZATION IS A LIVE DEVICE SESSION with the CURRENT `prizes` attribute,
 * re-read from Postgres on every request through the same primitives
 * `GET /api/device-auth` uses. It needs no `registration`, no badge range and
 * no badge binding: awarding a prize consumes no badge number. An Admin
 * cookie authorizes nothing here — the realms are cryptographically separate
 * and this file imports no Admin code.
 */

const MESSAGES = {
  prizesRequired:
    'This device does not have Prizes access, so it cannot award prizes.',
  rosterUnavailable:
    'The attendee register could not be read right now. No prize was recorded.',
  badgeNotRegistered:
    'That badge is not in this event’s attendee register.',
  unexpected: 'The prize could not be recorded. Try again.',
} as const

/**
 * The Sheet credentials, behind the EXISTING release interlock.
 *
 * Prizes reuses `readSyncEnvironment` rather than introducing a read-only
 * variant, for two reasons. The interlock is evaluated BEFORE any credential
 * is read, so a deployment with writes disabled still never handles a private
 * key — weakening that for a read path would give away a property this
 * repository has had since the interlock existed. And a roster is only
 * meaningful when THIS deployment is the one writing that ledger: reading a
 * Badge Register this runtime is not allowed to write would show a prize desk
 * somebody else's attendees.
 *
 * A failure returns the reason and no environment, so the endpoint fails
 * closed rather than half-operating.
 */
const readSheetAccess = ():
  | { ok: true; environment: SyncEnvironment }
  | { ok: false; response: Response } => {
  const environment = readSyncEnvironment()

  if (environment.ok === false) {
    // Names the reason, never a value.
    console.error(
      `Navaratri prizes: refused. ${SYNC_DISABLED_LOG_MESSAGES[environment.reason]}`,
    )

    return {
      ok: false,
      response: deviceJson(
        { ok: false, reason: 'roster-unavailable', message: MESSAGES.rosterUnavailable },
        503,
      ),
    }
  }

  return { ok: true, environment: environment.environment }
}

const prizesRequired = (): Response =>
  deviceJson(
    { ok: false, blocked: 'prizes-required', message: MESSAGES.prizesRequired },
    403,
  )

/**
 * The operation and, where available, the SQLSTATE. Never a body, never an
 * attendee, never a connection string, never a raw driver error.
 */
const logUnexpected = (operation: string, error: unknown): void => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'unknown'

  console.error(`Navaratri prizes: ${operation} failed (SQLSTATE ${code}).`)
}

export async function GET(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: false })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device } = authorized.context

  /**
   * The CURRENT central attribute set, re-read with the session. An Admin may
   * have removed `prizes` after this page was opened, and an anonymous caller
   * never reaches here at all — so no unauthenticated request can learn
   * whether a prize ledger or a database exists.
   */
  if (!device.attributes.includes(PRIZE_REQUIRED_ATTRIBUTE)) {
    return prizesRequired()
  }

  const access = readSheetAccess()

  if (access.ok === false) {
    return access.response
  }

  try {
    const roster = await readAttendeeRegister(access.environment)

    if (roster.ok === false) {
      return deviceJson(
        { ok: false, reason: 'roster-unavailable', message: MESSAGES.rosterUnavailable },
        503,
      )
    }

    const awards = await readPrizeAwards(device.eventId)

    /**
     * `attendees` is the WHOLE register and `awards` the whole history. They
     * are returned side by side rather than subtracted from each other: the
     * screen needs the previous prizes to warn about them, and an attendee
     * with three already is still an attendee.
     */
    return deviceJson(
      { ok: true, ...composePrizeRoster({ attendees: roster.attendees, awards }) },
      200,
    )
  } catch (error: unknown) {
    logUnexpected('roster', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpected }, 500)
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device } = authorized.context

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parsePrizeAwardInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  if (!device.attributes.includes(PRIZE_REQUIRED_ATTRIBUTE)) {
    return prizesRequired()
  }

  const access = readSheetAccess()

  if (access.ok === false) {
    return access.response
  }

  try {
    /**
     * THE BADGE MUST EXIST, and this read happens BEFORE the insert for that
     * reason: a prize recorded against a number nobody registered is a ledger
     * entry no human can reconcile. A Sheet that cannot be read therefore
     * writes NOTHING — the register is the only thing that can confirm the
     * badge, so failing closed is the only honest answer.
     */
    const roster = await readAttendeeRegister(access.environment)

    if (roster.ok === false) {
      return deviceJson(
        { ok: false, reason: 'roster-unavailable', message: MESSAGES.rosterUnavailable },
        503,
      )
    }

    const attendee = roster.attendees.find(
      (candidate) => candidate.badgeNumber === input.value.badgeNumber,
    )

    if (attendee === undefined) {
      return deviceJson(
        {
          ok: false,
          blocked: 'badge-not-registered',
          message: MESSAGES.badgeNotRegistered,
        },
        404,
      )
    }

    /**
     * THE LEDGER IS NOT CONSULTED. Repeat awards are the product rule, so
     * there is no "has this badge been awarded already?" question to ask and
     * no conflict to report. Every successful POST appends exactly one row.
     */
    const recorded = await recordPrizeAward({
      eventId: device.eventId,
      badgeNumber: input.value.badgeNumber,
      prizeName: input.value.prizeName,
      awardedByDevice: { id: device.id, name: device.name },
    })

    /**
     * The COMPLETE history row, shaped exactly as `GET` returns one, so the
     * client can place it straight into Awards without re-fetching. The
     * attendee is the one just confirmed above — joined, never stored.
     */
    return deviceJson({ ok: true, award: { ...recorded, attendee } }, 201)
  } catch (error: unknown) {
    logUnexpected('award', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpected }, 500)
  }
}
