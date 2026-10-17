import { parseCngMemberName } from '../../src/shared/cng-contract.js'
import { parsePrizeName } from '../../src/shared/prize-contract.js'

/**
 * The shapes of the three CNG request bodies, as EXACT contracts.
 *
 * Each method declares the keys it accepts and refuses everything else by
 * name. That is stronger than a shared deny-list and it avoids the trap a
 * shared one sets: a field that is REQUIRED by one method and MEANINGLESS on
 * another cannot be forbidden globally without breaking the method that needs
 * it.
 *
 *   PUT     { cngMemberId, name }        add a volunteer
 *   DELETE  { cngMemberId }              soft-remove one
 *   PATCH   { cngMemberId, prizeName }   award a prize to one
 *
 * `name` is therefore legal on PUT — it is the whole point of the request —
 * and refused on DELETE and PATCH, where two members may share one and acting
 * on "whoever is called that" could act on the wrong person.
 *
 * `cngMemberId` IS ON ALL THREE, and on PUT it is the IDEMPOTENCY KEY rather
 * than a caller choosing a database id. A volunteer's name cannot be that
 * key, because two volunteers may genuinely have the same name; the row's
 * UUID can. The client generates it once per member it is about to add, so a
 * retry after a lost response reaches the same row instead of creating a
 * second one.
 *
 * IT OWNS NO POLICY OF ITS OWN. The NAME rule lives in
 * `src/shared/cng-contract.ts` and the PRIZE rule in
 * `src/shared/prize-contract.ts`, both read by the browser too, so what an
 * operator can submit and what the endpoint accepts cannot drift.
 */

export interface CngAddInput {
  /** The client-generated row id. Makes PUT genuinely idempotent. */
  cngMemberId: string
  /** Trimmed, non-empty, bounded. The only person field accepted. */
  name: string
}

export interface CngRemoveInput {
  cngMemberId: string
}

export interface CngAwardInput {
  cngMemberId: string
  /** One of the eight canonical catalog labels, exactly. */
  prizeName: string
}

export type CngInputResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value)

/**
 * Fields NO CNG request may carry, whichever method it is.
 *
 * The authenticated session decides which device and event a row belongs to,
 * and the DATABASE decides when it happened. Accepting any of these — even to
 * ignore them — would invite a caller to believe it can choose, and would
 * leave a field a later refactor might start reading.
 *
 * `badgeNumber` AND `badge` HEAD THE LIST DELIBERATELY. A CNG member has no
 * badge; a body offering one is either Phase CNG1's retired model
 * resurfacing or a client inventing an identity, and both must fail loudly.
 *
 * THE ATTENDEE FACTS ARE REFUSED FOR A SECOND REASON. A volunteer's name is
 * stored on purpose; their age, gender, phone number, WhatsApp link and
 * payment details are not, are not needed to hand somebody a prize, and have
 * no column to land in. Refusing them at the boundary is what keeps that
 * true.
 *
 * `id` IS FORBIDDEN while `cngMemberId` is accepted, and the difference is
 * not cosmetic: the body names a MEMBER, never a column, so no request can
 * read as "set this row's primary key to that".
 */
export const FORBIDDEN_CNG_FIELDS = [
  'badgeNumber',
  'badge',
  'eventId',
  'eventSlug',
  'deviceId',
  'loginName',
  'addedAt',
  'addedBy',
  'removedAt',
  'removedBy',
  'removedByDeviceId',
  'awardedAt',
  'awardedBy',
  'awardedByDeviceId',
  'id',
  'attendee',
  'normalizedName',
  'age',
  'gender',
  'phone',
  'whatsapp',
  'payment',
  'paymentMethod',
  'amount',
] as const

/** Exactly the keys each method accepts. Anything else is refused by name. */
const ADD_KEYS = ['cngMemberId', 'name'] as const
const REMOVE_KEYS = ['cngMemberId'] as const
const AWARD_KEYS = ['cngMemberId', 'prizeName'] as const

/**
 * A body whose keys are EXACTLY within one method's contract.
 *
 * The always-forbidden list is checked first so the dangerous fields get a
 * message that says WHY, rather than the generic "not accepted on this
 * request" an unknown key gets. Both refuse; only the wording differs.
 */
const parseExactBody = (
  body: unknown,
  allowed: readonly string[],
): CngInputResult<Record<string, unknown>> => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  for (const field of FORBIDDEN_CNG_FIELDS) {
    if (field in body) {
      return {
        ok: false,
        message: `${field} is not accepted; a CNG member is identified by name, and the device session identifies the device and the event.`,
      }
    }
  }

  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        message: `${key} is not accepted on this request; it takes ${allowed.join(' and ')}.`,
      }
    }
  }

  return { ok: true, value: body }
}

/**
 * `PUT` — add one volunteer, idempotently.
 *
 * BOTH FIELDS ARE REQUIRED. The id makes the request retryable and the name
 * is the member; a PUT with only one of them is not a complete assertion of
 * the state the operator wants.
 */
export const parseCngAddInput = (body: unknown): CngInputResult<CngAddInput> => {
  const exact = parseExactBody(body, ADD_KEYS)

  if (exact.ok === false) {
    return exact
  }

  if (!isUuid(exact.value.cngMemberId)) {
    return {
      ok: false,
      message: 'cngMemberId must be a CNG member id, generated by the client so a retry is safe.',
    }
  }

  const name = parseCngMemberName(exact.value.name)

  if (name.ok === false) {
    return { ok: false, message: name.message }
  }

  return {
    ok: true,
    value: { cngMemberId: exact.value.cngMemberId, name: name.value },
  }
}

/**
 * `DELETE` — soft-remove one volunteer, by the row's own id.
 *
 * A NAME IS NOT AN IDENTITY HERE, so it is not in the contract at all. Two
 * volunteers may share one, and removing "whoever is called that" could
 * remove the wrong person — which the UUID makes impossible.
 */
export const parseCngRemoveInput = (
  body: unknown,
): CngInputResult<CngRemoveInput> => {
  const exact = parseExactBody(body, REMOVE_KEYS)

  if (exact.ok === false) {
    return exact
  }

  if (!isUuid(exact.value.cngMemberId)) {
    return { ok: false, message: 'cngMemberId must be a CNG member id.' }
  }

  return { ok: true, value: { cngMemberId: exact.value.cngMemberId } }
}

/**
 * `PATCH` — award one prize to one ACTIVE volunteer.
 *
 * Deliberately a different method from the attendee award, so the existing
 * badge-based contract on `POST` cannot drift into carrying a CNG identity.
 */
export const parseCngAwardInput = (
  body: unknown,
): CngInputResult<CngAwardInput> => {
  const exact = parseExactBody(body, AWARD_KEYS)

  if (exact.ok === false) {
    return exact
  }

  if (!isUuid(exact.value.cngMemberId)) {
    return { ok: false, message: 'cngMemberId must be a CNG member id.' }
  }

  /** THE SAME eight-prize catalog attendees use. One list, both ledgers. */
  const prizeName = parsePrizeName(exact.value.prizeName)

  if (prizeName.ok === false) {
    return { ok: false, message: prizeName.message }
  }

  return {
    ok: true,
    value: {
      cngMemberId: exact.value.cngMemberId,
      prizeName: prizeName.value,
    },
  }
}
