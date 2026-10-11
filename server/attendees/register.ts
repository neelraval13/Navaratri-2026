import {
  ATTENDEE_MAX_AGE,
  type AttendeeGender,
  type EventAttendee,
} from '../../src/shared/attendee-contract.js'
import type { SyncEnvironment } from '../sync/environment.js'
import { createSheetsAccess } from '../sync/google-sheets.js'
import {
  BADGE_REGISTER_COLUMNS,
  BADGE_REGISTER_HEADERS,
  BADGE_REGISTER_HEADERS_V1,
  BADGE_REGISTER_RANGE,
  BADGE_REGISTER_TITLE,
  checkTabShape,
} from '../sync/sheet-contract.js'

/**
 * THE ATTENDEE REGISTER — the attendees this event has actually registered.
 *
 * THE ONE READER, for every module that needs them. Phase P1 wrote it for the
 * prize desk; Phase A1 added the read-only directory at `/attendees` and
 * moved it here rather than writing a second one. A second Badge Register
 * parser is a second opinion about which columns exist, how an age is read,
 * how gender is normalised and which rows are usable — and the two would
 * drift the first time somebody hand-edited a cell.
 *
 * It comes from the SAME Badge Register that production registrations already
 * sync into, because that is where attendee data lives. There is deliberately
 * no central attendee table to read instead: Postgres holds no PII, and
 * adding a shadow copy for the convenience of a screen is how two sources of
 * truth start disagreeing.
 *
 * STRICTLY READ-ONLY. This module performs no `batchUpdate`, creates no tab,
 * writes no header and repairs no layout. A missing or unrecognised tab is
 * refused, never initialised — initialising a Sheet is the sync endpoint's
 * job, gated by the release interlock, and an event desk is not the place to
 * discover that the ledger has the wrong shape.
 *
 * IT PROJECTS FOUR FIELDS. Badge number, name, age and gender reach the
 * caller; the phone number and the WhatsApp link are read into no variable
 * and leave in no response. The row is never spread, so a column appended to
 * the Sheet later cannot ride along either.
 */

export type AttendeeRegisterResult =
  | { ok: true; attendees: EventAttendee[] }
  /**
   * The register could not be established. Every caller must FAIL CLOSED. An
   * EMPTY register and an UNREADABLE one are different facts: the first means
   * nobody has registered yet, the second means this module cannot say, and
   * presenting the second as the first would show a volunteer an empty event
   * and let a prize be recorded against a badge nobody could confirm.
   */
  | { ok: false; reason: 'unreadable' | 'sheet-shape-conflict' }

const readText = (row: readonly unknown[], index: number): string => {
  const value = row[index]

  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The Sheet stores `Badge` as a NUMBER, but a human may have retyped a cell
 * as text, so a numeric string is accepted. Anything else is not a badge.
 */
const readBadgeNumber = (row: readonly unknown[]): number | null => {
  const value = row[BADGE_REGISTER_COLUMNS.badge]

  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())

    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }

  return null
}

const readAge = (row: readonly unknown[]): number | null => {
  const value = row[BADGE_REGISTER_COLUMNS.age]
  const parsed = typeof value === 'number' ? value : Number(readText(row, BADGE_REGISTER_COLUMNS.age))

  return Number.isInteger(parsed) && parsed >= 0 && parsed <= ATTENDEE_MAX_AGE
    ? parsed
    : null
}

/**
 * Back to the value registration already stores.
 *
 * The Sheet carries the display labels `Male` and `Female`; the application's
 * own normalised values are `male` and `female`, and every attendee filter
 * uses those, so there is never a third spelling of gender in the codebase.
 */
const readGender = (row: readonly unknown[]): AttendeeGender | null => {
  const label = readText(row, BADGE_REGISTER_COLUMNS.gender).toLowerCase()

  if (label === 'male') {
    return 'male'
  }

  return label === 'female' ? 'female' : null
}

