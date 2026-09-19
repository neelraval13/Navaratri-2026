import { useEffect } from 'react'
import type * as React from 'react'

import { subscribeOutboxChanged } from '@/sync/outbox-events'
import {
  refreshSyncStatus,
  requestOutboxSync,
  stopOutboxSyncScheduling,
} from '@/sync/outbox-sync'

/**
 * Owns the background synchronization triggers. Renders nothing.
 *
 * Mounted INSIDE DatabaseGate so it can only start once bootstrap has
 * succeeded — there is exactly one database bootstrap owner, and this is not
 * a second one.
 *
 * Nothing here is on the critical path of registration: Hold, Resume, payment
 * and Issue Badge never await synchronization.
 */
const SyncManager: React.FC = () => {
  useEffect(() => {
    let cancelled = false

    const sync = () => {
      if (cancelled) {
        return
      }

      void requestOutboxSync()
    }

    /** Another tab may have drained the queue while this one was hidden. */
    const refresh = () => {
      if (cancelled) {
        return
      }

      void refreshSyncStatus()
    }

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') {
        return
      }

      refresh()
      sync()
    }

    // 1. startup, now that the database is ready
    sync()

    // 2/3. a new Held or Completed snapshot was committed
    const unsubscribe = subscribeOutboxChanged(sync)

    // 4. connectivity returned
    window.addEventListener('online', sync)

    // 6. this tab became current again
    window.addEventListener('focus', handleVisibility)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener('online', sync)
      window.removeEventListener('focus', handleVisibility)
      document.removeEventListener('visibilitychange', handleVisibility)
      stopOutboxSyncScheduling()
    }
  }, [])

  return null
}

export default SyncManager
