import {
  parseDeviceSessionContext,
  type DeviceSessionContext,
} from '@/device-auth/device-session-contract'
import { CURRENT_EVENT_SLUG } from '@/shared/event'

/**
 * The browser's only interface to the central device realm.
 *
 * It talks to exactly three endpoints and holds no credential of its own. The
 * session lives in an HttpOnly cookie the browser attaches automatically —
 * this module never reads `document.cookie`, and could not see it if it did.
 *
 * No server secret, hash or session version ever enters this file.
 */

const LOGIN_ENDPOINT = '/api/device-login'
const SESSION_ENDPOINT = '/api/device-session'
const LOGOUT_ENDPOINT = '/api/device-logout'

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
    response = await request(LOGIN_ENDPOINT, {
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
    response = await request(SESSION_ENDPOINT, { method: 'GET' })
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
    const response = await request(LOGOUT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    return { ok: response.ok }
  } catch {
    return { ok: false }
  }
}
