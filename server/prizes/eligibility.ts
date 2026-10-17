import type {
  PrizeAttendee,
  PrizeAward,
  PrizeRosterLists,
} from '../../src/shared/prize-contract.js'
import type { PrizeAwardRecord } from './awards.js'

/**
 * The prize desk's two lists: who is registered, and what has been given.
 *
 * PURE: no database, no Sheets, no HTTP. It is handed the two sources and
 * composes the response, so the product rule of this module is a function
 * that can be read and tested rather than a query that has to be inferred
 * from a join.
 *
 * THE RULE CHANGED IN PHASE P1.1. P1 composed
 *
 *   eligible = Badge Register rows MINUS badges already in prize_awards
 *
 * and that subtraction is GONE. A previous prize no longer disqualifies
 * anybody: an attendee may win Best Dance and Best Dress, or the same prize
 * twice, so every registered attendee stays in the list after every award and
 * stays findable by search and by the age and gender filters.
 *
 * The property is therefore simple and worth stating plainly: `attendees` is
 * exactly the roster it was given, in the order it was given, and NOTHING
 * here can remove an entry from it. The join runs one way only — the Sheet
 * supplies the person, the ledger supplies the prizes.
 *
 * IT RETURNS TWO LISTS, NOT THE WHOLE RESPONSE. Phase CNG1 added the CNG
 * group to `GET /api/prizes`, and this composer deliberately does not produce
 * it: `PrizeRosterLists` is the half the prize module owns, so a prize
 * composer cannot touch membership and a membership composer cannot touch
 * prize history. The endpoint puts the two halves together.
 */
export const composePrizeRoster = (input: {
  attendees: readonly PrizeAttendee[]
  awards: readonly PrizeAwardRecord[]
}): PrizeRosterLists => {
  /**
   * Indexed by badge number so history can name an attendee without a scan
   * per row. SEVERAL AWARDS MAY SHARE A BADGE, and each one looks the
   * attendee up independently, so repeats are a non-event here.
   */
  const byBadge = new Map(
    input.attendees.map((attendee) => [attendee.badgeNumber, attendee]),
  )

  const awards: PrizeAward[] = input.awards.map((award) => ({
    id: award.id,
    badgeNumber: award.badgeNumber,
    prizeName: award.prizeName,
    awardedAt: award.awardedAt,
    awardedBy: { id: award.awardedBy.id, name: award.awardedBy.name },
    /**
     * `null` when the Sheet row is gone. The prize was still given, so the
     * badge, the prize, the time and the awarding device must still be shown
     * — losing a row of history because somebody edited a spreadsheet would
     * be worse than showing it without a name.
     */
    attendee: byBadge.get(award.badgeNumber) ?? null,
  }))

  // Badge-ascending from the roster reader, and passed through untouched.
  return { attendees: [...input.attendees], awards }
}
