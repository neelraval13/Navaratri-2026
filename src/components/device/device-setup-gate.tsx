import { CircleAlert } from 'lucide-react'
import type * as React from 'react'

import DeviceSetupForm from '@/components/device/device-setup-form'
import EventConfigGate from '@/components/registration/event-config-gate'
import { Card, CardContent } from '@/components/ui/card'
import { isDeviceConfigured } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'

interface DeviceSetupGateProps {
  children: React.ReactNode
}

/**
 * Blocks NEW registrations until this device has been assigned a badge range.
 *
 * FAILS CLOSED. An unresolved configuration is not an excuse to show the
 * registration form: while the read is loading, has failed, or produced no row,
 * this device cannot be shown to be configured, so the form stays hidden.
 * Returning `children` in those states would expose registration on a device
 * that might own no badge range at all.
 *
 * Deliberately sits INSIDE DatabaseGate but around the registration form only —
 * SyncManager stays outside it, so a legacy or pending outbox row can still
 * drain on a device that has not completed setup.
 *
 * This gate is the convenient layer, not the safety layer: holdRegistration and
 * issueBadge independently refuse an unconfigured device inside their own
 * transactions.
 */
const DeviceSetupGate: React.FC<DeviceSetupGateProps> = ({ children }) => {
  const eventConfig = useEventConfig()

  if (eventConfig.status === 'loading') {
    // Reuses the existing presentational gate rather than duplicating it; the
    // row being loaded is the same event configuration row.
    return (
      <EventConfigGate
        status="loading"
        onRetry={eventConfig.reload}
      />
    )
  }

  if (eventConfig.status === 'failed' || eventConfig.config === null) {
    return (
      <EventConfigGate
        status="failed"
        onRetry={eventConfig.reload}
      />
    )
  }

  if (isDeviceConfigured(eventConfig.config)) {
    return <>{children}</>
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            One-time setup
          </p>

          <h2 className="font-heading text-2xl font-semibold">
            Device Setup
          </h2>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Assign this device its own badge range. Every device must have a
            different range, and the matching physical badges must be at this
            desk.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />

          <p className="text-sm text-muted-foreground">
            The range is set once and cannot be changed here afterwards.
            Registration cannot begin until setup is complete.
          </p>
        </div>

        <DeviceSetupForm
          onConfigured={() => {
            // Re-read the stored configuration rather than assuming the write.
            eventConfig.reload()
          }}
        />
      </CardContent>
    </Card>
  )
}

export default DeviceSetupGate
