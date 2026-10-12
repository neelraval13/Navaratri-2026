/**
 * THE EVENT'S ONE PHONE RULE, framework-free and shared.
 *
 * This application has stored a phone number the same way since Phase 1:
 * EXACTLY TEN DIGITS, no `+91`, no spacing. Registration enters it that way,
 * the sync contract validates it that way, and the Sheet writes it that way
 * with the country code added only inside the WhatsApp link.
 *
 * It lives here because THREE places now need it and two of them are not
 * browser code: registration's own validator, and — since Phase D3.3 — the
 * dandiya contact number, which the browser form and the server must agree
 * about exactly. A second normaliser would be a second opinion about which
 * ten digits somebody typed.
 *
 * `server/sync/sync-registration.ts` and `server/sync/sheet-contract.ts` keep
 * their own `^\d{10}$` checks. Those validate an ALREADY-CANONICAL wire value
 * on a Production-live path and are deliberately left alone; this module is
 * the parser for what a human types.
 *
 * IT STORES NOTHING AND KNOWS NOBODY. These are string rules.
 */

/** The `+91` prefix is a visual element, never part of the stored value. */
export const PHONE_DIGITS = 10

const CANONICAL_PATTERN = /^\d{10}$/

/** Is this already the stored form — exactly ten digits? */
export const isCanonicalPhone = (value: unknown): value is string =>
  typeof value === 'string' && CANONICAL_PATTERN.test(value)

/**
 * Just the digits. `+91 98765 43210`, `098765-43210` and `9876543210` all
 * reduce to a comparable string.
 */
export const phoneDigits = (value: string): string => value.replace(/\D/g, '')

/**
 * WHAT A HUMAN TYPED, AS THE TEN DIGITS WE STORE.
 *
 * Operator-friendly in, canonical out. Spaces, dashes, brackets and dots are
 * ignored, and the three ways an Indian number is commonly prefixed are
 * accepted and dropped:
 *
 *   `+91 98765 43210`  ->  `9876543210`
 *   `919876543210`     ->  `9876543210`
 *   `09876543210`      ->  `9876543210`
 *   `98765 43210`      ->  `9876543210`
 *
 * A number that is not ten digits after that is REFUSED rather than padded,
 * truncated or guessed at. The message is the one registration already shows,
 * so an operator meets the same sentence wherever they type a number.
 */
export const parsePhoneNumber = (
  value: unknown,
):
  | { ok: true; value: string }
  | { ok: false; message: string } => {
  const refused = { ok: false, message: 'Enter a 10-digit phone number.' } as const

  if (typeof value !== 'string') {
    return refused
  }

  let digits = phoneDigits(value)

  /**
   * ONE prefix, and only when what remains is a whole number. Stripping
   * eagerly would turn a mistyped eleven-digit number into a plausible ten,
   * which is worse than refusing it.
   */
  if (digits.length === PHONE_DIGITS + 2 && digits.startsWith('91')) {
    digits = digits.slice(2)
  } else if (digits.length === PHONE_DIGITS + 1 && digits.startsWith('0')) {
    digits = digits.slice(1)
  }

  return CANONICAL_PATTERN.test(digits) ? { ok: true, value: digits } : refused
}

/**
 * THE DIGITS TO SHOW in a field that already displays a `+91` prefix.
 *
 * A fixed `+91` beside an input that also accepts `+91 98765 43210` renders
 * `+91  +91 98765 43210`, which is both wrong and alarming to read back to
 * somebody. This normalises what the field DISPLAYS, and nothing else.
 *
 * IT IS NOT A SECOND PARSER. It is defined in terms of the one above: a value
 * that parses is shown as the ten digits it means, and anything else is shown
 * as the digits typed so far — so a half-typed number stays visible and keeps
 * its own error message instead of being silently repaired.
 *
 * THE SERVER IS UNAFFECTED and still accepts every operator-friendly form:
 * this only decides what sits beside the prefix on screen.
 */
export const localPhoneDigits = (value: string): string => {
  const parsed = parsePhoneNumber(value)

  return parsed.ok ? parsed.value : phoneDigits(value)
}

/**
 * The digits to COMPARE a search box against, or `null` when there is nothing
 * phone-shaped in it.
 *
 * A volunteer may type the number with or without a country code, so a query
 * of ten or more digits is compared on its LAST ten — `+919876543210` and
 * `9876543210` both find the same loan. Shorter runs are treated as a partial
 * number and matched as a substring, which is how somebody searches by the
 * last four digits they can remember.
 */
export const phoneSearchDigits = (query: string): string | null => {
  const digits = phoneDigits(query)

  if (digits === '') {
    return null
  }

  return digits.length >= PHONE_DIGITS ? digits.slice(-PHONE_DIGITS) : digits
}
