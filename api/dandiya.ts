import { DANDIYA_REQUIRED_ATTRIBUTE } from '../src/shared/device-attributes.js'
import { currentEventDayKey, eventDayWindow } from '../src/shared/event-time.js'
import { readAttendeeRegister } from '../server/attendees/register.js'
import { composeDandiyaBoard } from '../server/dandiya/board.js'
import {
  openDandiyaLoan,
  readDandiyaLedger,
  readDandiyaLoan,
  resolveDandiyaHolders,
  type DandiyaHistoryWindow,
} from '../server/dandiya/loans.js'
import {
  slotOf,
  parseDandiyaIssueInput,
  parseDandiyaResolveInput,
  registeredBadgesOf,
  resolutionOf,
} from '../server/dandiya/requests.js'
import { authorizeDeviceRequest } from '../server/device-auth/authorize.js'
import { deviceJson, readDeviceBody } from '../server/device-auth/http.js'
import {
  SYNC_DISABLED_LOG_MESSAGES,
  readSyncEnvironment,
  type SyncEnvironment,
} from '../server/sync/environment.js'

/**
 * DANDIYA CHECKOUT AND RETURN, as one Function.
 *
 *   GET   /api/dandiya   what is out, which pairs are quarantined, history
 *   POST  /api/dandiya   issue one pair to two attendees
 *   PATCH /api/dandiya   resolve one stick, or every stick still out
 *
 * The METHOD is the dispatcher. Separate active, history, issue, return and
 * search endpoints would cost five deployment Functions out of twelve for one
 * screen, and they are the same resource read and written.
 *
 * IT STRADDLES THE PRIVACY BOUNDARY DELIBERATELY, AND KEEPS IT.
 *
 *   Google Sheets  the attendees — badge, name, age, gender, read per request
 *                  through the ONE Badge Register reader `/api/prizes` and
 *                  `/api/attendees` also use
 *   Postgres       the loan ledger — pair code, two badge NUMBERS, two
 *                  slots, two devices, two timestamps, and nothing about the
 *                  people
 *
 * EACH STICK MOVES INDEPENDENTLY, since Phase D3.1. One may come back while
 * the other stays out — the loan is still open, the second attendee is still
 * holding, and the pair is still unavailable. A stick may also be reported
 * LOST, which frees its attendee and QUARANTINES the physical pair: the loan
 * closes, but `pair_released_at` stays null and the index keeps refusing that
 * pair code until a human releases it.
 *
 * Nothing here expires: there is no timer, no nightly job and no date
 * arithmetic on any mutation path. Midnight changes which rows `today` counts
 * and nothing else.
 *
 * ONLINE ONLY. There is no offline queue, no optimistic issue, no optimistic
 * return, no local authoritative state, no polling and no heartbeat. Two
 * disconnected desks must never be able to issue the same physical pair, or
 * the same attendee, and the only thing that can prevent that is a single
 * central authority answering in the moment.
 *
 * AUTHORIZATION IS A LIVE DEVICE SESSION with the CURRENT `dandiya`
 * attribute, re-read from Postgres on every request through the same
 * primitives `GET /api/device-auth` uses. It needs no `registration`, no
 * `prizes`, no `attendees`, no badge range and no badge binding — a dandiya
 * desk hands out sticks, not badges. It DOES read the safe attendee register,
 * because identifying the two badge holders is part of issuing the pair; that
 * is not the same as being granted the standalone directory. An Admin cookie
 * authorizes nothing here, and this file imports no Admin code.
 */

