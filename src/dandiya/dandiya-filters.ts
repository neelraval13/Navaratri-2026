import { formatBadgeNumber } from '@/lib/badge'
import type {
  DandiyaActiveLoan,
  DandiyaHolder,
  DandiyaLoanRecord,
} from '@/shared/dandiya-contract'
import { currentEventDayKey, eventDayKey } from '@/shared/event-time'

/**
 * Finding one loan on a busy board, as pure functions.
 *
 * PURE on purpose: no React, no fetch, no state. A volunteer is being handed
 * a pair of sticks while somebody waits, so "does searching 9005 find the
 * pair Meera is holding" has to be answerable without rendering anything.
 *
 * CLIENT-SIDE, after ONE board fetch. An evening's loans are a few hundred
 * rows; a query per keystroke would add latency and server complexity to
 * solve a problem of a size this event does not have.
 */

/** Only the digits, so `#042`, `042` and `42` are the same query. */
const digitsOf = (value: string): string => value.replace(/\D/g, '')

const badgeMatches = (badgeNumber: number, query: string): boolean => {
  const digits = digitsOf(query)

  if (digits === '') {
    return false
  }

  return (
    String(badgeNumber).includes(digits) ||
    formatBadgeNumber(badgeNumber).slice(1).includes(digits)
  )
}

const textMatches = (value: string, query: string): boolean =>
  value.toLowerCase().includes(query.trim().toLowerCase())

/**
 * Does this loan match what was typed?
 *
 * The pair code, EITHER badge number, or EITHER attendee name — the four
 * things somebody at the desk actually has to hand. Never a phone number:
 * this screen never receives one.
 */
export const matchesLoanSearch = (
  loan: DandiyaActiveLoan | DandiyaLoanRecord,
  search: string,
): boolean => {
  const query = search.trim()

  if (query === '') {
    return true
  }

  if (textMatches(loan.pairCode, query)) {
    return true
  }

  return loan.holders.some(
    (holder) =>
      badgeMatches(holder.badgeNumber, query) ||
      (holder.attendee !== null && textMatches(holder.attendee.name, query)),
  )
}

/** Input order is preserved, so the oldest-first board stays oldest-first. */
export const filterActiveLoans = (
  loans: readonly DandiyaActiveLoan[],
  search: string,
): DandiyaActiveLoan[] => loans.filter((loan) => matchesLoanSearch(loan, search))

/**
 * WHAT HAPPENED TO ONE LOAN, as a day's history reads it.
 *
 * `outstanding` is any loan with a stick still out, whatever the hour — it is
 * the state nobody can close, and the one an operator is looking for. The
 * other three are the loan's final outcome.
 *
 * DERIVED FROM DURABLE STATE, never from the clock: the same loan classifies
 * the same way at 11 PM and at 1 AM. Only a person resolving a stick moves it.
 */
export type DandiyaLoanState = 'outstanding' | 'returned' | 'partial_loss' | 'lost'

export const loanStateOf = (loan: DandiyaLoanRecord): DandiyaLoanState => {
  if (loan.holders.some((holder) => holder.resolution === null)) {
    return 'outstanding'
  }

  return loan.outcome ?? 'outstanding'
}

/** The sticks of a historical loan that nobody has accounted for. */
const unresolvedCount = (loan: DandiyaLoanRecord): number =>
  loan.holders.filter((holder) => holder.resolution === null).length

/** The four views a day's history offers. `losses` is both loss outcomes. */
export type HistoryView = 'all' | 'outstanding' | 'returned' | 'losses'

const matchesView = (loan: DandiyaLoanRecord, view: HistoryView): boolean => {
  const state = loanStateOf(loan)

  if (view === 'all') {
    return true
  }

  if (view === 'losses') {
    return state === 'partial_loss' || state === 'lost'
  }

  return state === view
}

/**
 * ONE DAY'S ROWS, filtered and searched.
 *
 * The DAY is already decided — the server answered for it, and membership is
 * the issue timestamp. This narrows within that day and nothing more: there
 * is deliberately no "all days" option, because a question about the whole
 * event is a question about a different day at a time.
 *
 * Input order is preserved, so the newest-issued-first board stays so.
 */
export const filterDayHistory = (
  loans: readonly DandiyaLoanRecord[],
  state: { view: HistoryView; search: string },
): DandiyaLoanRecord[] =>
  loans.filter(
    (loan) => matchesView(loan, state.view) && matchesLoanSearch(loan, state.search),
  )

/**
 * A DAY'S SUMMARY, counted from the day's own rows.
 *
 * Not sent by the server and deliberately so: every number here is a
 * classification of `history`, and a second copy travelling beside the list
 * is a second thing that can disagree with it. `issued` is the length of the
 * list, for the same reason.
 *
 * `outstandingSticks` counts unresolved HOLDER ROWS rather than loans, so a
 * pair with one stick back contributes one — the number of sticks actually
 * still in the room from that day.
 */
export interface DandiyaDaySummary {
  issued: number
  fullyReturned: number
  outstanding: number
  partialLosses: number
  lostPairs: number
  outstandingSticks: number
}

export const summariseDay = (
  loans: readonly DandiyaLoanRecord[],
): DandiyaDaySummary => {
  const summary: DandiyaDaySummary = {
    issued: loans.length,
    fullyReturned: 0,
    outstanding: 0,
    partialLosses: 0,
    lostPairs: 0,
    outstandingSticks: 0,
  }

  for (const loan of loans) {
    const state = loanStateOf(loan)

    if (state === 'outstanding') {
      summary.outstanding += 1
      summary.outstandingSticks += unresolvedCount(loan)
    } else if (state === 'returned') {
      summary.fullyReturned += 1
    } else if (state === 'partial_loss') {
      summary.partialLosses += 1
    } else {
      summary.lostPairs += 1
    }
  }

  return summary
}

