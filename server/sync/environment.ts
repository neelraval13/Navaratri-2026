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
 * Dashboards and `.env` files commonly store a PEM with escaped newlines, which
 * arrives as the two characters `\` `n`. Google's JWT client needs real ones.
 *
 * The key itself is never logged, returned, or included in any error.
 */
export const normalizePrivateKey = (value: string): string => {
  return value.replace(/\\n/g, '\n').trim()
}

const readValue = (name: string): string => {
  return (process.env[name] ?? '').trim()
}

/**
 * Returns null when ANY required variable is missing, so the endpoint fails
 * closed with `sync-not-configured` instead of half-operating.
 */
export const readSyncEnvironment = (): SyncEnvironment | null => {
  const spreadsheetId = readValue('GOOGLE_SHEETS_SPREADSHEET_ID')
  const serviceAccountEmail = readValue('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const rawPrivateKey = readValue('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
  const allowedOrigin = readValue('SYNC_ALLOWED_ORIGIN')

  const privateKey = normalizePrivateKey(rawPrivateKey)

  if (
    spreadsheetId === '' ||
    serviceAccountEmail === '' ||
    privateKey === '' ||
    allowedOrigin === ''
  ) {
    return null
  }

  return { spreadsheetId, serviceAccountEmail, privateKey, allowedOrigin }
}
