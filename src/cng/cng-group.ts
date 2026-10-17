import type { CngMember } from '@/shared/cng-contract'

/**
 * Applying a confirmed membership change to the group ALREADY ON SCREEN.
 *
 * Pure functions, so "what does the list look like after this add" is
 * answerable without rendering anything — and so the desk can apply the
 * server's authoritative row without a re-fetch, which would discard the
 * filters and the search a volunteer is working through.
 *
 * THEY ARE NOT AN OPTIMISTIC UPDATE. Both are applied only AFTER the server
 * has confirmed, with the row the server returned. Nothing here guesses at an
 * outcome, and nothing here is reachable before a response.
 *
 * KEYED BY THE ROW'S UUID, never by the name. Phase CNG1.1 made the name the
 * thing a human reads rather than the identity: two volunteers may genuinely
 * share one, so matching on it would merge two people or remove the wrong
 * one.
 */

/**
 * The group with this membership added.
 *
 * APPENDED, never replaced. Every add is a new row — the name is not unique
 * and the server reports no conflict — so appending is the truthful
 * operation. The id is checked only so a response applied twice (a retry
 * whose first answer arrived late) cannot show one member twice.
 */
export const withCngMember = (
  members: readonly CngMember[],
  member: CngMember,
): CngMember[] => [
  ...members.filter((entry) => entry.id !== member.id),
  member,
]

/** The group without this membership. */
export const withoutCngMember = (
  members: readonly CngMember[],
  cngMemberId: string,
): CngMember[] => members.filter((member) => member.id !== cngMemberId)
