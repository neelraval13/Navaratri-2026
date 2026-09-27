import { CircleAlert, CircleCheck } from 'lucide-react'
import type * as React from 'react'

import DeviceReadiness from '@/components/device/device-readiness'
import DeviceRegistrationForm from '@/components/device/device-registration-form'
import EventConfigGate from '@/components/registration/event-config-gate'
import { Card, CardContent } from '@/components/ui/card'
import { isDeviceRegistered } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'
import { formatEventDateTime } from '@/lib/datetime'

/**
 * GENERIC provisioning and inspection for THIS physical device.
 *
 * Identity only. Badge ranges are not assigned here, because not every event
 * device distributes badges — a prize or dandiya desk is registered exactly
 * like this one and owns none. Badge assignment belongs to the badge module,
 * inside `/badge-registration`.
 *
 * An already-registered device never sees the form again, and there is no
 * device-id change, no delete and no clear: re-registering hardware that
 * already has an identity would mint a second id for the same device.
 */
const DeviceRegistrationPage: React.FC = () => {
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

  const config = eventConfig.config

  if (isDeviceRegistered(config)) {
    return (
      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Device Registration
            </p>

            <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold">
              <CircleCheck className="size-5 text-emerald-700 dark:text-emerald-400" />
              This device is registered
            </h1>
          </div>

          <dl className="space-y-3">
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Device
              </dt>

              <dd className="font-heading text-xl font-semibold">
                {config.deviceName}
              </dd>
            </div>

            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Device ID
              </dt>

              <dd className="break-all text-sm text-muted-foreground">
                {config.deviceId}
              </dd>
            </div>

            {config.deviceConfiguredAt === undefined ? null : (
              <div>
                <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  Registered
                </dt>

                <dd className="text-sm text-muted-foreground">
                  {formatEventDateTime(config.deviceConfiguredAt)}
                </dd>
              </div>
            )}
          </dl>

          <DeviceReadiness trigger="button" />

          <p className="text-xs leading-relaxed text-muted-foreground">
            Device identity is assigned once and never changes. Module
            configuration — such as a badge range — is set up inside the module
            that needs it.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            One-time setup
          </p>

          <h1 className="font-heading text-2xl font-semibold">
            Device Registration
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Give this physical device a name. Every event device is registered
            once, whether or not it will hand out badges.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />

          <p className="text-sm text-muted-foreground">
            The device identity is created once and cannot be changed
            afterwards. Event modules cannot be used until this is complete.
          </p>
        </div>

        {/* The one and only device-identity writer. */}
        <DeviceRegistrationForm
          onRegistered={() => {
            eventConfig.reload()
          }}
        />
      </CardContent>
    </Card>
  )
}

export default DeviceRegistrationPage
