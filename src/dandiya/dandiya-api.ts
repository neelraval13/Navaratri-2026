import {
  parseActiveLoan,
  parseDandiyaBoardResponse,
} from '@/dandiya/dandiya-contract-parsers'
import type {
  DandiyaActiveLoan,
  DandiyaBoardResponse,
  DandiyaHolderResolution,
} from '@/shared/dandiya-contract'
import { isDandiyaConflict } from '@/shared/dandiya-contract'

/**
 * The browser's only interface to the Dandiya ledger.
 *
 * It holds no credential of its own: the device session lives in an HttpOnly
 * cookie the browser attaches automatically, and this module never reads
 * `document.cookie`.
 *
 * ONLINE ONLY, AND BY DESIGN. There is no queue, no cache, no retry timer, no
 * polling and no heartbeat here, and there must not be: two disconnected
 * desks must never be able to issue the same physical pair or the same
 * attendee, and anything that made an issue or a return survive a failed
 * request would be exactly that.
 */

/**
 * One endpoint, three methods: GET reads the board, POST issues, PATCH
 * resolves a stick or every stick still out. Each file under `api/` is a deployment Function and the Hobby plan
 * allows twelve, so one screen spends one rather than five.
 */
const DANDIYA_ENDPOINT = '/api/dandiya'

const TIMEOUT_MS = 15_000

/**
 * Every message an operator can see. Server response text is NEVER rendered.
 */
export const DANDIYA_MESSAGES = {
  offline: 'Dandiya requires an internet connection.',
  unreachable:
    'Unable to reach the server. Check the connection and try again.',
  sessionExpired:
    'Device sign-in is no longer valid. Open Device Sign-In and sign in again.',
  dandiyaRequired:
    'This device does not have Dandiya access. An administrator grants it.',
  registerUnavailable:
    'The attendee register could not be read right now. Try again in a moment.',
  unexpected: 'The server returned an unexpected response.',
  invalidHistoryDate: 'That is not a day this event can show. Pick another date.',
  pairInUse: 'That pair is already out. The board has been refreshed.',
  pairUnavailable:
    'That pair is unavailable — its last loan ended with a stick lost. Use another pair.',
  attendeeHolding:
    'That attendee is already holding a stick. The board has been refreshed.',
  badgeNotRegistered:
    'That badge is not in this event’s attendee register.',
  holderResolved:
    'That stick has already been resolved. The board has been refreshed.',
  loanClosed:
    'Every stick on that pair has already been resolved. The board has been refreshed.',
  loanNotFound: 'That loan is no longer open. The board has been refreshed.',
  tooMany: 'Too many requests. Wait a moment and try again.',
  issueFailed: 'The pair could not be issued. Try again.',
  resolveFailed: 'The stick could not be resolved. Try again.',
} as const

const request = async (
  init: RequestInit,
  query?: Record<string, string>,
): Promise<Response> => {
  const controller = new AbortController()
  /**
   * The ONLY timer in this module, and it ABORTS rather than retries: a
   * request that never answers must end, and anything that resent an issue on
   * a schedule could put one pair out twice.
   */
  const timeout = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)

  /**
   * The endpoint is a CONSTANT and the only thing a caller may add is a
   * query parameter, built here rather than concatenated by a caller — so a
   * value can never escape into the path.
   */
  const url =
    query === undefined
      ? DANDIYA_ENDPOINT
      : `${DANDIYA_ENDPOINT}?${new URLSearchParams(query).toString()}`

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

const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null && key in body
    ? (body as Record<string, unknown>)[key]
    : null

export type DandiyaBoardResult =
  | { status: 'loaded'; board: DandiyaBoardResponse }
  | { status: 'invalid-day'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'register-unavailable'; message: string }
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * The board in one request: what is out, which pairs are quarantined, ONE
 * day's loans, and today's counters.
 *
 * `historyDate` names the event-local day whose loans are wanted, as
 * `YYYY-MM-DD`. Omitting it asks for today — and the SERVER decides which day
 * that is, in event time, so a tablet with a wrong clock or an unexpected
 * locale cannot shift the heading.
 *
 * ONE DAY PER REQUEST, deliberately. Active and Issues are bounded by the
 * event's physical stock of pairs, but history grows all week, and shipping
 * every loan ever made in order to render one night is what a day parameter
 * avoids. Changing the day is a new request; FILTERING and SEARCHING within
 * the day stay client-side, where a keystroke costs nothing.
 */
