import type { EventAttendee } from '../../src/shared/attendee-contract.js'
import type {
  DandiyaActiveLoan,
  DandiyaBoardResponse,
  DandiyaDevice,
  DandiyaHolder,
  DandiyaHolderResolution,
  DandiyaLoanRecord,
  DandiyaOutcome,
} from '../../src/shared/dandiya-contract.js'
import {
  isDandiyaHolderResolution,
  isDandiyaOutcome,
} from '../../src/shared/dandiya-contract.js'
import { currentEventDayKey, eventDayKey } from '../../src/shared/event-time.js'
import type { DandiyaDeviceNames, DandiyaLoanRow } from './loans.js'

/**
 * THE DANDIYA BOARD: what is out, which pairs are quarantined, what has
 * happened, and today's numbers.
 *
 * PURE: no database, no Sheets, no HTTP. It is handed the ledger, the current
 * attendee register and the current time, and composes the response — so the
 * product rules of this module are functions that can be read and tested
 * rather than behaviour inferred from a query plan.
 *
 * THE JOIN RUNS ONE WAY ONLY. Postgres supplies the loan, the badge numbers,
 * the resolutions and the devices; the Sheet supplies the person. Nothing
 * here writes, and nothing it produces is persisted.
 *
 * `attendee` MAY BE NULL, and the loan survives it. A Sheet row edited away
 * must not erase the fact that a stick went out to that badge at that time
 * from that desk, or that it never came back — those are the ledger's own
 * facts.
 */

/** An unknown device id still renders as a device, never as blank. */
const deviceOf = (names: DandiyaDeviceNames, id: string): DandiyaDevice => ({
  id,
  name: names.get(id) ?? 'Unknown device',
})

const optionalDevice = (
  names: DandiyaDeviceNames,
  id: string | null,
): DandiyaDevice | null => (id === null ? null : deviceOf(names, id))

/**
 * A stored resolution, validated on the way out.
 *
 * The column is TEXT, so an unrecognised value is possible in principle — a
 * hand-edited row, a future value from a newer deployment. It degrades to
 * `null`, meaning "still out", which is the safe direction: a stick nobody
 * can account for stays somebody's obligation rather than silently clearing.
 */
const resolutionOf = (value: string | null): DandiyaHolderResolution | null =>
  isDandiyaHolderResolution(value) ? value : null

const outcomeOf = (value: string | null): DandiyaOutcome | null =>
  isDandiyaOutcome(value) ? value : null

const holdersOf = (
  row: DandiyaLoanRow,
  names: DandiyaDeviceNames,
  attendeesByBadge: Map<number, EventAttendee>,
): DandiyaHolder[] =>
  row.holders.map((holder) => ({
    badgeNumber: holder.badgeNumber,
    slot: holder.slot,
    /**
     * A GUEST HAS NO BADGE AND THEREFORE NO ATTENDEE. The register is never
     * consulted for a null badge, so there is no number to look up and no
     * chance of a stray zero matching somebody.
     */
    attendee:
      holder.badgeNumber === null
        ? null
        : attendeesByBadge.get(holder.badgeNumber) ?? null,
    resolution: resolutionOf(holder.resolution),
    resolvedAt: holder.resolvedAt,
    resolvedBy: optionalDevice(names, holder.resolvedByDeviceId),
  }))

/** A loan is ACTIVE while any stick is unresolved — one back, one out counts. */
const isActive = (row: DandiyaLoanRow): boolean =>
  row.holders.some((holder) => holder.resolvedAt === null)

/**
 * Today's counters, in the EVENT's timezone.
 *
 * `activeLoans` and `sticksOut` have NO date in them at all — that is the
 * point. A pair issued yesterday and still out counts today, and will count
 * tomorrow, because midnight closes nothing. `sticksOut` counts unresolved
 * HOLDER ROWS rather than loans, so a partially returned pair contributes
 * one: it is the number of sticks actually still in the room.
 *
 * The other four are about the day's traffic rather than the day's
 * obligations, and they are counted by the day a loan CLOSED — the day the
 * incident happened — not the day it was issued.
 */
const countToday = (
  loans: readonly DandiyaLoanRow[],
  now: Date,
): DandiyaBoardResponse['today'] => {
  const today = currentEventDayKey(now)

  let issued = 0
  let fullyReturned = 0
  let partialLosses = 0
  let lostPairs = 0
  let activeLoans = 0
  let sticksOut = 0

  for (const loan of loans) {
    if (eventDayKey(loan.issuedAt) === today) {
      issued += 1
    }

    if (isActive(loan)) {
      activeLoans += 1
      sticksOut += loan.holders.filter((holder) => holder.resolvedAt === null).length
    }

    if (loan.closedAt !== null && eventDayKey(loan.closedAt) === today) {
      const outcome = outcomeOf(loan.outcome)

      if (outcome === 'returned') {
        fullyReturned += 1
      } else if (outcome === 'partial_loss') {
        partialLosses += 1
      } else if (outcome === 'lost') {
        lostPairs += 1
      }
    }
  }

  return { issued, fullyReturned, partialLosses, lostPairs, activeLoans, sticksOut }
}

