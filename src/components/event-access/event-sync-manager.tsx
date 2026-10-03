import type * as React from 'react'

import SyncManager from '@/components/sync-manager'
import { useDeviceEventAuthorization } from '@/device-auth/device-event-authorization-context'
import { useOperatorAccess } from '@/hooks/use-operator-access'

/**
 * SyncManager, mounted once the desk has SOME event access.
 *
 * Still app-global: one instance, outside the page routes, so a pending
 * outbox row keeps draining while the operator moves between modules. The
 * condition only reproduces what the shell already did — Operator Access
 * previously wrapped the whole subtree, so a locked browser never ran the
 * processor either.
 *
 * `expired` still syncs. The rows are parked on an attention hold rather than
 * lost, and an unlock releases them; that behaviour predates this phase.
 */
const EventSyncManager: React.FC = () => {
  const access = useOperatorAccess()
  const device = useDeviceEventAuthorization()

  const hasAccess =
    access.phase === 'unlocked' ||
    access.phase === 'expired' ||
    device.grant !== null

  return hasAccess ? <SyncManager /> : null
}

export default EventSyncManager
