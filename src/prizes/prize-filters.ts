import { formatBadgeNumber } from '@/lib/badge'
import type { PrizeAward } from '@/shared/prize-contract'

/**
 * The prize module's own list logic: awards, not attendees.
 *
 * ATTENDEE filtering is NOT here. Phase A1 gave the read-only directory the
 * same search, age window and gender filter, so those moved once into
 * `src/attendees/attendee-filters.ts` and both modules call them. What
 * remains is what only prizes has — a ledger of awards.
 */

/** Only the digits, so `#042`, `042` and `42` are the same query. */
const digitsOf = (value: string): string => value.replace(/\D/g, '')

/**
 * Does this badge number match what was typed?
 *
 * Both the bare number and the zero-padded display form are searched, because
 * the badge in the operator's hand reads `#042` while the register stores 42.
 */
const badgeMatches = (badgeNumber: number, query: string): boolean => {
  const digits = digitsOf(query)

  if (digits === '') {
    return false
  }

  return (
    String(badgeNumber).includes(digits) ||
    formatBadgeNumber(badgeNumber).slice(1).includes(digits)
  )
}

const textMatches = (value: string, query: string): boolean =>
  value.toLowerCase().includes(query.trim().toLowerCase())

/**
 * The AWARDS search: badge, attendee name when it is still known, or prize
 * name. History has no filters of its own — it is already newest-first, and
 * the thing an operator looks up is "what has #9005 been given".
 *
 * It filters RECORDS, not people. Several rows may share a badge number and
 * each one is matched and shown independently.
 */
export const filterPrizeAwards = (
  awards: readonly PrizeAward[],
  search: string,
): PrizeAward[] => {
  const query = search.trim()

  if (query === '') {
    return [...awards]
  }

  return awards.filter(
    (award) =>
      badgeMatches(award.badgeNumber, query) ||
      textMatches(award.prizeName, query) ||
      (award.attendee !== null && textMatches(award.attendee.name, query)),
  )
}

/**
 * Every prize this badge has ALREADY been given, newest first.
 *
 * This is what the award dialog warns from. It is INFORMATION: an empty
 * result means "no warning to show", never "may be awarded", and a non-empty
 * one never withholds the award button. The authority over whether an award
 * is allowed is simply that the badge is registered.
 *
 * Read from the history the screen already holds, so no extra request is
 * needed and the warning is as fresh as the list the volunteer is looking at.
 * The input is already newest-first from the server; filtering preserves it.
 */
export const previousAwardsFor = (
  awards: readonly PrizeAward[],
  badgeNumber: number,
): PrizeAward[] => awards.filter((award) => award.badgeNumber === badgeNumber)
