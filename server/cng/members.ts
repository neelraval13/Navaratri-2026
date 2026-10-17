import { and, eq, isNull } from 'drizzle-orm'

import { getDatabase } from '../db/client.js'
import { cngMembers, devices } from '../db/schema.js'

/**
 * The ONLY module that WRITES `cng_members`.
 *
 * One writer, deliberately, for the same reason the prize ledger, the badge
 * assignments and the dandiya loans each have one: everything that is true
 * about how a membership is recorded — that the server stamps the times, that
 * the acting device comes from the session — is true in exactly one place.
 * `server/cng/awards.ts` READS these rows (it locks one and selects from it)
 * but writes none.
 *
 * A MEMBER IS A VOLUNTEER'S NAME, NOT A BADGE. Phase CNG1 keyed membership by
 * badge number on the assumption that a volunteer was a registered attendee.
 * They are not, so Phase CNG1.1 corrected the model: the name the operator
 * typed IS the member, stored deliberately, and NOTHING here reads the Badge
 * Register. This module imports no attendee reader, no Sheets client and no
 * prize table — a CNG name is matched against nothing.
 *
 * THE NAME IS THE ONLY PERSON FIELD. No phone, age, gender, WhatsApp link or
 * payment column exists here or could: the table has none.
 *
 * THE ROW ID IS THE IDEMPOTENCY KEY, and it has to be. A name cannot be:
 * two volunteers may genuinely share one, so "already added?" is
 * unanswerable from a name and de-duplicating by it would merge two people.
 * The client therefore generates the UUID once per member it is about to add
 * and sends it, so a retried PUT reaches the same row.
 *
 * REMOVAL IS SOFT, and that is a requirement rather than a preference.
 * `cng_prize_awards` references these rows with `ON DELETE restrict`, so a
 * member who has received a prize cannot be deleted at all — and history must
 * still be able to say WHO received it. `removeCngMember` therefore stamps
 * `removed_at` and the removing device, and the ACTIVE roster is
 * `removed_at IS NULL`.
 *
 * IT IS ALSO THE OTHER HALF OF A SERIALISATION PAIR. The removal is an
 * `UPDATE` of one `cng_members` row, which takes that row's lock; the award
 * writer locks the SAME row `FOR UPDATE` as the first statement of its own
 * transaction. PostgreSQL then orders the two for us — see
 * `server/cng/awards.ts`.
 *
 * It holds no HTTP or authorization concern. Who may curate the group is the
 * endpoint's question, answered against a live device session before this is
 * reached.
 */

/** A membership row as Postgres holds it, plus the adding device's name. */
export interface CngMemberRecord {
  id: string
  name: string
  /** ISO 8601 UTC. The SERVER's clock, never a caller's. */
  addedAt: string
  addedBy: { id: string; name: string }
}

const memberColumns = {
  id: cngMembers.id,
  name: cngMembers.name,
  addedAt: cngMembers.addedAt,
  deviceId: cngMembers.addedByDeviceId,
  deviceName: devices.name,
}

const toRecord = (row: {
  id: string
  name: string
  addedAt: Date
  deviceId: string
  deviceName: string
}): CngMemberRecord => ({
  id: row.id,
  name: row.name,
  addedAt: row.addedAt.toISOString(),
  addedBy: { id: row.deviceId, name: row.deviceName },
})

/**
 * The ACTIVE CNG group for one event, oldest first.
 *
 * Insertion order rather than alphabetical: the organiser pastes their list
 * in the order they wrote it, and a roster that re-sorted itself would be one
 * they have to search rather than read. A removed member is absent — this is
 * the group as it stands now, and history has its own join.
 *
 * The device NAME is joined because a human reads this ("Prize Desk B added
 * them") and a UUID is not. It is read FRESH rather than copied into the row,
 * so a renamed device does not leave history naming a desk that no longer
 * exists.
 */
export const readCngMembers = async (
  eventId: string,
): Promise<CngMemberRecord[]> => {
  const rows = await getDatabase()
    .select(memberColumns)
    .from(cngMembers)
    .innerJoin(devices, eq(devices.id, cngMembers.addedByDeviceId))
    .where(and(eq(cngMembers.eventId, eventId), isNull(cngMembers.removedAt)))

  return rows
    .map(toRecord)
    .sort((left, right) => {
      const byTime = left.addedAt.localeCompare(right.addedAt)

      /**
       * The id breaks the tie, and it has to: a pasted list adds several
       * members in quick succession, so two rows in the same millisecond are
       * ordinary and would otherwise swap places between requests.
       */
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime
    })
}

/**
 * One membership of this event, by id, active or removed. `null` when the id
 * is unknown HERE — including when it belongs to another event.
 */
const readCngMember = async (input: {
  eventId: string
  cngMemberId: string
}): Promise<CngMemberRecord | null> => {
  const [row] = await getDatabase()
    .select(memberColumns)
    .from(cngMembers)
    .innerJoin(devices, eq(devices.id, cngMembers.addedByDeviceId))
    .where(
      and(
        eq(cngMembers.id, input.cngMemberId),
        eq(cngMembers.eventId, input.eventId),
      ),
    )

  return row === undefined ? null : toRecord(row)
}

export type CngAddResult =
  | { outcome: 'added'; member: CngMemberRecord }
  /** The same id and the same name again. The requested state already holds. */
  | { outcome: 'already-member'; member: CngMemberRecord }
  /** The same id with a DIFFERENT name. Refused, never overwritten. */
  | { outcome: 'id-in-use'; member: CngMemberRecord }
  /** The id exists on ANOTHER event. Refused; nothing is disclosed about it. */
  | { outcome: 'id-elsewhere' }

