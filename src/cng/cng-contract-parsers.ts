import type { CngMember, CngPrizeAward } from '@/shared/cng-contract'

/**
 * Runtime validation of the CNG responses.
 *
 * A TypeScript annotation on a `fetch` result is a claim, not a check. These
 * lists decide who the event believes its volunteers are and what they have
 * been given, so every field is verified and an unrecognised shape FAILS
 * CLOSED rather than becoming a card on screen.
 *
 * NO ATTENDEE PARSER IS INVOLVED, and that is the Phase CNG1.1 correction. A
 * CNG member is not an attendee: there is no badge, no age and no gender to
 * validate, and nothing here reaches for `parseEventAttendee`. A response
 * that offered those fields would simply have them ignored — and the server
 * refuses them on the way in.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value)

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** One ACTIVE membership. */
export const parseCngMember = (value: unknown): CngMember | null => {
  if (!isRecord(value) || !isRecord(value.addedBy)) {
    return null
  }

  if (
    !isUuid(value.id) ||
    !isNonEmpty(value.name) ||
    !isNonEmpty(value.addedAt) ||
    !isUuid(value.addedBy.id) ||
    !isNonEmpty(value.addedBy.name)
  ) {
    return null
  }

  return {
    id: value.id,
    name: value.name,
    addedAt: value.addedAt,
    addedBy: { id: value.addedBy.id, name: value.addedBy.name },
  }
}

/** One CNG prize. `memberName` is joined and always present. */
export const parseCngPrizeAward = (value: unknown): CngPrizeAward | null => {
  if (!isRecord(value) || !isRecord(value.awardedBy)) {
    return null
  }

  if (
    !isUuid(value.id) ||
    !isUuid(value.cngMemberId) ||
    !isNonEmpty(value.memberName) ||
    !isNonEmpty(value.prizeName) ||
    !isNonEmpty(value.awardedAt) ||
    !isUuid(value.awardedBy.id) ||
    !isNonEmpty(value.awardedBy.name)
  ) {
    return null
  }

  return {
    id: value.id,
    cngMemberId: value.cngMemberId,
    memberName: value.memberName,
    prizeName: value.prizeName,
    awardedAt: value.awardedAt,
    awardedBy: { id: value.awardedBy.id, name: value.awardedBy.name },
  }
}

/**
 * A whole list, or `null`.
 *
 * ONE bad entry rejects the WHOLE list rather than being dropped. A desk
 * working from a silently shortened group would add a volunteer who is
 * already there, or fail to see one who needs removing — and a shortened
 * award history would under-report what the event has given out. Both are
 * worse than an honest error.
 *
 * Accumulated rather than mapped-and-cast: a cast would assert the result of
 * the check instead of using it, which is the mistake this file exists to
 * avoid.
 */
const parseList = <T>(
  value: unknown,
  parse: (entry: unknown) => T | null,
): T[] | null => {
  if (!Array.isArray(value)) {
    return null
  }

  const parsed: T[] = []

  for (const entry of value) {
    const one = parse(entry)

    if (one === null) {
      return null
    }

    parsed.push(one)
  }

  return parsed
}

export const parseCngMemberList = (value: unknown): CngMember[] | null =>
  parseList(value, parseCngMember)

export const parseCngPrizeAwardList = (
  value: unknown,
): CngPrizeAward[] | null => parseList(value, parseCngPrizeAward)
