import { parseAttendeeList, parseEventAttendee } from '@/shared/attendee-contract'
import { isEventDayKey } from '@/shared/event-time'
import { isCanonicalPhone } from '@/shared/phone'
import type {
  DandiyaActiveLoan,
  DandiyaBoardResponse,
  DandiyaDayCounters,
  DandiyaDevice,
  DandiyaHolder,
  DandiyaLoanRecord,
} from '@/shared/dandiya-contract'
import {
  isDandiyaHolderResolution,
  isDandiyaOutcome,
} from '@/shared/dandiya-contract'

/**
 * Runtime validation of the Dandiya responses.
 *
 * A TypeScript annotation on a `fetch` result is a claim, not a check. This
 * screen decides which physical pair a volunteer hands over and which pair
 * they take back, so every field is verified and an unrecognised shape FAILS
 * CLOSED rather than becoming a card.
 *
 * Projected FIELD BY FIELD, never spread. If the server ever started
 * returning an attendee's phone number — the one thing the attendee contract
 * deliberately excludes — it would not reach local state by accident.
 *
 * The ATTENDEE half is not duplicated here: it lives once in
 * `src/shared/attendee-contract.ts` and every module calls it.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value)

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * The six counters, parsed FIELD BY FIELD and never cast.
 *
 * A missing one fails the whole response rather than rendering as `undefined`
 * on a stat card — and building the object explicitly is what makes that
 * true: a cast would assert the result of the check instead of using it,
 * which is the mistake this file exists to avoid.
 */
const parseCounters = (value: unknown): DandiyaDayCounters | null => {
  if (!isRecord(value)) {
    return null
  }

  const { issued, fullyReturned, partialLosses, lostPairs, activeLoans, sticksOut } = value

  if (
    !isCount(issued) ||
    !isCount(fullyReturned) ||
    !isCount(partialLosses) ||
    !isCount(lostPairs) ||
    !isCount(activeLoans) ||
    !isCount(sticksOut)
  ) {
    return null
  }

  return { issued, fullyReturned, partialLosses, lostPairs, activeLoans, sticksOut }
}

const parseDevice = (value: unknown): DandiyaDevice | null => {
  if (!isRecord(value) || !isUuid(value.id) || !isNonEmpty(value.name)) {
    return null
  }

  return { id: value.id, name: value.name }
}

/**
 * One stick. `attendee` is legitimately `null` — the Sheet row may be gone
 * and the stick really did go out — so an absent attendee is accepted while a
 * MALFORMED one rejects the holder.
 *
 * THE THREE RESOLUTION FIELDS MOVE TOGETHER, exactly as the database's own
 * check requires. A holder with a resolution and no time, or a time and no
 * device, is a row nobody could account for, and it is rejected rather than
 * rendered as half-resolved.
 */
const parseHolder = (value: unknown): DandiyaHolder | null => {
  if (!isRecord(value)) {
    return null
  }

  if (value.slot !== 1 && value.slot !== 2) {
    return null
  }

  /**
   * A BADGE, OR `null` FOR A GUEST — and nothing in between. A `0`, a
   * negative number or a string is REJECTED rather than coerced to "no
   * badge": a synthetic badge arriving from a server is a bug worth seeing,
   * and silently rendering it as a guest would hide it.
   */
  if (value.badgeNumber !== null && !isPositiveInteger(value.badgeNumber)) {
    return null
  }

  const badgeNumber: number | null = value.badgeNumber

  const attendee =
    value.attendee === null || value.attendee === undefined
      ? null
      : parseEventAttendee(value.attendee)

  if (value.attendee !== null && value.attendee !== undefined && attendee === null) {
    return null
  }

  const unresolved =
    value.resolution === null && value.resolvedAt === null && value.resolvedBy === null

  if (unresolved) {
    return {
      badgeNumber,
      slot: value.slot,
      attendee,
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
    }
  }

  const resolvedBy = parseDevice(value.resolvedBy)

  if (
    !isDandiyaHolderResolution(value.resolution) ||
    !isNonEmpty(value.resolvedAt) ||
    resolvedBy === null
  ) {
    return null
  }

  return {
    badgeNumber,
    slot: value.slot,
    attendee,
    resolution: value.resolution,
    resolvedAt: value.resolvedAt,
    resolvedBy,
  }
}

/** A pair goes to exactly two people, so two holders or the loan is rejected. */
const parseHolders = (value: unknown): DandiyaHolder[] | null => {
  if (!Array.isArray(value) || value.length !== 2) {
    return null
  }

  const holders: DandiyaHolder[] = []

  for (const entry of value) {
    const holder = parseHolder(entry)

    if (holder === null) {
      return null
    }

    holders.push(holder)
  }

  /**
   * TWO DIFFERENT ATTENDEES, when both have badges. Two GUESTS are not the
   * same holder twice — they are two anonymous sticks, which is exactly what
   * the database's NULL-distinct uniqueness allows, so a pair of nulls is
   * accepted while a repeated real badge is not.
   */
  const [first, second] = holders

  if (
    first.badgeNumber !== null &&
    second.badgeNumber !== null &&
    first.badgeNumber === second.badgeNumber
  ) {
    return null
  }

  return holders
}

