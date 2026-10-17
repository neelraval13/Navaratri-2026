import type { CngPrizeAward } from '@/shared/cng-contract'
import { eventDayKey } from '@/shared/event-time'
import type { PrizeAttendee, PrizeAward, PrizeAwardDevice } from '@/shared/prize-contract'

/**
 * PRIZE HISTORY, GROUPED BY THE EVENT-LOCAL CALENDAR DAY — Phase CNG1,
 * extended by Phase CNG1.1 to carry volunteer prizes beside attendee ones.
 *
 * A multi-night event had every card repeating the same date, so the list read
 * as one undifferentiated run of awards. Grouping is a PRESENTATION change
 * and nothing more: no award is moved between days, merged, counted twice,
 * reordered within its day, or altered in any field. Both ledgers are
 * untouched and `awarded_at` is read, never written.
 *
 * THE DAY IS ASIA/KOLKATA, through the ONE shared definition in
 * `src/shared/event-time.ts` — the same `eventDayKey` the dandiya desk counts
 * by and the server scopes its history with. Never the browser's timezone,
 * never the server's, and never a second local implementation:
 *
 *   - `new Date(iso).getDate()` would answer in the VIEWER's zone, so a
 *     tablet set to UTC would file a 11:30 PM IST award under the previous
 *     day — and a volunteer comparing two tablets would see two histories
 *   - `toLocaleDateString()` without a `timeZone` does the same thing more
 *     quietly
 *   - a hardcoded `+05:30` would be a second definition of the event's clock
 *     that could drift from the one the counters use
 *
 * 23:59 and 00:01 IST are therefore DIFFERENT groups, which is the whole
 * point: the awards given either side of midnight belong to the nights they
 * were given on.
 *
 * TWO LEDGERS, ONE HISTORY. An attendee prize is keyed by BADGE NUMBER and an
 * volunteer prize by CNG MEMBER ID; they are separate tables for good reason
 * — a volunteer has no badge, and inventing one is exactly what Phase CNG1.1
 * removed. They are combined HERE, for display only, as a discriminated
 * union: nothing about either row is reshaped, and no badge is fabricated for
 * a volunteer.
 *
 * PURE: no React, no fetch, no state, no `Date.now()`. "Which day does this
 * award belong to" has to be answerable without rendering anything, and a
 * grouping that read the clock would produce different output for the same
 * input.
 */

/**
 * One row of the combined history.
 *
 * A DISCRIMINATED UNION rather than a widened shape with optional fields: a
 * renderer must decide which kind of recipient it is looking at, and
 * `badgeNumber?: number` would let it quietly print nothing for a volunteer
 * instead of their name.
 */
export type HistoryAward =
  | {
      source: 'attendee'
      id: string
      awardedAt: string
      prizeName: string
      awardedBy: PrizeAwardDevice
      badgeNumber: number
      /** `null` when the Sheet row is gone. The prize was still given. */
      attendee: PrizeAttendee | null
    }
  | {
      source: 'cng'
      id: string
      awardedAt: string
      prizeName: string
      awardedBy: PrizeAwardDevice
      cngMemberId: string
      /** Joined from the membership row, which soft removal keeps alive. */
      memberName: string
    }

export interface AwardDateGroup {
  /** `YYYY-MM-DD` in the event zone. Sorts and compares as a string. */
  dayKey: string
  /** The day's awards, in the order they arrived: newest first. */
  awards: HistoryAward[]
}

/**
 * An award whose timestamp cannot be read at all.
 *
 * `eventDayKey` answers `''` for an unusable value rather than throwing
 * inside a render. Such a row still has a prize and a device — real facts
 * somebody may need — so it is kept in its own group and sorted LAST rather
 * than dropped. Hiding a ledger row because one field is corrupt would lose
 * the only record of it.
 */
const UNDATED = ''

/**
 * The two ledgers as one list, NEWEST FIRST.
 *
 * Merged by timestamp rather than concatenated, so a volunteer prize given at
 * 9:55 pm sits above an attendee prize from 9:50 pm — which is what "the
 * history" means to somebody reading it. The id breaks a tie so the order is
 * deterministic: both lists arrive newest-first with their own tie-break, and
 * two awards in the same millisecond must not swap places between renders.
 *
 * NOTHING IS RESHAPED. Each row keeps its own identity — a badge number and a
 * joined attendee, or a member id and a joined name — and the `source` tag is
 * the only field added.
 */
export const combineAwardHistory = (
  awards: readonly PrizeAward[],
  cngAwards: readonly CngPrizeAward[],
): HistoryAward[] => {
  const combined: HistoryAward[] = [
    ...awards.map(
      (award): HistoryAward => ({
        source: 'attendee',
        id: award.id,
        awardedAt: award.awardedAt,
        prizeName: award.prizeName,
        awardedBy: award.awardedBy,
        badgeNumber: award.badgeNumber,
        attendee: award.attendee,
      }),
    ),
    ...cngAwards.map(
      (award): HistoryAward => ({
        source: 'cng',
        id: award.id,
        awardedAt: award.awardedAt,
        prizeName: award.prizeName,
        awardedBy: award.awardedBy,
        cngMemberId: award.cngMemberId,
        memberName: award.memberName,
      }),
    ),
  ]

  return combined.sort((left, right) => {
    const byTime = right.awardedAt.localeCompare(left.awardedAt)

    return byTime === 0 ? right.id.localeCompare(left.id) : byTime
  })
}

/**
 * Prize history as one group per event-local day.
 *
 * NEWEST DAY FIRST, by comparing the day keys themselves: `YYYY-MM-DD` sorts
 * lexicographically in calendar order, so no second date parse is involved
 * and no locale can reorder the headings.
 *
 * WITHIN A DAY THE INPUT ORDER IS PRESERVED, untouched. The combined list is
 * already newest-first with a deterministic tie-break, so re-sorting here
 * would be a second ordering rule that could disagree with it. Filtering
 * preserves that order too, which is why a searched history groups correctly.
 */
export const groupAwardsByEventDay = (
  awards: readonly HistoryAward[],
): AwardDateGroup[] => {
  const groups = new Map<string, HistoryAward[]>()

  for (const award of awards) {
    const dayKey = eventDayKey(award.awardedAt)
    const existing = groups.get(dayKey)

    if (existing === undefined) {
      groups.set(dayKey, [award])

      continue
    }

    existing.push(award)
  }

  return [...groups.entries()]
    .map(([dayKey, dayAwards]) => ({ dayKey, awards: dayAwards }))
    .sort((left, right) => {
      // An undated group sits below every real day, whichever way they sort.
      if (left.dayKey === UNDATED) {
        return right.dayKey === UNDATED ? 0 : 1
      }

      if (right.dayKey === UNDATED) {
        return -1
      }

      return right.dayKey.localeCompare(left.dayKey)
    })
}

/**
 * Is this group open when nobody has touched it?
 *
 * THE LATEST DAY IS EXPANDED AND EVERY OLDER ONE IS COLLAPSED. Tonight is
 * what a volunteer at the table is looking at; last night is reference
 * material, and three expanded nights is a wall of cards to scroll past.
 *
 * Expressed as a function of the group's POSITION rather than of today's
 * date, which matters twice. It stays correct after midnight with no re-read
 * — the newest group is simply the newest group — and when a search hides
 * every award from tonight, the newest day that still has results opens
 * instead of the operator finding every group shut.
 */
export const isDefaultExpandedAwardGroup = (index: number): boolean => index === 0
