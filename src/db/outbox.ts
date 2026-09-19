import { db } from '@/db/database'
import type { OutboxItem } from '@/db/types'
import type { OutboxSyncErrorCode } from '@/shared/sync-contract'

/**
 * Identifies one exact snapshot: which row, whose registration, and which
 * version of it. Every conditional write below is keyed on all three.
 */
export interface OutboxSnapshotRef {
  outboxId: string
  registrationId: string
  payloadUpdatedAt: string
}

export const toSnapshotRef = (item: OutboxItem): OutboxSnapshotRef => {
  return {
    outboxId: item.id,
    registrationId: item.registrationId,
    payloadUpdatedAt: item.payload.updatedAt,
  }
}

const matchesSnapshot = (
  item: OutboxItem | undefined,
  ref: OutboxSnapshotRef,
): item is OutboxItem => {
  return (
    item !== undefined &&
    item.registrationId === ref.registrationId &&
    item.payload.updatedAt === ref.payloadUpdatedAt
  )
}

/**
 * Pending rows in a deterministic order: oldest first, id as the tiebreak.
 * Never relies on object iteration order.
 */
export const listPendingOutboxItems = async (): Promise<OutboxItem[]> => {
  const items = await db.outbox.toArray()

  return items.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1
    }

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export const readOutboxItem = async (
  outboxId: string,
): Promise<OutboxItem | undefined> => {
  return await db.outbox.get(outboxId)
}

export type AttemptStartResult =
  | { outcome: 'started'; item: OutboxItem }
  | { outcome: 'superseded' }
  | { outcome: 'missing' }

/**
 * Records that an attempt is starting, but only for the snapshot the caller
 * intends to send.
 *
 * Re-reads inside the transaction because the row may have been replaced since
 * the queue was listed — a Held snapshot can become Completed while the
 * processor is busy with an earlier row. `attemptCount` counts attempts for the
 * CURRENT snapshot, and stale failure metadata is cleared so the new attempt
 * starts clean.
 */
export const markAttemptStarted = async (
  ref: OutboxSnapshotRef,
): Promise<AttemptStartResult> => {
  return await db.transaction('rw', db.outbox, async () => {
    const current = await db.outbox.get(ref.outboxId)

    if (current === undefined) {
      return { outcome: 'missing' }
    }

    if (!matchesSnapshot(current, ref)) {
      return { outcome: 'superseded' }
    }

    const updated: OutboxItem = {
      ...current,
      attemptCount: current.attemptCount + 1,
      lastAttemptAt: new Date().toISOString(),
    }

    delete updated.lastError
    delete updated.lastErrorCode

    await db.outbox.put(updated)

    return { outcome: 'started', item: updated }
  })
}

export type AcknowledgeResult = 'deleted' | 'superseded' | 'missing'

/**
 * Retires a snapshot the server acknowledged — THE critical Phase 5B invariant.
 *
 * The row is deleted only when it still holds the exact acknowledged snapshot.
 * If a newer local snapshot replaced it while the request was in flight, the
 * row is kept untouched: an older acknowledgement must never delete a newer
 * local state.
 *
 *   Held A sent -> Completed B replaces the row -> A returns success
 *   -> B survives and is synced on its own.
 */
export const acknowledgeSnapshot = async (
  ref: OutboxSnapshotRef,
): Promise<AcknowledgeResult> => {
  return await db.transaction('rw', db.outbox, async () => {
    const current = await db.outbox.get(ref.outboxId)

    if (current === undefined) {
      // Already gone; nothing to do and nothing wrong.
      return 'missing'
    }

    if (!matchesSnapshot(current, ref)) {
      return 'superseded'
    }

    await db.outbox.delete(ref.outboxId)

    return 'deleted'
  })
}

export type FailureRecordResult = 'recorded' | 'superseded' | 'missing'

/**
 * Stores failure metadata, conditional on the same exact snapshot.
 *
 * A failure for snapshot A must never be written onto snapshot B, which would
 * attach a stale error and an inflated attempt count to a newer local state and
 * delay it behind a backoff it never earned.
 */
export const recordSnapshotFailure = async (
  ref: OutboxSnapshotRef,
  errorCode: OutboxSyncErrorCode,
  message: string,
): Promise<FailureRecordResult> => {
  return await db.transaction('rw', db.outbox, async () => {
    const current = await db.outbox.get(ref.outboxId)

    if (current === undefined) {
      return 'missing'
    }

    if (!matchesSnapshot(current, ref)) {
      return 'superseded'
    }

    await db.outbox.put({
      ...current,
      lastError: message,
      lastErrorCode: errorCode,
    })

    return 'recorded'
  })
}
