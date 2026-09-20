import type * as React from 'react'

import ConnectivityStatus from '@/components/connectivity-status'
import DatabaseGate from '@/components/database-gate'
import LockDeviceButton from '@/components/operator/lock-device-button'
import OperatorAccessBanner from '@/components/operator/operator-access-banner'
import OperatorAccessGate from '@/components/operator/operator-access-gate'
import RegistrationForm from '@/components/registration/registration-form'
import StorageManager from '@/components/storage-manager'
import SyncManager from '@/components/sync-manager'
import SyncStatus from '@/components/sync-status'
import ThemeToggle from '@/components/theme-toggle'

const App: React.FC = () => {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
          <p className="text-xl font-semibold tracking-wide">
            Navaratri 2026
          </p>

          {/* Connectivity and sync are separate facts: the browser can be
              online while snapshots are still queued. */}
          <div className="flex items-center gap-3">
            <ConnectivityStatus />

            <SyncStatus />

            <ThemeToggle />

            <LockDeviceButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        {/* Only a device that has NEVER been unlocked is gated here. A trusted
            device always renders the app, even with an expired session. */}
        <OperatorAccessGate>
          <OperatorAccessBanner />

          <DatabaseGate>
            {/* Both start only once bootstrap has succeeded, and render nothing. */}
            <StorageManager />

            <SyncManager />

            <RegistrationForm />
          </DatabaseGate>
        </OperatorAccessGate>
      </main>
    </div>
  )
}

export default App
