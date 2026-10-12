import {
  DANDIYA_ACTIONS,
  DANDIYA_PAIR_HOLDERS,
  isDandiyaAction,
  isDandiyaHolderResolution,
  parsePairCode,
  type DandiyaAction,
  type DandiyaHolderResolution,
} from '../../src/shared/dandiya-contract.js'

/**
 * The shapes of the two Dandiya mutations.
 *
 * Its own validator rather than a reuse of the device, Admin or prize ones:
 * those answer different questions. The one thing it does NOT own is the
 * pair-code policy, which lives in `src/shared/dandiya-contract.ts` and is
 * read by the browser form too, so instant feedback and real enforcement
 * cannot drift.
 */

export interface DandiyaIssueInput {
  pairCode: string
  /** Exactly two, different, both positive integers. */
  badgeNumbers: [number, number]
}

/**
 * WHAT A PATCH ASKS FOR.
 *
 * `resolve-holder` names one stick by badge number; the two shortcuts name
 * none and mean "every stick still out". The resolution is only meaningful
 * for the per-stick action — the shortcuts carry their own — so it is
 * modelled as part of the action rather than as a free field, which makes
 * `{ action: 'return-pair', resolution: 'lost' }` unrepresentable instead of
 * merely refused.
 */
export type DandiyaResolveInput =
  | {
      action: 'resolve-holder'
      loanId: string
      badgeNumber: number
      resolution: DandiyaHolderResolution
    }
  | { action: 'return-pair'; loanId: string }
  | { action: 'lost-pair'; loanId: string }

/** What the writer needs, whichever action asked for it. */
export const resolutionOf = (input: DandiyaResolveInput): DandiyaHolderResolution =>
  input.action === 'resolve-holder'
    ? input.resolution
    : input.action === 'return-pair'
      ? 'returned'
      : 'lost'

export const badgeNumberOf = (input: DandiyaResolveInput): number | undefined =>
  input.action === 'resolve-holder' ? input.badgeNumber : undefined

export type DandiyaIssueResult =
  | { ok: true; value: DandiyaIssueInput }
  | { ok: false; message: string }

export type DandiyaResolveResult =
  | { ok: true; value: DandiyaResolveInput }
  | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Fields a Dandiya request must never carry.
 *
 * The authenticated session decides which device and event a loan belongs to,
 * and the SERVER decides when it happened. Accepting any of these — even to
 * ignore them — would invite a caller to believe it can choose, and would
 * leave a field a later refactor might start reading.
 *
 * The attendee fields are refused for a second reason: they are not this
 * endpoint's to accept. A name, age or gender submitted by a client is a
 * claim about a person that the Badge Register already answers, and writing
 * one into Postgres is exactly the privacy boundary this module preserves.
 */
export const FORBIDDEN_DANDIYA_FIELDS = [
  'eventId',
  'eventSlug',
  'deviceId',
  'loginName',
  'issuedAt',
  'issuedBy',
  'closedAt',
  'closedBy',
  'closedByDeviceId',
  'outcome',
  'pairReleasedAt',
  'resolvedAt',
  'resolvedBy',
  'resolvedByDeviceId',
  'attendees',
  'attendee',
  'name',
  'age',
  'gender',
] as const

const refuseForbidden = (body: Record<string, unknown>): string | null => {
  for (const field of FORBIDDEN_DANDIYA_FIELDS) {
    if (field in body) {
      return `${field} is not accepted; the device session identifies the device and the event.`
    }
  }

  return null
}

/**
 * Validates an issue request's SHAPE.
 *
 * Whether the badges actually exist in the Badge Register is a separate
 * question the endpoint asks the Sheet, and whether the pair or either
 * attendee is already out is the DATABASE's. This only establishes that the
 * request is well formed: a real pair code, and two different real badges.
 */
export const parseDandiyaIssueInput = (body: unknown): DandiyaIssueResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const forbidden = refuseForbidden(body)

  if (forbidden !== null) {
    return { ok: false, message: forbidden }
  }

  const pairCode = parsePairCode(body.pairCode)

  if (pairCode.ok === false) {
    return { ok: false, message: pairCode.message }
  }

  if (!Array.isArray(body.badgeNumbers) || body.badgeNumbers.length !== DANDIYA_PAIR_HOLDERS) {
    return {
      ok: false,
      message: `badgeNumbers must be exactly ${String(DANDIYA_PAIR_HOLDERS)} badge numbers.`,
    }
  }

  const [first, second] = body.badgeNumbers

  if (!isPositiveInteger(first) || !isPositiveInteger(second)) {
    return { ok: false, message: 'Each badge number must be a positive whole number.' }
  }

  /**
   * ONE PAIR, TWO PEOPLE. Refused here as well as by the
   * `UNIQUE(loan_id, badge_number)` constraint, because the operator needs a
   * sentence rather than a conflict code — they have almost certainly
   * selected the same attendee twice by accident.
   */
  if (first === second) {
    return { ok: false, message: 'A pair goes to two different attendees.' }
  }

  return { ok: true, value: { pairCode: pairCode.value, badgeNumbers: [first, second] } }
}

/**
 * Validates a resolution request's SHAPE.
 *
 * `outcome` and `pairReleasedAt` are among the refused fields, and that is
 * the point of refusing rather than ignoring: an outcome is DERIVED from the
 * two sticks by the database, and releasing the physical pair is something
 * only a clean return may do. A caller that believes it can choose either is
 * a caller a later refactor might believe.
 *
 * Which sticks are still out, and whether this one is already resolved, are
 * the DATABASE's questions — answered by a compare-and-set, not here.
 */
export const parseDandiyaResolveInput = (body: unknown): DandiyaResolveResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const forbidden = refuseForbidden(body)

  if (forbidden !== null) {
    return { ok: false, message: forbidden }
  }

  if (!isDandiyaAction(body.action)) {
    return {
      ok: false,
      message: `action must be one of: ${DANDIYA_ACTIONS.join(', ')}.`,
    }
  }

  if (typeof body.loanId !== 'string' || !UUID_PATTERN.test(body.loanId)) {
    return { ok: false, message: 'loanId must identify an open loan.' }
  }

  const action: DandiyaAction = body.action
  const loanId = body.loanId

  if (action !== 'resolve-holder') {
    /**
     * A SHORTCUT NAMES NO STICK. Carrying a badge number or a resolution here
     * would mean two sources for one decision, so they are refused rather
     * than ignored — `{ action: 'return-pair', resolution: 'lost' }` must not
     * read as either.
     */
    for (const field of ['badgeNumber', 'resolution'] as const) {
      if (field in body) {
        return {
          ok: false,
          message: `${field} is not accepted with the ${action} action.`,
        }
      }
    }

    return { ok: true, value: { action, loanId } }
  }

  if (!isPositiveInteger(body.badgeNumber)) {
    return { ok: false, message: 'badgeNumber must be a positive whole number.' }
  }

  if (!isDandiyaHolderResolution(body.resolution)) {
    return { ok: false, message: 'resolution must be returned or lost.' }
  }

  return {
    ok: true,
    value: {
      action,
      loanId,
      badgeNumber: body.badgeNumber,
      resolution: body.resolution,
    },
  }
}
