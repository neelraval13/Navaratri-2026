import { parsePrizeName } from '../../src/shared/prize-contract.js'

/**
 * The shape of a prize award request.
 *
 * Its own validator rather than a reuse of the device or Admin ones: those
 * answer different questions. The one thing it does NOT own is the prize-name
 * policy, which lives in `src/shared/prize-contract.ts` and is read by the
 * browser chooser too, so what the volunteer can tap and what the server will
 * accept cannot drift.
 *
 * SINCE PHASE P1.1 that policy is an ALLOW-LIST of eight canonical labels
 * rather than free text, so an arbitrary prize string is refused here — not
 * corrected into whichever catalog entry it resembled.
 */

export interface PrizeAwardInput {
  badgeNumber: number
  /** One of the eight canonical catalog labels, exactly. */
  prizeName: string
}

export type PrizeAwardInputResult =
  | { ok: true; value: PrizeAwardInput }
  | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Fields an award must never carry.
 *
 * The authenticated session decides which device and event an award belongs
 * to, and the DATABASE decides when it happened. Accepting any of these —
 * even to ignore them — would invite a caller to believe it can choose, and
 * would leave a field a later refactor might start reading.
 *
 * The attendee fields are refused for a second reason: they are not this
 * endpoint's to accept. A name, age or gender submitted by a client is a
 * claim about a person that the Badge Register already answers, and writing
 * one into Postgres is exactly the privacy boundary this phase preserves.
 */
export const FORBIDDEN_AWARD_FIELDS = [
  'eventId',
  'eventSlug',
  'deviceId',
  'loginName',
  'awardedAt',
  'awardedBy',
  'attendee',
  'name',
  'age',
  'gender',
] as const

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/**
 * Validates an award request's SHAPE.
 *
 * Whether the badge actually exists in the Badge Register is a separate
 * question the endpoint asks the Sheet. Whether the attendee already has a
 * prize is nobody's question any more — repeat awards are legal — so this
 * only establishes that the request is well formed and names a real prize.
 */
export const parsePrizeAwardInput = (body: unknown): PrizeAwardInputResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  for (const field of FORBIDDEN_AWARD_FIELDS) {
    if (field in body) {
      return {
        ok: false,
        message: `${field} is not accepted; the device session identifies the device and the event.`,
      }
    }
  }

  if (!isPositiveInteger(body.badgeNumber)) {
    return { ok: false, message: 'badgeNumber must be a positive whole number.' }
  }

  const prizeName = parsePrizeName(body.prizeName)

  if (prizeName.ok === false) {
    return { ok: false, message: prizeName.message }
  }

  return { ok: true, value: { badgeNumber: body.badgeNumber, prizeName: prizeName.value } }
}
