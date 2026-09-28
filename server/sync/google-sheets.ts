import { google, type sheets_v4 } from 'googleapis'

import type { SyncEnvironment } from './environment.js'

/** The narrowest scope that can read and write the target spreadsheet. */
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

/**
 * The service-account credential, typed from the constructor this module
 * actually uses rather than from a package name.
 *
 * `google-auth-library` is a TRANSITIVE dependency of `googleapis`, so naming
 * it in an import would be a phantom dependency that pnpm's isolated layout
 * can refuse to resolve. Querying the constructor keeps the real type and adds
 * no dependency.
 */
export type SheetsAuth = InstanceType<typeof google.auth.JWT>

/**
 * A Sheets API surface plus the credential every request must carry.
 *
 * The two are kept SEPARATE on purpose. `google.sheets({ version, auth })`
 * binds the credential into the client, which reads well but goes through the
 * object overload of `google.sheets()` — and that overload resolves against
 * `GlobalOptions.auth`, whose type comes from the transitive
 * `google-auth-library`. Where that package does not resolve, the argument
 * matches neither overload and the call fails with TS2769. The string form
 * `google.sheets('v4')` has exactly one signature and cannot be ambiguous.
 *
 * The credential therefore travels on each request instead. It is NEVER set
 * through `google.options({ auth })`: that is process-global mutable state,
 * and a serverless instance serves concurrent invocations, so one request's
 * credential could be observed by another.
 */
export interface SheetsAccess {
  client: sheets_v4.Sheets
  auth: SheetsAuth
}

export type SheetsClient = sheets_v4.Sheets

/**
 * A service-account Sheets client.
 *
 * The human shares one existing spreadsheet with the service-account address;
 * this code never creates a spreadsheet of its own and only ever touches
 * `GOOGLE_SHEETS_SPREADSHEET_ID`.
 *
 * Neither the credentials object nor any token is ever logged.
 */
export const createSheetsAccess = (
  environment: SyncEnvironment,
): SheetsAccess => {
  const auth: SheetsAuth = new google.auth.JWT({
    email: environment.serviceAccountEmail,
    key: environment.privateKey,
    scopes: [SHEETS_SCOPE],
  })

  return { client: google.sheets('v4'), auth }
}
