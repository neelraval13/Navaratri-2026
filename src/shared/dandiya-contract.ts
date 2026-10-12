import type { EventAttendee } from './attendee-contract.js'

/**
 * The DANDIYA wire contract, shared by the browser and the server.
 *
 * Framework-free and dependency-free, like the other shared contracts: the
 * screen that renders a refusal and the endpoint that produces one must agree
 * about every name, or an ordinary operational conflict — "that pair is
 * already out" — arrives as "unexpected response" and a desk stops for no
 * reason.
 *
 * IT CARRIES NO ATTENDEE DATA OF ITS OWN. A loan's `attendees` are
 * `EventAttendee` values READ from the Badge Register per request and joined
 * into the response; Postgres stores two badge NUMBERS and nothing about the
 * people. One shape for an attendee across every module — see
 * `src/shared/attendee-contract.ts`.
 */

/**
 * The PAIR CODE policy.
 *
 * A pair code is an OPERATIONAL IDENTIFIER for one physical object, not a
 * piece of prose, so it is CANONICALISED: outer whitespace trimmed, then
 * uppercased.
 *
 *   " d-014 "  ->  "D-014"
 *   "D-014"    ->  "D-014"
 *   "test-01"  ->  "TEST-01"
 *
 * CASE INSENSITIVITY IS A SAFETY REQUIREMENT, not a convenience. The whole
 * protection against one pair going out twice is
 * `UNIQUE(event_id, pair_code) WHERE returned_at IS NULL`, and that index
 * compares bytes. If `D-014` and `d-014` were stored as written, two
 * volunteers typing the same physical label with different shift keys would
 * each get an "open" loan on the same sticks — the index would see two pairs
 * and the floor would have one. Canonicalising before the insert is what
 * makes the index mean what it says.
 *
 * Nothing else is rewritten: separators and internal characters are left
 * exactly as typed, because those really do distinguish labels.
 *
 * THE SERVER IS THE AUTHORITY. The browser may uppercase a field for
 * comfort, but this function runs on the request and its result is what is
 * stored, shown and searched.
 *
 * Bounded at 32, which the database also enforces as its own floor — along
 * with a CHECK that every persisted code is already canonical.
 */
export const PAIR_CODE_MAX_LENGTH = 32

/** Letters, digits, and the separators a physical label actually uses. */
const PAIR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 \-_/.]*$/

export type PairCodeResult =
  | { ok: true; value: string }
  | { ok: false; message: string }

export const parsePairCode = (value: unknown): PairCodeResult => {
  if (typeof value !== 'string') {
    return { ok: false, message: 'Enter the pair number.' }
  }

  const trimmed = value.trim()

  if (trimmed === '') {
    return { ok: false, message: 'Enter the pair number.' }
  }

  if (trimmed.length > PAIR_CODE_MAX_LENGTH) {
    return {
      ok: false,
      message: `A pair number may be at most ${String(PAIR_CODE_MAX_LENGTH)} characters.`,
    }
  }

  if (!PAIR_CODE_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message: 'A pair number may use letters, numbers, spaces and - _ / . only.',
    }
  }

  /**
   * Validated BEFORE uppercasing and returned AFTER it. The pattern allows
   * both cases, so the order only matters for the message: a volunteer who
   * typed something unusable should see their own characters quoted back by
   * the form, not a shouted version of them.
   */
  return { ok: true, value: trimmed.toUpperCase() }
}

/** Exactly two, different, and both real badge numbers. */
export const DANDIYA_PAIR_HOLDERS = 2

/** Who handed the pair over, or resolved a stick. A device, never a person. */
export interface DandiyaDevice {
  id: string
  name: string
}

/**
 * HOW ONE STICK ENDED.
 *
 * `null` means it is still OUT. Neither outcome is reversible: a stick that
 * came back came back, and a stick reported lost was reported lost by
 * somebody who looked. Correcting a mistake is a human database operation,
 * not a button — see `docs/DANDIYA.md`.
 */
export const DANDIYA_HOLDER_RESOLUTIONS = ['returned', 'lost'] as const

export type DandiyaHolderResolution = (typeof DANDIYA_HOLDER_RESOLUTIONS)[number]

export const isDandiyaHolderResolution = (
  value: unknown,
): value is DandiyaHolderResolution =>
  typeof value === 'string' &&
  (DANDIYA_HOLDER_RESOLUTIONS as readonly string[]).includes(value)

