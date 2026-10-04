import type * as React from 'react'

import SyncManager from '@/components/sync-manager'
import { useDeviceEventAuthorization } from '@/device-auth/device-event-authorization-context'

/**
 * SyncManager, mounted once the desk holds device event authority.
 *
 * Still app-global: one instance, outside the page routes, so a pending
 * outbox row keeps draining while the operator moves between modules.
 *
 * An OFFLINE grant mounts it too, and that is deliberate. The processor
 * already declines to send anything while the browser reports offline, and
 * the moment connectivity returns the queue must drain without waiting for a
 * session check to land first. The signed lease is never sent as server
 * authorization — `/api/sync-registration` requires a live device cookie and
 * will answer 401 without one, which is an ordinary retained-row failure.
 */
const EventSyncManager: React.FC = () => {
  const device = useDeviceEventAuthorization()

  return device.grant === null ? null : <SyncManager />
}

export default EventSyncManager
