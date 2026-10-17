import { parseCngMember, parseCngPrizeAward } from '@/cng/cng-contract-parsers'
import type {
  CngMember,
  CngMembershipOutcome,
  CngPrizeAward,
} from '@/shared/cng-contract'
import type { PrizeAward, PrizeAttendee } from '@/shared/prize-contract'
import {
  parsePrizeAward,
  parsePrizeRosterResponse,
} from '@/prizes/prize-contract-parsers'

/**
 * The browser's only interface to the prize ledger AND the CNG group.
 *
 * Both live here because both are `/api/prizes`: one endpoint, one request
 * helper, one timeout, one set of operator-facing messages. A second module
 * would be a second abort timer and a second opinion about what a 401 means
 * on the same URL.
 *
 * It holds no credential of its own: the device session lives in an HttpOnly
 * cookie the browser attaches automatically, and this module never reads
 * `document.cookie`.
 *
 * ONLINE ONLY, AND BY DESIGN. There is no queue, no retry timer, no polling
 * and no heartbeat here, and there must not be: two disconnected prize desks
 * must never be able to award the same badge, and anything that made an award
 * survive a failed request would be exactly that.
 */

/**
 * One endpoint, five methods:
 *
 *   GET     the attendees, both award histories and the active CNG group
 *   POST    award a prize to a BADGE        (attendees — unchanged)
 *   PUT     add a CNG member, by NAME
 *   DELETE  soft-remove a CNG member, by ID
 *   PATCH   award a prize to a CNG member
 *
 * Each file under `api/` is a deployment Function and the Hobby plan allows
 * twelve, so one screen spends one rather than six.
 *
 * THE TWO AWARD CALLS ARE SEPARATE ON PURPOSE. `POST` is the live attendee
 * contract and Phase CNG1.1 does not touch it; `PATCH` carries a CNG member
 * id instead of a badge. No body shape could be read as either, so the
 * badge-based semantics cannot drift.
 */
const PRIZES_ENDPOINT = '/api/prizes'

const TIMEOUT_MS = 15_000

/**
 * Every message an operator can see. Server response text is NEVER rendered.
 */
export const PRIZE_MESSAGES = {
  offline: 'Prizes requires an internet connection.',
  unreachable:
    'Unable to reach the server. Check the connection and try again.',
  sessionExpired:
    'Device sign-in is no longer valid. Open Device Sign-In and sign in again.',
  prizesRequired:
    'This device does not have Prizes access. An administrator grants it.',
  rosterUnavailable:
    'The attendee register could not be read right now. Try again in a moment.',
  notConfigured: 'Prizes is not available on this deployment right now.',
  unexpected: 'The server returned an unexpected response.',
  badgeNotRegistered:
    'That badge is not in this event’s attendee register.',
  tooMany: 'Too many requests. Wait a moment and try again.',
  awardFailed: 'The prize could not be recorded. Try again.',
  /** CNG membership and prizes. Both need the same Prizes access. */
  cngAddFailed: 'The CNG member could not be added. Try again.',
  cngIdInUse:
    'That CNG member was already added under a different name. Refresh the group and check before adding again.',
  cngRemoveFailed: 'The CNG member could not be removed. Try again.',
  cngAwardFailed: 'The CNG prize could not be recorded. Try again.',
  notACngMember: 'That CNG member is no longer in the group.',
  cngMemberUnavailable:
    'That CNG member is no longer in the group, so no prize was recorded.',
} as const

const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)

  try {
    return await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

const blockedReason = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && 'blocked' in body
    ? (body as { blocked: unknown }).blocked
    : null

/**
 * The failures the roster read and the award share.
 *
 * `unreachable` is NOT ambiguous for a read — nothing was changed — but it is
 * for a WRITE, so the award result names it separately and never reports it
 * as a refusal.
 */
export type PrizeRosterResult =
  | {
      status: 'loaded'
      attendees: PrizeAttendee[]
      awards: PrizeAward[]
      /** The ACTIVE CNG volunteer group, oldest first. Named, not badged. */
      cng: CngMember[]
      /** Every CNG prize, newest first. A separate ledger from `awards`. */
      cngAwards: CngPrizeAward[]
    }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'roster-unavailable'; message: string }
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * EVERY registered attendee and the permanent history, in one request.
 *
 * Both lists are needed together: the history is what the award dialog warns
 * from, and since Phase P1.1 an attendee with previous prizes stays in the
 * attendee list, so neither list can be derived from the other.
 *
 * Filtering is CLIENT-SIDE after this one fetch. The event is a few hundred
 * attendees, so paging, server-side search and a query per keystroke would
 * add latency and complexity to solve a problem this event does not have.
 */
