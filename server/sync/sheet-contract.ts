import type {
  SyncCompletedPayload,
  SyncGender,
  SyncHeldPayload,
  SyncPaymentMethod,
} from '../../src/shared/sync-contract'

/** The two application-owned tabs. No other tab is ever read or written. */
export const BADGE_REGISTER_TITLE = 'Badge Register'

export const HELD_REGISTRATIONS_TITLE = 'Held Registrations'

/**
 * A1 notation requires a sheet title containing spaces to be single-quoted, and
 * an embedded single quote to be doubled. Both current titles contain a space,
 * so an unquoted range simply fails to resolve.
 */
export const quoteSheetTitle = (title: string): string => {
  return `'${title.replace(/'/g, "''")}'`
}

/**
 * A..J are the operator-facing ledger; K..L are technical and hidden.
 * Technical columns deliberately sit AFTER the human columns.
 */
export const BADGE_REGISTER_HEADERS = [
  'Badge',
  'Name',
  'Phone',
  'WhatsApp Link',
  'Age',
  'Gender',
  'Payment',
  'Amount',
  'Date',
  'Time',
  'Registration ID',
  'Updated At',
] as const

/** A..I visible, J..K technical and hidden. */
export const HELD_REGISTRATIONS_HEADERS = [
  'Name',
  'Phone',
  'WhatsApp Link',
  'Age',
  'Gender',
  'Payment',
  'Amount',
  'Held Date',
  'Held Time',
  'Registration ID',
  'Updated At',
] as const

export const BADGE_REGISTER_COLUMNS = {
  badge: 0,
  phone: 2,
  registrationId: 10,
  updatedAt: 11,
  count: BADGE_REGISTER_HEADERS.length,
} as const

export const HELD_REGISTRATIONS_COLUMNS = {
  phone: 1,
  registrationId: 9,
  updatedAt: 10,
  count: HELD_REGISTRATIONS_HEADERS.length,
} as const

export const BADGE_REGISTER_RANGE = `${quoteSheetTitle(BADGE_REGISTER_TITLE)}!A1:L`

export const HELD_REGISTRATIONS_RANGE = `${quoteSheetTitle(HELD_REGISTRATIONS_TITLE)}!A1:K`

/** The event runs on India time regardless of where the server happens to be. */
const EVENT_TIME_ZONE = 'Asia/Kolkata'

/** DD/MM/YYYY */
const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: EVENT_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** hh:mm:ss AM/PM */
const TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: EVENT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
})

const GENDER_LABELS: Record<SyncGender, string> = {
  male: 'Male',
  female: 'Female',
}

const PAYMENT_LABELS: Record<SyncPaymentMethod, string> = {
  upi: 'UPI',
  cash: 'Cash',
}

const PHONE_PATTERN = /^\d{10}$/

export const formatEventDate = (isoTimestamp: string): string => {
  return DATE_FORMATTER.format(new Date(isoTimestamp))
}

/**
 * Some ICU builds separate the meridiem with a narrow no-break space; normalise
 * it so the Sheet always receives the same characters.
 */
export const formatEventTime = (isoTimestamp: string): string => {
  return TIME_FORMATTER.format(new Date(isoTimestamp)).replace(
    /[\u202f\u00a0]/g,
    ' ',
  )
}

/**
 * How a cell must be written.
 *
 * The discriminant exists so a value can never become a formula by accident:
 * every builder below states the kind explicitly, and only `buildWhatsAppCell`
 * is able to produce `formula`.
 */
export type SheetCell =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'formula'; value: string }

export const stringCell = (value: string): SheetCell => {
  return { kind: 'string', value }
}

export const numberCell = (value: number): SheetCell => {
  return { kind: 'number', value }
}

export const buildWhatsAppFormula = (phone: string): string => {
  return `=HYPERLINK("https://wa.me/91${phone}","WhatsApp")`
}