/**
 * Adds one volunteer, IDEMPOTENTLY on the client-supplied row id.
 *
 * `addedAt` comes from the row Postgres wrote — the column default — so a
 * caller can never date its own membership. The adding device and the event
 * both come from the authenticated session, so neither is accepted from a
 * body.
 *
 * THE PRIMARY KEY IS THE AUTHORITY, not a pre-read. The insert carries
 * `ON CONFLICT DO NOTHING` targeted at `id`, and the EMPTY `RETURNING` is the
 * verdict: a row with that id already exists. Only THEN is it read back, to
 * decide which of the three refusals applies. A `SELECT` then `INSERT` would
 * only move the race — two retries of the same request could both see the id
 * absent and both insert — and this project has made that mistake once
 * already, on the dandiya issuance path.
 *
 * THE THREE OUTCOMES BEYOND `added` ARE DISTINCT ON PURPOSE:
 *
 *   already-member  same id, same name. The retry of a lost response, which
 *                   is exactly what the idempotency key exists for
 *   id-in-use       same id, DIFFERENT name. Refused rather than silently
 *                   overwriting somebody: a name is a person, and whichever
 *                   of the two the operator meant, guessing is wrong
 *   id-elsewhere    the id belongs to another event. Refused, and nothing
 *                   about that row is returned
 *
 * TWO DIFFERENT IDS WITH THE SAME NAME BOTH SUCCEED, because two volunteers
 * may genuinely share a name. That is the case a name-keyed idempotency would
 * have destroyed.
 *
 * NOTHING IS LOOKED UP. No Badge Register read, no attendee match, no badge.
 */
export const addCngMember = async (input: {
  eventId: string
  cngMemberId: string
  name: string
  addedByDevice: { id: string; name: string }
}): Promise<CngAddResult> => {
  const inserted = await getDatabase()
    .insert(cngMembers)
    .values({
      id: input.cngMemberId,
      eventId: input.eventId,
      name: input.name,
      addedByDeviceId: input.addedByDevice.id,
    })
    /**
     * TARGETED at the primary key, never bare. A bare `DO NOTHING` would also
     * absorb a constraint nobody meant to hit — a blank name, a cross-event
     * device — and this write must stay loud about everything except the
     * retry it is built for.
     */
    .onConflictDoNothing({ target: cngMembers.id })
    .returning()

  const [row] = inserted

  if (row !== undefined) {
    return {
      outcome: 'added',
      member: {
        id: row.id,
        name: row.name,
        addedAt: row.addedAt.toISOString(),
        addedBy: { id: input.addedByDevice.id, name: input.addedByDevice.name },
      },
    }
  }

  /**
   * THE KEY REFUSED IT, so a row with that id exists. Read it back — scoped
   * to this event — so the answer carries the AUTHORITATIVE row rather than
   * the one this request tried to write.
   */
  const existing = await readCngMember({
    eventId: input.eventId,
    cngMemberId: input.cngMemberId,
  })

  if (existing === null) {
    /**
     * The id exists but not on this event. Effectively impossible for a
     * client-generated UUID, and refused rather than reported in detail: the
     * caller learns nothing about another event's data.
     */
    return { outcome: 'id-elsewhere' }
  }

  return existing.name === input.name
    ? { outcome: 'already-member', member: existing }
    : { outcome: 'id-in-use', member: existing }
}

/**
 * Removes one volunteer from the ACTIVE group. `false` when there was nothing
 * to remove.
 *
 * A SOFT REMOVAL, and a COMPARE-AND-SET: the update requires
 * `removed_at IS NULL`, so two desks removing the same member cannot both
 * believe they did it — the loser matches no row. The EMPTY `RETURNING` is
 * the verdict, rather than a read deciding first.
 *
 * IT IS ALSO ONE HALF OF THE AWARD/REMOVAL SERIALISATION. This `UPDATE`
 * takes the row's own lock, and `recordCngPrizeAward` opens its transaction
 * by locking the SAME row `FOR UPDATE`. Whichever gets the lock first
 * decides: an award that wins commits while the member is still active and
 * the removal follows; a removal that wins makes the waiting award observe a
 * removed member and refuse. No timing assumption is involved.
 *
 * SCOPED TO THE EVENT, always — never a bare `WHERE id = ?`.
 *
 * IT REMOVES MEMBERSHIP AND NOTHING ELSE. The row survives, its prize history
 * survives and still names them, and no attendee, registration or badge is
 * touched: this module imports none of those tables.
 */
export const removeCngMember = async (input: {
  eventId: string
  cngMemberId: string
  removedByDevice: { id: string }
}): Promise<boolean> => {
  const removed = await getDatabase()
    .update(cngMembers)
    .set({
      /**
       * STAMPED HERE, not accepted from a caller. An UPDATE has no column
       * default to fall back on, so the one server-side writer owns the
       * clock — the same arrangement the dandiya resolution writer uses.
       */
      removedAt: new Date(),
      removedByDeviceId: input.removedByDevice.id,
    })
    .where(
      and(
        eq(cngMembers.id, input.cngMemberId),
        eq(cngMembers.eventId, input.eventId),
        isNull(cngMembers.removedAt),
      ),
    )
    .returning({ id: cngMembers.id })

  return removed.length > 0
}
