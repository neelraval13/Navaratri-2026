import {
  getOperatorAccess,
  setOperatorAccess,
  type OperatorAccessState,
} from '@/auth/operator-access-store'
import {
  clearTrustedDevice,
  isDeviceTrusted,
  markDeviceTrusted,
} from '@/auth/trusted-device'
import { requestOutboxSync } from '@/sync/outbox-sync'

const SESSION_ENDPOINT = '/api/operator-session'
const LOGIN_ENDPOINT = '/api/operator-login'
const LOGOUT_ENDPOINT = '/api/operator-logout'

/** An unlock must not hang a desk. Short, because the operator is waiting. */
const AUTH_TIMEOUT_MS = 15_000

export const OPERATOR_ACCESS_MESSAGES = {
  incorrect: 'Access code is incorrect.',
  notConfigured: 'Operator access is not configured.',
  unreachable: 'Could not reach the server. Try again when online.',
} as const

export interface UnlockResult {
  ok: boolean
  message?: string
}

type SessionVerdict =
  | 'authenticated'
  | 'unauthenticated'
  | 'not-configured'
  | 'unreachable'

const isBrowserOffline = (): boolean => {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

const postJson = async (url: string, body?: unknown): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, AUTH_TIMEOUT_MS)

  try {
    return await fetch(url, {
      method: 'POST',
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Asks the server whether this browser holds a valid session.
 *
 * The access code is never involved: only the HttpOnly cookie, which this code
 * cannot read and never sees.
 */
const verifyOperatorSession = async (): Promise<SessionVerdict> => {
  try {
    const response = await fetch(SESSION_ENDPOINT, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    })

    if (response.status === 503) {
      return 'not-configured'
    }

    const body: unknown = await response.json()

    const authenticated =
      typeof body === 'object' &&
      body !== null &&
      (body as Record<string, unknown>).authenticated === true

    return authenticated ? 'authenticated' : 'unauthenticated'
  } catch {
    // Unreachable is NOT "unauthenticated": a flaky network must never lock a
    // desk out of a session it legitimately holds.
    return 'unreachable'
  }
}

const unlockedState: OperatorAccessState = { phase: 'unlocked', lockReason: null }

let activeRefresh: Promise<void> | null = null

const runRefresh = async (): Promise<void> => {
  const trusted = isDeviceTrusted()

  /**
   * Offline: no auth request is attempted at all. A device that has been
   * unlocked before simply opens; one that never has is told to connect once.
   */
  if (isBrowserOffline()) {
    setOperatorAccess(
      trusted ? unlockedState : { phase: 'locked', lockReason: 'offline-first-use' },
    )

    return
  }

  const verdict = await verifyOperatorSession()

  if (verdict === 'authenticated') {
    markDeviceTrusted()
    setOperatorAccess(unlockedState)

    return
  }

  if (verdict === 'unreachable') {
    setOperatorAccess(
      trusted ? unlockedState : { phase: 'locked', lockReason: 'unreachable' },
    )

    return
  }

  /**
   * The server rejected the session. A trusted device keeps the application
   * open and shows a banner — the form is never yanked away mid-registration.
   * Only a device that has never been unlocked sees the hard gate.
   */
  setOperatorAccess(
    trusted
      ? { phase: 'expired', lockReason: null }
      : {
          phase: 'locked',
          lockReason: verdict === 'not-configured' ? 'not-configured' : 'new-device',
        },
  )
}

/** Single-flight: concurrent callers share the running check. */
export const refreshOperatorAccess = (): Promise<void> => {
  const existing = activeRefresh

  if (existing !== null) {
    return existing
  }

  const refresh = runRefresh().finally(() => {
    if (activeRefresh === refresh) {
      activeRefresh = null
    }
  })

  activeRefresh = refresh

  return refresh
}

/**
 * Exchanges the access code for a session cookie.
 *
 * The code is sent once and never retained: it is not stored in IndexedDB,
 * localStorage, sessionStorage or any module variable.
 */
export const unlockOperatorAccess = async (
  accessCode: string,
): Promise<UnlockResult> => {
  if (isBrowserOffline()) {
    return { ok: false, message: OPERATOR_ACCESS_MESSAGES.unreachable }
  }

  let response: Response

  try {
    response = await postJson(LOGIN_ENDPOINT, { accessCode })
  } catch {
    return { ok: false, message: OPERATOR_ACCESS_MESSAGES.unreachable }
  }

  if (response.status === 503) {
    return { ok: false, message: OPERATOR_ACCESS_MESSAGES.notConfigured }
  }

  if (!response.ok) {
    return { ok: false, message: OPERATOR_ACCESS_MESSAGES.incorrect }
  }

  markDeviceTrusted()
  setOperatorAccess(unlockedState)

  /**
   * Rows parked on `unauthorized` are held by the attention rule, which no
   * timer clears. A manual cycle is what releases them, so the operator does
   * not have to unlock and then also press Retry.
   */
  void requestOutboxSync({ manual: true })

  return { ok: true }
}

/**
 * Ends the operator session on this device.
 *
 * Auth only. It never touches IndexedDB, registrations, the outbox, the event
 * config, `nextBadge` or the PWA cache.
 */
export const lockOperatorDevice = async (): Promise<void> => {
  try {
    await postJson(LOGOUT_ENDPOINT)
  } catch {
    // The local marker is still cleared below. The server cookie is removed by
    // the next online logout, or expires on its own.
  }

  clearTrustedDevice()
  setOperatorAccess({ phase: 'locked', lockReason: 'new-device' })
}

export { getOperatorAccess }