const MESSAGES = {
  dandiyaRequired:
    'This device does not have Dandiya access, so it cannot issue or resolve pairs.',
  registerUnavailable:
    'The attendee register could not be read right now. No pair was issued.',
  badgeNotRegistered:
    'That badge is not in this event’s attendee register.',
  pairInUse: 'That pair is already out.',
  pairUnavailable:
    'That pair is unavailable: its last loan ended with a stick lost.',
  attendeeHolding: 'That attendee is already holding a dandiya stick.',
  contactHolding:
    'That contact number already has a dandiya pair out. Bring it back first, or use a badge.',
  accountabilityHolding:
    'That attendee is still accountable for a pair that has not come back. Bring that pair back first.',
  holderResolved: 'That stick has already been resolved.',
  loanClosed: 'Every stick on that pair has already been resolved.',
  loanNotFound: 'That loan is not open on this event.',
  holderNotFound: 'That stick is not part of this loan.',
  unexpectedRead: 'The dandiya board could not be loaded. Try again.',
  unexpectedIssue: 'The pair could not be issued. Try again.',
  unexpectedResolve: 'The stick could not be resolved. Try again.',
  invalidHistoryDate:
    'historyDate must be a real calendar day, as YYYY-MM-DD.',
} as const

/**
 * WHICH DAY'S HISTORY WAS ASKED FOR, resolved to INSTANTS here.
 *
 * The client sends a day key and nothing else: no timestamps, no offset, no
 * timezone name. The boundaries are computed from the EVENT's zone through
 * the one shared definition, so neither a tablet's locale nor the database
 * session's `TimeZone` can decide which day a loan belongs to.
 *
 * An absent parameter means TODAY — in event time, decided here rather than
 * by whatever day the browser thinks it is.
 *
 * A malformed or impossible day is a 400 and NOT a silent fall back to today.
 * A typo that quietly answered for a different day would be a screen
 * confidently showing the wrong night's pairs.
 *
 * READ PATH ONLY. No calendar reaches `POST` or `PATCH`: a loan is issued and
 * resolved by a person, and nothing about either depends on the date.
 */
const readHistoryDay = (
  request: Request,
):
  | { ok: true; day: string; window: DandiyaHistoryWindow; today: DandiyaHistoryWindow }
  | { ok: false; response: Response } => {
  const today = currentEventDayKey()
  const todayWindow = eventDayWindow(today)
  const requested = new URL(request.url).searchParams.get('historyDate')
  const day = requested === null || requested === '' ? today : requested
  const window = eventDayWindow(day)

  if (window === null || todayWindow === null) {
    return {
      ok: false,
      response: deviceJson(
        {
          ok: false,
          blocked: 'invalid-history-date',
          message: MESSAGES.invalidHistoryDate,
        },
        400,
      ),
    }
  }

  return { ok: true, day, window, today: todayWindow }
}

/** Each public conflict, with the sentence an operator should read. */
const CONFLICT_MESSAGE = {
  'pair-in-use': MESSAGES.pairInUse,
  'pair-unavailable': MESSAGES.pairUnavailable,
  'attendee-already-holding-pair': MESSAGES.attendeeHolding,
  'contact-already-holding-pair': MESSAGES.contactHolding,
  'accountability-already-holding-pair': MESSAGES.accountabilityHolding,
  'holder-already-resolved': MESSAGES.holderResolved,
  'loan-already-closed': MESSAGES.loanClosed,
} as const

/**
 * The Sheet credentials, behind the EXISTING release interlock.
 *
 * Dandiya reuses `readSyncEnvironment` rather than introducing a read-only
 * variant, for the same two reasons prizes does. The interlock is evaluated
 * BEFORE any credential is read, so a deployment with writes disabled still
 * never handles a private key. And a register is only meaningful when THIS
 * deployment is the one writing that ledger: reading a Badge Register this
 * runtime may not write would show a dandiya desk somebody else's attendees.
 */
const readSheetAccess = ():
  | { ok: true; environment: SyncEnvironment }
  | { ok: false; response: Response } => {
  const environment = readSyncEnvironment()

  if (environment.ok === false) {
    // Names the reason, never a value.
    console.error(
      `Navaratri dandiya: refused. ${SYNC_DISABLED_LOG_MESSAGES[environment.reason]}`,
    )

    return {
      ok: false,
      response: deviceJson(
        {
          ok: false,
          reason: 'register-unavailable',
          message: MESSAGES.registerUnavailable,
        },
        503,
      ),
    }
  }

  return { ok: true, environment: environment.environment }
}

