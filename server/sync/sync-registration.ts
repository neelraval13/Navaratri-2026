import type {
  SyncCompletedPayload,
  SyncHeldPayload,
  SyncRegistrationRequest,
  SyncSuccessOutcome,
} from '../../src/shared/sync-contract'
import {
  decideCompletedSync,
  decideHeldSync,
  findByRegistrationId,
  findDuplicateRegistrationId,
  type SheetRowView,
} from './decisions'
import type { SyncEnvironment } from './environment'
import { createSheetsClient, type SheetsClient } from './google-sheets'
import {
  buildCompletedSyncRequests,
  buildHeldSyncRequests,
  buildTabInitializationRequests,
  type SheetsRequest,
} from './requests'
import {
  BADGE_REGISTER_COLUMNS,
  BADGE_REGISTER_HEADERS,
  BADGE_REGISTER_RANGE,
  BADGE_REGISTER_TITLE,
  HELD_REGISTRATIONS_COLUMNS,
  HELD_REGISTRATIONS_HEADERS,
  HELD_REGISTRATIONS_RANGE,
  HELD_REGISTRATIONS_TITLE,
  checkTabShape,
} from './sheet-contract'

export type SyncExecutionResult =
  | { ok: true; outcome: SyncSuccessOutcome }
  | { ok: false; outcome: 'badge-conflict'; badgeNumber: number }
  | { ok: false; outcome: 'sheet-shape-conflict'; message: string }
  | { ok: false; outcome: 'sync-failed'; message: string }

interface TabState {
  sheetId: number
  rows: SheetRowView[]
}

const readCell = (row: readonly unknown[], index: number): string => {
  const value = row[index]

  return typeof value === 'string' ? value.trim() : ''
}

const readBadgeNumber = (row: readonly unknown[]): number | undefined => {
  const value = row[BADGE_REGISTER_COLUMNS.badge]

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    // Sheets returns UNFORMATTED_VALUE as a number, but be tolerant of a cell a
    // human retyped as text.
    const parsed = Number(value.trim())

    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

const toRowViews = (
  dataRows: readonly (readonly unknown[])[],
  registrationIdColumn: number,
  updatedAtColumn: number,
  includeBadge: boolean,
): SheetRowView[] => {
  const views: SheetRowView[] = []

  dataRows.forEach((row, index) => {
    const registrationId = readCell(row, registrationIdColumn)

    // A blank or cleared row carries no identity and is simply skipped.
    if (registrationId === '') {
      return
    }

    views.push({
      index,
      registrationId,
      updatedAt: readCell(row, updatedAtColumn),
      ...(includeBadge ? { badgeNumber: readBadgeNumber(row) } : {}),
    })
  })

  return views
}

const runBatch = async (
  sheets: SheetsClient,
  spreadsheetId: string,
  requests: SheetsRequest[],
): Promise<void> => {
  if (requests.length === 0) {
    return
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  })
}

/**
 * Ensures both tabs exist and match the contract, then reads their data.
 *
 * Fails closed on a conflicting layout, on a blank header sitting above data a
 * human is maintaining, and on a tab that already contains the same Registration
 * ID twice. Unrelated tabs are never read, modified or deleted.
 */
const loadTabs = async (
  sheets: SheetsClient,
  spreadsheetId: string,
): Promise<
  | { ok: true; badgeRegister: TabState; heldRegistrations: TabState }
  | { ok: false; message: string }
