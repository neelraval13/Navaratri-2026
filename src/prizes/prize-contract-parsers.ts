import type {
  PrizeAttendee,
  PrizeAward,
  PrizeGender,
  PrizeRosterResponse,
} from '@/shared/prize-contract'

/**
 * Runtime validation of the prize responses.
 *
 * A TypeScript annotation on a `fetch` result is a claim, not a check. This
 * screen decides which badge a volunteer hands a prize to, so every field is
 * verified and an unrecognised shape FAILS CLOSED rather than becoming a card
 * on screen.
 *
 * Projected FIELD BY FIELD, never spread. If the server ever starts returning
 * an attendee's phone number — the one thing this contract deliberately
 * excludes — it would not reach local state by accident.
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

const isAge = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 120

/** Exactly the two values registration stores. No third spelling arrives. */
const parseGender = (value: unknown): PrizeGender | null => {
  if (value === 'male' || value === 'female') {
    return value
  }

  return null
}

export const parsePrizeAttendee = (value: unknown): PrizeAttendee | null => {
  if (!isRecord(value)) {
    return null
  }

  const gender = parseGender(value.gender)

  if (
    !isPositiveInteger(value.badgeNumber) ||
    !isNonEmpty(value.name) ||
    !isAge(value.age) ||
    gender === null
  ) {
    return null
  }

  return {
    badgeNumber: value.badgeNumber,
    name: value.name,
    age: value.age,
    gender,
  }
}

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
 */
export const parsePrizeRosterResponse = (
  body: unknown,
): PrizeRosterResponse | null => {
  if (!isRecord(body) || !Array.isArray(body.attendees) || !Array.isArray(body.awards)) {
    return null
  }

  const attendees: PrizeAttendee[] = []
  const awards: PrizeAward[] = []

  // Accumulated rather than mapped-and-cast: a cast would assert the result
  // of the check instead of using it, which is the mistake this file exists
  // to avoid.
  for (const entry of body.attendees) {
    const attendee = parsePrizeAttendee(entry)

    if (attendee === null) {
      return null
    }

    attendees.push(attendee)
  }

  for (const entry of body.awards) {
    const award = parsePrizeAward(entry)

    if (award === null) {
      return null
    }

    awards.push(award)
  }

  return { attendees, awards }
}
