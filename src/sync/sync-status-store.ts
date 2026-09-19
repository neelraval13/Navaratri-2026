export type SyncPhase = 'loading' | 'idle' | 'syncing'

export interface SyncStatus {
  /** `loading` until the real queue has been read once. Never claim otherwise. */
  phase: SyncPhase
  /** Rows still awaiting acknowledgement. */
  pendingCount: number
  /** Rows whose last failure needs a human, not another timer. */
  attentionCount: number
  /** ISO 8601 UTC of the last acknowledged snapshot this session. */
  lastSuccessAt?: string
  /** ISO 8601 UTC when the earliest backed-off row becomes due. */
  nextRetryAt?: string
}

const INITIAL_STATUS: SyncStatus = {
  phase: 'loading',
  pendingCount: 0,
  attentionCount: 0,
}

let status: SyncStatus = INITIAL_STATUS

const listeners = new Set<() => void>()

const isSameStatus = (left: SyncStatus, right: SyncStatus): boolean => {
  return (
    left.phase === right.phase &&
    left.pendingCount === right.pendingCount &&
    left.attentionCount === right.attentionCount &&
    left.lastSuccessAt === right.lastSuccessAt &&
    left.nextRetryAt === right.nextRetryAt
  )
}

/**
 * Stable reference while nothing changes, which `useSyncExternalStore`
 * requires: returning a fresh object every call would re-render forever.
 */
export const getSyncStatus = (): SyncStatus => {
  return status
}

export const subscribeSyncStatus = (listener: () => void): (() => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export const setSyncStatus = (patch: Partial<SyncStatus>): void => {
  const next: SyncStatus = { ...status, ...patch }

  if (isSameStatus(next, status)) {
    return
  }

  status = next

  for (const listener of [...listeners]) {
    listener()
  }
}
