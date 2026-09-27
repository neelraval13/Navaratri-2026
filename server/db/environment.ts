/**
 * Server-only database configuration.
 *
 * `DATABASE_URL` must NEVER be given a `VITE_` prefix: everything so named is
 * compiled into the browser bundle, and a connection string carries
 * credentials.
 */
export const DATABASE_ENVIRONMENT_NAMES = ['DATABASE_URL'] as const

/** Injectable so the policy is testable without mutating the real process. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type DatabaseDisabledReason = 'database-url-missing'

export type DatabaseEnvironmentResult =
  | { ok: true; databaseUrl: string }
  | { ok: false; reason: DatabaseDisabledReason }

/**
 * Operator-facing messages. They name the problem and NEVER the value — a
 * connection string is a credential, so it must not reach a log line, an error
 * message or an HTTP response.
 */
export const DATABASE_DISABLED_MESSAGES: Record<DatabaseDisabledReason, string> = {
  'database-url-missing': 'DATABASE_URL is not set on this deployment.',
}

/**
 * Reads the database configuration.
 *
 * The value is used EXACTLY as configured. It is checked for emptiness only —
 * trimming a connection string could silently produce a different secret from
 * the one a human configured.
 *
 * This performs no connection: validating configuration must never open a
 * socket, least of all at module import.
 */
export const readDatabaseEnvironment = (
  source: EnvironmentSource = process.env,
): DatabaseEnvironmentResult => {
  const databaseUrl = source.DATABASE_URL

  if (databaseUrl === undefined || databaseUrl === '') {
    return { ok: false, reason: 'database-url-missing' }
  }

  return { ok: true, databaseUrl }
}

/**
 * Thrown when database functionality is invoked without configuration.
 *
 * Phase 9A functionality is not part of any live workflow, so the application
 * still loads, routes, registers devices, issues badges offline and syncs to
 * Sheets with `DATABASE_URL` absent. Only a deliberate database call fails,
 * and it fails closed.
 */
export class DatabaseNotConfiguredError extends Error {
  readonly reason: DatabaseDisabledReason

  constructor(reason: DatabaseDisabledReason) {
    // The message names the reason only. The URL is never interpolated.
    super(DATABASE_DISABLED_MESSAGES[reason])
    this.name = 'DatabaseNotConfiguredError'
    this.reason = reason
  }
}
