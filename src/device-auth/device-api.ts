import {
  parseDeviceBadgeRange,
  parseDeviceSessionContext,
  type DeviceBadgeRange,
  type DeviceSessionContext,
} from '@/device-auth/device-session-contract'
import { isBadgeClaimConflict } from '@/shared/badge-claim-contract'
import { CURRENT_EVENT_SLUG } from '@/shared/event'

/**
 * The browser's only interface to the central device realm.
 *
 * It holds no credential of its own. The session lives in an HttpOnly cookie
 * the browser attaches automatically — this module never reads
 * `document.cookie`, and could not see it if it did.
 *
 * No server secret, hash or session version ever enters this file.
 */

/**
 * One endpoint, three methods: POST signs in, GET introspects, DELETE signs
 * out. Each file under `api/` is a deployment Function and the Hobby plan
 * allows twelve, so the device credential's lifecycle spends one rather than
 * three.
 */
const DEVICE_AUTH_ENDPOINT = '/api/device-auth'

/**
 * The self-claim endpoint. Its own Function, because it is not authentication
 * — it is an authenticated central mutation, and the method dispatcher on
 * `/api/device-auth` is already spoken for by the credential's lifecycle.
 */
const DEVICE_BADGE_CLAIM_ENDPOINT = '/api/device-badge-claim'

const TIMEOUT_MS = 15_000

/**
 * Every message an operator can see. Server response text is NEVER rendered:
 * a generic 401 must stay generic, and nothing may reveal whether a login
 * name exists.
 */
export const DEVICE_MESSAGES = {
  failed: 'Device login failed. Check the login name and password.',
  disabled: 'This device is disabled. Ask an administrator to enable it.',
  eventInactive: 'This event is not active.',
  tooManyAttempts: 'Too many login attempts. Wait a moment and try again.',
  notConfigured: 'Device authentication is not configured right now.',
  unreachable: 'Unable to reach the server. Check the connection and try again.',
  unexpected: 'The server returned an unexpected response.',
  claimUnconfirmed:
    'Claim status could not be confirmed. Refresh the device status before trying again.',
  claimSessionExpired:
    'Device sign-in is no longer valid. Refresh the device status and sign in again to claim a badge range.',
  claimRegistrationRequired:
    'Registration access is no longer available for this device.',
  claimOverlap:
    'Those badges overlap a range already assigned to another device. Check the physical badge stack at this desk and enter a different range.',
  claimAlreadyAssigned: 'This device already has a central badge assignment.',
  claimTooMany: 'Too many requests. Wait a moment and try again.',
  claimInvalidRange:
    'Enter a valid badge range. The first badge must not be after the last badge.',
  claimFailed:
    'Something went wrong while claiming this badge range. Try again, or refresh the device status.',
} as const

export type DeviceLoginResult =
  | { ok: true; context: DeviceSessionContext }
  | { ok: false; message: string }

/**
 * `unreachable` is distinguished from every other failure because the page
 * treats it differently: offline is not a rejected credential, and a cached
 * enrollment may be shown as "last verified" rather than as an error.
 */
export type DeviceSessionResult =
  | { status: 'authenticated'; context: DeviceSessionContext }
  | { status: 'unauthenticated' }
  | { status: 'not-configured' }
  | { status: 'unreachable' }
  | { status: 'unexpected' }

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

const blockedMessage = (body: unknown): string => {
  const blocked =
    typeof body === 'object' && body !== null && 'blocked' in body
      ? (body as { blocked: unknown }).blocked
      : null

  if (blocked === 'device-disabled') {
    return DEVICE_MESSAGES.disabled
  }

  if (blocked === 'event-inactive') {
    return DEVICE_MESSAGES.eventInactive
  }

  return DEVICE_MESSAGES.failed
}

/**
 * Signs this browser in as a central device.
 *
 * The event slug is supplied by the application, never typed: this build
 * serves one event, and asking an operator for a slug invites a typo that
 * would look exactly like a wrong password.
 *
 * The password is sent EXACTLY as entered — never trimmed, case folded or
 * normalised — over HTTPS, and is not retained here.
 */
