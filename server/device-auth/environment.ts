/**
 * Server-only DEVICE authentication configuration.
 *
 * A security realm independent of Admin. The name
 * must never be `VITE_` prefixed, and the value is never logged, returned or
 * exposed to browser code.
 *
 * Nothing at application startup depends on this. Phase 9C-B adds a device
 * realm that the event application does not yet use, so a deployment without
 * the variable keeps running exactly as before — device authentication simply
 * reports itself unavailable when it is actually invoked.
 */
export interface DeviceAuthEnvironment {
  sessionSecret: string
}

export const DEVICE_AUTH_ENVIRONMENT_NAMES = [
  'EVENT_DEVICE_SESSION_SECRET',
] as const

export const MIN_DEVICE_SESSION_SECRET_LENGTH = 32

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type DeviceAuthDisabledReason =
  | 'session-secret-missing'
  | 'session-secret-too-short'

export type DeviceAuthEnvironmentResult =
  | { ok: true; environment: DeviceAuthEnvironment }
  | { ok: false; reason: DeviceAuthDisabledReason }

/** Names the problem, never a value — not even a length beyond the minimum. */
export const DEVICE_AUTH_LOG_MESSAGES: Record<DeviceAuthDisabledReason, string> = {
  'session-secret-missing': 'EVENT_DEVICE_SESSION_SECRET is not set.',
  'session-secret-too-short': `EVENT_DEVICE_SESSION_SECRET is shorter than ${String(MIN_DEVICE_SESSION_SECRET_LENGTH)} characters.`,
}

/**
 * The value is taken EXACTLY as configured: no trimming, no case folding. A
 * secret with a stray space is a different secret, and repairing it would
 * mean the value a human thinks they configured is not the value that signs
 * device sessions.
 *
 * It should be generated independently of `EVENT_ADMIN_SESSION_SECRET` — but
 * realm isolation does NOT depend on that. See the signing context in
 * `session.ts`.
 */
export const readDeviceAuthEnvironment = (
  source: EnvironmentSource = process.env,
): DeviceAuthEnvironmentResult => {
  const sessionSecret = source.EVENT_DEVICE_SESSION_SECRET ?? ''

  if (sessionSecret === '') {
    return { ok: false, reason: 'session-secret-missing' }
  }

  if (sessionSecret.length < MIN_DEVICE_SESSION_SECRET_LENGTH) {
    return { ok: false, reason: 'session-secret-too-short' }
  }

  return { ok: true, environment: { sessionSecret } }
}
