import { useSyncExternalStore } from 'react'

import {
  getSyncStatus,
  subscribeSyncStatus,
  type SyncStatus,
} from '@/sync/sync-status-store'

/**
 * Reads sync status from an external store rather than React state, so the
 * processor can live under DatabaseGate while the header indicator stays
 * outside it.
 */
export const useSyncStatus = (): SyncStatus => {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus)
}
