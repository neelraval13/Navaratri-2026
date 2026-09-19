import type { sheets_v4 } from 'googleapis'

import type {
  SyncCompletedPayload,
  SyncHeldPayload,
} from '../../src/shared/sync-contract'
import type { CompletedSyncDecision, HeldSyncDecision } from './decisions'
import {
  BADGE_REGISTER_COLUMNS,
  HELD_REGISTRATIONS_COLUMNS,
  buildBadgeRegisterRow,
  buildBlankRow,
  buildHeaderRow,
  buildHeldRegistrationRow,
  type SheetCell,
} from './sheet-contract'

export type SheetsRequest = sheets_v4.Schema$Request

/**
 * Header occupies grid row 0, so data row 0 is grid row 1.
 */
const toGridRowIndex = (dataRowIndex: number): number => {
  return dataRowIndex + 1
}

/**
 * Converts one cell to an explicitly typed `userEnteredValue`.
 *
 * This is the whole formula-injection defence. `spreadsheets.values` with
 * `USER_ENTERED` would parse any string starting with `=`, `+`, `-` or `@` as a
 * formula, so an attendee name could execute in the operator's spreadsheet.
 * Here a string is a `stringValue` and nothing else can reinterpret it.
 */
export const toCellData = (cell: SheetCell): sheets_v4.Schema$CellData => {
  if (cell.kind === 'number') {
    return { userEnteredValue: { numberValue: cell.value } }
  }

  if (cell.kind === 'formula') {
    return { userEnteredValue: { formulaValue: cell.value } }
  }

  return { userEnteredValue: { stringValue: cell.value } }
}

export const toRowData = (row: readonly SheetCell[]): sheets_v4.Schema$RowData => {
  return { values: row.map(toCellData) }
}

export const appendCellsRequest = (
  sheetId: number,
  row: readonly SheetCell[],
): SheetsRequest => {
  return {
    appendCells: {
      sheetId,
      rows: [toRowData(row)],
      fields: 'userEnteredValue',
    },
  }
}

export const updateCellsRequest = (
  sheetId: number,
  dataRowIndex: number,
  row: readonly SheetCell[],
): SheetsRequest => {
  const startRowIndex = toGridRowIndex(dataRowIndex)

  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex: startRowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: row.length,
      },
      rows: [toRowData(row)],
      fields: 'userEnteredValue',
    },
  }
}

/**
 * Blanks a held row's cells in place. The row itself is never deleted: removing
 * a dimension shifts every index below it and would race with anything already
 * holding those indices.
 */
export const clearHeldRowRequest = (
  heldSheetId: number,
  dataRowIndex: number,
): SheetsRequest => {
  return updateCellsRequest(
    heldSheetId,
    dataRowIndex,
    buildBlankRow(HELD_REGISTRATIONS_COLUMNS.count),
  )
}

/** Keeps the operator-facing ledger in ascending numeric badge order. */
export const sortBadgeRegisterRequest = (
  badgeSheetId: number,
): SheetsRequest => {
  return {
    sortRange: {
      range: {
        sheetId: badgeSheetId,
        startRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: BADGE_REGISTER_COLUMNS.count,
      },
      sortSpecs: [
        {
          dimensionIndex: BADGE_REGISTER_COLUMNS.badge,
          sortOrder: 'ASCENDING',
        },
      ],
    },
  }
}

/**
 * Every remote mutation a completed snapshot needs, as ONE batch.
 *
 * Google applies the subrequests of a single `spreadsheets.batchUpdate`
 * together, so the badge row, the held-row clearing and the sort cannot land
 * apart from one another.
 *
 * Sorting is issued on every path, including `already-current` and
 * `stale-ignored`: it is always safe, and it repairs a ledger left unsorted by
 * an earlier partial attempt. Clearing a lingering held row is likewise safe
 * whenever a completed row exists remotely, which is why a stale request still
 * finishes that job instead of assuming an earlier call completed every step.
 *
 * Returns an empty array only for `badge-conflict`, which must write nothing.
 */
export const buildCompletedSyncRequests = (
  decision: CompletedSyncDecision,
  payload: SyncCompletedPayload,
  badgeSheetId: number,
  heldSheetId: number,
): SheetsRequest[] => {
  if (decision.kind === 'badge-conflict') {
    return []
  }

  const requests: SheetsRequest[] = []

  if (decision.kind === 'append') {
    requests.push(
      appendCellsRequest(badgeSheetId, buildBadgeRegisterRow(payload)),
    )
  }

  if (decision.kind === 'update') {
    requests.push(
      updateCellsRequest(
        badgeSheetId,
        decision.rowIndex,
        buildBadgeRegisterRow(payload),
      ),
    )
  }

  if (decision.heldRowIndex !== undefined) {
    requests.push(clearHeldRowRequest(heldSheetId, decision.heldRowIndex))
  }

  requests.push(sortBadgeRegisterRequest(badgeSheetId))

  return requests
}

/**
 * A held snapshot never touches Badge Register and never needs sorting.
 *
 * Returns an empty array for the outcomes that must not write at all:
 * `completed-wins`, `already-current` and `stale-ignored`.
 */
export const buildHeldSyncRequests = (
  decision: HeldSyncDecision,
  payload: SyncHeldPayload,
  heldSheetId: number,
): SheetsRequest[] => {
  if (decision.kind === 'append') {
    return [appendCellsRequest(heldSheetId, buildHeldRegistrationRow(payload))]
  }

  if (decision.kind === 'update') {
    return [
      updateCellsRequest(
        heldSheetId,
        decision.rowIndex,
        buildHeldRegistrationRow(payload),
      ),
    ]
  }

  return []
}

/**
 * Initialises a genuinely blank tab in ONE batch: header values and every piece
 * of contract formatting together.
 *
 * Doing this as separate calls could leave a tab with a matching header but no
 * frozen row, visible technical columns or unformatted badges — which a later
 * run would then consider correctly initialised.
 */
export const buildTabInitializationRequests = (
  sheetId: number,
  headers: readonly string[],
  technicalStartColumn: number,
  phoneColumn: number,
  badgeColumn: number | null,
): SheetsRequest[] => {
  const requests: SheetsRequest[] = [
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
        rows: [toRowData(buildHeaderRow(headers))],
        fields: 'userEnteredValue',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: technicalStartColumn,
          endIndex: headers.length,
        },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
    {
      // Phone stays text so a 10-digit number is never regrouped or rounded.
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          startColumnIndex: phoneColumn,
          endColumnIndex: phoneColumn + 1,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ]

  if (badgeColumn !== null) {
    requests.push({
      // Displays #001 while the stored value stays a sortable number.
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          startColumnIndex: badgeColumn,
          endColumnIndex: badgeColumn + 1,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: '"#"000' },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    })
  }

  return requests
}
