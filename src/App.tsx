import { MonitorSmartphone } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import AppRouter from '@/components/app-router'
import ConnectivityStatus from '@/components/connectivity-status'
import SyncStatus from '@/components/sync-status'
import ThemeToggle from '@/components/theme-toggle'
import { ROUTES } from '@/app/routes'

/**
 * The application shell.
 *
 * The header is global and module-agnostic: it carries the app title, the two
 * separate connectivity and sync facts, the theme toggle and a way to reach
 * Device Sign-In, and deliberately no device-specific badge state — that
 * belongs to the pages.
 *
 * There is no lock control. Phase D2 removed the operator realm, and device
 * sign-out belongs to the device realm's own page, where it can report
 * whether the server actually accepted it.
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

            {/* A real link, not a button: it navigates. */}
            <Link
              href={ROUTES.deviceLogin}
              className="rounded-md p-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Device Sign-In"
              title="Device Sign-In"
            >
              <MonitorSmartphone className="size-5" />
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        {/*
          The router owns the security realms: `/admin` and `/device-login`
          render outside the event shell, and the event routes render inside
          EventAppGate behind central device authorization.
        */}
        <AppRouter />
      </main>
    </div>
  )
}

export default App
