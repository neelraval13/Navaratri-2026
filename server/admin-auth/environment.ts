/**
 * Server-only ADMIN configuration.
 *
 * A completely separate security realm from device auth. Neither name may
 * ever be `VITE_` prefixed, and neither value is logged, returned or exposed
 * to browser code.
 */
export interface AdminAuthEnvironment {
  accessCode: string
  sessionSecret: string
}

export const ADMIN_AUTH_ENVIRONMENT_NAMES = [
  'EVENT_ADMIN_ACCESS_CODE',
  'EVENT_ADMIN_SESSION_SECRET',
] as const

/**
 * The floor, not a recommendation.
 *
 * Admin can create devices and assign badge ranges for the whole event, so a
 * short code leans heavily on the edge rate limit for `POST /api/admin-auth`
 * (5 attempts per minute per IP) and on the fixed wrong-code delay. Neither
 * is a substitute for entropy — use a passphrase well above this minimum.
 */
export const MIN_ADMIN_ACCESS_CODE_LENGTH = 8

export const MIN_ADMIN_SESSION_SECRET_LENGTH = 32

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type AdminAuthDisabledReason =
  | 'access-code-missing'
  | 'access-code-too-short'
  | 'session-secret-missing'
  | 'session-secret-too-short'

export type AdminAuthEnvironmentResult =
  | { ok: true; environment: AdminAuthEnvironment }
  | { ok: false; reason: AdminAuthDisabledReason }

/** Names the problem, never a value — not even a length beyond the minimum. */
export const ADMIN_AUTH_LOG_MESSAGES: Record<AdminAuthDisabledReason, string> = {
  'access-code-missing': 'EVENT_ADMIN_ACCESS_CODE is not set.',
  'access-code-too-short': `EVENT_ADMIN_ACCESS_CODE is shorter than ${String(MIN_ADMIN_ACCESS_CODE_LENGTH)} characters.`,
  'session-secret-missing': 'EVENT_ADMIN_SESSION_SECRET is not set.',
  'session-secret-too-short': `EVENT_ADMIN_SESSION_SECRET is shorter than ${String(MIN_ADMIN_SESSION_SECRET_LENGTH)} characters.`,
}

/**
 * Values are taken EXACTLY as configured: no trimming, no case folding. A code
 * with a stray space is a different code, and repairing it would mean the
 * value a human thinks they configured is not the value that unlocks Admin.
 */
export const readAdminAuthEnvironment = (
  source: EnvironmentSource = process.env,
): AdminAuthEnvironmentResult => {
  const accessCode = source.EVENT_ADMIN_ACCESS_CODE ?? ''
  const sessionSecret = source.EVENT_ADMIN_SESSION_SECRET ?? ''

  if (accessCode === '') {
    return { ok: false, reason: 'access-code-missing' }
  }

  if (accessCode.length < MIN_ADMIN_ACCESS_CODE_LENGTH) {
    return { ok: false, reason: 'access-code-too-short' }
  }

  if (sessionSecret === '') {
    return { ok: false, reason: 'session-secret-missing' }
  }

  if (sessionSecret.length < MIN_ADMIN_SESSION_SECRET_LENGTH) {
    return { ok: false, reason: 'session-secret-too-short' }
  }

  return { ok: true, environment: { accessCode, sessionSecret } }
}