/**
 * HOW ONE LOAN ENDED, derived from its two holders and from nothing else:
 *
 *   returned + returned  ->  returned
 *   returned + lost      ->  partial_loss
 *   lost     + returned  ->  partial_loss
 *   lost     + lost      ->  lost
 *
 * Only `returned` frees the physical pair. ANY loss quarantines it, because
 * what is left on the table is not a pair somebody can be handed.
 */
export const DANDIYA_OUTCOMES = ['returned', 'partial_loss', 'lost'] as const

export type DandiyaOutcome = (typeof DANDIYA_OUTCOMES)[number]

export const isDandiyaOutcome = (value: unknown): value is DandiyaOutcome =>
  typeof value === 'string' && (DANDIYA_OUTCOMES as readonly string[]).includes(value)

/**
 * ONE STICK, AND WHO HAS IT.
 *
 * `attendee` is JOINED from the CURRENT Sheet and may be `null`: a loan must
 * survive a Sheet row being edited away, because the stick really did go out.
 * The ledger's own facts — the badge number, the slot, the resolution — never
 * depend on it.
 *
 * EACH STICK MOVES INDEPENDENTLY. `resolution === null` is OUT, and that
 * attendee is still holding; anything else means they are free, whether the
 * stick came back or did not. The three resolution fields always travel
 * together, which the database enforces as well.
 */
export interface DandiyaHolder {
  /**
   * `null` means THIS STICK BELONGS TO A GUEST WITH NO BADGE.
   *
   * Never a synthetic number. A `0` or a `999999` would sort, match a badge
   * search and collide with a real badge, and the screen could not tell a
   * guest from an attendee whose badge had been mistyped.
   */
  badgeNumber: number | null
  slot: number
  attendee: EventAttendee | null
  resolution: DandiyaHolderResolution | null
  /** ISO 8601 UTC, written by the server. Never accepted from a caller. */
  resolvedAt: string | null
  resolvedBy: DandiyaDevice | null
}

/**
 * A loan with at least one stick still OUT.
 *
 * A PARTIALLY RESOLVED LOAN IS STILL ACTIVE. One stick back and one still out
 * is the case this phase exists for: the pair is not available, and the
 * second attendee's obligation is untouched.
 */
export interface DandiyaActiveLoan {
  id: string
  pairCode: string
  /** ISO 8601 UTC, written by the server. Never accepted from a caller. */
  issuedAt: string
  issuedBy: DandiyaDevice
  holders: DandiyaHolder[]
  /**
   * THE PAIR'S ACCOUNTABILITY NUMBER, and only for a FULLY badgeless loan.
   *
   * Ten digits, as the rest of the application stores a phone number. `null`
   * whenever any holder has a badge: the badge is the accountability, and a
   * number collected beside one would be personal data nobody needed.
   *
   * It is how the team finds two people who have no badges, so Active and a
   * day's Outstanding show it. It is never a registered attendee's number —
   * those are not read into this module at all.
   */
  contactPhone: string | null
  /**
   * THE BADGE ACCOUNTABLE FOR THE WHOLE PAIR, and only for a MIXED loan —
   * one badge and one guest.
   *
   * `null` for two badges, where each holder answers for their own stick, and
   * for two guests, where `contactPhone` is the anchor instead. It is always
   * one of this loan's own holder badges.
   *
   * THE SERVER DECIDES IT, from the holders, and the screen reads it rather
   * than inferring it — the same reason `eventDay` travels in the response.
   * A browser that worked out accountability for itself would be a second
   * definition of the rule the database is enforcing.
   */
  accountabilityBadgeNumber: number | null
}

/**
 * A loan as the ledger holds it, open or closed.
 *
 * `outcome === null` means still open. `pairReleasedAt` is set ONLY on a
 * clean `returned` close — a loss leaves it null, and that null is what keeps
 * the physical pair out of circulation.
 */
export interface DandiyaLoanRecord extends DandiyaActiveLoan {
  closedAt: string | null
  closedBy: DandiyaDevice | null
  outcome: DandiyaOutcome | null
  pairReleasedAt: string | null
}

/**
 * Today's numbers, counted in the EVENT's timezone.
 *
 * `activeLoans` and `sticksOut` have NO date in them at all — a pair issued
 * yesterday and still out counts today and tomorrow. The other four are about
 * the day's traffic rather than the day's obligations.
 */
