import type { BadgeClaimConflict } from '../../src/shared/badge-claim-contract.js'
import { readConstraintName } from '../db/constraints.js'

/**
 * The database guarantees on `badge_assignments`, translated.
 *
 * Deliberately PURE and free of any database import: Admin's error map and
 * the reservation primitive both need these names, and routing one of them
 * through a module that opens a connection would make a conflict lookup
 * depend on a configured database.
 *
 * These constraints are the REAL protection. Two writers can each read "no
 * overlap" and both proceed, so the application-level checks above them only
 * produce a friendlier message; the violation below is what stops them.
 */
export type BadgeReservationConflict =
  /** Another ACTIVE assignment in this event covers part of the range. */
  | 'badge-range-overlap'
  /** This device already holds an active assignment. */
  | 'badge-range-already-assigned'
  /** The device does not belong to the event the range was requested for. */
  | 'device-event-mismatch'

export const BADGE_RESERVATION_CONSTRAINTS: Record<string, BadgeReservationConflict> = {
  badge_assignments_active_ranges_no_overlap: 'badge-range-overlap',
  badge_assignments_one_active_per_device: 'badge-range-already-assigned',
  badge_assignments_device_event_fk: 'device-event-mismatch',
}

/**
 * A typed conflict, or `null` when the error is not one of these.
 *
 * `null` means UNEXPECTED. The caller must rethrow rather than report a
 * plausible-looking conflict it did not actually diagnose.
 */
export const mapBadgeReservationConflict = (
  error: unknown,
): BadgeReservationConflict | null => {
  const constraint = readConstraintName(
    error,
    Object.keys(BADGE_RESERVATION_CONSTRAINTS),
  )

  return constraint === null ? null : (BADGE_RESERVATION_CONSTRAINTS[constraint] ?? null)
}

/**
 * The ONE place an internal conflict becomes a public one.
 *
 * Internal names describe the DATABASE guarantee that fired; public names
 * describe what the operator ran into. Typed as a total `Record`, so adding
 * an internal conflict without deciding its public name fails to compile
 * rather than silently reaching a browser as an unrecognised string — which
 * the client would then report as an unexpected response.
 *
 * A Postgres constraint name is never a public value.
 */
export const PUBLIC_BADGE_CLAIM_CONFLICT: Record<
  BadgeReservationConflict,
  BadgeClaimConflict
> = {
  'badge-range-overlap': 'range-overlap',
  'badge-range-already-assigned': 'already-assigned',
  'device-event-mismatch': 'device-event-mismatch',
}