> => {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })
  const existing = spreadsheet.data.sheets ?? []

  const resolveSheetId = (
    sheetList: typeof existing,
    title: string,
  ): number | undefined => {
    return (
      sheetList.find((sheet) => sheet.properties?.title === title)?.properties
        ?.sheetId ?? undefined
    )
  }

  const missingTitles = [BADGE_REGISTER_TITLE, HELD_REGISTRATIONS_TITLE].filter(
    (title) => resolveSheetId(existing, title) === undefined,
  )

  if (missingTitles.length > 0) {
    // A newly created tab is genuinely blank, so if initialisation below fails
    // a retry simply finds a blank tab and initialises it safely.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missingTitles.map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    })
  }

  const refreshed =
    missingTitles.length > 0
      ? ((await sheets.spreadsheets.get({ spreadsheetId })).data.sheets ?? [])
      : existing

  const badgeSheetId = resolveSheetId(refreshed, BADGE_REGISTER_TITLE)
  const heldSheetId = resolveSheetId(refreshed, HELD_REGISTRATIONS_TITLE)

  if (badgeSheetId === undefined || heldSheetId === undefined) {
    return { ok: false, message: 'Required tabs could not be created.' }
  }

  const values = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [BADGE_REGISTER_RANGE, HELD_REGISTRATIONS_RANGE],
    valueRenderOption: 'UNFORMATTED_VALUE',
  })

  const ranges = values.data.valueRanges ?? []
  const badgeValues = (ranges[0]?.values ?? []) as unknown[][]
  const heldValues = (ranges[1]?.values ?? []) as unknown[][]

  const badgeShape = checkTabShape(badgeValues, BADGE_REGISTER_HEADERS)
  const heldShape = checkTabShape(heldValues, HELD_REGISTRATIONS_HEADERS)

  if (badgeShape === 'conflicting') {
    return {
      ok: false,
      message: `"${BADGE_REGISTER_TITLE}" already contains a different layout or unexpected data.`,
    }
  }

  if (heldShape === 'conflicting') {
    return {
      ok: false,
      message: `"${HELD_REGISTRATIONS_TITLE}" already contains a different layout or unexpected data.`,
    }
  }

  const initializationRequests: SheetsRequest[] = []

  if (badgeShape === 'empty') {
    initializationRequests.push(
      ...buildTabInitializationRequests(
        badgeSheetId,
        BADGE_REGISTER_HEADERS,
        BADGE_REGISTER_COLUMNS.registrationId,
        BADGE_REGISTER_COLUMNS.phone,
        BADGE_REGISTER_COLUMNS.badge,
      ),
    )
  }

  if (heldShape === 'empty') {
    initializationRequests.push(
      ...buildTabInitializationRequests(
        heldSheetId,
        HELD_REGISTRATIONS_HEADERS,
        HELD_REGISTRATIONS_COLUMNS.registrationId,
        HELD_REGISTRATIONS_COLUMNS.phone,
        null,
      ),
    )
  }

  await runBatch(sheets, spreadsheetId, initializationRequests)

  const badgeRows = toRowViews(
    badgeValues.slice(1),
    BADGE_REGISTER_COLUMNS.registrationId,
    BADGE_REGISTER_COLUMNS.updatedAt,
    true,
  )
  const heldRows = toRowViews(
    heldValues.slice(1),
    HELD_REGISTRATIONS_COLUMNS.registrationId,
    HELD_REGISTRATIONS_COLUMNS.updatedAt,
    false,
  )

  for (const [title, rows] of [
    [BADGE_REGISTER_TITLE, badgeRows],
    [HELD_REGISTRATIONS_TITLE, heldRows],
  ] as const) {
    const duplicate = findDuplicateRegistrationId(rows)

    if (duplicate !== undefined) {
      // The id goes to the server log only; the operator-facing message stays
      // generic and carries no attendee details.
      console.error(
        `Navaratri sync: "${title}" contains duplicate Registration ID ${duplicate}.`,
      )

      return {
        ok: false,
        message: `"${title}" contains more than one row with the same Registration ID. Resolve the duplicate before syncing again.`,
      }
    }
  }

  return {
    ok: true,
    badgeRegister: { sheetId: badgeSheetId, rows: badgeRows },
    heldRegistrations: { sheetId: heldSheetId, rows: heldRows },
  }
}

const syncHeld = async (
  sheets: SheetsClient,
  spreadsheetId: string,
  heldSheetId: number,
  payload: SyncHeldPayload,
  badgeRows: readonly SheetRowView[],
  heldRows: readonly SheetRowView[],
): Promise<SyncExecutionResult> => {
  const decision = decideHeldSync(
    payload.updatedAt,
    findByRegistrationId(badgeRows, payload.id),
    findByRegistrationId(heldRows, payload.id),
  )

  await runBatch(
    sheets,
    spreadsheetId,
    buildHeldSyncRequests(decision, payload, heldSheetId),
  )

  if (decision.kind === 'completed-wins') {
    return { ok: true, outcome: 'completed-wins' }
  }

  if (decision.kind === 'already-current') {
    return { ok: true, outcome: 'already-current' }
  }

  if (decision.kind === 'stale-ignored') {
    return { ok: true, outcome: 'stale-ignored' }
  }

  return { ok: true, outcome: 'synced' }
}

const syncCompleted = async (
  sheets: SheetsClient,
  spreadsheetId: string,
  badgeSheetId: number,
  heldSheetId: number,
  payload: SyncCompletedPayload,
  badgeRows: readonly SheetRowView[],
  heldRows: readonly SheetRowView[],
): Promise<SyncExecutionResult> => {
  const decision = decideCompletedSync(
    {
      registrationId: payload.id,
      badgeNumber: payload.badgeNumber,
      updatedAt: payload.updatedAt,
    },
    badgeRows,
    heldRows,
  )

  if (decision.kind === 'badge-conflict') {
    return {
      ok: false,
      outcome: 'badge-conflict',
      badgeNumber: decision.badgeNumber,
    }
  }

  // ONE batch: the badge row, any lingering held row, and the sort land together
  // or not at all.
  await runBatch(
    sheets,
    spreadsheetId,
    buildCompletedSyncRequests(decision, payload, badgeSheetId, heldSheetId),
  )

  if (decision.kind === 'already-current') {
    return { ok: true, outcome: 'already-current' }
  }

  if (decision.kind === 'stale-ignored') {
    return { ok: true, outcome: 'stale-ignored' }
  }

  return { ok: true, outcome: 'synced' }
}

/**
 * Upserts one registration snapshot into the central ledger.
 *
 * Registration ID is the remote idempotency key — never name, phone or row
 * position — so replaying the same snapshot can never create a second row.
 */
export const syncRegistration = async (
  request: SyncRegistrationRequest,
  environment: SyncEnvironment,
): Promise<SyncExecutionResult> => {
  const sheets = createSheetsClient(environment)

  const tabs = await loadTabs(sheets, environment.spreadsheetId)

  if (!tabs.ok) {
    return { ok: false, outcome: 'sheet-shape-conflict', message: tabs.message }
  }

  const { payload } = request

  if (payload.status === 'held') {
    return await syncHeld(
      sheets,
      environment.spreadsheetId,
      tabs.heldRegistrations.sheetId,
      payload,
      tabs.badgeRegister.rows,
      tabs.heldRegistrations.rows,
    )
  }

  return await syncCompleted(
    sheets,
    environment.spreadsheetId,
    tabs.badgeRegister.sheetId,
    tabs.heldRegistrations.sheetId,
    payload,
    tabs.badgeRegister.rows,
    tabs.heldRegistrations.rows,
  )
}
