import { formatBadgeNumber } from '@/lib/badge'
import type { HistoryAward } from '@/prizes/award-groups'
import type { CngPrizeAward } from '@/shared/cng-contract'
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
 * The AWARDS search, over the COMBINED history: an attendee's badge or name,
 * a CNG member's name, or the prize. History has no filters of its own — it
 * is already newest-first, and the thing an operator looks up is "what has
 * #9005 been given" or "what did Priya win".
 *
 * BOTH KINDS OF RECIPIENT ARE SEARCHABLE, and each by what it actually has.
 * An attendee row is matched on its badge number — in both the bare and the
 * zero-padded form, because the badge in somebody's hand reads `#042` — and
 * on the attendee's name when the register still knows it. A CNG row has no
 * badge, so it is matched on the member's name. A volunteer is never matched
 * by a number, because they do not have one.
 *
 * It filters RECORDS, not people. Several rows may share a badge number or a
 * member, and each one is matched and shown independently.
 */
export const filterPrizeAwards = (
  awards: readonly HistoryAward[],
  search: string,
): HistoryAward[] => {
  const query = search.trim()

  if (query === '') {
    return [...awards]
  }

  return awards.filter((award) => {
    if (textMatches(award.prizeName, query)) {
      return true
    }

    if (award.source === 'cng') {
      return textMatches(award.memberName, query)
    }

    return (
      badgeMatches(award.badgeNumber, query) ||
      (award.attendee !== null && textMatches(award.attendee.name, query))
    )
  })
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

/**
 * Every prize this CNG MEMBER has already been given, newest first.
 *
 * The volunteer equivalent of `previousAwardsFor`, and keyed by the member's
 * UUID rather than by their name: two volunteers may genuinely share a name,
 * and showing one of them the other's prizes would be worse than showing
 * none.
 *
 * It is INFORMATION, exactly as the attendee version is. An empty result
 * means "no warning to show", never "may be awarded", and a non-empty one
 * never withholds the award button — repeat prizes are legal for volunteers
 * too. The only thing that decides whether a CNG award is allowed is that the
 * member is still active, which the database settles on the write.
 */
export const previousCngAwardsFor = (
  awards: readonly CngPrizeAward[],
  cngMemberId: string,
): CngPrizeAward[] =>
  awards.filter((award) => award.cngMemberId === cngMemberId)
