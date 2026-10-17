import { PRIZE_REQUIRED_ATTRIBUTE } from '../src/shared/device-attributes.js'
import {
  readCngPrizeAwards,
  recordCngPrizeAward,
} from '../server/cng/awards.js'
import {
  addCngMember,
  readCngMembers,
  removeCngMember,
} from '../server/cng/members.js'
import {
  parseCngAddInput,
  parseCngAwardInput,
  parseCngRemoveInput,
} from '../server/cng/requests.js'
import { composeCngMembers, composeCngPrizeAwards } from '../server/cng/roster.js'
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
 * PRIZE DISTRIBUTION AND THE CNG VOLUNTEER GROUP, as one Function.
 *
 *   GET    /api/prizes   the attendees, the attendee award history, the
 *                        ACTIVE CNG group, and the CNG award history
 *   POST   /api/prizes   award one prize to one BADGE      (attendees)
 *   PUT    /api/prizes   add one CNG member, by NAME       (volunteers)
 *   DELETE /api/prizes   soft-remove one CNG member, by ID (volunteers)
 *   PATCH  /api/prizes   award one prize to one CNG member (volunteers)
 *
 * The METHOD is the dispatcher, never `?action=` and never an `action` field
 * in a body. Separate list, history, award and membership endpoints would
 * cost six deployment Functions out of twelve for one screen — and at eleven
 * of twelve there is one slot left, which is headroom rather than permission.
 *
 * TWO AWARD METHODS, AND THAT IS DELIBERATE. `POST` is the Production-live
 * attendee contract — a badge number and a prize — and Phase CNG1.1 does not
 * touch it. `PATCH` is the volunteer one, carrying a CNG member id instead.
 * Keeping them apart is what stops the badge-based semantics drifting: there
 * is no body shape that could be read as either, and no code path where a
 * volunteer's identity could reach `prize_awards`.
 *
 * A CNG MEMBER IS A NAME, NOT A BADGE — the correction Phase CNG1.1 makes.
 * CNG1 assumed a volunteer was a registered attendee and keyed membership by
 * badge number; volunteers do not wear the numbered badges and most never
 * pass the registration desk. So `PUT` takes a NAME, the Badge Register is
 * NOT read when adding a member, and `badgeNumber` in any CNG body is
 * REFUSED rather than ignored.
 *
 * MEMBERSHIP IS SOFT-REMOVABLE AND BOTH LEDGERS ARE APPEND-ONLY. `DELETE`
 * stamps `removed_at` so a volunteer's prize history can still name them; it
 * deletes nothing. No method here can edit or delete a row of either
 * `prize_awards` or `cng_prize_awards`, and neither writer offers a function
 * that could.
 *
 * IT STRADDLES THE PRIVACY BOUNDARY DELIBERATELY, AND KEEPS IT.
 *
 *   Google Sheets  the ATTENDEES — badge, name, age, gender, read per
 *                  request through the ONE Badge Register reader
 *                  `/api/attendees` also uses
 *   Postgres       the attendee prize ledger — badge, prize, device, time —
 *                  the CNG group — NAME, device, time — and the CNG prize
 *                  ledger — member reference, prize, device, time
 *
 * Nothing an ATTENDEE told the registration desk is written centrally here.
 * The screen needs a name beside a badge number, so the name is READ from the
 * Sheet and joined; it is never stored, and the phone number and the WhatsApp
 * link are never read at all.
 *
 * A CNG MEMBER'S NAME *IS* STORED, and that is an explicit, product-required
 * change rather than an erosion. A volunteer has no badge and no Sheet row,
 * so the name is the only thing that can identify them — and it is the ONLY
 * person field either CNG table holds. No phone, age, gender, WhatsApp link
 * or payment detail is accepted by any method, stored by any writer, or has a
 * column to land in.
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
    'This device does not have Prizes access, so it cannot award prizes or curate the CNG group.',
  rosterUnavailable:
    'The attendee register could not be read right now. No prize was recorded.',
  badgeNotRegistered:
    'That badge is not in this event’s attendee register.',
  unexpected: 'The prize could not be recorded. Try again.',
  /** CNG membership. A member is a NAME — no badge, and no register read. */
  notACngMember: 'That CNG member is no longer in the group.',
  cngIdInUse:
    'That CNG member was already added under a different name. Refresh the group and check before adding again.',
  cngMemberUnavailable:
    'That CNG member is no longer in the group, so no prize was recorded.',
  unexpectedCngAdd: 'The CNG member could not be added. Try again.',
  unexpectedCngRemove: 'The CNG member could not be removed. Try again.',
  unexpectedCngAward: 'The CNG prize could not be recorded. Try again.',
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
    const members = await readCngMembers(device.eventId)
    const cngAwards = await readCngPrizeAwards(device.eventId)

    /**
     * FOUR LISTS, SIDE BY SIDE, none derived from another.
     *
     * `attendees` is the WHOLE Badge Register and `awards` the whole attendee
     * history — neither is subtracted from the other, because a previous
     * prize disqualifies nobody. `cng` is the ACTIVE volunteer group and
     * `cngAwards` every volunteer prize, including those of members who have
     * since been removed.
     *
     * THE TWO AWARD LISTS ARE SEPARATE ON THE WIRE and combined for DISPLAY
     * by the client, which is the honest shape: they are different ledgers
     * with different identities — a badge number and a member id — and
     * merging them server-side would mean inventing a field one of them does
     * not have.
     *
     * All four travel together because they are one screen, loaded in the one
     * request it already makes. Fetching the group separately would mean a
     * second round trip for a tab the operator may switch to at any moment.
     */
    return deviceJson(
      {
        ok: true,
        ...composePrizeRoster({ attendees: roster.attendees, awards }),
        cng: composeCngMembers(members),
        cngAwards: composeCngPrizeAwards(cngAwards),
      },
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

/**
 * PUT — add one CNG member, BY NAME, idempotently.
 *
 * THE BODY IS `{ cngMemberId, name }` AND NOTHING ELSE, and `badgeNumber` is
 * REFUSED rather than ignored. That refusal is the correction Phase CNG1.1
 * makes concrete: CNG1 keyed membership by badge on the assumption that a
 * volunteer was a registered attendee, and a body still carrying one would be
 * the first step back to a model that cannot represent the people it
 * describes.
 *
 * `cngMemberId` IS THE IDEMPOTENCY KEY, generated by the client once per
 * member it is about to add. A NAME COULD NOT BE: two volunteers may
 * genuinely share one, so "have I already added this person?" is unanswerable
 * from a name, and de-duplicating by it would merge two people. The row's
 * UUID answers it exactly.
 *
 * SO A RETRY IS SAFE AND A COLLISION IS NOT SILENT:
 *
 *   201  added            a new row
 *   200  already-member   the same id and the same name again — the retry of
 *                         a lost response, which is what the key is for
 *   409  id-in-use        the same id with a DIFFERENT name. Refused rather
 *                         than overwriting somebody; whichever of the two the
 *                         operator meant, guessing is wrong
 *
 * TWO DIFFERENT IDS WITH THE SAME NAME BOTH SUCCEED, which is the case a
 * name-keyed idempotency would have destroyed.
 *
 * NO BADGE REGISTER IS READ. There is nothing to confirm: a volunteer has no
 * badge, no Sheet row and no age or gender this application knows. So this
 * handler opens no Sheets client, and adding a member keeps working when the
 * register does not.
 */
export async function PUT(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device } = authorized.context

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parseCngAddInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  if (!device.attributes.includes(PRIZE_REQUIRED_ATTRIBUTE)) {
    return prizesRequired()
  }

  try {
    const result = await addCngMember({
      eventId: device.eventId,
      cngMemberId: input.value.cngMemberId,
      name: input.value.name,
      addedByDevice: { id: device.id, name: device.name },
    })

    /**
     * THE ID BELONGS TO ANOTHER EVENT. Effectively impossible for a
     * client-generated UUID, and refused without disclosing anything about
     * that row — the caller learns nothing about another event's data.
     */
    if (result.outcome === 'id-elsewhere') {
      return deviceJson(
        { ok: false, conflict: 'cng-id-in-use', message: MESSAGES.cngIdInUse },
        409,
      )
    }

    /**
     * The COMPLETE member row, shaped exactly as `GET` returns one, so the
     * client can place it straight into the group without re-fetching. It is
     * the AUTHORITATIVE row on every path — including a refusal, so the
     * screen can show what actually exists.
     */
    const [composed] = composeCngMembers([result.member])

    if (result.outcome === 'id-in-use') {
      return deviceJson(
        {
          ok: false,
          conflict: 'cng-id-in-use',
          member: composed,
          message: MESSAGES.cngIdInUse,
        },
        409,
      )
    }

    return deviceJson(
      { ok: true, outcome: result.outcome, member: composed },
      result.outcome === 'added' ? 201 : 200,
    )
  } catch (error: unknown) {
    logUnexpected('cng add', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpectedCngAdd }, 500)
  }
}