export const loginDevice = async (credentials: {
  loginName: string
  password: string
}): Promise<DeviceLoginResult> => {
  let response: Response

  try {
    response = await request(DEVICE_AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventSlug: CURRENT_EVENT_SLUG,
        loginName: credentials.loginName,
        password: credentials.password,
      }),
    })
  } catch {
    return { ok: false, message: DEVICE_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    // Deliberately one message. The server does not distinguish an unknown
    // event, an unknown login name, unprovisioned credentials and a wrong
    // password, and neither may this.
    return { ok: false, message: DEVICE_MESSAGES.failed }
  }

  if (response.status === 403) {
    return { ok: false, message: blockedMessage(await readJson(response)) }
  }

  if (response.status === 429) {
    return { ok: false, message: DEVICE_MESSAGES.tooManyAttempts }
  }

  if (response.status === 503) {
    return { ok: false, message: DEVICE_MESSAGES.notConfigured }
  }

  if (!response.ok) {
    return { ok: false, message: DEVICE_MESSAGES.unexpected }
  }

  const context = parseDeviceSessionContext(await readJson(response))

  // A 200 that does not validate is not a login.
  if (context === null) {
    return { ok: false, message: DEVICE_MESSAGES.unexpected }
  }

  return { ok: true, context }
}

/**
 * Asks the SERVER whether this browser holds a valid device session.
 *
 * The only way to know. A cached enrollment can never stand in for this
 * answer, and there is no polling — callers invoke it on mount, after a
 * login, and when the operator explicitly refreshes.
 */
export const getDeviceSession = async (): Promise<DeviceSessionResult> => {
  let response: Response

  try {
    response = await request(DEVICE_AUTH_ENDPOINT, { method: 'GET' })
  } catch {
    return { status: 'unreachable' }
  }

  if (response.status === 503) {
    return { status: 'not-configured' }
  }

  if (!response.ok) {
    return { status: 'unexpected' }
  }

  const body = await readJson(response)

  if (typeof body !== 'object' || body === null) {
    return { status: 'unexpected' }
  }

  if ((body as { configured?: unknown }).configured === false) {
    return { status: 'not-configured' }
  }

  if ((body as { authenticated?: unknown }).authenticated !== true) {
    return { status: 'unauthenticated' }
  }

  const context = parseDeviceSessionContext(body)

  return context === null ? { status: 'unexpected' } : { status: 'authenticated', context }
}

/**
 * Ends the DEVICE session on the server.
 *
 * Auth only: it clears one cookie. It never touches Operator Access, Admin,
 * IndexedDB, the badge range or the outbox. A failure is reported honestly
 * rather than assumed — the caller must not claim the server cookie is gone
 * when the request never arrived.
 */
export const logoutDevice = async (): Promise<{ ok: boolean }> => {
  try {
    const response = await request(DEVICE_AUTH_ENDPOINT, { method: 'DELETE' })

    return { ok: response.ok }
  } catch {
    return { ok: false }
  }
}

/**
 * Every answer the self-claim endpoint can produce, as the UI needs it.
 *
 * `unreachable` is AMBIGUOUS and is deliberately not a failure: the request
 * may have committed in Postgres with the response lost on the way back. The
 * caller must re-check central state rather than assume either outcome.
 */
export type DeviceBadgeClaimResult =
  | { status: 'claimed'; activeBadgeRange: DeviceBadgeRange }
  /** An identical range was already reserved for this device. Idempotent. */
  | { status: 'already-claimed'; activeBadgeRange: DeviceBadgeRange }
  /** This device owns a DIFFERENT range. Its own range, when readable. */
  | {
      status: 'already-assigned'
      activeBadgeRange: DeviceBadgeRange | null
      message: string
    }
  | { status: 'range-overlap'; message: string }
  | { status: 'registration-required'; message: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'not-configured'; message: string }
  | { status: 'unreachable'; message: string }
  | { status: 'unexpected'; message: string }

/**
 * A 409 carries a PUBLIC conflict identifier whose spelling both sides import
 * from `@/shared/badge-claim-contract`. Recognising it by the shared guard is
 * what keeps an ordinary operational conflict — an overlapping badge range —
 * from falling through to `unexpected` and reaching the desk as a technical
 * error.
 *
 * `unexpected` is reserved for a body this contract genuinely does not
 * describe.
 */
