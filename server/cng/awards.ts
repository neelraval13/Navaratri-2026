import { and, eq, isNull, sql } from 'drizzle-orm'

import { getDatabase } from '../db/client.js'
import { cngMembers, cngPrizeAwards, devices } from '../db/schema.js'

/**
 * The ONLY module that reads or writes `cng_prize_awards`.
 *
 * SEPARATE FROM THE ATTENDEE LEDGER, AND THAT IS THE POINT. `prize_awards` is
 * keyed by BADGE NUMBER and is Production-live with real history. A volunteer
 * has no badge, so recording their prize there would have meant making
 * `badge_number` nullable, inventing a value for it, or overloading it with
 * an identity it does not describe. This module imports no prize table, and
 * `server/prizes/awards.ts` imports nothing from here: neither ledger can
 * reach the other.
 *
 * ONE COPY OF A PERSON'S NAME. The award row holds a member REFERENCE, not a
 * name; the name lives once on `cng_members` and is joined per request —
 * exactly as an attendee's name is joined from the Badge Register.
 *
 * REPEAT PRIZES ARE LEGAL, as they are for attendees since Phase P1.1. There
 * is no uniqueness to arbitrate, so the insert has no conflict to translate
 * and never reports one. It is an append.
 *
 * ---------------------------------------------------------------------------
 * A REMOVED MEMBER MAY NOT RECEIVE A NEW PRIZE, AND THE MEMBER ROW LOCK IS
 * WHAT MAKES THAT TRUE.
 *
 * The transaction is ONE `db.batch` of exactly two statements, in this order
 * and no other:
 *
 *   1  SELECT id, name FROM cng_members
 *        WHERE id = $member AND event_id = $event AND removed_at IS NULL
 *        FOR UPDATE                                            the lock
 *
 *   2  INSERT INTO cng_prize_awards (...) SELECT ... FROM cng_members
 *        WHERE id = $member AND event_id = $event AND removed_at IS NULL
 *        RETURNING id                                   the guarded write
 *
 * THE ORDER IS LOAD-BEARING. The lock must be the FIRST statement of the SAME
 * batch: a lock taken afterwards protects nothing, and a lock taken in a
 * transaction of its own is released before the work it was meant to guard.
 *
 * WHY A LOCK AND NOT A CHECK. `removeCngMember` is an `UPDATE` of this same
 * row, which takes the row's own lock, so the two contend:
 *
 *   award locks first    the removal's UPDATE waits. The award commits while
 *                        the member is genuinely active, and the removal
 *                        then proceeds
 *   removal locks first  the award's SELECT ... FOR UPDATE waits. When the
 *                        removal commits, READ COMMITTED re-evaluates the
 *                        predicate on the locked row, `removed_at IS NULL` is
 *                        now false, the lock yields NO row — and statement 2
 *                        yields none either, so nothing is written
 *
 * A PRE-READ OF `removed_at` FOLLOWED BY AN INSERT WOULD NOT DO THIS. A
 * process can pause for any length of time between the read and the write — a
 * GC pause, a cold start, a retried request — and a removal can commit inside
 * that window. That is a TIMING ASSUMPTION, not a transactional guarantee,
 * and this project has already made it once on the dandiya issuance path and
 * been wrong. Never decide this outside the writing transaction again.
 *
 * STATEMENT 2 IS STILL GUARDED, even though the lock has settled the
 * question. `db.batch` cannot branch, so the rule has to be carried by the
 * insert's own `WHERE`: when it does not hold, the select yields no row,
 * nothing is written, and `RETURNING` comes back empty — which is the verdict
 * the writer reads. A foreign-key error is never used as ordinary control
 * flow.
 *
 * IT IS NOT THE D3.1 RESOLUTION LOCK AND DOES NOT TOUCH IT. That one locks a
 * `dandiya_loans` row; this one locks a `cng_members` row. Two different
 * questions, two different locks, each with exactly one call site.
 *
 * THE STAND-IN DATABASE CANNOT PROVE THE VISIBILITY RULES, for the same
 * reason it cannot prove the dandiya locks: it is single-threaded, so a
 * scripted concurrent writer has always already committed — which is exactly
 * the world the real lock produces. `verify:cng1` therefore pins the lock's
 * PRESENCE and its POSITION from the transaction's own record, plus the
 * post-lock behaviour, and `scripts/cng-award-concurrency-smoke.mjs` proves
 * the EFFECT against a real database.
 * ---------------------------------------------------------------------------
 */

/** A CNG award as Postgres holds it, plus the two joined names. */
export interface CngPrizeAwardRecord {
  id: string
  cngMemberId: string
  memberName: string
  prizeName: string
  /** ISO 8601 UTC. The SERVER's clock, never a caller's. */
  awardedAt: string
  awardedBy: { id: string; name: string }
}

/**
 * Every CNG award for one event, newest first.
 *
 * The member's name and the device's name are both joined FRESH rather than
 * copied into the ledger: a renamed desk must not leave history naming one
 * that no longer exists, and a volunteer's name lives in one place.
 *
 * A REMOVED MEMBER'S AWARDS ARE STILL RETURNED. Removal is soft precisely so
 * this join keeps working — the prize was given, and history has to say to
 * whom.
 *
 * Ordering is applied here rather than in SQL because it is part of the
 * response CONTRACT: sorting in the code that produces the response is what
 * makes the contract testable without a database that implements ORDER BY.
 */