/**
 * The ONLY formula this server ever writes.
 *
 * It is built from a phone number that the request validator already restricted
 * to exactly ten digits plus a constant label, so nothing attacker-controlled
 * can reach the formula grammar. The digit check is repeated here rather than
 * assumed: if it ever failed, the value degrades to a literal string instead of
 * becoming an executable formula.
 */
export const buildWhatsAppCell = (phone: string): SheetCell => {
  if (!PHONE_PATTERN.test(phone)) {
    return stringCell(phone)
  }

  return { kind: 'formula', value: buildWhatsAppFormula(phone) }
}

/**
 * Badge is written as a NUMBER; the `"#"000` display format shown in the Sheet
 * is presentation only, so sorting and comparison stay numeric.
 *
 * `name` and `id` are written as literal strings. A name such as
 * `=HYPERLINK("https://evil.example","x")` is a legitimate string in the
 * payload and must be stored verbatim, never parsed, never sanitised.
 */
export const buildBadgeRegisterRow = (
  payload: SyncCompletedPayload,
): SheetCell[] => {
  return [
    numberCell(payload.badgeNumber),
    stringCell(payload.name),
    stringCell(payload.phone),
    buildWhatsAppCell(payload.phone),
    numberCell(payload.age),
    stringCell(GENDER_LABELS[payload.gender]),
    stringCell(PAYMENT_LABELS[payload.paymentMethod]),
    numberCell(payload.amount),
    stringCell(formatEventDate(payload.completedAt)),
    stringCell(formatEventTime(payload.completedAt)),
    stringCell(payload.id),
    stringCell(payload.updatedAt),
  ]
}

export const buildHeldRegistrationRow = (
  payload: SyncHeldPayload,
): SheetCell[] => {
  return [
    stringCell(payload.name),
    stringCell(payload.phone),
    buildWhatsAppCell(payload.phone),
    numberCell(payload.age),
    stringCell(GENDER_LABELS[payload.gender]),
    // Blank when the hold happened before a payment method was chosen.
    stringCell(
      payload.paymentMethod === undefined
        ? ''
        : PAYMENT_LABELS[payload.paymentMethod],
    ),
    numberCell(payload.amount),
    stringCell(formatEventDate(payload.heldAt)),
    stringCell(formatEventTime(payload.heldAt)),
    stringCell(payload.id),
    stringCell(payload.updatedAt),
  ]
}

/** A cleared held row: the same width, entirely blank literal strings. */
export const buildBlankRow = (width: number): SheetCell[] => {
  return Array.from({ length: width }, () => stringCell(''))
}

export const buildHeaderRow = (headers: readonly string[]): SheetCell[] => {
  return headers.map((header) => stringCell(header))
}

const isBlankCell = (cell: unknown): boolean => {
  return cell === null || cell === undefined || String(cell).trim() === ''
}

/**
 * True only when EVERY cell in the application-owned range is blank.
 */
export const isRangeBlank = (
  values: readonly (readonly unknown[])[] | undefined,
): boolean => {
  return (values ?? []).every((row) => (row ?? []).every(isBlankCell))
}

export type TabShape = 'empty' | 'matching' | 'conflicting'

/**
 * Decides whether a tab is safe to use, looking at the WHOLE range rather than
 * only row 1.
 *
 * A blank header over human data below it is the dangerous case: initialising
 * that tab would stamp a header onto somebody's spreadsheet and then append
 * beneath their records. Only a wholly blank range may be initialised.
 */
export const checkTabShape = (
  values: readonly (readonly unknown[])[] | undefined,
  expected: readonly string[],
): TabShape => {
  const rows = values ?? []
  const header = (rows[0] ?? []).map((cell) => String(cell ?? '').trim())

  if (header.every((cell) => cell === '')) {
    return isRangeBlank(rows) ? 'empty' : 'conflicting'
  }

  const matches = expected.every((value, index) => header[index] === value)

  return matches ? 'matching' : 'conflicting'
}