const dandiyaRequired = (): Response =>
  deviceJson(
    { ok: false, blocked: 'dandiya-required', message: MESSAGES.dandiyaRequired },
    403,
  )

const registerUnavailable = (): Response =>
  deviceJson(
    { ok: false, reason: 'register-unavailable', message: MESSAGES.registerUnavailable },
    503,
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

  console.error(`Navaratri dandiya: ${operation} failed (SQLSTATE ${code}).`)
}

/**
 * The common opening of every method: a live session with the current
 * `dandiya` attribute. An anonymous caller never gets past it, so no
 * unauthenticated request can learn whether an event, a ledger or a database
 * exists.
 */
const authorizeDandiya = async (
  request: Request,
  options: { mutating: boolean },
): Promise<
  | { ok: true; device: { id: string; name: string; eventId: string } }
  | { ok: false; response: Response }
> => {
  const authorized = await authorizeDeviceRequest(request, options)

  if (authorized.ok === false) {
    return { ok: false, response: authorized.response }
  }

  const { device } = authorized.context

  /**
   * The CURRENT central attribute set, re-read with the session. An Admin may
   * have removed `dandiya` after this page was opened.
   */
  if (!device.attributes.includes(DANDIYA_REQUIRED_ATTRIBUTE)) {
    return { ok: false, response: dandiyaRequired() }
  }

  return { ok: true, device: { id: device.id, name: device.name, eventId: device.eventId } }
}

