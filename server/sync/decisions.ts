/**
 * Every synchronisation decision, expressed as pure functions over what was read
 * from the Sheet. Nothing here talks to Google, so the rules that protect the
 * ledger can be exercised directly.
 */

/** One row as read back from a tab, with its position among the data rows. */
export interface SheetRowView {
  /** 0-based index among data rows; add 2 to get the A1 row number. */
  index: number
  registrationId: string
  updatedAt: string
  /** Badge Register only. */
  badgeNumber?: number
}

export type TimestampComparison = 'incoming-newer' | 'same' | 'remote-newer'

/**
 * Compares the incoming snapshot against what the Sheet already holds.
 *
 * An unparseable remote timestamp is treated as older, so a corrupt technical
 * cell can be repaired by the next sync rather than freezing the row forever.
 */
export const compareUpdatedAt = (
  incomingUpdatedAt: string,
  remoteUpdatedAt: string,
): TimestampComparison => {
  const incoming = Date.parse(incomingUpdatedAt)
  const remote = Date.parse(remoteUpdatedAt)

  if (Number.isNaN(remote)) {
    return 'incoming-newer'
  }

  if (incoming === remote) {
    return 'same'
  }

  return incoming > remote ? 'incoming-newer' : 'remote-newer'
}

export const findByRegistrationId = (
  rows: readonly SheetRowView[],
  registrationId: string,
): SheetRowView | undefined => {
  return rows.find((row) => row.registrationId === registrationId)
}

export type HeldSyncDecision =
  | { kind: 'completed-wins' }
  | { kind: 'already-current' }
  | { kind: 'stale-ignored' }
  | { kind: 'update'; rowIndex: number }
  | { kind: 'append' }

/**
 * A held snapshot never touches Badge Register.
 *
 * COMPLETED ALWAYS WINS: if this registration already has a badge in the
 * central ledger, a held payload — however it got delayed — must not resurrect
 * the person in Held Registrations. Retries and races depend on this.
 */
export const decideHeldSync = (
  incomingUpdatedAt: string,
  existingBadgeRow: SheetRowView | undefined,
  existingHeldRow: SheetRowView | undefined,
): HeldSyncDecision => {
  if (existingBadgeRow !== undefined) {
    return { kind: 'completed-wins' }
  }

  if (existingHeldRow === undefined) {
    return { kind: 'append' }
  }

  const comparison = compareUpdatedAt(incomingUpdatedAt, existingHeldRow.updatedAt)

  if (comparison === 'same') {
    return { kind: 'already-current' }
  }

  if (comparison === 'remote-newer') {
    return { kind: 'stale-ignored' }
  }

  return { kind: 'update', rowIndex: existingHeldRow.index }
}

export type CompletedSyncDecision =
  | {
      kind: 'badge-conflict'
      badgeNumber: number
      conflictingRegistrationId: string
    }
  | { kind: 'stale-ignored'; heldRowIndex?: number }
  | { kind: 'already-current'; heldRowIndex?: number }
  | { kind: 'update'; rowIndex: number; heldRowIndex?: number }
  | { kind: 'append'; heldRowIndex?: number }

export interface CompletedSyncInput {
  registrationId: string
  badgeNumber: number
  updatedAt: string
}

/**
 * A completed snapshot upserts into Badge Register and clears the person's held
 * row.
 *
 * The badge collision check runs FIRST and fails closed: if the incoming badge
 * number already belongs to a DIFFERENT registration, the physical badge was
 * issued twice and a human has to reconcile it. The server never overwrites the
 * other attendee, never picks another number, and never silently continues.
 *
 * `already-current` still reports any lingering held row, so a retry after a
 * partial failure finishes clearing it.
 */
export const decideCompletedSync = (
  input: CompletedSyncInput,
  badgeRegisterRows: readonly SheetRowView[],
  heldRows: readonly SheetRowView[],
): CompletedSyncDecision => {
  const collision = badgeRegisterRows.find(
    (row) =>
      row.badgeNumber === input.badgeNumber &&
      row.registrationId !== input.registrationId,
  )

  if (collision !== undefined) {
    return {
      kind: 'badge-conflict',
      badgeNumber: input.badgeNumber,
      conflictingRegistrationId: collision.registrationId,
    }
  }

  const heldRowIndex = findByRegistrationId(heldRows, input.registrationId)?.index
  const existing = findByRegistrationId(badgeRegisterRows, input.registrationId)

  if (existing === undefined) {
    return { kind: 'append', heldRowIndex }
  }

  const comparison = compareUpdatedAt(input.updatedAt, existing.updatedAt)

  if (comparison === 'same') {
    return { kind: 'already-current', heldRowIndex }
  }

  if (comparison === 'remote-newer') {
    // The newer remote badge row must not be overwritten — but a held row for
    // the same person is still safe to clear, because a completed row already
    // exists remotely. Carrying the index keeps the server self-healing rather
    // than assuming an earlier call reached every step.
    return { kind: 'stale-ignored', heldRowIndex }
  }

  return { kind: 'update', rowIndex: existing.index, heldRowIndex }
}

/**
 * The first Registration ID that appears on more than one nonblank row.
 *
 * A duplicate means the ledger is already corrupt, and picking one row silently
 * would compound it — so the caller fails closed and asks for human attention.
 * Google Sheets offers no conditional unique append, so this is a detection, not
 * a prevention.
 */
export const findDuplicateRegistrationId = (
  rows: readonly SheetRowView[],
): string | undefined => {
  const seen = new Set<string>()

  for (const row of rows) {
    if (seen.has(row.registrationId)) {
      return row.registrationId
    }

    seen.add(row.registrationId)
  }

  return undefined
}
