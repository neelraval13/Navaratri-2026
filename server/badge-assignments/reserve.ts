import { and, eq, isNull } from 'drizzle-orm'

import { getDatabase } from '../db/client.js'
import { badgeAssignments } from '../db/schema.js'
import {
  mapBadgeReservationConflict,
  type BadgeReservationConflict,
} from './conflicts.js'
import type { BadgeRangeInput } from './range.js'

/**
 * The ONE central badge-assignment writer.
 *
 * Admin preassignment, Device self-claim and Device refill all go through
 * this module, so the INSERT, the contiguous UPDATE and the interpretation of
 * a constraint violation exist once. Their AUTHORIZATION layers stay entirely separate — an Admin
 * session and a device session prove different things — and neither realm's
 * HTTP or auth concerns appear here.
 *
 * POSTGRES IS THE AUTHORITY. Callers may precheck for a better message, but a
 * precheck is never the guarantee: two writers can each read "no overlap" and
 * both proceed. The GiST exclusion constraint and the partial unique index
 * are what actually stop them, so the insert's failure is translated rather
 * than pre-empted.
 *
 * This module holds no live counter. Central owns the RANGE; `nextBadge`
 * stays in each device's own IndexedDB, because issuing a badge must work
 * with no network.
 */

/** A central assignment exactly as Postgres holds it. */
export interface CentralBadgeRange {
  rangeStart: number
  rangeEnd: number
  /** ISO 8601 UTC. */
  assignedAt: string
}

/**
 * The device's ACTIVE assignment, or `null`.
 *
 * `released_at IS NULL` is what "active" means; a released row is history and
 * is never returned here.
 */
export const readActiveBadgeAssignment = async (
  deviceId: string,
): Promise<CentralBadgeRange | null> => {
  const rows = await getDatabase()
    .select()
    .from(badgeAssignments)
    .where(
      and(eq(badgeAssignments.deviceId, deviceId), isNull(badgeAssignments.releasedAt)),
    )

  const [row] = rows

  return row === undefined
    ? null
    : {
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
        assignedAt: row.assignedAt.toISOString(),
      }
}

export type BadgeReservationResult =
  | { ok: true; value: CentralBadgeRange }
  | { ok: false; conflict: BadgeReservationConflict }

/**
 * Inserts one `badge_assignments` row and returns the canonical assignment.
 *
 * The returned values come from the row Postgres wrote, never from the
 * request: `assignedAt` in particular is the server's, so a client cannot
 * date its own ownership.
 *
 * A constraint violation becomes a typed conflict. Anything else is rethrown
 * — an unrecognised database error must not be reported as a conflict the
 * caller can act on.
 */
export const reserveBadgeRange = async (input: {
  eventId: string
  deviceId: string
  range: BadgeRangeInput
}): Promise<BadgeReservationResult> => {
  try {
    const [row] = await getDatabase()
      .insert(badgeAssignments)
      .values({
        eventId: input.eventId,
        deviceId: input.deviceId,
        rangeStart: input.range.rangeStart,
        rangeEnd: input.range.rangeEnd,
      })
      .returning()

    return {
      ok: true,
      value: {
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
        assignedAt: row.assignedAt.toISOString(),
      },
    }
  } catch (error: unknown) {
    const conflict = mapBadgeReservationConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, conflict }
  }
}

export type BadgeExtensionOutcome =
  | { ok: true; outcome: 'extended' | 'already-extended'; value: CentralBadgeRange }
  /**
   * The guarded update matched no row. `current` is the authoritative re-read:
   * `null` means the device owns no active assignment at all, and any other
   * value means its end is not the one the caller expected.
   */
  | { ok: false; reason: 'stale-range'; current: CentralBadgeRange | null }
  | { ok: false; reason: 'conflict'; conflict: BadgeReservationConflict }

/**
 * Extends the device's ACTIVE assignment upward, contiguously.
 *
 * It mutates `range_end` and NOTHING else: `range_start`, `assigned_at`,
 * `device_id`, `event_id` and `released_at` are untouched, so the assignment
 * keeps its identity and its provenance. There is no second row and no
 * release — a refill adds badges to a range a desk already owns.
 *
 * CONCURRENCY IS A COMPARE-AND-SET, not a read followed by trust. The
 * expected end is part of the WHERE clause, so two callers racing to extend
 * the same assignment cannot both win: the loser matches no row and is told
 * the range moved. Cross-DEVICE races are decided by the GiST exclusion
 * constraint, which applies to an UPDATE exactly as it does to an INSERT —
 * extending #001-#050 to #001-#100 fails if another device owns any of
 * #051-#100.
 *
 * The caller must already have established that `newRangeEnd` is greater than
 * `expectedRangeEnd`. This function will not shrink a range, and the
 * database's own `range_start <= range_end` check is the backstop.
 */
export const extendActiveBadgeRange = async (input: {
  deviceId: string
  expectedRangeEnd: number
  newRangeEnd: number
}): Promise<BadgeExtensionOutcome> => {
  try {
    const rows = await getDatabase()
      .update(badgeAssignments)
      .set({ rangeEnd: input.newRangeEnd })
      .where(
        and(
          eq(badgeAssignments.deviceId, input.deviceId),
          isNull(badgeAssignments.releasedAt),
          // The compare-and-set. Without it this would be a blind write.
          eq(badgeAssignments.rangeEnd, input.expectedRangeEnd),
        ),
      )
      .returning()

    const [row] = rows

    if (row !== undefined) {
      return {
        ok: true,
        outcome: 'extended',
        value: {
          rangeStart: row.rangeStart,
          rangeEnd: row.rangeEnd,
          assignedAt: row.assignedAt.toISOString(),
        },
      }
    }
  } catch (error: unknown) {
    const conflict = mapBadgeReservationConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, reason: 'conflict', conflict }
  }

  /**
   * ZERO ROWS. Re-reading is what distinguishes an idempotent repeat from a
   * genuinely stale caller: if the assignment ALREADY ends where this request
   * asked it to, the extension happened — possibly on an earlier attempt
   * whose response was lost — and reporting a conflict would send an operator
   * looking for a problem that is already solved.
   */
  const current = await readActiveBadgeAssignment(input.deviceId)

  if (current !== null && current.rangeEnd === input.newRangeEnd) {
    return { ok: true, outcome: 'already-extended', value: current }
  }

  return { ok: false, reason: 'stale-range', current }
}
