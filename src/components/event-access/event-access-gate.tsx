import type * as React from 'react'

import BadgeOwnershipBlock from '@/components/event-access/badge-ownership-block'
import DeviceAccessRequired from '@/components/event-access/device-access-required'
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
 * THE CENTRAL DEVICE IS THE ONLY AUTHORITY. Phase D2 removed the operator
 * code, so there is no second credential and no fallback branch here — three
 * outcomes, and every one of them is decided by the same pure evaluator:
 *
 *   authorized   a live device session or a verified offline lease says yes
 *   unavailable  this browser has not finished becoming an event device;
 *                the answer is Device Sign-In, not another credential
 *   blocked      central and local badge ownership DISAGREE, or this browser
 *                is enrolled as a different device. Hard stop
 *
 * The device check settles before anything renders, so a page never flashes
 * a setup prompt at a device that was about to be authorized.
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

  return <DeviceAccessRequired gap={authorization.gap} />
}

export default EventAccessGate