const claimConflict = (body: unknown): DeviceBadgeClaimResult => {
  const raw =
    typeof body === 'object' && body !== null && 'conflict' in body
      ? (body as { conflict: unknown }).conflict
      : null

  if (!isBadgeClaimConflict(raw)) {
    return { status: 'unexpected', message: DEVICE_MESSAGES.claimFailed }
  }

  if (raw === 'already-assigned') {
    return {
      status: 'already-assigned',
      // A missing or malformed range is reported as absent rather than
      // guessed at; the next session check is the authority either way.
      activeBadgeRange: parseDeviceBadgeRange(
        (body as { activeBadgeRange?: unknown }).activeBadgeRange,
      ),
      message: DEVICE_MESSAGES.claimAlreadyAssigned,
    }
  }

  if (raw === 'range-overlap') {
    return { status: 'range-overlap', message: DEVICE_MESSAGES.claimOverlap }
  }

  /**
   * `device-event-mismatch`. Named by the contract, so it is not an unknown
   * response — but it means central state disagrees with itself, which only a
   * fresh session check can resolve.
   */
  return { status: 'unexpected', message: DEVICE_MESSAGES.claimFailed }
}

/**
 * Asks central Postgres to record that THIS device owns a badge range.
 *
 * The device is identified by its HttpOnly session cookie alone. No device
 * id, event id, event slug or login name is sent — the server would refuse
 * them, and a browser that believes it can name its own device is a browser
 * one bug away from claiming on another's behalf.
 *
 * `physicalStackConfirmed` travels as a mutation guard, never as data to
 * store: the server cannot see the badges, but it can require that the
 * deliberate confirmation happened.
 *
 * The response is validated at RUNTIME. A 200 whose range does not parse is
 * not a claim, because the number that comes back decides which physical
 * badges this desk will hand out.
 */
export const claimDeviceBadgeRange = async (input: {
  rangeStart: number
  rangeEnd: number
  physicalStackConfirmed: boolean
}): Promise<DeviceBadgeClaimResult> => {
  let response: Response

  try {
    response = await request(DEVICE_BADGE_CLAIM_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        physicalStackConfirmed: input.physicalStackConfirmed,
      }),
    })
  } catch {
    // Includes the abort on timeout. The reservation may still have
    // committed, so this is never reported as a refusal.
    return { status: 'unreachable', message: DEVICE_MESSAGES.claimUnconfirmed }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated', message: DEVICE_MESSAGES.claimSessionExpired }
  }

  if (response.status === 403) {
    const body = await readJson(response)
    const blocked =
      typeof body === 'object' && body !== null && 'blocked' in body
        ? (body as { blocked: unknown }).blocked
        : null

    // A 403 without the typed reason is a refused origin, not a permission
    // answer, and must not be rendered as one.
    return blocked === 'registration-required'
      ? {
          status: 'registration-required',
          message: DEVICE_MESSAGES.claimRegistrationRequired,
        }
      : { status: 'unexpected', message: DEVICE_MESSAGES.claimFailed }
  }

  if (response.status === 409) {
    return claimConflict(await readJson(response))
  }

  if (response.status === 429) {
    // Not a login, so it must not borrow the login copy: an operator told
    // "too many login attempts" after claiming a range looks locked out.
    return { status: 'unexpected', message: DEVICE_MESSAGES.claimTooMany }
  }

  if (response.status === 503) {
    return { status: 'not-configured', message: DEVICE_MESSAGES.notConfigured }
  }

  if (response.status === 400 || response.status === 413 || response.status === 415) {
    // The browser validates the range before enabling the button, so this is
    // close to unreachable — it still says what to fix rather than "invalid".
    return { status: 'invalid', message: DEVICE_MESSAGES.claimInvalidRange }
  }

  if (!response.ok) {
    return { status: 'unexpected', message: DEVICE_MESSAGES.claimFailed }
  }

  const body = await readJson(response)
  const outcome =
    typeof body === 'object' && body !== null && 'outcome' in body
      ? (body as { outcome: unknown }).outcome
      : null
  const activeBadgeRange = parseDeviceBadgeRange(
    typeof body === 'object' && body !== null
      ? (body as { activeBadgeRange?: unknown }).activeBadgeRange
      : null,
  )

  // A TypeScript annotation would be a claim; this is the check.
  if (activeBadgeRange === null || (outcome !== 'claimed' && outcome !== 'already-claimed')) {
    return { status: 'unexpected', message: DEVICE_MESSAGES.claimFailed }
  }

  return { status: outcome, activeBadgeRange }
}