export const fetchPrizeRoster = async (): Promise<PrizeRosterResult> => {
  let response: Response

  try {
    response = await request(PRIZES_ENDPOINT, { method: 'GET' })
  } catch {
    return { status: 'unreachable', message: PRIZE_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: PRIZE_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    // A 403 without the typed reason is a refused origin, not a permission
    // answer, and must not be rendered as one.
    return blockedReason(await readJson(response)) === 'prizes-required'
      ? { status: 'not-permitted', message: PRIZE_MESSAGES.prizesRequired }
      : { status: 'unexpected', message: PRIZE_MESSAGES.unexpected }
  }

  if (response.status === 503) {
    return {
      status: 'roster-unavailable',
      message: PRIZE_MESSAGES.rosterUnavailable,
    }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.unexpected }
  }

  const roster = parsePrizeRosterResponse(await readJson(response))

  // A 200 that does not validate is not a roster.
  if (roster === null) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.unexpected }
  }

  return {
    status: 'loaded',
    attendees: roster.attendees,
    awards: roster.awards,
    cng: roster.cng,
    cngAwards: roster.cngAwards,
  }
}

export type PrizeAwardResult =
  | { status: 'awarded'; award: PrizeAward }
  | { status: 'badge-not-registered'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'roster-unavailable'; message: string }
  | { status: 'invalid'; message: string }
  /** AMBIGUOUS: the insert may have committed with the response lost. */
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * Awards one prize to one badge. Every success appends exactly one record.
 *
 * There is NO `already-awarded` outcome any more: an attendee may win more
 * than one prize, including the same one twice, so a previous award is
 * something the dialog warns about and never something this call refuses.
 *
 * The body carries the badge number and the prize name and NOTHING else. The
 * event, the device and the timestamp come from the authenticated session and
 * from Postgres — a caller that believes it can choose them is a caller a
 * later refactor might believe too.
 */
export const awardPrize = async (input: {
  badgeNumber: number
  prizeName: string
}): Promise<PrizeAwardResult> => {
  let response: Response

  try {
    response = await request(PRIZES_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        badgeNumber: input.badgeNumber,
        prizeName: input.prizeName,
      }),
    })
  } catch {
    // Includes the abort on timeout. The row may have committed, so the
    // caller must re-read rather than assume either outcome.
    return { status: 'unreachable', message: PRIZE_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: PRIZE_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    return blockedReason(await readJson(response)) === 'prizes-required'
      ? { status: 'not-permitted', message: PRIZE_MESSAGES.prizesRequired }
      : { status: 'unexpected', message: PRIZE_MESSAGES.awardFailed }
  }

  if (response.status === 404) {
    return {
      status: 'badge-not-registered',
      message: PRIZE_MESSAGES.badgeNotRegistered,
    }
  }

  if (response.status === 429) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.tooMany }
  }

  if (response.status === 503) {
    return {
      status: 'roster-unavailable',
      message: PRIZE_MESSAGES.rosterUnavailable,
    }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    // The chooser only ever submits a catalog label, so this is close to
    // unreachable — it still says the award did not happen.
    return { status: 'invalid', message: PRIZE_MESSAGES.awardFailed }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.awardFailed }
  }

  const body = await readJson(response)
  const award = parsePrizeAward(
    typeof body === 'object' && body !== null
      ? (body as { award?: unknown }).award
      : null,
  )

  if (award === null) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.awardFailed }
  }

  return { status: 'awarded', award }
}

/* ------------------------------------------- the CNG volunteer group */

export type CngAddResult =
  /** `added` created a row; `already-member` found the same one again. */
  | { status: 'member'; outcome: CngMembershipOutcome; member: CngMember }
  /** The same id under a DIFFERENT name. Never overwritten. */
  | { status: 'id-in-use'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  /** AMBIGUOUS: the row may have committed with the response lost. */
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * Adds one CNG member, BY NAME, IDEMPOTENTLY.
 *
 * The body carries the client-generated row id and the name, and NOTHING
 * else. There is no badge number — a volunteer does not have one, and the
 * server refuses the field outright — and no age, gender, phone or payment
 * detail, because none of those are needed to hand somebody a prize.
 *
 * `cngMemberId` IS THE IDEMPOTENCY KEY, AND A NAME COULD NOT BE. Two
 * volunteers may genuinely share a name, so "have I already added this
 * person?" is unanswerable from one. The caller generates the UUID once for
 * the member it is adding and reuses it on a retry, so an ambiguous failure
 * can be retried without creating a second row.
 *
 * SO A RETRY IS SAFE: the same id and name again answers `already-member`
 * with the authoritative row, while the same id under a different name is
 * REFUSED rather than silently overwriting somebody.
 */
export const addCngMember = async (input: {
  cngMemberId: string
  name: string
}): Promise<CngAddResult> => {
  let response: Response

  try {
    response = await request(PRIZES_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cngMemberId: input.cngMemberId,
        name: input.name,
      }),
    })
  } catch {
    /**
     * Includes the abort on timeout. The row may have committed — which is
     * precisely why the id is the caller's: retrying this exact request
     * reaches the same row rather than creating a second one.
     */
    return { status: 'unreachable', message: PRIZE_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: PRIZE_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    return blockedReason(await readJson(response)) === 'prizes-required'
      ? { status: 'not-permitted', message: PRIZE_MESSAGES.prizesRequired }
      : { status: 'unexpected', message: PRIZE_MESSAGES.cngAddFailed }
  }

  if (response.status === 409) {
    return { status: 'id-in-use', message: PRIZE_MESSAGES.cngIdInUse }
  }

  if (response.status === 429) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.tooMany }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    return { status: 'invalid', message: PRIZE_MESSAGES.cngAddFailed }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.cngAddFailed }
  }

  const body = await readJson(response)
  const member = parseCngMember(
    typeof body === 'object' && body !== null
      ? (body as { member?: unknown }).member
      : null,
  )

  if (member === null) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.cngAddFailed }
  }

  /**
   * The outcome is read from the body rather than from the status code, so
   * one shape answers both. An unrecognised value is treated as the
   * conservative one — the member exists either way, and claiming "added"
   * for a row that was already there would misreport what happened.
   */
  const outcome =
    typeof body === 'object' &&
    body !== null &&
    (body as { outcome?: unknown }).outcome === 'added'
      ? 'added'
      : 'already-member'

  return { status: 'member', outcome, member }
}

