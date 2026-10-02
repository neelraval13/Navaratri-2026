/**
 * The badge RANGE model, shared by Admin preassignment and Device self-claim.
 *
 * One mathematical definition of "what is a badge range", so the two callers
 * cannot drift into accepting different things. There is deliberately NO
 * maximum size: the physical badge stack decides how many badges a desk has,
 * and inventing a cap here would refuse a legitimate real-world range.
 *
 * Pure. It holds no database, HTTP, auth or realm concern at all.
 */

export interface BadgeRangeInput {
  rangeStart: number
  rangeEnd: number
}

export type BadgeRangeResult =
  | { ok: true; value: BadgeRangeInput }
  | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Validates `rangeStart` and `rangeEnd` from an untrusted body.
 *
 * A single-badge range (`rangeStart === rangeEnd`) is valid: one physical
 * badge is a perfectly real stack.
 */
export const parseBadgeRange = (body: unknown): BadgeRangeResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const { rangeStart, rangeEnd } = body

  if (!isPositiveInteger(rangeStart) || !isPositiveInteger(rangeEnd)) {
    return { ok: false, message: 'Badge numbers must be positive whole numbers.' }
  }

  if (rangeStart > rangeEnd) {
    return { ok: false, message: 'The first badge must not be after the last badge.' }
  }

  return { ok: true, value: { rangeStart, rangeEnd } }
}

/** Exact equality of the numbers, used to decide whether a retry is a repeat. */
export const isSameBadgeRange = (
  left: BadgeRangeInput,
  right: BadgeRangeInput,
): boolean => {
  return left.rangeStart === right.rangeStart && left.rangeEnd === right.rangeEnd
}
