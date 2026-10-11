import type * as React from 'react'

import AttendeeDirectory from '@/components/attendees/attendee-directory'
import { isDeviceRegistered } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'

/**
 * The read-only attendee directory.
 *
 * Reachable only once the central device has proven `attendees` authority for
 * this event AND this browser's identity is that device's — the route gate
 * settles that before anything here renders. A device holding only
 * `attendees` is a complete viewer: it owns no badge range, holds no central
 * badge binding and advances no counter, because reading a register changes
 * nothing.
 *
 * The device line is GENERIC IDENTITY ONLY, for that reason. `DeviceLabel`
 * and Device Readiness both report badge-distribution state, which a viewer
 * does not have, and a mixed-access device showing "Badges #001-#200" here
 * would be describing the wrong module.
 */
const AttendeesPage: React.FC = () => {
  const eventConfig = useEventConfig()

  const registered =
    eventConfig.status === 'loaded' &&
    eventConfig.config !== null &&
    isDeviceRegistered(eventConfig.config)
      ? eventConfig.config
      : null

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {registered === null ? null : (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {registered.deviceName}
            </span>
            {' · Central device'}
          </p>
        )}

        <h1 className="font-heading text-3xl font-semibold uppercase tracking-[0.08em] sm:text-4xl">
          Attendees
        </h1>

        <p className="text-sm text-muted-foreground">
          Read-only event attendee directory.
        </p>
      </div>

      <AttendeeDirectory />
    </div>
  )
}

export default AttendeesPage
