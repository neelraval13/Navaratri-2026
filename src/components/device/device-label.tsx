import { MonitorSmartphone } from 'lucide-react'
import type * as React from 'react'

import { formatBadgeRange, isDeviceConfigured } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'

/**
 * A restrained line naming this desk and the range it owns.
 *
 * STATIC ASSIGNMENT METADATA ONLY. `deviceName`, `badgeStart` and `badgeEnd`
 * never change after setup, so they are safe to render from this component's
 * own configuration snapshot.
 *
 * A live count such as "N remaining" deliberately is NOT shown here. This
 * component holds its own `useEventConfig()` instance, and the one
 * RegistrationForm refreshes after a successful issue is a different instance —
 * a derived count here would silently go stale the moment a badge was issued.
 *
 * The authoritative live value is the large badge number in the registration
 * form header, which is refreshed by the issuing transaction itself.
 */
const DeviceLabel: React.FC = () => {
  const eventConfig = useEventConfig()

  if (eventConfig.config === null || !isDeviceConfigured(eventConfig.config)) {
    return null
  }

  const config = eventConfig.config

  return (
    <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <MonitorSmartphone className="size-4 shrink-0" />

      <span className="font-medium text-foreground">
        {config.deviceName}
      </span>

      <span aria-hidden="true">
        ·
      </span>

      <span>
        Badges {formatBadgeRange(config.badgeStart, config.badgeEnd)}
      </span>
    </p>
  )
}

export default DeviceLabel