/**
 * One Badge Register row as an attendee, or `null`.
 *
 * A row with no Registration ID is blank or cleared and carries no identity.
 * A row missing a usable badge, name, age or gender is SKIPPED rather than
 * failing the whole read: this is a human-maintained spreadsheet, and one
 * hand-edited cell must not close the prize desk. The skip is visible — that
 * badge simply will not appear as eligible — and the count is logged.
 */
const toAttendee = (row: readonly unknown[]): EventAttendee | null => {
  if (readText(row, BADGE_REGISTER_COLUMNS.registrationId) === '') {
    return null
  }

  const badgeNumber = readBadgeNumber(row)
  const name = readText(row, BADGE_REGISTER_COLUMNS.name)
  const age = readAge(row)
  const gender = readGender(row)

  if (badgeNumber === null || name === '' || age === null || gender === null) {
    return null
  }

  return { badgeNumber, name, age, gender }
}

/**
 * Reads the Badge Register and projects the four attendee-visible fields.
 *
 * Sorted by badge number ascending, which is the response contract and the
 * order an operator scans a stack of badges in.
 *
 * Every failure is reported as a REASON, never as an empty roster. An empty
 * roster means "nobody is registered yet"; an unreadable Sheet means "do not
 * award anything", and conflating the two would let a prize be recorded
 * against a badge nobody could confirm exists.
 */
export const readAttendeeRegister = async (
  environment: SyncEnvironment,
): Promise<AttendeeRegisterResult> => {
  const sheets = createSheetsAccess(environment)

  let values: unknown[][]

  try {
    const response = await sheets.client.spreadsheets.values.get({
      // Per request, never through process-global `google.options`.
      auth: sheets.auth,
      spreadsheetId: environment.spreadsheetId,
      range: BADGE_REGISTER_RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
    })

    values = (response.data.values ?? []) as unknown[][]
  } catch {
    /**
     * The message is deliberately not inspected or logged: a Google API error
     * can quote the request, and the request names the spreadsheet. The
     * operation is enough to act on.
     */
    console.error('Navaratri attendees: the Badge Register could not be read.')

    return { ok: false, reason: 'unreadable' }
  }

  const shape = checkTabShape(
    values,
    BADGE_REGISTER_HEADERS,
    BADGE_REGISTER_HEADERS_V1,
  )

  /**
   * `empty` is refused too, and that is not pedantry: a blank range means the
   * tab has never been initialised, which is indistinguishable here from the
   * Sheet having been replaced. Initialising it is the sync endpoint's
   * deliberate, interlocked act, and reading a register that does not exist
   * yet must not look like an event with no attendees.
   */
  if (shape !== 'matching' && shape !== 'legacy') {
    console.error(
      `Navaratri attendees: "${BADGE_REGISTER_TITLE}" does not have the expected layout (${shape}).`,
    )

    return { ok: false, reason: 'sheet-shape-conflict' }
  }

  const seen = new Set<number>()
  const attendees: EventAttendee[] = []
  let skipped = 0

  for (const row of values.slice(1)) {
    const attendee = toAttendee(row ?? [])

    if (attendee === null) {
      // A wholly blank row is normal padding and is not a skip worth counting.
      if ((row ?? []).some((cell) => String(cell ?? '').trim() !== '')) {
        skipped += 1
      }

      continue
    }

    /**
     * One badge, one attendee. A duplicate badge number is a registration-side
     * ledger problem that this screen cannot fix and must not compound, so the
     * first row wins and the count is logged. No name or number is logged.
     */
    if (seen.has(attendee.badgeNumber)) {
      skipped += 1

      continue
    }

    seen.add(attendee.badgeNumber)
    attendees.push(attendee)
  }

  if (skipped > 0) {
    console.error(
      `Navaratri attendees: ${String(skipped)} Badge Register row(s) were not usable and were skipped.`,
    )
  }

  attendees.sort((left, right) => left.badgeNumber - right.badgeNumber)

  return { ok: true, attendees }
}
