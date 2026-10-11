import type { PrizeAward, PrizeAttendee } from '@/shared/prize-contract'
import {
  parsePrizeAward,
  parsePrizeRosterResponse,
} from '@/prizes/prize-contract-parsers'

/**
 * The browser's only interface to the prize ledger.
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
 * One endpoint, two methods: GET reads the attendees and the history, POST
 * awards. Each file under `api/` is a deployment Function and the Hobby plan
 * allows twelve, so one screen spends one rather than three.
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
  | { status: 'loaded'; attendees: PrizeAttendee[]; awards: PrizeAward[] }
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

  return { status: 'loaded', attendees: roster.attendees, awards: roster.awards }
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