export interface DandiyaDayCounters {
  issued: number
  fullyReturned: number
  partialLosses: number
  lostPairs: number
  activeLoans: number
  /** Unresolved holder rows: the number of sticks actually still in the room. */
  sticksOut: number
}

export interface DandiyaBoardResponse {
  /**
   * EVERY registered attendee, badge-ascending — the roster the issue form
   * searches to identify the two badge holders.
   *
   * It travels with the board rather than from `/api/attendees`, for a
   * decisive reason: a dandiya-only device does not hold the `attendees`
   * attribute and must not need it. Identifying the two holders is part of
   * issuing a pair; browsing the register as a directory is a separate grant.
   * Returning it here also keeps the desk to ONE request, so the names a
   * volunteer picks from and the loans they are checked against are one
   * snapshot rather than two that can disagree.
   */
  attendees: EventAttendee[]
  /**
   * Pairs that are out, OLDEST FIRST.
   *
   * Chosen deliberately: the desk's question is "what is still outstanding",
   * and the pair that has been out longest is the one somebody needs to chase
   * — including anything left over from yesterday, which therefore sits at
   * the top rather than scrolling away under the evening's traffic.
   */
  active: DandiyaActiveLoan[]
  /**
   * CLOSED loans that ended in a loss and whose pair is STILL UNRELEASED —
   * newest first.
   *
   * This is the list of physical pair codes that must not be handed out. It
   * is a view of rows `history` also carries, surfaced separately because
   * "which pairs are missing a stick" is a question somebody asks at the
   * table rather than a historical record they scroll for.
   */
  issues: DandiyaLoanRecord[]
  /**
   * ONE EVENT-LOCAL DAY'S LOANS, newest issued first — every pair ISSUED on
   * `historyDay`, whatever state it is now in.
   *
   * MEMBERSHIP IS DECIDED BY `issuedAt`, NEVER BY `closedAt`. A pair issued
   * at 11:50 PM and brought back at 12:20 AM belongs to the day it went out
   * on, and says it closed on the next one. Grouping by the close instead
   * would move a loan between days as it was resolved, so the question "what
   * did we hand out last night?" could never be answered twice the same way.
   *
   * OPEN LOANS ARE INCLUDED. A day's record has to show what never came back,
   * which is the whole reason this list exists — those rows are in `active`
   * too, and nothing is moved out of either to build the other.
   *
   * Repeated pair codes are normal, and an incident is never erased or
   * collapsed into a clean return.
   */
  history: DandiyaLoanRecord[]
  /**
   * The event-local day `history` answers for, as `YYYY-MM-DD`.
   *
   * THE SERVER SAYS WHICH DAY IT ANSWERED. The browser may ask for one, but
   * the day it labels the screen with comes from here — a client that decided
   * for itself could render one day's rows under another day's heading if its
   * clock or its timezone disagreed.
   */
  historyDay: string
  /**
   * The event-local day the SERVER is currently in, as `YYYY-MM-DD`.
   *
   * What "today" and therefore "a previous day" mean. Carried because the
   * previous-day outstanding warning is a statement about the event's clock,
   * not the tablet's: a device whose clock is a day out would otherwise
   * under- or over-report pairs nobody has come back for.
   */
  eventDay: string
  today: DandiyaDayCounters
}

/**
 * The PUBLIC conflict identifiers of `/api/dandiya`.
 *
 * Each one is the database's answer rather than the application's: the two
 * partial unique indexes decide, and an application check above them would
 * only move the race. A Postgres constraint name, a SQLSTATE and another
 * device's identity never appear here and never reach a browser.
 */