export async function GET(request: Request): Promise<Response> {
  const authorized = await authorizeDandiya(request, { mutating: false })

  if (authorized.ok === false) {
    return authorized.response
  }

  const history = readHistoryDay(request)

  if (history.ok === false) {
    return history.response
  }

  const access = readSheetAccess()

  if (access.ok === false) {
    return access.response
  }

  try {
    const register = await readAttendeeRegister(access.environment)

    /**
     * FAIL CLOSED. An unreadable register is not an empty event, and a board
     * whose attendee names were silently missing would read as though a dozen
     * pairs were out to people who are no longer registered.
     */
    if (register.ok === false) {
      return registerUnavailable()
    }

    const ledger = await readDandiyaLedger({
      eventId: authorized.device.eventId,
      history: history.window,
      today: history.today,
    })

    return deviceJson(
      {
        ok: true,
        ...composeDandiyaBoard({
          ledger,
          attendees: register.attendees,
          historyDay: history.day,
        }),
      },
      200,
    )
  } catch (error: unknown) {
    logUnexpected('board', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpectedRead }, 500)
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorized = await authorizeDandiya(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parseDandiyaIssueInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  const access = readSheetAccess()

  if (access.ok === false) {
    return access.response
  }

  try {
    /**
     * EVERY BADGE PRESENTED MUST EXIST, and this read happens BEFORE the
     * insert for that reason: a pair recorded against a number nobody
     * registered is a ledger entry no human can reconcile. A Sheet that
     * cannot be read therefore writes NOTHING — the register is the only
     * thing that can confirm a badge, so failing closed is the only honest
     * answer.
     *
     * A GUEST SLOT PRESENTS NO BADGE, so there is nothing to confirm about
     * it. The register is still read — the other holder may have a badge, and
     * the board's names come from it — but a fully badgeless pair is
     * accountable to its contact number rather than to the register.
     */
    const register = await readAttendeeRegister(access.environment)

    if (register.ok === false) {
      return registerUnavailable()
    }

    const byBadge = new Map(
      register.attendees.map((attendee) => [attendee.badgeNumber, attendee]),
    )
    const missing = registeredBadgesOf(input.value.issuance).filter(
      (badge) => !byBadge.has(badge),
    )

    if (missing.length > 0) {
      return deviceJson(
        {
          ok: false,
          blocked: 'badge-not-registered',
          badgeNumbers: missing,
          message: MESSAGES.badgeNotRegistered,
        },
        404,
      )
    }

    /**
     * NO PRECHECK DECIDES ANYTHING. Whether this pair is available, and
     * whether either attendee already holds a stick, are the DATABASE's
     * answers: two desks would both read "free" and both proceed. The two
     * partial unique indexes decide, and the loser is told which conflict it
     * hit — including whether the pair is merely OUT or is quarantined after
     * a loss, which the writer resolves by re-reading AFTER the refusal.
     */
    const opened = await openDandiyaLoan({
      eventId: authorized.device.eventId,
      pairCode: input.value.pairCode,
      issuance: input.value.issuance,
      issuedByDeviceId: authorized.device.id,
    })

    if (opened.ok === false) {
      /**
       * Translated through the ONE internal-to-public map. No constraint
       * name, no SQLSTATE, and nothing about the other desk: the operator
       * needs to know the pair is out or the attendee is holding one, not
       * which index refused it.
       */
      return deviceJson(
        {
          ok: false,
          conflict: opened.conflict,
          message: CONFLICT_MESSAGE[opened.conflict],
        },
        409,
      )
    }

    /**
     * The COMPLETE active loan, shaped exactly as `GET` returns one, so the
     * client can show it immediately. The attendees are the two just
     * confirmed above — joined, never stored.
     */
    const board = composeDandiyaBoard({
      ledger: { loans: [opened.value], deviceNames: new Map([[authorized.device.id, authorized.device.name]]) },
      attendees: register.attendees,
    })

    return deviceJson({ ok: true, loan: board.active[0] }, 201)
  } catch (error: unknown) {
    logUnexpected('issue', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpectedIssue }, 500)
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorized = await authorizeDandiya(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parseDandiyaResolveInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  try {
    /**
     * A RESOLUTION NEEDS NO SHEET. The badges are already in the ledger and
     * nobody's name has to be confirmed to take a stick back or to record one
     * missing, so this path reads no attendee data at all — and resolving
     * keeps working when the Sheet does not.
     *
     * THE LOAN IS READ FIRST, but only for the MESSAGE: it separates "no
     * such loan on this event" from "that badge is not one of its holders"
     * from "somebody resolved it first". Every authority below is a
     * compare-and-set behind the loan's own row lock.
     *
     * One loan by id, never the board: a resolution must not depend on which
     * DAY the operator happens to be looking at, and a mutation path has no
     * business consulting a calendar.
     */
    const loan = await readDandiyaLoan({
      eventId: authorized.device.eventId,
      loanId: input.value.loanId,
    })

    if (loan === null) {
      return deviceJson(
        { ok: false, blocked: 'loan-not-found', message: MESSAGES.loanNotFound },
        404,
      )
    }

    const slot = slotOf(input.value)

    if (slot !== undefined && !loan.holders.some((holder) => holder.slot === slot)) {
      return deviceJson(
        { ok: false, blocked: 'holder-not-found', message: MESSAGES.holderNotFound },
        404,
      )
    }

    const resolved = await resolveDandiyaHolders({
      eventId: authorized.device.eventId,
      loanId: input.value.loanId,
      slot,
      resolution: resolutionOf(input.value),
      resolvedByDeviceId: authorized.device.id,
    })

    if (resolved.ok === false) {
      /**
       * The compare-and-set matched nothing: that stick, or every stick, was
       * already resolved. Ordinary operational news — and never an overwrite,
       * because a resolution is final.
       */
      return deviceJson(
        {
          ok: false,
          conflict: resolved.conflict,
          message: CONFLICT_MESSAGE[resolved.conflict],
        },
        409,
      )
    }

    /**
     * The client re-reads rather than being handed a new board: the counters,
     * Active, Issues and History all move together, and whether this
     * resolution CLOSED the loan was decided by the database rather than by
     * this process. One request is cheaper than composing all of that twice,
     * and it cannot disagree with the ledger.
     */
    return deviceJson(
      {
        ok: true,
        loanId: input.value.loanId,
        resolvedAt: resolved.resolvedAt,
        resolvedHolders: resolved.resolvedHolders,
      },
      200,
    )
  } catch (error: unknown) {
    logUnexpected('resolve', error)

    return deviceJson({ ok: false, message: MESSAGES.unexpectedResolve }, 500)
  }
}
