import type * as React from 'react'

import DatabaseGate from '@/components/database-gate'
import DeviceEventAuthorizationProvider from '@/components/device-auth/device-event-authorization-provider'
import EventAccessBanner from '@/components/event-access/event-access-banner'
import EventSyncManager from '@/components/event-access/event-sync-manager'
import StorageManager from '@/components/storage-manager'

interface EventAppGateProps {
  children: React.ReactNode
}

/**
 * The event application shell: the local database, device event
 * authorization, and the app-global managers.
 *
 * Mounted for the EVENT routes only. `/admin` is a separate security realm
 * and must not sit behind any of this, nor mount the offline registration
 * workflow merely to manage a central registry.
 *
 * DATABASE FIRST, and this ordering is load-bearing. Device authorization has
 * to read the verified offline lease, the badge configuration and the central
 * enrollment out of IndexedDB before it can decide anything, so bootstrap
 * cannot sit behind the access gate any more. Bootstrap writes only the
 * default local config row — no attendee data, no credential — so running it
 * before a credential is presented reveals nothing and costs nothing.
 *
 * The per-module gates live further in, at the routes, because the answer
 * differs per module: Home needs only an attribute, while badge registration
 * also needs its badge state to agree with the central assignment.
 *
 * One route pattern covers every event page, so navigating between them keeps
 * this subtree mounted: the provider must not re-check the session on each
 * navigation, SyncManager must not restart, and DatabaseGate must not re-run
 * bootstrap.
 */
const EventAppGate: React.FC<EventAppGateProps> = ({ children }) => {
  return (
    <DatabaseGate>
      {/* Starts only once bootstrap has succeeded, and renders nothing. */}
      <StorageManager />

      <DeviceEventAuthorizationProvider>
        <EventAccessBanner />

        {/* App-global, outside the page routes on purpose: a pending outbox
            row must keep draining on Home and on every other module. */}
        <EventSyncManager />

        {children}
      </DeviceEventAuthorizationProvider>
    </DatabaseGate>
  )
}

export default EventAppGate
