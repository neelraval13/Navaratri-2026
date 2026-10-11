/**
 * THE ATTENDEE SHAPE, shared by every module that may see one.
 *
 * Framework-free and dependency-free, like the sync contract and the device
 * attribute allow-list: the screen that renders an attendee and the endpoint
 * that projects one must agree about every field, or a module quietly starts
 * showing something the privacy boundary does not allow it to show.
 *
 * TWO MODULES READ ATTENDEES, and since Phase A1 there are two:
 *
 *   /prizes      awards a prize to the badge in somebody's hand
 *   /attendees   a read-only directory
 *
 * They must see the SAME four fields and no more, so the shape, the gender
 * normalisation, the age bound and the runtime parser all live here once.
 * A second copy of "what may a module know about an attendee?" is how one of
 * them eventually knows more.
 *
 * IT CARRIES NO ATTENDEE DATA OF ITS OWN. These fields describe what a module
 * may be TOLD, and they are read from the Google Sheet on every request.
 * Nothing here is persisted: Postgres holds no attendee PII, and neither
 * module writes one to IndexedDB.
 *
 * PHONE NUMBER AND THE WHATSAPP LINK ARE DELIBERATELY ABSENT, and not merely
 * unused — the Badge Register reader never reads those columns. A prize desk
 * identifies an attendee by the badge in their hand, and a directory is a
 * directory of who is here, not a contact list.
 */

/** The gender values registration already stores. No third spelling. */
export type AttendeeGender = 'male' | 'female'

/**
 * Exactly what an attendee-reading module may know.
 *
 * Projected field by field from the Badge Register, never spread, so a column
 * appended to the Sheet later cannot ride along into a response.
 */
export interface EventAttendee {
  badgeNumber: number
  name: string
  age: number
  gender: AttendeeGender
}

/** The same bound registration enforces on entry. */
export const ATTENDEE_MAX_AGE = 120

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isAge = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= ATTENDEE_MAX_AGE

/** Exactly the two values registration stores. No third spelling arrives. */
export const parseAttendeeGender = (value: unknown): AttendeeGender | null => {
  if (value === 'male' || value === 'female') {
    return value
  }

  return null
}

/**
 * One attendee, validated at RUNTIME.
 *
 * A TypeScript annotation on a `fetch` result is a claim, not a check. These
 * screens decide which badge a volunteer hands a prize to and who the event
 * believes is present, so every field is verified and an unrecognised shape
 * FAILS CLOSED rather than becoming a card.
 *
 * Projected field by field, never spread. If a server ever started returning
 * an attendee's phone number — the one thing this contract excludes — it
 * would not reach local state by accident.
 */
export const parseEventAttendee = (value: unknown): EventAttendee | null => {
  if (!isRecord(value)) {
    return null
  }

  const gender = parseAttendeeGender(value.gender)

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
 * A whole list of attendees, or `null`.
 *
 * ONE bad entry rejects the WHOLE list rather than being dropped. A desk
 * working from a silently shortened roster would conclude an attendee is not
 * registered, and that is worse than an honest error.
 *
 * Accumulated rather than mapped-and-cast: a cast would assert the result of
 * the check instead of using it, which is the mistake this module exists to
 * avoid.
 */
export const parseAttendeeList = (value: unknown): EventAttendee[] | null => {
  if (!Array.isArray(value)) {
    return null
  }

  const attendees: EventAttendee[] = []

  for (const entry of value) {
    const attendee = parseEventAttendee(entry)

    if (attendee === null) {
      return null
    }

    attendees.push(attendee)
  }

  return attendees
}

/**
 * `GET /api/attendees` — the read-only directory, and nothing else.
 *
 * There is no `awards`, no prize state and no count: a count is
 * `attendees.length`, and a second field carrying it is a second thing that
 * can disagree with the list.
 */
export interface AttendeeDirectoryResponse {
  attendees: EventAttendee[]
}
