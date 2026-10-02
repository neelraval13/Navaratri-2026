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
 * Admin preassignment and Device self-claim both reserve a range through
 * this module, so the INSERT and the interpretation of a constraint violation
 * exist once. Their AUTHORIZATION layers stay entirely separate — an Admin
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
