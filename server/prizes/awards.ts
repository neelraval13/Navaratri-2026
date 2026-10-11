import { eq } from 'drizzle-orm'

import { getDatabase } from '../db/client.js'
import { devices, prizeAwards } from '../db/schema.js'

/**
 * The ONLY module that reads or writes `prize_awards`.
 *
 * One writer, deliberately, for the same reason badge assignments have one:
 * everything that is true about how a prize is recorded — that the server
 * stamps the time, that the awarding device comes from the session, that
 * nothing about the person is stored — is true in exactly one place.
 *
 * It stores the OPERATIONAL LEDGER and nothing else — event, badge number,
 * prize name, awarding device, server timestamp. No attendee name, phone,
 * age, gender, WhatsApp link or payment detail is written here or could be:
 * the table has no column for any of them.
 *
 * SINCE PHASE P1.1 THERE IS NO UNIQUENESS TO ARBITRATE. An attendee may win
 * more than one prize, including the same prize twice, so the insert has no
 * conflict to translate and never reports one. It is an append — if the
 * database refuses it, something is genuinely wrong and the error travels up
 * as an unexpected failure rather than being reported as a product rule.
 *
 * It holds no HTTP or authorization concern. Who may award is the endpoint's
 * question, answered against a live device session before this is reached.
 */

/** A ledger row as Postgres holds it, plus the awarding device's name. */
export interface PrizeAwardRecord {
  id: string
  badgeNumber: number
  prizeName: string
  /** ISO 8601 UTC. The SERVER's clock, never a caller's. */
  awardedAt: string
  awardedBy: { id: string; name: string }
}

/**
 * Every award for one event, newest first.
 *
 * The device NAME is joined because history has to be readable by a human
 * ("Prize Desk B gave it") and a UUID is not. The name is editable Admin
 * metadata, so it is read fresh rather than copied into the ledger — a
 * renamed device must not leave history naming a desk that no longer exists.
 *
 * Ordering is applied here rather than in SQL because it is part of the
 * response CONTRACT: sorting in the code that produces the response is what
 * makes the contract testable without a database that implements ORDER BY.
 *
 * REPEATED BADGE NUMBERS ARE EXPECTED. Nothing is grouped, collapsed or
 * de-duplicated: three prizes for #9005 are three rows, because that is three
 * things that happened.
 */
export const readPrizeAwards = async (
  eventId: string,
): Promise<PrizeAwardRecord[]> => {
  const rows = await getDatabase()
    .select({
      id: prizeAwards.id,
      badgeNumber: prizeAwards.badgeNumber,
      prizeName: prizeAwards.prizeName,
      awardedAt: prizeAwards.awardedAt,
      deviceId: prizeAwards.awardedByDeviceId,
      deviceName: devices.name,
    })
    .from(prizeAwards)
    .innerJoin(devices, eq(devices.id, prizeAwards.awardedByDeviceId))
    .where(eq(prizeAwards.eventId, eventId))

  return rows
    .map((row) => ({
      id: row.id,
      badgeNumber: row.badgeNumber,
      prizeName: row.prizeName,
      awardedAt: row.awardedAt.toISOString(),
      awardedBy: { id: row.deviceId, name: row.deviceName },
    }))
    .sort((left, right) => {
      const byTime = right.awardedAt.localeCompare(left.awardedAt)

      if (byTime !== 0) {
        return byTime
      }

      const byBadge = right.badgeNumber - left.badgeNumber

      /**
       * The id breaks the final tie, and it has to: one badge may now hold
       * several awards, so two rows in the same millisecond for the SAME
       * badge are possible and would otherwise swap places between requests.
       */
      return byBadge === 0 ? right.id.localeCompare(left.id) : byBadge
    })
}

/**
 * Records one prize. Every call appends exactly one row.
 *
 * `awardedAt` comes from the row Postgres wrote — the column default — so a
 * caller can never date its own award, and `id` is the database's. The
 * awarding device and the event both come from the authenticated session, so
 * neither is accepted from a body.
 *
 * It does NOT ask whether this badge already has a prize, and there is
 * nothing to ask: repeat awards are the product rule. The warning a volunteer
 * sees comes from the history the screen already has, and it informs rather
 * than refuses.
 */
export const recordPrizeAward = async (input: {
  eventId: string
  badgeNumber: number
  prizeName: string
  awardedByDevice: { id: string; name: string }
}): Promise<PrizeAwardRecord> => {
  const [row] = await getDatabase()
    .insert(prizeAwards)
    .values({
      eventId: input.eventId,
      badgeNumber: input.badgeNumber,
      prizeName: input.prizeName,
      awardedByDeviceId: input.awardedByDevice.id,
    })
    .returning()

  return {
    id: row.id,
    badgeNumber: row.badgeNumber,
    prizeName: row.prizeName,
    awardedAt: row.awardedAt.toISOString(),
    awardedBy: {
      id: input.awardedByDevice.id,
      name: input.awardedByDevice.name,
    },
  }
}