export const parseActiveLoan = (value: unknown): DandiyaActiveLoan | null => {
  if (!isRecord(value) || !isUuid(value.id) || !isNonEmpty(value.pairCode)) {
    return null
  }

  const issuedBy = parseDevice(value.issuedBy)
  const holders = parseHolders(value.holders)

  if (!isNonEmpty(value.issuedAt) || issuedBy === null || holders === null) {
    return null
  }

  /**
   * A CONTACT NUMBER, and only in the one shape this application stores: ten
   * digits. Anything else rejects the loan rather than being rendered — a
   * number somebody is meant to ring has to be the number that was given.
   *
   * IT MUST BE ABSENT WHENEVER A HOLDER HAS A BADGE, which is the invariant
   * the open-contact index relies on. A server sending both is not a server
   * this screen can reason about.
   */
  const badgeless = holders.every((holder) => holder.badgeNumber === null)
  const contactPhone = value.contactPhone

  if (contactPhone !== null && (!isCanonicalPhone(contactPhone) || !badgeless)) {
    return null
  }

  /**
   * THE MIXED LOAN'S ANCHOR, and it must be one of THIS loan's own badges.
   *
   * Present exactly when one holder has a badge and the other does not, and
   * equal to that badge. Absent for two badges and for two guests, and never
   * beside a contact number — which is the exclusivity the database enforces
   * as a CHECK.
   *
   * A server sending any other combination is not a server this screen can
   * reason about: it would be showing accountability that does not match the
   * ledger's own, so the loan is REJECTED rather than rendered with a label
   * nobody can act on.
   */
  const badges = holders
    .map((holder) => holder.badgeNumber)
    .filter((badge): badge is number => badge !== null)
  /**
   * DERIVED FROM THE HOLDERS AND THEN COMPARED, rather than read and trusted.
   *
   * Comparing is what makes every wrong combination fail at once: a mixed
   * loan with no anchor, a mixed loan anchored to some other badge, an anchor
   * on a two-badge loan, and an anchor beside a contact number — which cannot
   * reach here, because a badgeless loan's expected anchor is `null`.
   */
  const anchor = badges.length === 1 ? badges[0] : null

  if (value.accountabilityBadgeNumber !== anchor) {
    return null
  }

  return {
    id: value.id,
    pairCode: value.pairCode,
    issuedAt: value.issuedAt,
    issuedBy,
    holders,
    contactPhone,
    accountabilityBadgeNumber: anchor,
  }
}

export const parseLoanRecord = (value: unknown): DandiyaLoanRecord | null => {
  const active = parseActiveLoan(value)

  if (active === null || !isRecord(value)) {
    return null
  }

  /**
   * A CLOSE IS ONE FACT, so its three fields move together — exactly as the
   * database's own check requires. A record with a close time and no outcome
   * is a loan nobody could account for, and it is rejected rather than
   * rendered.
   */
  const open =
    value.closedAt === null && value.closedBy === null && value.outcome === null

  if (open) {
    return value.pairReleasedAt === null
      ? { ...active, closedAt: null, closedBy: null, outcome: null, pairReleasedAt: null }
      : null
  }

  const closedBy = parseDevice(value.closedBy)

  if (
    !isNonEmpty(value.closedAt) ||
    closedBy === null ||
    !isDandiyaOutcome(value.outcome)
  ) {
    return null
  }

  /**
   * AND THE PAIR IS FREED BY A CLEAN RETURN AND BY NOTHING ELSE, in both
   * directions — the same pair of checks the database carries. A record
   * claiming a loss released the pair, or that a clean return did not, is
   * rejected: the screen decides from this whether to show a pair as
   * unavailable, and a wrong answer there sends somebody to fetch a pair that
   * is missing a stick.
   */
  const released = value.pairReleasedAt

  if (value.outcome === 'returned') {
    if (!isNonEmpty(released)) {
      return null
    }
  } else if (released !== null) {
    return null
  }

  return {
    ...active,
    closedAt: value.closedAt,
    closedBy,
    outcome: value.outcome,
    pairReleasedAt: typeof released === 'string' ? released : null,
  }
}

/**
 * The whole board, or `null`.
 *
 * ONE bad entry rejects the WHOLE response rather than being dropped. A
 * dandiya desk working from a silently shortened Active list would issue a
 * pair that is already out, and be refused by the database for a reason the
 * screen could not explain.
 */
export const parseDandiyaBoardResponse = (
  body: unknown,
): DandiyaBoardResponse | null => {
  if (
    !isRecord(body) ||
    !Array.isArray(body.active) ||
    !Array.isArray(body.issues) ||
    !Array.isArray(body.history)
  ) {
    return null
  }

  const today = parseCounters(body.today)

  if (today === null) {
    return null
  }

  /**
   * THE TWO DAY KEYS ARE VERIFIED, not assumed.
   *
   * `historyDay` is what the screen labels the day's rows with and
   * `eventDay` is what makes a loan "from a previous day", so a missing or
   * malformed value must reject the whole board rather than become a heading
   * nobody can trust. `isEventDayKey` is the SAME predicate the server used
   * to accept the request.
   */
  if (!isEventDayKey(body.historyDay) || !isEventDayKey(body.eventDay)) {
    return null
  }

  const attendees = parseAttendeeList(body.attendees)

  if (attendees === null) {
    return null
  }

  const active: DandiyaActiveLoan[] = []
  const issues: DandiyaLoanRecord[] = []
  const history: DandiyaLoanRecord[] = []

  // Accumulated rather than mapped-and-cast: a cast would assert the result
  // of the check instead of using it.
  for (const entry of body.active) {
    const loan = parseActiveLoan(entry)

    if (loan === null) {
      return null
    }

    active.push(loan)
  }

  for (const [entries, into] of [
    [body.issues, issues],
    [body.history, history],
  ] as const) {
    for (const entry of entries) {
      const loan = parseLoanRecord(entry)

      if (loan === null) {
        return null
      }

      into.push(loan)
    }
  }

  return {
    attendees,
    active,
    issues,
    history,
    historyDay: body.historyDay,
    eventDay: body.eventDay,
    today,
  }
}
