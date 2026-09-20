import { google, type sheets_v4 } from 'googleapis'

import type { SyncEnvironment } from './environment.js'

/** The narrowest scope that can read and write the target spreadsheet. */
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

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
export const createSheetsClient = (
  environment: SyncEnvironment,
): SheetsClient => {
  const auth = new google.auth.JWT({
    email: environment.serviceAccountEmail,
    key: environment.privateKey,
    scopes: [SHEETS_SCOPE],
  })

  return google.sheets({ version: 'v4', auth })
}
