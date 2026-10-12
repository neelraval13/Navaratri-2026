import {
  DANDIYA_ACTIONS,
  DANDIYA_PAIR_HOLDERS,
  isDandiyaAction,
  isDandiyaHolderResolution,
  parsePairCode,
  type DandiyaAction,
  type DandiyaHolderResolution,
} from '../../src/shared/dandiya-contract.js'
import { parsePhoneNumber } from '../../src/shared/phone.js'

/**
 * The shapes of the two Dandiya mutations.
 *
 * Its own validator rather than a reuse of the device, Admin or prize ones:
 * those answer different questions. The one thing it does NOT own is the
 * pair-code policy, which lives in `src/shared/dandiya-contract.ts` and is
 * read by the browser form too, so instant feedback and real enforcement
 * cannot drift.
 */

/**
 * AN ISSUANCE, ALREADY DISCRIMINATED BY MODE — the one shape the writer takes.
 *
 * The three modes differ in WHO IS ACCOUNTABLE, and that is the whole reason
 * this is a union rather than three independent fields:
 *
 *   two badges          each holder answers for their own stick
 *   one badge + guest   THAT badge answers for the whole loan
 *   two guests          one contact number answers for the whole loan
 *
 * Carried as `{ badgeNumbers, accountabilityBadgeNumber, contactPhone }` the
 * four impossible loans would all be EXPRESSIBLE — a mixed loan with no
 * anchor, a mixed loan anchored to a badge that is not on it, a badge loan
 * carrying a phone number, a badgeless loan with no contact — and only a
 * convention would stand between a future call site and writing one. As a
 * union, every one of them is a type error, and `issuanceColumns` in
 * `loans.ts` is the single total function that turns a mode into columns.
 *
 * `badgeSlot` is which STICK the one badge holds, because the slot is the
 * stick's identity and `[9008, null]` and `[null, 9008]` are different loans.
 */
export type DandiyaIssuance =
  | { mode: 'two-badges'; badgeNumbers: readonly [number, number] }
  | { mode: 'one-badge'; badgeNumber: number; badgeSlot: 1 | 2 }
  | { mode: 'badgeless'; contactPhone: string }

export interface DandiyaIssueInput {
  pairCode: string
  issuance: DandiyaIssuance
}

/**
 * THE REAL BADGES THIS ISSUANCE NAMES — none, one or two.
 *
 * For the endpoint's Badge Register check, which has nothing to confirm about
 * a guest slot. Derived from the mode so the caller never filters nulls out
 * of a positional pair and never has to know which slot held what.
 */
