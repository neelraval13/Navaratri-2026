/**
 * Server-only configuration. None of these names may ever be prefixed with
 * `VITE_`: everything so prefixed is compiled into the browser bundle, and a
 * service-account private key must never leave the server.
 */
export interface SyncEnvironment {
  spreadsheetId: string
  serviceAccountEmail: string
  privateKey: string
  allowedOrigin: string
}

export const REQUIRED_SYNC_ENVIRONMENT_NAMES = [
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'SYNC_ALLOWED_ORIGIN',
] as const

/**
 * The release interlock. Also server-only, and also never `VITE_` prefixed.
 */
export const SYNC_RELEASE_ENVIRONMENT_NAMES = [
  'SYNC_WRITE_ENABLED',
  'SYNC_ALLOWED_VERCEL_ENV',
] as const

export const ALLOWED_VERCEL_ENVIRONMENTS = [
  'development',
  'preview',
  'production',
] as const

export type AllowedVercelEnvironment =
  (typeof ALLOWED_VERCEL_ENVIRONMENTS)[number]

/** Injectable so the policy can be tested without mutating the real process. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type SyncDisabledReason =
  | 'writes-disabled'
  | 'runtime-environment-unknown'
  | 'runtime-environment-mismatch'
  | 'missing-credentials'

export type SyncEnvironmentResult =
  | { ok: true; environment: SyncEnvironment }
  | { ok: false; reason: SyncDisabledReason }

/**
 * Operator-facing log lines. They name the reason, never a value — a log is not
 * a place to reveal which credential is present or what an origin is set to.
 */
export const SYNC_DISABLED_LOG_MESSAGES: Record<SyncDisabledReason, string> = {
  'writes-disabled':
    'SYNC_WRITE_ENABLED is not exactly "true", so Sheet writes are intentionally disabled for this deployment.',
  'runtime-environment-unknown':
    'VERCEL_ENV is absent, so the runtime environment cannot be confirmed.',
  'runtime-environment-mismatch':
    'The runtime VERCEL_ENV does not match SYNC_ALLOWED_VERCEL_ENV.',
  'missing-credentials':
    'One or more required server environment variables are missing.',
}

/**
 * Dashboards and `.env` files commonly store a PEM with escaped newlines, which
 * arrives as the two characters `\` `n`. Google's JWT client needs real ones.
 *
 * The key itself is never logged, returned, or included in any error.
 */
export const normalizePrivateKey = (value: string): string => {
  return value.replace(/\\n/g, '\n').trim()
}

/**
 * The literal string `true` and NOTHING else enables writes.
 *
 * Not `TRUE`, not `True`, not `1`, not `yes`, and not `' true'` or `'true '`.
 * Whitespace is deliberately NOT trimmed: this is a production release
 * interlock, so a value that is not exactly right is a configuration failure to
 * be fixed, never something for the code to repair on the operator's behalf.
 *
 * Everything else — unset, blank, `false`, anything unrecognised — means
 * disabled, so the switch can only ever be turned on deliberately.
 */
export const parseSyncWriteEnabled = (value: string | undefined): boolean => {
  return value === 'true'
}

/**
 * Exact literals only, for the same reason: no trimming and no case folding.
 * Returns null for unset, blank, mis-cased, padded or unrecognised values.
 */
export const parseAllowedVercelEnvironment = (
  value: string | undefined,
): AllowedVercelEnvironment | null => {
  return ALLOWED_VERCEL_ENVIRONMENTS.includes(value as AllowedVercelEnvironment)
    ? (value as AllowedVercelEnvironment)
    : null
}

export interface SyncRuntimeInput {
  writeEnabled: boolean
  configuredVercelEnvironment: AllowedVercelEnvironment | null
  actualVercelEnvironment: string | undefined
}

export type SyncRuntimeVerdict =
  | { allowed: true }
  | {
      allowed: false
      reason: Exclude<SyncDisabledReason, 'missing-credentials'>
    }

/**
 * The release interlock, as a pure function.
 *
 * Google credentials existing on a deployment must never be enough to write to
 * the event ledger. A push can produce a deployment before a human intended one
 * to be live, so writes additionally require an explicit switch AND a runtime
 * that matches the environment the switch was set for.
 *
 * An absent `VERCEL_ENV` fails closed: this application is deliberately
 * deployed through Vercel, and an unrecognised runtime is exactly the situation
 * where writing to the real Sheet is least safe.
 */
export const isSyncRuntimeAllowed = (
  input: SyncRuntimeInput,
): SyncRuntimeVerdict => {
  if (!input.writeEnabled) {
    return { allowed: false, reason: 'writes-disabled' }
  }

  /**
   * The runtime value is not trimmed either. A padded `VERCEL_ENV` cannot match
   * a configured environment, and silently repairing it would defeat the point
   * of requiring the two to agree exactly.
   */
  const actual = input.actualVercelEnvironment ?? ''

  if (actual === '') {
    return { allowed: false, reason: 'runtime-environment-unknown' }
  }

  if (
    input.configuredVercelEnvironment === null ||
    actual !== input.configuredVercelEnvironment
  ) {
    return { allowed: false, reason: 'runtime-environment-mismatch' }
  }

  return { allowed: true }
}

const readValue = (source: EnvironmentSource, name: string): string => {
  return (source[name] ?? '').trim()
}

/**
 * The single entry point the endpoint uses.
 *
 * The interlock is evaluated BEFORE any credential is read, so a deployment
 * with writes disabled never handles a private key at all.
 *
 * Any failure returns a reason and no environment, so the endpoint fails closed
 * with the existing `sync-not-configured` contract rather than half-operating.
 */
export const readSyncEnvironment = (
  source: EnvironmentSource = process.env,
): SyncEnvironmentResult => {
  const runtime = isSyncRuntimeAllowed({
    writeEnabled: parseSyncWriteEnabled(source.SYNC_WRITE_ENABLED),
    configuredVercelEnvironment: parseAllowedVercelEnvironment(
      source.SYNC_ALLOWED_VERCEL_ENV,
    ),
    actualVercelEnvironment: source.VERCEL_ENV,
  })

  if (!runtime.allowed) {
    return { ok: false, reason: runtime.reason }
  }

  const spreadsheetId = readValue(source, 'GOOGLE_SHEETS_SPREADSHEET_ID')
  const serviceAccountEmail = readValue(source, 'GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const rawPrivateKey = readValue(source, 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
  const allowedOrigin = readValue(source, 'SYNC_ALLOWED_ORIGIN')

  const privateKey = normalizePrivateKey(rawPrivateKey)

  if (
    spreadsheetId === '' ||
    serviceAccountEmail === '' ||
    privateKey === '' ||
    allowedOrigin === ''
  ) {
    return { ok: false, reason: 'missing-credentials' }
  }

  return {
    ok: true,
    environment: {
      spreadsheetId,
      serviceAccountEmail,
      privateKey,
      allowedOrigin,
    },
  }
}
