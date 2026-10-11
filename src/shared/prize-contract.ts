/**
 * The PRIZE wire contract, shared by the browser and the server.
 *
 * Framework-free and dependency-free, for the same reason the device
 * attribute allow-list and the sync contract are: the screen that renders a
 * refusal and the endpoint that produces one must agree about every name, or
 * an ordinary operational conflict arrives as "unexpected response" and a
 * desk stops for no reason.
 *
 * IT CARRIES NO ATTENDEE DATA OF ITS OWN. The attendee fields below describe
 * what the PRIZE SCREEN is allowed to see — badge number, name, age and
 * gender — and they are read from the Google Sheet on every request. They are
 * never persisted centrally: `prize_awards` stores the operational ledger
 * (which badge, which prize, which device, when) and nothing about a person.
 *
 * Phone number and the WhatsApp link are deliberately ABSENT. The prize desk
 * identifies an attendee by the badge in their hand and the name on it; a
 * contact number would be a new copy of personal data in a new place for no
 * operational gain.
 */

/** The gender values registration already stores. No third spelling. */
export type PrizeGender = 'male' | 'female'

/**
 * Exactly what the prize screen may know about an attendee.
 *
 * Projected field by field from the Badge Register, never spread, so a column
 * appended to the Sheet later cannot ride along into a prize response.
 */
export interface PrizeAttendee {
  badgeNumber: number
  name: string
  age: number
  gender: PrizeGender
}

/** Who handed the prize over. A device, never a person. */
export interface PrizeAwardDevice {
  id: string
  name: string
}

/**
 * One row of permanent prize history.
 *
 * `attendee` is JOINED from the CURRENT Sheet and may be `null`: history must
 * survive a row that has been edited away, because the prize was still given.
 * The ledger's own facts — badge, prize, time, device — never depend on it.
 *
 * SEVERAL ROWS MAY SHARE A BADGE NUMBER since Phase P1.1, including rows with
 * the same `prizeName`. `id` is what identifies an award, never the badge.
 */
export interface PrizeAward {
  id: string
  badgeNumber: number
  prizeName: string
  /** ISO 8601 UTC, written by the server. Never accepted from a caller. */
  awardedAt: string
  awardedBy: PrizeAwardDevice
  attendee: PrizeAttendee | null
}

export interface PrizeRosterResponse {
  /**
   * EVERY registered attendee in the Badge Register, badge-ascending.
   *
   * Not "eligible": since Phase P1.1 nothing removes an attendee from this
   * list, because a previous prize no longer disqualifies anybody. The one
   * thing an entry here proves is that the badge is registered.
   */
  attendees: PrizeAttendee[]
  /** Every award record, newest first. Repeated badge numbers are normal. */
  awards: PrizeAward[]
}

/* -------------------------------------------------------- the prize catalog */

/**
 * THE FIXED PRIZE CATALOG — Phase P1.1.
 *
 * P1 took free text, because nobody had agreed a list and inventing one would
 * have been a guess. The event has now agreed one, so free text is GONE: a
 * typo at one desk and a different spelling at another produced two prizes
 * where the organiser meant one, and nothing downstream could tell.
 *
 * It is an ALLOW-LIST in shared code, not a catalog table. Eight values that
 * change once a year do not need a migration, an Admin screen and a join;
 * they need to be the same eight values in the browser and on the server,
 * which is what living here guarantees.
 *
 * The CANONICAL LABEL is the wire value and the stored value, so the ledger
 * reads correctly with no lookup — history has to survive this list changing.
 * The `code` is for keys, grouping and tests only, and is never stored.
 */
export type PrizeCategory = 'best-dance' | 'best-dress'

/**
 * The demographic division a prize is awarded in.
 *
 * `boy`/`girl` are the under-18 divisions and `male`/`female` the adult ones.
 * They are DIVISIONS OF A PRIZE, never a record of the attendee: no division
 * is stored against a person, and nothing infers one from the ledger.
 */
export type PrizeDivision = 'boy' | 'girl' | 'male' | 'female'

export interface PrizeCatalogEntry {
  code: string
  category: PrizeCategory
  division: PrizeDivision
  /** What the API accepts, what Postgres stores, what a human reads. */
  label: string
}

/**
 * Written out in full rather than built from a cross product.
 *
 * These eight strings are a wire contract and a stored value. Generating them
 * would hide the exact bytes behind a template and make a future change to
 * the join — a different dash, say — invisible at review.
 */