export const registeredBadgesOf = (issuance: DandiyaIssuance): number[] => {
  switch (issuance.mode) {
    case 'two-badges':
      return [...issuance.badgeNumbers]
    case 'one-badge':
      return [issuance.badgeNumber]
    case 'badgeless':
      return []
  }
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
      /**
       * WHICH STICK, BY SLOT — 1 or 2.
       *
       * Not by badge number, since Phase D3.3: a guest has no badge, so a
       * badge could not name their stick at all, and two guests on one pair
       * would be indistinguishable. The slot is what every screen already
       * shows and what the holder row already carries.
       */
      slot: number
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

export const slotOf = (input: DandiyaResolveInput): number | undefined =>
  input.action === 'resolve-holder' ? input.slot : undefined

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
  /**
   * DERIVED FROM THE HOLDERS, never chosen. A caller that could name the
   * accountability badge could anchor a mixed loan to a badge that is not on
   * it — or to no badge at all — which is precisely the hole the loan-level
   * anchor exists to close.
   */
  'accountabilityBadgeNumber',
  'accountabilityBadge',
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
      message: `badgeNumbers must be exactly ${String(DANDIYA_PAIR_HOLDERS)} entries.`,
    }
  }

  /**
   * EACH SLOT IS A BADGE OR `null`, and `null` means a guest with no badge.
   *
   * Positional, because the position IS the stick: slot 1 and slot 2. A
   * synthetic badge number is never accepted — there is no value that could
   * stand for "no badge" without colliding with a real one.
   */
  const [first, second] = body.badgeNumbers

  for (const entry of [first, second]) {
    if (entry !== null && !isPositiveInteger(entry)) {
      return {
        ok: false,
        message: 'Each holder is a positive badge number, or null for a guest.',
      }
    }
  }

  const badges = [first, second].filter((entry): entry is number => entry !== null)

  /**
   * ONE PAIR, TWO PEOPLE. Refused here as well as by the
   * `UNIQUE(loan_id, badge_number)` constraint, because the operator needs a
   * sentence rather than a conflict code — they have almost certainly
   * selected the same attendee twice by accident.
   *
   * TWO GUESTS ARE NOT "the same holder twice". They are two anonymous
   * sticks, which is why the database treats their NULL badges as distinct.
   */
  if (badges.length === DANDIYA_PAIR_HOLDERS && badges[0] === badges[1]) {
    return { ok: false, message: 'A pair goes to two different attendees.' }
  }

  /**
   * A CONTACT NUMBER IS REQUIRED BY EXACTLY ONE CASE, and refused by the
   * others.
   *
   *   two badges          no phone — the badges are the accountability
   *   one badge + guest   no phone — THAT badge is the accountability
   *   two guests          one phone, mandatory
   *
   * REFUSED rather than ignored when a badge is present, for the reason every
   * other unaccepted field is: a number nobody needed would be persisted
   * personal data, and `contact_phone IS NOT NULL` would stop meaning "this
   * loan is fully badgeless" — which is what the open-contact index relies
   * on.
   */
  const hasPhone = 'contactPhone' in body && body.contactPhone !== null &&
    body.contactPhone !== undefined && body.contactPhone !== ''

  if (badges.length > 0) {
    if (hasPhone) {
      return {
        ok: false,
        message:
          'contactPhone is not accepted when a holder has a badge; the badge is the accountability.',
      }
    }

    /**
     * TWO BADGES, or ONE — and the mode is decided HERE, from the holders,
     * never from anything the caller said about accountability.
     *
     * A mixed loan is anchored to its SOLE badge, and that is not a choice:
     * the `one-badge` shape carries one badge and the slot it holds, so there
     * is no way to express a mixed loan anchored to a badge that is not on
     * it, or to none at all.
     */
    if (badges.length === DANDIYA_PAIR_HOLDERS) {
      return {
        ok: true,
        value: {
          pairCode: pairCode.value,
          issuance: { mode: 'two-badges', badgeNumbers: [badges[0], badges[1]] },
        },
      }
    }

    return {
      ok: true,
      value: {
        pairCode: pairCode.value,
        issuance: {
          mode: 'one-badge',
          badgeNumber: badges[0],
          badgeSlot: first === null ? 2 : 1,
        },
      },
    }
  }

  if (!hasPhone) {
    return {
      ok: false,
      message: 'A contact phone number is required when neither person has a badge.',
    }
  }

  const contactPhone = parsePhoneNumber(body.contactPhone)

  if (contactPhone.ok === false) {
    return { ok: false, message: contactPhone.message }
  }

  return {
    ok: true,
    value: {
      pairCode: pairCode.value,
      issuance: { mode: 'badgeless', contactPhone: contactPhone.value },
    },
  }
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
    for (const field of ['slot', 'badgeNumber', 'resolution'] as const) {
      if (field in body) {
        return {
          ok: false,
          message: `${field} is not accepted with the ${action} action.`,
        }
      }
    }

    return { ok: true, value: { action, loanId } }
  }

  /**
   * A SLOT, and only a real one. `DANDIYA_PAIR_HOLDERS` is two, so 1 and 2
   * are the whole set — the same values the database's `slot in (1, 2)` check
   * accepts.
   */
  if (
    !isPositiveInteger(body.slot) ||
    body.slot > DANDIYA_PAIR_HOLDERS
  ) {
    return {
      ok: false,
      message: `slot must be 1 or ${String(DANDIYA_PAIR_HOLDERS)}.`,
    }
  }

  /**
   * A BADGE NUMBER IS REFUSED, not ignored. It used to be how a stick was
   * named; a caller still sending one is working from the old contract, and
   * silently resolving a slot they did not ask for would be the worst
   * possible reading of it.
   */
  if ('badgeNumber' in body) {
    return {
      ok: false,
      message: 'badgeNumber is not accepted; a stick is named by its slot.',
    }
  }

  if (!isDandiyaHolderResolution(body.resolution)) {
    return { ok: false, message: 'resolution must be returned or lost.' }
  }

  return {
    ok: true,
    value: {
      action,
      loanId,
      slot: body.slot,
      resolution: body.resolution,
    },
  }
}
