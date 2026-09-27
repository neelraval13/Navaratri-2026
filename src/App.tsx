import type * as React from 'react'
import { Link } from 'wouter'

import AppRouter from '@/components/app-router'
import ConnectivityStatus from '@/components/connectivity-status'
import LockDeviceButton from '@/components/operator/lock-device-button'
import SyncStatus from '@/components/sync-status'
import ThemeToggle from '@/components/theme-toggle'
import { ROUTES } from '@/app/routes'

/**
 * The application shell.
 *
 * The header is global and module-agnostic: it carries the app title, the two
 * separate connectivity and sync facts, the theme toggle and Lock Device, and
 * deliberately no device-specific badge state — that belongs to the pages.
 *
 * Nothing rendered in the header may read the database, because the header
 * renders OUTSIDE DatabaseGate and therefore before bootstrap has completed.
 * It is also shown on `/admin`, which never mounts the database at all.
 */
const App: React.FC = () => {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
          {/* Router navigation, so returning Home never reloads the document
              and never re-runs bootstrap. */}
          <Link
            href={ROUTES.home}
            className="rounded-md text-xl font-semibold tracking-wide outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Navaratri 2026
          </Link>

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
        {/*
          The router owns the security realms: `/admin` renders outside the
          event shell behind its own gate, and the event routes render inside
          EventAppGate behind Operator Access.
        */}
        <AppRouter />
      </main>
    </div>
  )
}

export default App
