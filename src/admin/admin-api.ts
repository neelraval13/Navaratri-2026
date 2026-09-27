import {
  getAdminAccess,
  setAdminAccess,
  type AdminAccessState,
} from '@/admin/admin-access-store'
import type { DeviceAttribute } from '@/shared/device-attributes'

const SESSION_ENDPOINT = '/api/admin-session'
const LOGIN_ENDPOINT = '/api/admin-login'
const LOGOUT_ENDPOINT = '/api/admin-logout'
const EVENTS_ENDPOINT = '/api/admin-events'
const DEVICES_ENDPOINT = '/api/admin-devices'
const BADGE_ENDPOINT = '/api/admin-badge-assignment'

const TIMEOUT_MS = 15_000

export const ADMIN_MESSAGES = {
  incorrect: 'Access code is incorrect.',
  notConfigured: 'Admin access is not configured.',
  tooManyAttempts: 'Too many admin login attempts. Wait a moment and try again.',
  unreachable: 'Could not reach the server. Admin needs a connection.',
  unavailable: 'Unable to sign in. Try again.',
} as const

export interface AdminEvent {
  id: string
  slug: string
  name: string
  timezone: string
  startsAt: string | null
  endsAt: string | null
  active: boolean
}

export interface AdminBadgeRange {
  rangeStart: number
  rangeEnd: number
  assignedAt: string
}

export interface AdminDevice {
  id: string
  eventId: string
  name: string
  loginName: string | null
  enabled: boolean
  lastSeenAt: string | null
  createdAt: string
  attributes: DeviceAttribute[]
  activeBadgeRange: AdminBadgeRange | null
}

export type AdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

const request = async (
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
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

const readMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body: unknown = await response.json()

    if (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as Record<string, unknown>).message === 'string'
    ) {
      return (body as { message: string }).message
    }
  } catch {
    // Fall through: a body we cannot read is never rendered raw.
  }

  return fallback
}

/** Every mutating call goes through this, so 401 always re-locks the UI. */
const json = async <T>(
  url: string,
  init: RequestInit,
  pick: (body: Record<string, unknown>) => T,
): Promise<AdminResult<T>> => {
  let response: Response

  try {
    response = await request(url, init)
  } catch {
    return { ok: false, message: ADMIN_MESSAGES.unreachable }
  }

  if (response.status === 401) {
    setAdminAccess({ phase: 'locked', reason: null })

    return { ok: false, message: 'Your admin session has ended. Sign in again.' }
  }

  if (response.status === 503) {
    setAdminAccess({ phase: 'unavailable', reason: 'database-unavailable' })

    return { ok: false, message: 'The central database is not available.' }
  }

  if (!response.ok) {
    return { ok: false, message: await readMessage(response, 'That could not be completed.') }
  }

  try {
    return { ok: true, value: pick((await response.json()) as Record<string, unknown>) }
  } catch {
    return { ok: false, message: 'The server returned an unexpected response.' }
  }
}

const mutation = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const UNLOCKED: AdminAccessState = { phase: 'authenticated', reason: null }

export const refreshAdminAccess = async (): Promise<void> => {
  let response: Response

  try {
    response = await request(SESSION_ENDPOINT, { method: 'GET' })
  } catch {
    setAdminAccess({ phase: 'unavailable', reason: 'unreachable' })

    return
  }

  if (response.status === 503) {
    setAdminAccess({ phase: 'unavailable', reason: 'not-configured' })

    return
  }

  let body: Record<string, unknown>

  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    setAdminAccess({ phase: 'unavailable', reason: 'unreachable' })

    return
  }

  if (body.authenticated !== true) {
    setAdminAccess({ phase: 'locked', reason: null })

    return
  }

  setAdminAccess(
    body.databaseConfigured === false
      ? { phase: 'unavailable', reason: 'database-unavailable' }
      : UNLOCKED,
  )
}

/**
 * The access code is held only long enough to send it. It is never written to
 * IndexedDB, localStorage or sessionStorage, and the reply carries no token —
 * the session arrives as an HttpOnly cookie.
 */
export const adminLogin = async (accessCode: string): Promise<AdminResult<true>> => {
  let response: Response

  try {
    response = await request(LOGIN_ENDPOINT, mutation({ accessCode }, 'POST'))
  } catch {
    return { ok: false, message: ADMIN_MESSAGES.unreachable }
  }

  if (response.status === 503) {
    return { ok: false, message: ADMIN_MESSAGES.notConfigured }
  }

  /**
   * From the edge rate limiter, which the endpoint knows nothing about.
   * It reveals no address, no counter and nothing about the submitted code.
   */
  if (response.status === 429) {
    return { ok: false, message: ADMIN_MESSAGES.tooManyAttempts }
  }

  if (response.status === 401) {
    return { ok: false, message: ADMIN_MESSAGES.incorrect }
  }

  if (!response.ok) {
    return { ok: false, message: ADMIN_MESSAGES.unavailable }
  }

  await refreshAdminAccess()

  return { ok: true, value: true }
}

/** Clears only the admin cookie. Operator Access is a separate realm. */
export const adminLogout = async (): Promise<void> => {
  try {
    await request(LOGOUT_ENDPOINT, { method: 'POST' })
  } catch {
    // The local state is still locked below.
  }

  setAdminAccess({ phase: 'locked', reason: null })
}

export const fetchEvents = async (): Promise<AdminResult<AdminEvent[]>> =>
  json(EVENTS_ENDPOINT, { method: 'GET' }, (body) => body.events as AdminEvent[])

export const createEvent = async (input: {
  name: string
  slug: string
  timezone: string
}): Promise<AdminResult<AdminEvent>> =>
  json(EVENTS_ENDPOINT, mutation(input, 'POST'), (body) => body.event as AdminEvent)

export const fetchDevices = async (eventId: string): Promise<AdminResult<AdminDevice[]>> =>
  json(
    `${DEVICES_ENDPOINT}?eventId=${encodeURIComponent(eventId)}`,
    { method: 'GET' },
    (body) => body.devices as AdminDevice[],
  )

export const createDevice = async (input: {
  eventId: string
  name: string
  loginName: string | null
  enabled: boolean
  attributes: DeviceAttribute[]
}): Promise<AdminResult<AdminDevice>> =>
  json(DEVICES_ENDPOINT, mutation(input, 'POST'), (body) => body.device as AdminDevice)

/**
 * The COMPLETE Edit Device operation: fields and the exact attribute set in
 * ONE request, so a refused attribute change can never leave a rename already
 * persisted. The reply carries the whole updated device, so the caller can
 * update that one card without reloading the registry.
 */
export const updateDevice = async (input: {
  deviceId: string
  eventId: string
  name: string
  loginName: string | null
  enabled: boolean
  attributes: DeviceAttribute[]
}): Promise<AdminResult<AdminDevice>> =>
  json(DEVICES_ENDPOINT, mutation(input, 'PATCH'), (body) => body.device as AdminDevice)

export const assignBadgeRange = async (input: {
  eventId: string
  deviceId: string
  rangeStart: number
  rangeEnd: number
}): Promise<AdminResult<AdminBadgeRange>> =>
  json(BADGE_ENDPOINT, mutation(input, 'POST'), (body) => body.badgeRange as AdminBadgeRange)

export { getAdminAccess }
