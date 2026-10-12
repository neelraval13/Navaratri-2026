import type { DandiyaConflict } from '../../src/shared/dandiya-contract.js'
import { readConstraintName } from '../db/constraints.js'

/**
 * The database guarantees on the Dandiya tables, translated.
 *
 * Pure and free of any database import, exactly like the badge-assignment
 * map: translating a violation must never require a configured connection.
 *
 * THE CONSTRAINTS ARE THE REAL PROTECTION. Two desks can each read "pair
 * D-014 is free" and each submit; no application check can stop the second.
 * The two PARTIAL UNIQUE INDEXES can, so the insert's failure is translated
 * rather than pre-empted.
 *
 * Holder RESOLUTION conflicts are not here, and could not be: nothing about
 * resolving a stick violates a constraint. "Somebody resolved it first" is a
 * compare-and-set matching no row, which the writer reports directly.
 *
 * THE DRIVER ERROR ARRIVES WRAPPED. Drizzle rethrows it as a
 * `DrizzleQueryError` whose message is `Failed query: …` and whose `cause`
 * holds the real Postgres error with its `constraint` field, so the chain is
 * walked by `readConstraintName` rather than inspected at the top level. That
 * mistake once made every genuine badge-range overlap read as an unexpected
 * failure.
 */
export type DandiyaViolation =
  /**
   * This physical pair is not available: its last loan is either still open
   * or closed with a stick lost. The INDEX cannot tell those apart — both
   * hold the same slot — so the writer re-reads once the database has
   * refused, and only then chooses between `pair-in-use` and
   * `pair-unavailable`.
   */
  | 'pair-unavailable'
  /** One of the attendees already holds an unresolved stick in this event. */
  | 'attendee-already-holding'
  /** The same attendee was given both sticks of one pair. */
  | 'duplicate-holder-in-loan'
  /**
   * This contact number already has an OPEN fully badgeless loan. The
   * badgeless analogue of `attendee-already-holding`, and it frees the moment
   * that loan closes.
   */
  | 'contact-already-holding'
  /**
   * THIS BADGE IS STILL ACCOUNTABLE FOR AN OPEN MIXED LOAN.
   *
   * Distinct from `attendee-already-holding`, and the difference is the whole
   * point of the loan-level anchor: that one says the attendee is personally
   * holding an unresolved STICK, and it is released as soon as their own
   * stick is accounted for. This one says they answer for a whole PAIR that
   * has not come back — a guest still holds the other stick — and it is
   * released only when that loan closes.
   */
  | 'accountability-already-holding'

export const DANDIYA_CONSTRAINTS: Record<string, DandiyaViolation> = {
  dandiya_loans_one_unreleased_per_pair: 'pair-unavailable',
  dandiya_loan_holders_one_unresolved_per_badge: 'attendee-already-holding',
  dandiya_loan_holders_loan_id_badge_number_key: 'duplicate-holder-in-loan',
  dandiya_loans_one_open_per_contact: 'contact-already-holding',
  dandiya_loans_one_open_per_accountability_badge: 'accountability-already-holding',
}

/**
 * A typed violation, or `null` when the error is not one of these.
 *
 * `null` means UNEXPECTED. The caller must rethrow rather than report a
 * conflict it did not actually diagnose — a cross-event foreign key failure
 * or a check-constraint violation is a bug, not "that pair is already out".
 */
export const mapDandiyaViolation = (error: unknown): DandiyaViolation | null => {
  const constraint = readConstraintName(error, Object.keys(DANDIYA_CONSTRAINTS))

  return constraint === null ? null : (DANDIYA_CONSTRAINTS[constraint] ?? null)
}

/**
 * The ONE place an internal violation becomes a public conflict.
 *
 * A total `Record`, so adding an internal name without deciding its public
 * one fails to compile rather than reaching a browser as a string the client
 * cannot name — which the client would then report as an unexpected response.
 *
 * `duplicate-holder-in-loan` maps to the attendee conflict deliberately: the
 * endpoint already refuses two identical badge numbers before it writes, so
 * if this index ever fires the operator's actionable truth is still "pick a
 * different attendee".
 *
 * A Postgres constraint name is never a wire value.
 */
export const PUBLIC_DANDIYA_CONFLICT: Record<DandiyaViolation, DandiyaConflict> = {
  /**
   * The DEFAULT for a pair refusal, narrowed to `pair-unavailable` by the
   * writer when the blocking loan turns out to be closed. `pair-in-use` is
   * the safer thing to say without that extra read: it describes a pair
   * somebody else has, which is true either way.
   */
  'pair-unavailable': 'pair-in-use',
  'attendee-already-holding': 'attendee-already-holding-pair',
  'duplicate-holder-in-loan': 'attendee-already-holding-pair',
  'contact-already-holding': 'contact-already-holding-pair',
  'accountability-already-holding': 'accountability-already-holding-pair',
}
