import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import DatabaseGate from '@/components/database-gate'
import DeviceEnrollmentPanel from '@/components/device-auth/device-enrollment-panel'
import { buttonVariants } from '@/components/ui/button'

/**
 * Central device sign-in for this browser.
 *
 * Since Phase D2 this is the ONLY entry point: the shared operator code is
 * gone, and every event module is authorized by the central device. It is
 * also the only provisioning path — Device setup, badge-range adoption and
 * sign-out all live here, and there is no local device registration page any
 * more.
 *
 * Signing in is not a blanket unlock. Each module authorizes itself from the
 * device's attributes and, for registration, from this browser's converged
 * identity and badge-safety checks. "Continue to Event Operations" simply
 * navigates; the gates there still decide whether it opens.
 *
 * DatabaseGate wraps only the panel, because the enrollment snapshot is
 * persisted in the existing IndexedDB config row. It does not bring the event
 * workflow with it: no StorageManager, no SyncManager, no registration form.
 */
const DeviceLoginPage: React.FC = () => {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Central device
        </p>

        <h1 className="font-heading text-3xl font-semibold sm:text-4xl">
          Device Sign-In
        </h1>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Identifies this browser as a registered event device. Event
          operations are authorized here and nowhere else — each module still
          checks this device&rsquo;s own access.
        </p>
      </div>

      <DatabaseGate>
        <DeviceEnrollmentPanel />
      </DatabaseGate>

      <div>
        {/*
          A real link, styled as a button. It is NOT routed through the Button
          component: that one assumes a native <button>, and rendering an <a>
          through it either warns or applies `role="button"`, which would
          announce this navigation as a button rather than a link.
        */}
        <Link
          href={ROUTES.home}
          className={buttonVariants({ variant: 'ghost' })}
        >
          Continue to Event Operations
        </Link>
      </div>
    </div>
  )
}

export default DeviceLoginPage
