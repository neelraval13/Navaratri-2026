import type * as React from 'react'

import DatabaseGate from '@/components/database-gate'
import OperatorAccessBanner from '@/components/operator/operator-access-banner'
import OperatorAccessGate from '@/components/operator/operator-access-gate'
import StorageManager from '@/components/storage-manager'
import SyncManager from '@/components/sync-manager'

interface EventAppGateProps {
  children: React.ReactNode
}

/**
 * The event application shell: Operator Access, the local database, and the
 * app-global managers.
 *
 * Mounted for the EVENT routes only. `/admin` is a separate security realm
 * and must not sit behind Operator Access, nor mount the offline registration
 * workflow merely to manage a central registry.
 *
 * It wraps one route pattern covering every event page, so navigating between
 * them keeps this subtree mounted — SyncManager must not restart on each
 * navigation, and DatabaseGate must not re-run bootstrap.
 *
 * The access gate renders IN PLACE and never navigates, so a deep link to
 * /badge-registration survives authentication and resumes at that same URL.
 */
const EventAppGate: React.FC<EventAppGateProps> = ({ children }) => {
  return (
    <OperatorAccessGate>
      <OperatorAccessBanner />

      <DatabaseGate>
        {/* Both start only once bootstrap has succeeded, and render nothing. */}
        <StorageManager />

        {/* App-global, outside the page routes on purpose: a pending outbox
            row must keep draining on Home and on every other module. */}
        <SyncManager />

        {children}
      </DatabaseGate>
    </OperatorAccessGate>
  )
}

export default EventAppGate