export const PRIZE_CATALOG: readonly PrizeCatalogEntry[] = [
  { code: 'best-dance-boy', category: 'best-dance', division: 'boy', label: 'Best Dance - Boy' },
  { code: 'best-dance-girl', category: 'best-dance', division: 'girl', label: 'Best Dance - Girl' },
  { code: 'best-dance-male', category: 'best-dance', division: 'male', label: 'Best Dance - Male' },
  { code: 'best-dance-female', category: 'best-dance', division: 'female', label: 'Best Dance - Female' },
  { code: 'best-dress-boy', category: 'best-dress', division: 'boy', label: 'Best Dress - Boy' },
  { code: 'best-dress-girl', category: 'best-dress', division: 'girl', label: 'Best Dress - Girl' },
  { code: 'best-dress-male', category: 'best-dress', division: 'male', label: 'Best Dress - Male' },
  { code: 'best-dress-female', category: 'best-dress', division: 'female', label: 'Best Dress - Female' },
]

/** The two groups the chooser renders, in order. */
export const PRIZE_CATEGORIES: readonly PrizeCategory[] = ['best-dance', 'best-dress']

export const PRIZE_CATEGORY_LABELS: Record<PrizeCategory, string> = {
  'best-dance': 'Best Dance',
  'best-dress': 'Best Dress',
}

export const PRIZE_DIVISION_LABELS: Record<PrizeDivision, string> = {
  boy: 'Boy',
  girl: 'Girl',
  male: 'Male',
  female: 'Female',
}

/** Exactly the eight values a NEW award may carry. */
export const PRIZE_NAMES: readonly string[] = PRIZE_CATALOG.map((entry) => entry.label)

/**
 * The database's own ceiling on a prize name, unchanged from P1.
 *
 * Every catalog label is far inside it. It still matters because the LEDGER
 * is older than the catalog: a P1 row may hold any free-text name up to this
 * length, and history has to keep displaying it.
 */
export const PRIZE_NAME_MAX_LENGTH = 80

export type PrizeNameResult =
  | { ok: true; value: string }
  | { ok: false; message: string }

/**
 * Validates a prize name for a NEW award: one of the eight, exactly.
 *
 * Surrounding whitespace is trimmed, because that is a transport artifact
 * rather than a different prize. Nothing else is repaired — no case folding,
 * no fuzzy match, no nearest-neighbour — so an arbitrary string is REFUSED
 * rather than corrected into whichever prize it resembled.
 *
 * This is deliberately NOT applied to history. A P1 row saying `Best Dressed`
 * is a prize that was really given, and hiding it because the catalog changed
 * afterwards would lose the one record of it. Only new awards are restricted.
 */
export const parsePrizeName = (value: unknown): PrizeNameResult => {
  if (typeof value !== 'string') {
    return { ok: false, message: 'Choose one of the eight prize types.' }
  }

  const trimmed = value.trim()

  if (!PRIZE_NAMES.includes(trimmed)) {
    return { ok: false, message: 'Choose one of the eight prize types.' }
  }

  return { ok: true, value: trimmed }
}

/* ------------------------------------------------ the demographic suggestion */

/** The age at which the adult divisions begin. */
export const PRIZE_ADULT_AGE = 18

/**
 * The division an attendee's age and gender SUGGEST.
 *
 *   under 18 + male   -> Boy        18 and over + male   -> Male
 *   under 18 + female -> Girl       18 and over + female -> Female
 *
 * A RECOMMENDATION AND NOTHING ELSE. It highlights one of the eight buttons
 * so a volunteer taps the usual one without reading all eight; the other
 * seven stay fully selectable, nothing is auto-submitted, and no award is
 * refused for disagreeing with it. The organiser at the table knows things
 * the Badge Register does not.
 *
 * It lives here because the divisions and the age threshold do, and a second
 * copy of "when does Boy become Male" is a second thing that can drift. The
 * SERVER never calls it: a suggestion is not authorization, and `release:check`
 * fails if anything under `api/` or `server/` reaches for it.
 */
export const suggestedPrizeDivision = (attendee: {
  age: number
  gender: PrizeGender
}): PrizeDivision => {
  if (attendee.age < PRIZE_ADULT_AGE) {
    return attendee.gender === 'male' ? 'boy' : 'girl'
  }

  return attendee.gender === 'male' ? 'male' : 'female'
}