/**
 * WHICH DAY `history` ANSWERS FOR, and the event's own today.
 *
 * `historyDay` defaults to today, so the board is self-describing even when
 * nobody asked for a day. It is reported back in the response because the
 * SERVER decides it: a browser that labelled one day's rows with another
 * day's heading would be an error nobody could see.
 */
export const composeDandiyaBoard = (input: {
  ledger: { loans: readonly DandiyaLoanRow[]; deviceNames: DandiyaDeviceNames }
  attendees: readonly EventAttendee[]
  historyDay?: string
  now?: Date
}): DandiyaBoardResponse => {
  const now = input.now ?? new Date()
  const eventDay = currentEventDayKey(now)
  const historyDay = input.historyDay ?? eventDay
  const names = input.ledger.deviceNames
  const attendeesByBadge = new Map(
    input.attendees.map((attendee) => [attendee.badgeNumber, attendee]),
  )

  const active: DandiyaActiveLoan[] = []
  const history: DandiyaLoanRecord[] = []
  const issues: DandiyaLoanRecord[] = []

  for (const row of input.ledger.loans) {
    const holders = holdersOf(row, names, attendeesByBadge)
    const issuedBy = deviceOf(names, row.issuedByDeviceId)

    const record: DandiyaLoanRecord = {
      id: row.id,
      pairCode: row.pairCode,
      issuedAt: row.issuedAt,
      issuedBy,
      holders,
      contactPhone: row.contactPhone,
      accountabilityBadgeNumber: row.accountabilityBadgeNumber,
      closedAt: row.closedAt,
      closedBy: optionalDevice(names, row.closedByDeviceId),
      outcome: outcomeOf(row.outcome),
      pairReleasedAt: row.pairReleasedAt,
    }

    if (isActive(row)) {
      active.push({
        id: row.id,
        pairCode: row.pairCode,
        issuedAt: row.issuedAt,
        issuedBy,
        holders,
        contactPhone: row.contactPhone,
        accountabilityBadgeNumber: row.accountabilityBadgeNumber,
      })
    } else if (
      /**
       * A QUARANTINED PAIR: closed with a loss and never released. The null
       * `pairReleasedAt` is what the database's own index is enforcing, so
       * the list and the refusal cannot describe different sets of pairs.
       */
      row.pairReleasedAt === null &&
      (record.outcome === 'partial_loss' || record.outcome === 'lost')
    ) {
      issues.push(record)
    }

    /**
     * A DAY'S HISTORY IS DECIDED BY `issuedAt`, AND BY NOTHING ELSE.
     *
     * Not `closedAt`: a pair handed out at 11:50 PM and brought back at
     * 12:20 AM belongs to the night it went out on. Grouping by the close
     * would move a loan from one day to another as it was resolved, so "what
     * did we hand out last night" could never be answered twice the same way.
     *
     * OPEN LOANS ARE INCLUDED — they are the reason an operator opens this
     * screen. A pair still out appears here AND in `active`; nothing is moved
     * out of one list to build the other, and midnight moves neither.
     */
    if (eventDayKey(row.issuedAt) === historyDay) {
      history.push(record)
    }
  }

  /**
   * ACTIVE IS OLDEST FIRST, a deliberate product choice rather than an
   * accident of the query: the desk's question is "what is still
   * outstanding", so the pair that has been out longest sits at the top —
   * including anything left over from yesterday, which would otherwise scroll
   * away under the evening's traffic.
   *
   * The id breaks a tie so the order cannot change between two reads.
   */
  active.sort((left, right) =>
    left.issuedAt === right.issuedAt
      ? left.id.localeCompare(right.id)
      : left.issuedAt.localeCompare(right.issuedAt))

  /**
   * ISSUES IS NEWEST FIRST by the moment the loan CLOSED — which is when the
   * incident happened, and the order somebody scanning for the latest problem
   * expects.
   */
  const closedAtOf = (loan: DandiyaLoanRecord): string => loan.closedAt ?? loan.issuedAt

  issues.sort((left, right) =>
    closedAtOf(left) === closedAtOf(right)
      ? right.id.localeCompare(left.id)
      : closedAtOf(right).localeCompare(closedAtOf(left)))

  /**
   * HISTORY IS NEWEST ISSUED FIRST. The day is already fixed, so the only
   * thing left to order by is when each pair went out — and it must NOT be
   * the close time, or a day's list would reshuffle itself as pairs came
   * back. The latest pair handed out sits at the top.
   */
  history.sort((left, right) =>
    left.issuedAt === right.issuedAt
      ? right.id.localeCompare(left.id)
      : right.issuedAt.localeCompare(left.issuedAt))

  return {
    /**
     * The roster is passed through unchanged — badge-ascending from the
     * reader — because the issue form has to search it. It is READ per
     * request and persisted nowhere.
     */
    attendees: [...input.attendees],
    active,
    issues,
    history,
    historyDay,
    eventDay,
    today: countToday(input.ledger.loans, now),
  }
}