export type CngRemoveResult =
  | { status: 'removed'; cngMemberId: string }
  /** Somebody else removed them, or this screen was stale. Not an error. */
  | { status: 'not-a-member'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'invalid'; message: string }
  /** AMBIGUOUS: the removal may have committed with the response lost. */
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * Soft-removes one CNG member, by the row's own id.
 *
 * BY ID, NEVER BY NAME: two volunteers may share a name, so removing
 * "whoever is called that" could remove the wrong person.
 *
 * IT DELETES NOTHING. The member leaves the active group and keeps every
 * prize already awarded — the history still names them, which is the whole
 * reason the removal is soft.
 */
export const removeCngMember = async (input: {
  cngMemberId: string
}): Promise<CngRemoveResult> => {
  let response: Response

  try {
    response = await request(PRIZES_ENDPOINT, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cngMemberId: input.cngMemberId }),
    })
  } catch {
    return { status: 'unreachable', message: PRIZE_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: PRIZE_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    return blockedReason(await readJson(response)) === 'prizes-required'
      ? { status: 'not-permitted', message: PRIZE_MESSAGES.prizesRequired }
      : { status: 'unexpected', message: PRIZE_MESSAGES.cngRemoveFailed }
  }

  if (response.status === 404) {
    return { status: 'not-a-member', message: PRIZE_MESSAGES.notACngMember }
  }

  if (response.status === 429) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.tooMany }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    return { status: 'invalid', message: PRIZE_MESSAGES.cngRemoveFailed }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.cngRemoveFailed }
  }

  return { status: 'removed', cngMemberId: input.cngMemberId }
}

export type CngAwardResult =
  | { status: 'awarded'; award: CngPrizeAward }
  /** Removed, or never on this event. Nothing was written. */
  | { status: 'member-unavailable'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'invalid'; message: string }
  /** AMBIGUOUS: the insert may have committed with the response lost. */
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * Awards one prize to one ACTIVE CNG member.
 *
 * A DIFFERENT METHOD FROM `awardPrize`, and deliberately so: that one carries
 * a BADGE NUMBER and appends to the attendee ledger, this one carries a CNG
 * MEMBER ID and appends to the volunteer ledger. Neither can reach the
 * other's table, and no badge is invented for a volunteer.
 *
 * There is no `already-awarded` outcome: repeat prizes are legal here exactly
 * as they are for attendees. The only refusal is that the member is no longer
 * active, which the database decides on the write.
 */
export const awardCngPrize = async (input: {
  cngMemberId: string
  prizeName: string
}): Promise<CngAwardResult> => {
  let response: Response

  try {
    response = await request(PRIZES_ENDPOINT, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cngMemberId: input.cngMemberId,
        prizeName: input.prizeName,
      }),
    })
  } catch {
    return { status: 'unreachable', message: PRIZE_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: PRIZE_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    return blockedReason(await readJson(response)) === 'prizes-required'
      ? { status: 'not-permitted', message: PRIZE_MESSAGES.prizesRequired }
      : { status: 'unexpected', message: PRIZE_MESSAGES.cngAwardFailed }
  }

  if (response.status === 404) {
    return {
      status: 'member-unavailable',
      message: PRIZE_MESSAGES.cngMemberUnavailable,
    }
  }

  if (response.status === 429) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.tooMany }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    return { status: 'invalid', message: PRIZE_MESSAGES.cngAwardFailed }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.cngAwardFailed }
  }

  const body = await readJson(response)
  const award = parseCngPrizeAward(
    typeof body === 'object' && body !== null
      ? (body as { award?: unknown }).award
      : null,
  )

  if (award === null) {
    return { status: 'unexpected', message: PRIZE_MESSAGES.cngAwardFailed }
  }

  return { status: 'awarded', award }
}
