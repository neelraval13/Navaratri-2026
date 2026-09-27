import type * as React from 'react'

import BadgeDistributionForm from '@/components/device/badge-distribution-form'
import EventConfigGate from '@/components/registration/event-config-gate'
import { Card, CardContent } from '@/components/ui/card'
import { isBadgeDistributionConfigured } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'

interface BadgeDistributionGateProps {
  children: React.ReactNode
}

/**
 * The badge module's own configuration step, for a device that is already
 * registered but owns no badge range yet.
 *
 * This is where a range is assigned — not at device registration, because
 * owning badges is a property of this module rather than of the hardware.
 * It lives inside `/badge-registration` on purpose: it is the first step of
 * the badge workflow, not a separate destination.
 *
 * FAILS CLOSED like every other gate, and it is still only the convenient
 * layer: holdRegistration and issueBadge independently refuse a device with
 * no badge range inside their own transactions.
 */
const BadgeDistributionGate: React.FC<BadgeDistributionGateProps> = ({
  children,
}) => {
  const eventConfig = useEventConfig()

  if (eventConfig.status === 'loading') {
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

  if (isBadgeDistributionConfigured(eventConfig.config)) {
    return <>{children}</>
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            One-time setup
          </p>

          <h1 className="font-heading text-2xl font-semibold">
            Badge Distribution Setup
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            This device is registered, but it has not been assigned a badge
            range.
          </p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Device
          </p>

          <p className="font-heading text-xl font-semibold">
            {eventConfig.config.deviceName}
          </p>
        </div>

        <BadgeDistributionForm
          onConfigured={() => {
            eventConfig.reload()
          }}
        />
      </CardContent>
    </Card>
  )
}

export default BadgeDistributionGate