export const fetchDandiyaBoard = async (
  historyDate?: string,
): Promise<DandiyaBoardResult> => {
  let response: Response

  try {
    response = await request(
      { method: 'GET' },
      historyDate === undefined ? undefined : { historyDate },
    )
  } catch {
    return { status: 'unreachable', message: DANDIYA_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: DANDIYA_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    // A 403 without the typed reason is a refused origin, not a permission
    // answer, and must not be rendered as one.
    return fieldOf(await readJson(response), 'blocked') === 'dandiya-required'
      ? { status: 'not-permitted', message: DANDIYA_MESSAGES.dandiyaRequired }
      : { status: 'unexpected', message: DANDIYA_MESSAGES.unexpected }
  }

  if (response.status === 503) {
    return {
      status: 'register-unavailable',
      message: DANDIYA_MESSAGES.registerUnavailable,
    }
  }

  /**
   * A REFUSED DAY IS NOT A BROKEN BOARD. The only 400 this read can produce
   * is an unusable `historyDate`, which is the screen's own input to fix.
   */
  if (response.status === 400) {
    return { status: 'invalid-day', message: DANDIYA_MESSAGES.invalidHistoryDate }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: DANDIYA_MESSAGES.unexpected }
  }

  const board = parseDandiyaBoardResponse(await readJson(response))

  // A 200 that does not validate is not a board.
  if (board === null) {
    return { status: 'unexpected', message: DANDIYA_MESSAGES.unexpected }
  }

  return { status: 'loaded', board }
}

export type DandiyaIssueResult =
  | { status: 'issued'; loan: DandiyaActiveLoan }
  /**
   * THE DATABASE DECIDED, not this client. Another desk got there first, so
   * the caller refreshes and says so.
   */
  | { status: 'pair-in-use'; message: string }
  | { status: 'pair-unavailable'; message: string }
  | { status: 'attendee-holding'; message: string }
  | { status: 'badge-not-registered'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'register-unavailable'; message: string }
  | { status: 'invalid'; message: string }
  /** AMBIGUOUS: the loan may have committed with the response lost. */
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * Issues one pair to two badges.
 *
 * The body carries the pair code and the two badge numbers and NOTHING else.
 * The event, the device and the timestamp come from the authenticated session
 * and from the server — a caller that believes it can choose them is a caller
 * a later refactor might believe too.
 */
export const issueDandiyaPair = async (input: {
  pairCode: string
  badgeNumbers: readonly [number, number]
}): Promise<DandiyaIssueResult> => {
  let response: Response

  try {
    response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairCode: input.pairCode,
        badgeNumbers: [...input.badgeNumbers],
      }),
    })
  } catch {
    // Includes the abort on timeout. The loan may have committed, so the
    // caller must re-read rather than assume either outcome.
    return { status: 'unreachable', message: DANDIYA_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: DANDIYA_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    return fieldOf(await readJson(response), 'blocked') === 'dandiya-required'
      ? { status: 'not-permitted', message: DANDIYA_MESSAGES.dandiyaRequired }
      : { status: 'unexpected', message: DANDIYA_MESSAGES.issueFailed }
  }

  if (response.status === 404) {
    return {
      status: 'badge-not-registered',
      message: DANDIYA_MESSAGES.badgeNotRegistered,
    }
  }

  if (response.status === 409) {
    const conflict = fieldOf(await readJson(response), 'conflict')

    // Parsed with the SHARED guard, so the client never has to know the
    // server's internal spelling of a conflict.
    if (!isDandiyaConflict(conflict)) {
      return { status: 'unexpected', message: DANDIYA_MESSAGES.issueFailed }
    }

    if (conflict === 'pair-in-use') {
      return { status: 'pair-in-use', message: DANDIYA_MESSAGES.pairInUse }
    }

    if (conflict === 'pair-unavailable') {
      return { status: 'pair-unavailable', message: DANDIYA_MESSAGES.pairUnavailable }
    }

    return conflict === 'attendee-already-holding-pair'
      ? { status: 'attendee-holding', message: DANDIYA_MESSAGES.attendeeHolding }
      : { status: 'unexpected', message: DANDIYA_MESSAGES.issueFailed }
  }

  if (response.status === 429) {
    return { status: 'unexpected', message: DANDIYA_MESSAGES.tooMany }
  }

  if (response.status === 503) {
    return {
      status: 'register-unavailable',
      message: DANDIYA_MESSAGES.registerUnavailable,
    }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    // The form validates before enabling the button, so this is close to
    // unreachable — it still says the pair did not go out.
    return { status: 'invalid', message: DANDIYA_MESSAGES.issueFailed }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: DANDIYA_MESSAGES.issueFailed }
  }

  const loan = parseActiveLoan(fieldOf(await readJson(response), 'loan'))

  if (loan === null) {
    return { status: 'unexpected', message: DANDIYA_MESSAGES.issueFailed }
  }

  return { status: 'issued', loan }
}

