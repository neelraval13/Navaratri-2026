/**
 * Server-only operator authentication configuration.
 *
 * Neither name may EVER be given a `VITE_` prefix: everything so prefixed is
 * compiled into the browser bundle, and both of these values grant access.
 */
export interface OperatorAuthEnvironment {
  accessCode: string
  sessionSecret: string
}

export const OPERATOR_AUTH_ENVIRONMENT_NAMES = [
  'EVENT_OPERATOR_ACCESS_CODE',
  'EVENT_SESSION_SECRET',
] as const

/**
 * A shared desk code is only as good as its entropy, and a fixed response delay
 * is not a rate limiter. A short numeric PIN is therefore rejected as a
 * CONFIGURATION error rather than quietly accepted.
 */
export const MIN_ACCESS_CODE_LENGTH = 12

/** HMAC-SHA256 key material. 32 characters is the floor, not a target. */
export const MIN_SESSION_SECRET_LENGTH = 32

/** Injectable so the policy is testable without mutating the real process. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type OperatorAuthDisabledReason =
  | 'access-code-missing'
  | 'access-code-too-short'
  | 'session-secret-missing'
  | 'session-secret-too-short'

export type OperatorAuthEnvironmentResult =
  | { ok: true; environment: OperatorAuthEnvironment }
  | { ok: false; reason: OperatorAuthDisabledReason }

/**
 * Server log lines. They name the problem and NEVER a value — not the code, not
 * the secret, not even their lengths beyond the configured minimum.
 */
export const OPERATOR_AUTH_LOG_MESSAGES: Record<
  OperatorAuthDisabledReason,
  string
> = {
  'access-code-missing': 'EVENT_OPERATOR_ACCESS_CODE is not set.',
  'access-code-too-short': `EVENT_OPERATOR_ACCESS_CODE is shorter than ${String(MIN_ACCESS_CODE_LENGTH)} characters.`,
  'session-secret-missing': 'EVENT_SESSION_SECRET is not set.',
  'session-secret-too-short': `EVENT_SESSION_SECRET is shorter than ${String(MIN_SESSION_SECRET_LENGTH)} characters.`,
}

/**
 * Reads and validates the operator auth configuration.
 *
 * Values are taken EXACTLY as configured — no trimming. A code with a stray
 * space is a different code, and silently repairing it would mean the value a
 * human thinks they configured is not the value that unlocks the desk.
 */
export const readOperatorAuthEnvironment = (
  source: EnvironmentSource = process.env,
): OperatorAuthEnvironmentResult => {
  const accessCode = source.EVENT_OPERATOR_ACCESS_CODE ?? ''
  const sessionSecret = source.EVENT_SESSION_SECRET ?? ''

  if (accessCode === '') {
    return { ok: false, reason: 'access-code-missing' }
  }

  if (accessCode.length < MIN_ACCESS_CODE_LENGTH) {
    return { ok: false, reason: 'access-code-too-short' }
  }

  if (sessionSecret === '') {
    return { ok: false, reason: 'session-secret-missing' }
  }

  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    return { ok: false, reason: 'session-secret-too-short' }
  }

  return { ok: true, environment: { accessCode, sessionSecret } }
}
