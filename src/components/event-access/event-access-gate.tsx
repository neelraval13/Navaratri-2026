import type * as React from 'react'

import BadgeOwnershipBlock from '@/components/event-access/badge-ownership-block'
import OperatorAccessGate from '@/components/operator/operator-access-gate'
import { Card, CardContent } from '@/components/ui/card'
import { useDeviceEventAuthorization } from '@/device-auth/device-event-authorization-context'
import { authorizeEventModule, type EventModule } from '@/device-auth/event-authorization'

interface EventAccessGateProps {
  module: EventModule
  children: React.ReactNode
}

/**
 * Who may open one event module.
 *
 * THREE outcomes, and the difference between the last two is the whole point:
 *
 *   authorized   a live device session or a verified offline lease says yes
 *   unavailable  device authority is absent or insufficient — Operator Access
 *                remains the transitional fallback
 *   blocked      central and local badge ownership DISAGREE. Hard stop, and
 *                Operator Access is not offered: a credential authorizes a
 *                person, not two desks sharing physical badge numbers
 *
 * The device check settles before anything renders, so a page never flashes
 * an operator prompt at a device that was about to be authorized.
 */
const EventAccessGate: React.FC<EventAccessGateProps> = ({ module, children }) => {
  const device = useDeviceEventAuthorization()

  if (device.isChecking) {
    return (
      <Card>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Checking event access…
          </p>
        </CardContent>
      </Card>
    )
  }

  const authorization = authorizeEventModule(module, {
    grant: device.grant,
    config: device.config,
    enrollment: device.enrollment,
  })

  if (authorization.outcome === 'authorized') {
    return <>{children}</>
  }

  if (authorization.outcome === 'blocked') {
    return (
      <BadgeOwnershipBlock
        conflict={authorization.conflict}
        central={authorization.central}
        local={authorization.local}
      />
    )
  }

  /**
   * The EXISTING Operator Access flow, reused rather than reimplemented: its
   * credential comparison, session, trusted-device marker and offline
   * behaviour are unchanged, and there is no second code form anywhere.
   */
  return <OperatorAccessGate>{children}</OperatorAccessGate>
}

export default EventAccessGate
