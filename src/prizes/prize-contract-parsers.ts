import {
  parseCngMemberList,
  parseCngPrizeAwardList,
} from '@/cng/cng-contract-parsers'
import { parseAttendeeList, parseEventAttendee } from '@/shared/attendee-contract'
import type { PrizeAttendee, PrizeAward, PrizeRosterResponse } from '@/shared/prize-contract'

/**
 * Runtime validation of the prize responses.
 *
 * A TypeScript annotation on a `fetch` result is a claim, not a check. This
 * screen decides which badge a volunteer hands a prize to, so every field is
 * verified and an unrecognised shape FAILS CLOSED rather than becoming a card
 * on screen.
 *
 * THE ATTENDEE HALF IS NOT HERE. Phase A1 added a second attendee-reading
 * module, so attendee validation lives once in
 * `src/shared/attendee-contract.ts` and both modules call it — a second copy
 * would be a second opinion about which fields are allowed on screen. What
 * remains here is what only prizes has: an award, and the roster response
 * that pairs attendees with award history.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value)

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** The shared attendee parser, under the name the prize module uses. */
export const parsePrizeAttendee = (value: unknown): PrizeAttendee | null =>
  parseEventAttendee(value)

/**
 * One history row. `attendee` is legitimately `null` — the Sheet row may be
 * gone and the prize was still given — so an absent attendee is accepted
 * while a MALFORMED one rejects the row.
 *
 * `prizeName` is checked for being a non-empty string and NOTHING MORE. It is
 * deliberately not validated against the P1.1 catalog: a P1 row saying
 * `Best Dressed` is a prize that was really handed over, and rejecting it
 * here would make the screen hide the ledger because the list of prizes
 * changed afterwards. Only NEW awards are restricted to the eight values.
 */
export const parsePrizeAward = (value: unknown): PrizeAward | null => {
  if (!isRecord(value) || !isRecord(value.awardedBy)) {
    return null
  }

  if (
    !isUuid(value.id) ||
    !isPositiveInteger(value.badgeNumber) ||
    !isNonEmpty(value.prizeName) ||
    !isNonEmpty(value.awardedAt) ||
    !isUuid(value.awardedBy.id) ||
    !isNonEmpty(value.awardedBy.name)
  ) {
    return null
  }

  const attendee =
    value.attendee === null || value.attendee === undefined
      ? null
      : parsePrizeAttendee(value.attendee)

  if (value.attendee !== null && value.attendee !== undefined && attendee === null) {
    return null
  }

  return {
    id: value.id,
    badgeNumber: value.badgeNumber,
    prizeName: value.prizeName,
    awardedAt: value.awardedAt,
    awardedBy: { id: value.awardedBy.id, name: value.awardedBy.name },
    attendee,
  }
}

/**
 * The whole roster, or `null`.
 *
 * ONE bad entry rejects the WHOLE response rather than being dropped. A prize
 * desk working from a silently shortened attendee list would conclude an
 * attendee is not registered, and that is worse than an honest error.
 *
 * FOUR LISTS, each validated by the module that owns its shape: attendees by
 * the shared contract, attendee awards here, and the CNG group and CNG awards
 * by `src/cng/cng-contract-parsers.ts`. A malformed list rejects the WHOLE
 * response rather than yielding an empty one — a desk told the group is empty
 * would add every volunteer a second time, and an empty award history would
 * under-report what the event has given out.
 */
export const parsePrizeRosterResponse = (
  body: unknown,
): PrizeRosterResponse | null => {
  if (!isRecord(body) || !Array.isArray(body.awards)) {
    return null
  }

  const attendees = parseAttendeeList(body.attendees)
  const cng = parseCngMemberList(body.cng)
  const cngAwards = parseCngPrizeAwardList(body.cngAwards)

  if (attendees === null || cng === null || cngAwards === null) {
    return null
  }

  const awards: PrizeAward[] = []

  // Accumulated rather than mapped-and-cast: a cast would assert the result
  // of the check instead of using it, which is the mistake this file exists
  // to avoid.
  for (const entry of body.awards) {
    const award = parsePrizeAward(entry)

    if (award === null) {
      return null
    }

    awards.push(award)
  }

  return { attendees, awards, cng, cngAwards }
}