/**
 * WHICH OPEN LOANS THE ACTIVE TAB IS SHOWING.
 *
 * `all` is every pair that is out — the tab's original and usual behaviour.
 * `carryover` narrows to the ones issued BEFORE today, which is the list
 * somebody works through the morning after.
 *
 * PURELY A VIEW. Both read the same `active` array the board already carried;
 * choosing one asks the server nothing, writes nothing and resolves nothing.
 */
export type ActiveView = 'all' | 'carryover'

export const selectActiveLoans = (
  active: readonly DandiyaActiveLoan[],
  state: { view: ActiveView; search: string; eventDay: string },
): DandiyaActiveLoan[] => {
  /**
   * `outstandingBeforeDay` is the ONE definition of "issued before today",
   * shared with the banner that offers this view — so the count in the banner
   * and the rows behind it cannot describe different pairs.
   */
  const scoped =
    state.view === 'carryover'
      ? outstandingBeforeDay(active, state.eventDay).loans
      : [...active]

  return filterActiveLoans(scoped, state.search)
}

/**
 * WHAT IS STILL OUT FROM AN EARLIER DAY.
 *
 * Derived from the OPEN loans the board already carries — `active` is every
 * open loan for the event, with no day scoping, which is what makes this
 * answerable at all. It is a projection and never a stored figure: nothing is
 * written at midnight, and nothing needs to be.
 *
 * `eventDay` comes from the SERVER. Using the tablet's own idea of today
 * would let a device with a wrong clock under-report pairs nobody has come
 * back for, which is precisely the number somebody is relying on.
 */
export const outstandingBeforeDay = (
  active: readonly DandiyaActiveLoan[],
  eventDay: string,
): { pairs: number; sticks: number; loans: DandiyaActiveLoan[] } => {
  const loans = active.filter((loan) => eventDayKey(loan.issuedAt) < eventDay)

  return {
    pairs: loans.length,
    sticks: loans.reduce(
      (total, loan) =>
        total + loan.holders.filter((holder) => holder.resolution === null).length,
      0,
    ),
    loans,
  }
}

/**
 * Was this pair issued on an earlier event day than the one we are in?
 *
 * Used ONLY to label an active loan as outstanding. It changes no state,
 * closes nothing and frees nothing — a pair is returned by a person, never by
 * a clock. What it does is stop a leftover pair from looking like part of
 * tonight's traffic, so somebody chases it.
 */
export const isOutstandingFromEarlierDay = (
  loan: DandiyaActiveLoan,
  now?: Date,
): boolean => eventDayKey(loan.issuedAt) !== currentEventDayKey(now)

/**
 * EVERY STICK THIS BADGE HAS EVER LOST, newest first.
 *
 * Scanned across ACTIVE and finished loans alike, because a stick can be
 * reported lost while the pair's other stick is still out — that loan is open
 * and lives in `active`, so looking only at history would miss the most
 * recent loss there is.
 *
 * INFORMATION ONLY. A prior loss never blocks another issue: the attendee is
 * free the moment their own stick is resolved, and the desk decides whether
 * to hand them another pair. What this avoids is handing one over without
 * knowing.
 */
export const priorLossesFor = (
  loans: readonly (DandiyaActiveLoan | DandiyaLoanRecord)[],
  badgeNumber: number,
): { pairCode: string; resolvedAt: string }[] => {
  const losses: { pairCode: string; resolvedAt: string }[] = []

  for (const loan of loans) {
    for (const holder of loan.holders) {
      if (
        holder.badgeNumber === badgeNumber &&
        holder.resolution === 'lost' &&
        holder.resolvedAt !== null
      ) {
        losses.push({ pairCode: loan.pairCode, resolvedAt: holder.resolvedAt })
      }
    }
  }

  return losses.sort((left, right) => right.resolvedAt.localeCompare(left.resolvedAt))
}

/**
 * Is this pair code UNAVAILABLE, and why?
 *
 * `out` is an open loan; `quarantined` is a finished loan that lost a stick
 * and never released the pair. Both refuse an issue, and the operator's next
 * action differs — wait, or take the pair out of the stock.
 *
 * Derived from the loaded board, so it is a WARNING: the authority is the
 * partial unique index, and the screen says so when the database disagrees.
 */
export type PairAvailability =
  | { status: 'available' }
  | { status: 'out'; loan: DandiyaActiveLoan }
  | { status: 'quarantined'; loan: DandiyaLoanRecord }

export const pairAvailability = (
  pairCode: string,
  board: { active: readonly DandiyaActiveLoan[]; issues: readonly DandiyaLoanRecord[] },
): PairAvailability => {
  const out = board.active.find((loan) => loan.pairCode === pairCode)

  if (out !== undefined) {
    return { status: 'out', loan: out }
  }

  const quarantined = board.issues.find((loan) => loan.pairCode === pairCode)

  return quarantined === undefined
    ? { status: 'available' }
    : { status: 'quarantined', loan: quarantined }
}

/** The sticks of this loan that are still out. */
export const unresolvedHolders = (loan: DandiyaActiveLoan): DandiyaHolder[] =>
  loan.holders.filter((holder) => holder.resolution === null)

/**
 * A loan with some sticks resolved and some not.
 *
 * Shown as INCOMPLETE rather than OUT, because the difference matters to
 * whoever is reading the board: one person has finished and one has not, and
 * the pair is not available either way.
 */
export const isPartiallyResolved = (loan: DandiyaActiveLoan): boolean => {
  const remaining = unresolvedHolders(loan).length

  return remaining > 0 && remaining < loan.holders.length
}
