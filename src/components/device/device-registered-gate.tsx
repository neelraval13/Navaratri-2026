import { MonitorSmartphone } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import EventConfigGate from '@/components/registration/event-config-gate'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { isDeviceRegistered } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'

interface DeviceRegisteredGateProps {
  children: React.ReactNode
}

/**
 * Blocks a module that needs a registered physical device.
 *
 * IDENTITY ONLY. It says nothing about badges — a registered prize or dandiya
 * desk passes this gate, and whatever module-specific configuration that
 * module needs is its own concern, nested inside.
 *
 * FAILS CLOSED. An unresolved configuration is not an excuse to show the
 * module: while the read is loading, has failed, or produced no row, this
 * device cannot be shown to be registered, so the children stay hidden.
 *
 * Device registration is NOT embedded here. It has its own route, so an
 * operator who lands on a module with unregistered hardware is sent there
 * rather than being handed a setup form mid-workflow.
 */
const DeviceRegisteredGate: React.FC<DeviceRegisteredGateProps> = ({ children }) => {
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

  if (isDeviceRegistered(eventConfig.config)) {
    return <>{children}</>
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <p className="flex items-center gap-2 font-semibold">
          <MonitorSmartphone className="size-5 text-muted-foreground" />
          This device is not registered
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Register this physical device before configuring event modules.
        </p>

        <Button
          render={<Link href={ROUTES.deviceRegistration} />}
          className="h-12 w-full sm:w-auto sm:min-w-52"
        >
          Register This Device
        </Button>
      </CardContent>
    </Card>
  )
}

export default DeviceRegisteredGate