export const readCngPrizeAwards = async (
  eventId: string,
): Promise<CngPrizeAwardRecord[]> => {
  const rows = await getDatabase()
    .select({
      id: cngPrizeAwards.id,
      cngMemberId: cngPrizeAwards.cngMemberId,
      memberName: cngMembers.name,
      prizeName: cngPrizeAwards.prizeName,
      awardedAt: cngPrizeAwards.awardedAt,
      deviceId: cngPrizeAwards.awardedByDeviceId,
      deviceName: devices.name,
    })
    .from(cngPrizeAwards)
    .innerJoin(cngMembers, eq(cngMembers.id, cngPrizeAwards.cngMemberId))
    .innerJoin(devices, eq(devices.id, cngPrizeAwards.awardedByDeviceId))
    .where(eq(cngPrizeAwards.eventId, eventId))

  return rows
    .map((row) => ({
      id: row.id,
      cngMemberId: row.cngMemberId,
      memberName: row.memberName,
      prizeName: row.prizeName,
      awardedAt: row.awardedAt.toISOString(),
      awardedBy: { id: row.deviceId, name: row.deviceName },
    }))
    .sort((left, right) => {
      const byTime = right.awardedAt.localeCompare(left.awardedAt)

      /**
       * The id breaks the tie, and it has to: one member may hold several
       * awards, so two rows in the same millisecond are possible and would
       * otherwise swap places between requests.
       */
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime
    })
}

/**
 * THE SERIALISATION POINT: the member's own row, locked.
 *
 * Scoped to the event AND to `removed_at IS NULL`, the same way
 * `lockOpenLoan` is scoped to its loan's event and `closed_at IS NULL`. It
 * has exactly ONE call site — the batch below — and must stay that way: a
 * second one would be a second claim about what this lock protects.
 *
 * It selects the NAME as well as the id, so the response needs no second
 * read: the locked row is, by definition, the authoritative one.
 */
const lockCngMember = (input: { eventId: string; cngMemberId: string }) =>
  getDatabase()
    .select({ id: cngMembers.id, name: cngMembers.name })
    .from(cngMembers)
    .where(
      and(
        eq(cngMembers.id, input.cngMemberId),
        eq(cngMembers.eventId, input.eventId),
        isNull(cngMembers.removedAt),
      ),
    )
    .for('update')

/**
 * THE GUARDED WRITE: one award row, or none.
 *
 * EVERY SELECTED FIELD IS A CONSTANT, and the whole column set is named in
 * the table's own order — Drizzle builds the explicit column list from the
 * table definition and refuses a mismatch loudly. The scanned member row
 * decides HOW MANY rows are written (one, or none), never WHAT is written.
 */
const guardedAwardInsert = (input: {
  eventId: string
  cngMemberId: string
  prizeName: string
  deviceId: string
}) =>
  getDatabase()
    .insert(cngPrizeAwards)
    .select((qb) =>
      qb
        .select({
          id: sql`gen_random_uuid()`.as('id'),
          eventId: sql`${input.eventId}::uuid`.as('event_id'),
          cngMemberId: sql`${input.cngMemberId}::uuid`.as('cng_member_id'),
          prizeName: sql`${input.prizeName}::text`.as('prize_name'),
          awardedByDeviceId: sql`${input.deviceId}::uuid`.as('awarded_by_device_id'),
          awardedAt: sql`now()`.as('awarded_at'),
        })
        .from(cngMembers)
        .where(
          and(
            eq(cngMembers.id, input.cngMemberId),
            eq(cngMembers.eventId, input.eventId),
            isNull(cngMembers.removedAt),
          ),
        ),
    )
    .returning()

export type CngAwardResult =
  | { outcome: 'awarded'; award: CngPrizeAwardRecord }
  /** No such ACTIVE member on this event. Nothing was written. */
  | { outcome: 'member-unavailable' }

/**
 * Records one prize for one ACTIVE CNG member.
 *
 * `awardedAt` comes from the row Postgres wrote — `now()`, evaluated by the
 * database — so a caller can never date its own award, and `id` is the
 * database's. The awarding device and the event both come from the
 * authenticated session.
 *
 * ONE TRANSACTION, TWO STATEMENTS, LOCK FIRST. See the module comment for why
 * the order is load-bearing and why a pre-read would not do.
 */
export const recordCngPrizeAward = async (input: {
  eventId: string
  cngMemberId: string
  prizeName: string
  awardedByDevice: { id: string; name: string }
}): Promise<CngAwardResult> => {
  /**
   * INLINE, so the tuple types itself. Drizzle's `batch` demands a non-empty
   * tuple, which a `const statements = [...]` loses — the dandiya ISSUANCE
   * writer needs a cast for that reason. An inline literal needs none, and a
   * cast avoided is better than a cast explained.
   *
   * THE LOCK IS FIRST. A guarded write above this line would run
   * unserialised, which is the entire bug this lock exists to close.
   */
  const [locked, inserted] = await getDatabase().batch([
    lockCngMember({ eventId: input.eventId, cngMemberId: input.cngMemberId }),
    guardedAwardInsert({
      eventId: input.eventId,
      cngMemberId: input.cngMemberId,
      prizeName: input.prizeName,
      deviceId: input.awardedByDevice.id,
    }),
  ])

  /**
   * THE LOCK FOUND NO ACTIVE MEMBER — removed, or never on this event. The
   * guarded insert then matched nothing either, so the batch commits having
   * written nothing at all.
   */
  const member = locked[0]
  const award = inserted[0]

  if (member === undefined || award === undefined) {
    return { outcome: 'member-unavailable' }
  }

  return {
    outcome: 'awarded',
    award: {
      id: award.id,
      cngMemberId: award.cngMemberId,
      /** From the LOCKED row: the authoritative name, read under the lock. */
      memberName: member.name,
      prizeName: award.prizeName,
      awardedAt: award.awardedAt.toISOString(),
      awardedBy: {
        id: input.awardedByDevice.id,
        name: input.awardedByDevice.name,
      },
    },
  }
}
