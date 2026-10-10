/**
 * The PUBLIC conflict identifiers of `/api/device-badge-claim`.
 *
 * The database layer has its own internal names (`badge-range-overlap`), and
 * the wire has these. Keeping both spellings means exactly one place may
 * translate between them — `PUBLIC_BADGE_CLAIM_CONFLICT` in
 * `server/badge-assignments/conflicts.ts` — and the browser must never be left
 * guessing which spelling arrived.
 *
 * Shared, framework-free, and imported by BOTH sides for the same reason the
 * attribute allow-list is: a response the client cannot name is a response it
 * reports as "unexpected", and an operational conflict shown as a technical
 * error is a desk that stops working for no reason.
 *
 * An internal Postgres constraint name NEVER appears here and never reaches a
 * browser.
 */
export const BADGE_CLAIM_CONFLICTS = [
  /** The range overlaps an active assignment held by ANOTHER device. */
  'range-overlap',
  /** This device already holds a DIFFERENT active assignment. */
  'already-assigned',
  /** Should be unreachable: device and event both come from one session. */
  'device-event-mismatch',
] as const

export type BadgeClaimConflict = (typeof BADGE_CLAIM_CONFLICTS)[number]

export const isBadgeClaimConflict = (value: unknown): value is BadgeClaimConflict => {
  return (
    typeof value === 'string' &&
    (BADGE_CLAIM_CONFLICTS as readonly string[]).includes(value)
  )
}

/**
 * The PUBLIC conflict identifiers of `PATCH /api/device-badge-claim` — the
 * CONTIGUOUS REFILL that extends a device's existing range upward.
 *
 * A separate list rather than more entries in the one above, because the two
 * methods fail in different ways and a client must not have to guess which
 * vocabulary arrived. `range-overlap` appears in both and means the same
 * thing in both: another device in this event owns part of the numbers.
 */
export const BADGE_REFILL_CONFLICTS = [
  /** Part of the new span is already assigned to ANOTHER device. */
  'range-overlap',
  /**
   * The device's current range end is not the one the caller expected. Either
   * a concurrent writer extended it or this browser is stale; the current
   * assignment travels back so the browser reconciles against the truth.
   */
  'stale-range',
  /** The device owns no active assignment, so there is nothing to extend. */
  'no-active-range',
] as const

export type BadgeRefillConflict = (typeof BADGE_REFILL_CONFLICTS)[number]

export const isBadgeRefillConflict = (value: unknown): value is BadgeRefillConflict => {
  return (
    typeof value === 'string' &&
    (BADGE_REFILL_CONFLICTS as readonly string[]).includes(value)
  )
}
