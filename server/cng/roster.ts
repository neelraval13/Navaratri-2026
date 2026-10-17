import type { CngMember, CngPrizeAward } from '../../src/shared/cng-contract.js'
import type { CngPrizeAwardRecord } from './awards.js'
import type { CngMemberRecord } from './members.js'

/**
 * The CNG group and its prize history, projected for the wire.
 *
 * PURE: no database, no Sheets, no HTTP. It is handed the rows and projects
 * them, exactly as `server/prizes/eligibility.ts` does for attendee history,
 * so what a CNG screen is allowed to see is a function that can be read and
 * tested rather than inferred from a query.
 *
 * IT PROJECTS FIELD BY FIELD AND NEVER SPREADS. A column added to either
 * table later cannot ride along into a response through here — which is the
 * property that matters most on this path, because `cng_members.name` is the
 * one person field the central database holds and nothing else about a
 * volunteer may join it.
 *
 * THERE IS NO BADGE REGISTER READ ANYWHERE IN THIS FILE. An attendee's name
 * is joined from the Google Sheet; a volunteer's is already in the ledger.
 * That asymmetry is the whole correction Phase CNG1.1 makes.
 */

/** The ACTIVE group, in the order the reader supplies: oldest first. */
export const composeCngMembers = (
  members: readonly CngMemberRecord[],
): CngMember[] =>
  members.map((member) => ({
    id: member.id,
    name: member.name,
    addedAt: member.addedAt,
    addedBy: { id: member.addedBy.id, name: member.addedBy.name },
  }))

/**
 * Every CNG award, newest first, with its recipient's name.
 *
 * A REMOVED MEMBER'S AWARDS ARE INCLUDED. Removal is soft precisely so this
 * stays possible: the prize was given, and history has to say to whom.
 */
export const composeCngPrizeAwards = (
  awards: readonly CngPrizeAwardRecord[],
): CngPrizeAward[] =>
  awards.map((award) => ({
    id: award.id,
    cngMemberId: award.cngMemberId,
    memberName: award.memberName,
    prizeName: award.prizeName,
    awardedAt: award.awardedAt,
    awardedBy: { id: award.awardedBy.id, name: award.awardedBy.name },
  }))
