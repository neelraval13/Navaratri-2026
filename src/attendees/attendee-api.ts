import { parseAttendeeList, type EventAttendee } from '@/shared/attendee-contract'

/**
 * The browser's only interface to the attendee directory.
 *
 * It holds no credential of its own: the device session lives in an HttpOnly
 * cookie the browser attaches automatically, and this module never reads
 * `document.cookie`.
 *
 * READ-ONLY, and structurally so. There is exactly one function here and it
 * sends `GET`. No `POST`, no `PUT`, no `PATCH`, no `DELETE`, no body, and no
 * writer anywhere in the module — the directory cannot change an attendee
 * because nothing here is capable of asking.
 *
 * ONLINE ONLY, AND BY DESIGN. There is no cache, no queue, no retry timer, no
 * polling and no heartbeat, and there must not be: a directory that showed a
 * stale list as current would tell a volunteer somebody is registered who is
 * not, or hide somebody who is.
 */

const ATTENDEES_ENDPOINT = '/api/attendees'

const TIMEOUT_MS = 15_000

/**
 * Every message an operator can see. Server response text is NEVER rendered.
 */
export const ATTENDEE_MESSAGES = {
  offline: 'Attendees requires an internet connection.',
  unreachable:
    'Unable to reach the server. Check the connection and try again.',
  sessionExpired:
    'Device sign-in is no longer valid. Open Device Sign-In and sign in again.',
  attendeesRequired:
    'This device does not have Attendees access. An administrator grants it.',
  registerUnavailable:
    'The attendee register could not be read right now. Try again in a moment.',
  unexpected: 'The server returned an unexpected response.',
} as const

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

export type AttendeeDirectoryResult =
  | { status: 'loaded'; attendees: EventAttendee[] }
  | { status: 'unauthenticated'; message: string }
  | { status: 'not-permitted'; message: string }
  /**
   * The register could not be read. DISTINCT from an empty directory, which
   * is `loaded` with no attendees — conflating the two would present an
   * unreadable Sheet as an event nobody has registered for.
   */
  | { status: 'register-unavailable'; message: string }
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

export const fetchAttendeeDirectory = async (): Promise<AttendeeDirectoryResult> => {
  const controller = new AbortController()
  /**
   * The ONLY timer in this module, and it exists to ABORT rather than to
   * retry: a request that never answers must end, and a directory that
   * retried itself on a schedule would be the polling this module refuses.
   */
  const timeout = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)

  let response: Response

  try {
    response = await fetch(ATTENDEES_ENDPOINT, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
  } catch {
    return { status: 'unreachable', message: ATTENDEE_MESSAGES.unreachable }
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: ATTENDEE_MESSAGES.sessionExpired }
  }

  if (response.status === 403) {
    // A 403 without the typed reason is a refused origin, not a permission
    // answer, and must not be rendered as one.
    return blockedReason(await readJson(response)) === 'attendees-required'
      ? { status: 'not-permitted', message: ATTENDEE_MESSAGES.attendeesRequired }
      : { status: 'unexpected', message: ATTENDEE_MESSAGES.unexpected }
  }

  if (response.status === 503) {
    return {
      status: 'register-unavailable',
      message: ATTENDEE_MESSAGES.registerUnavailable,
    }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: ATTENDEE_MESSAGES.unexpected }
  }

  const body = await readJson(response)
  const attendees = parseAttendeeList(
    typeof body === 'object' && body !== null
      ? (body as { attendees?: unknown }).attendees
      : null,
  )

  // A 200 that does not validate is not a directory. Fails closed rather than
  // rendering whatever arrived.
  if (attendees === null) {
    return { status: 'unexpected', message: ATTENDEE_MESSAGES.unexpected }
  }

  return { status: 'loaded', attendees }
}