export type DandiyaResolveResult =
  | { status: 'resolved'; resolvedHolders: number }
  /** Somebody resolved that stick first. A resolution is never overwritten. */
  | { status: 'holder-already-resolved'; message: string }
  | { status: 'loan-already-closed'; message: string }
  | { status: 'loan-not-found'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  | { status: 'invalid'; message: string }
  /** AMBIGUOUS: the resolution may have committed with the response lost. */
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * Resolves one stick, or every stick still out.
 *
 * THREE ACTIONS, ONE REQUEST SHAPE. `resolve-holder` names a stick and its
 * ending; `return-pair` and `lost-pair` name neither, because they mean
 * "every stick still out" — and they are shortcuts over the same per-stick
 * resolution, so neither can overwrite one that is already resolved.
 *
 * No timestamp and no device: the server derives both. No outcome either —
 * whether this closes the loan, and as what, is derived by the database from
 * the two sticks.
 */
export const resolveDandiyaPair = async (
  input:
    | { action: 'resolve-holder'; loanId: string; badgeNumber: number; resolution: DandiyaHolderResolution }
    | { action: 'return-pair'; loanId: string }
    | { action: 'lost-pair'; loanId: string },
): Promise<DandiyaResolveResult> => {
  let response: Response

  try {
    response = await request({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    return { status: 'unreachable', message: DANDIYA_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: DANDIYA_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    return fieldOf(await readJson(response), 'blocked') === 'dandiya-required'
      ? { status: 'not-permitted', message: DANDIYA_MESSAGES.dandiyaRequired }
      : { status: 'unexpected', message: DANDIYA_MESSAGES.resolveFailed }
  }

  if (response.status === 404) {
    return { status: 'loan-not-found', message: DANDIYA_MESSAGES.loanNotFound }
  }

  if (response.status === 409) {
    const conflict = fieldOf(await readJson(response), 'conflict')

    // Parsed with the SHARED guard, so the client never has to know the
    // server's internal spelling of a conflict.
    if (conflict === 'holder-already-resolved') {
      return {
        status: 'holder-already-resolved',
        message: DANDIYA_MESSAGES.holderResolved,
      }
    }

    return conflict === 'loan-already-closed'
      ? { status: 'loan-already-closed', message: DANDIYA_MESSAGES.loanClosed }
      : { status: 'unexpected', message: DANDIYA_MESSAGES.resolveFailed }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    return { status: 'invalid', message: DANDIYA_MESSAGES.resolveFailed }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: DANDIYA_MESSAGES.resolveFailed }
  }

  const resolvedHolders = fieldOf(await readJson(response), 'resolvedHolders')

  return {
    status: 'resolved',
    resolvedHolders: typeof resolvedHolders === 'number' ? resolvedHolders : 0,
  }
}