/**
 * DELETE — soft-remove one CNG member, by the row's own id.
 *
 * IT DELETES NOTHING. `removed_at` and the removing device are stamped, and
 * the row stays: `cng_prize_awards` references it with `ON DELETE restrict`,
 * so a volunteer who has received a prize could not be deleted anyway — and
 * history has to be able to say WHO received it. The ACTIVE group is what
 * `GET` returns, so the member disappears from the roster and their awards
 * stay in the history.
 *
 * BY ID, NEVER BY NAME. Two volunteers may share a name, so removing
 * "whoever is called that" could remove the wrong person; `name` in the body
 * is refused rather than used.
 *
 * NO SHEET IS READ and no attendee, registration, badge or attendee award is
 * touched. The removal is its own authority: a compare-and-set on
 * `removed_at IS NULL`, whose empty `RETURNING` is what says there was
 * nothing to remove — ordinary operational news when another desk got there
 * first.
 */
export async function DELETE(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device } = authorized.context

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parseCngRemoveInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  if (!device.attributes.includes(PRIZE_REQUIRED_ATTRIBUTE)) {
    return prizesRequired()
  }

  try {
    const removed = await removeCngMember({
      eventId: device.eventId,
      cngMemberId: input.value.cngMemberId,
      removedByDevice: { id: device.id },
    })

    if (!removed) {
      return deviceJson(
        {
          ok: false,
          blocked: 'not-a-cng-member',
          message: MESSAGES.notACngMember,
        },
        404,
      )
    }

    return deviceJson({ ok: true, cngMemberId: input.value.cngMemberId }, 200)
  } catch (error: unknown) {
    logUnexpected('cng remove', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpectedCngRemove }, 500)
  }
}

