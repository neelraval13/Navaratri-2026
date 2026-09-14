/**
 * The only currency this application supports. UPI fails closed for anything
 * else rather than generating a QR that pretends another currency works.
 */
export const UPI_CURRENCY = 'INR'

/** Account part of `account@handle`. */
const UPI_ACCOUNT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.\-_]*$/

/** Handle (PSP) part of `account@handle`. */
const UPI_HANDLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9.\-_]*[a-zA-Z0-9]$/

export interface UpiPaymentDetails {
  upiId: string
  payeeName: string
  amount: number
  eventName: string
}

/**
 * Everything needed to render the payment panel: the validated details and the
 * URI the QR encodes.
 */
export interface UpiPayment {
  details: UpiPaymentDetails
  uri: string
}

/**
 * The shape `EventConfig` already satisfies structurally, so this module stays
 * free of any database dependency.
 */
export interface UpiConfigSource {
  upiId?: string
  payeeName?: string
  currency: string
  amount: number
  eventName: string
}

/**
 * A restrained format check, never a verification.
 *
 * This says nothing about whether the UPI ID exists, is reachable, or belongs to
 * anyone in particular. No network call is made and none ever should be: the
 * point is only to catch an obviously malformed value before it is encoded into
 * a QR that a person would scan.
 */
export const isUpiIdValid = (upiId: string): boolean => {
  const trimmed = upiId.trim()

  if (trimmed === '' || /\s/.test(trimmed)) {
    return false
  }

  const parts = trimmed.split('@')

  // Exactly one meaningful separator.
  if (parts.length !== 2) {
    return false
  }

  const [account, handle] = parts

  return UPI_ACCOUNT_PATTERN.test(account) && UPI_HANDLE_PATTERN.test(handle)
}

/**
 * The `am` parameter, with at most two decimal places.
 *
 * Returns null rather than an unusable string for NaN, Infinity, zero, negative
 * amounts, or any magnitude large enough that `toFixed` would fall back to
 * exponent notation.
 */
export const formatUpiAmount = (amount: number): string | null => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  const formatted = amount.toFixed(2)

  if (formatted.includes('e') || formatted.includes('E')) {
    return null
  }

  return formatted
}

/**
 * Builds the `upi://pay` URI the QR encodes.
 *
 * Deliberately contains nothing attendee-specific — no name, phone, age, badge
 * number, registration id or transaction reference — so the SAME QR is valid for
 * every attendee all event long. This application performs no reconciliation, so
 * a per-attendee reference would carry no benefit and would leak personal data
 * into a code that gets shown to strangers.
 *
 * Values are percent-encoded individually rather than through URLSearchParams,
 * which would encode spaces as `+`; some UPI apps display that literally in the
 * transaction note.
 *
 * Returns null when the details cannot produce a valid payment URI.
 */
export const buildUpiPaymentUri = (details: UpiPaymentDetails): string | null => {
  const upiId = details.upiId.trim()
  const payeeName = details.payeeName.trim()
  const eventName = details.eventName.trim()
  const amount = formatUpiAmount(details.amount)

  if (!isUpiIdValid(upiId) || payeeName === '' || amount === null) {
    return null
  }

  const transactionNote =
    eventName === '' ? 'Badge Fee' : `${eventName} Badge Fee`

  const parameters: [string, string][] = [
    ['pa', upiId],
    ['pn', payeeName],
    ['am', amount],
    ['cu', UPI_CURRENCY],
    ['tn', transactionNote],
  ]

  const query = parameters
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')

  return `upi://pay?${query}`
}

/**
 * The validated UPI details from stored configuration, or null when UPI cannot
 * be offered as a payment option.
 */
export const getUpiPaymentDetails = (
  source: UpiConfigSource,
): UpiPaymentDetails | null => {
  // Fail closed rather than generate a QR in a currency UPI is not being used
  // for here.
  if (source.currency !== UPI_CURRENCY) {
    return null
  }

  const upiId = source.upiId?.trim() ?? ''
  const payeeName = source.payeeName?.trim() ?? ''

  if (!isUpiIdValid(upiId) || payeeName === '') {
    return null
  }

  if (formatUpiAmount(source.amount) === null) {
    return null
  }

  return {
    upiId,
    payeeName,
    amount: source.amount,
    eventName: source.eventName,
  }
}

/**
 * Single entry point for the UI: null means UPI is not usable and Cash must be
 * used instead.
 */
export const resolveUpiPayment = (
  source: UpiConfigSource,
): UpiPayment | null => {
  const details = getUpiPaymentDetails(source)

  if (details === null) {
    return null
  }

  const uri = buildUpiPaymentUri(details)

  if (uri === null) {
    return null
  }

  return { details, uri }
}