export const DANDIYA_CONFLICTS = [
  /** This physical pair is out on an open loan. */
  'pair-in-use',
  /**
   * This physical pair is QUARANTINED: its last loan ended with a stick lost,
   * so what is left is not a pair. Distinguished from `pair-in-use` because
   * the operator's next action differs — find another pair, and tell whoever
   * keeps the stock.
   */
  'pair-unavailable',
  /** One of the two attendees is already holding an unresolved stick. */
  'attendee-already-holding-pair',
  /**
   * This CONTACT NUMBER already has an open fully badgeless loan.
   *
   * The badgeless analogue of the attendee rule: one open pair per
   * accountability anchor. It frees as soon as that loan closes, so the same
   * number may borrow again the same evening.
   */
  'contact-already-holding-pair',
  /**
   * THIS BADGE IS STILL ACCOUNTABLE FOR AN OPEN MIXED PAIR.
   *
   * One badge + one guest goes out ON THE BADGE, so that attendee answers for
   * both sticks until the loan closes. Returning their own stick does not end
   * it while the guest still holds theirs — which is exactly why this is a
   * different conflict from `attendee-already-holding-pair`, and why it tells
   * the operator to bring the first pair back rather than to pick somebody
   * else.
   */
  'accountability-already-holding-pair',
  /**
   * Somebody resolved that stick first. A resolution is never overwritten:
   * returned does not become lost and lost does not become returned.
   */
  'holder-already-resolved',
  /** Every stick was already resolved, so there was nothing left to do. */
  'loan-already-closed',
] as const

export type DandiyaConflict = (typeof DANDIYA_CONFLICTS)[number]

export const isDandiyaConflict = (value: unknown): value is DandiyaConflict =>
  typeof value === 'string' && (DANDIYA_CONFLICTS as readonly string[]).includes(value)

/* ------------------------------------------------------- the PATCH actions */

/**
 * WHAT A PATCH DOES. Three actions, one endpoint.
 *
 *   resolve-holder   one stick came back, or did not
 *   return-pair      every stick still out came back
 *   lost-pair        every stick still out is gone
 *
 * The two shortcuts exist because that is usually what a desk has: both
 * sticks together. They are shortcuts over the SAME per-stick resolution, so
 * neither can overwrite a stick that is already resolved — `return-pair` on a
 * loan with one lost stick resolves the other and closes as `partial_loss`,
 * and never turns the loss into a return.
 */
export const DANDIYA_ACTIONS = ['resolve-holder', 'return-pair', 'lost-pair'] as const

export type DandiyaAction = (typeof DANDIYA_ACTIONS)[number]

export const isDandiyaAction = (value: unknown): value is DandiyaAction =>
  typeof value === 'string' && (DANDIYA_ACTIONS as readonly string[]).includes(value)

/**
 * WHAT TO CALL ONE STICK'S HOLDER, in one place.
 *
 * `#042` for a registered attendee, `Guest 1` for somebody with no badge —
 * named by SLOT, because that is the only thing that distinguishes two
 * guests, and it is the same slot every screen and the resolution request
 * use.
 *
 * Here rather than in `src/lib/badge.ts` because this is a dandiya rule
 * rather than a badge rule, and because every surface that renders a holder
 * must say the same thing. The `#000` padding matches `formatBadgeNumber`
 * deliberately; this module is framework-free and imported by the server, so
 * it reaches into no `src/lib`.
 */
export const dandiyaHolderLabel = (holder: {
  badgeNumber: number | null
  slot: number
}): string =>
  holder.badgeNumber === null
    ? `Guest ${String(holder.slot)}`
    : `#${String(holder.badgeNumber).padStart(3, '0')}`

/**
 * THE SECOND LINE BESIDE THAT LABEL — who the holder actually is.
 *
 * ONE helper, because four surfaces render a holder and all four got this
 * wrong in the same way: they printed "Attendee no longer in the register"
 * whenever `attendee` was null, which for a GUEST is simply false. A guest
 * was never in the register; there is nothing missing.
 *
 *   badgeNumber === null                  ->  "No badge"
 *   badgeNumber !== null, attendee null   ->  "Attendee no longer in the register"
 *   otherwise                             ->  the attendee's name
 *
 * The middle case is the real one and stays: a loan must survive its Sheet
 * row being edited away, because the stick really did go out, and that is a
 * row somebody should go and look at.
 */
export const dandiyaHolderDetail = (holder: {
  badgeNumber: number | null
  attendee: { name: string } | null
}): string => {
  if (holder.badgeNumber === null) {
    return 'No badge'
  }

  return holder.attendee === null
    ? 'Attendee no longer in the register'
    : holder.attendee.name
}

/** Human labels for the three outcomes, used wherever one is shown. */
export const DANDIYA_OUTCOME_LABELS: Record<DandiyaOutcome, string> = {
  returned: 'Returned',
  partial_loss: 'Partial loss',
  lost: 'Pair lost',
}