/**
 * PATCH — award one prize to one ACTIVE CNG member.
 *
 * A SEPARATE METHOD FROM THE ATTENDEE AWARD, deliberately. `POST` carries a
 * BADGE NUMBER and writes `prize_awards`; this carries a CNG MEMBER ID and
 * writes `cng_prize_awards`. Keeping them apart is what stops the live
 * badge-based contract drifting: there is no body shape that could be read as
 * either, and no path by which a volunteer's identity could reach the
 * attendee ledger. This handler names no prize-ledger function at all.
 *
 * NO FAKE BADGE, ANYWHERE. `prize_awards.badge_number` stays NOT NULL and
 * badge-based; a volunteer simply does not appear in it.
 *
 * NO BADGE REGISTER IS READ. The recipient is a volunteer, and the one thing
 * that has to be true about them — that they are still an active member of
 * this event — is decided by the DATABASE, as a predicate on the insert
 * rather than a read above it. A removed member's award yields no row.
 *
 * REPEAT PRIZES ARE LEGAL, as they are for attendees: the ledger is not
 * consulted before the insert and there is no conflict to report.
 */
export async function PATCH(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device } = authorized.context

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parseCngAwardInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  if (!device.attributes.includes(PRIZE_REQUIRED_ATTRIBUTE)) {
    return prizesRequired()
  }

  try {
    const recorded = await recordCngPrizeAward({
      eventId: device.eventId,
      cngMemberId: input.value.cngMemberId,
      prizeName: input.value.prizeName,
      awardedByDevice: { id: device.id, name: device.name },
    })

    if (recorded.outcome === 'member-unavailable') {
      /**
       * No such ACTIVE member on this event — removed, or never here.
       * Ordinary operational news, and nothing was written.
       */
      return deviceJson(
        {
          ok: false,
          blocked: 'cng-member-unavailable',
          message: MESSAGES.cngMemberUnavailable,
        },
        404,
      )
    }

    /**
     * The COMPLETE award row, shaped exactly as `GET` returns one, so the
     * client can place it straight into the combined history without
     * re-fetching.
     */
    const [composed] = composeCngPrizeAwards([recorded.award])

    return deviceJson({ ok: true, award: composed }, 201)
  } catch (error: unknown) {
    logUnexpected('cng award', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpectedCngAward }, 500)
  }
}
