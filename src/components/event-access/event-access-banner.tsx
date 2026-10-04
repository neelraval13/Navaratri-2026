import { CloudOff, MonitorCheck, RotateCcw } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { useDeviceEventAuthorization } from '@/device-auth/device-event-authorization-context'
import { DEVICE_ATTRIBUTE_LABELS } from '@/shared/device-attributes'
import { formatEventDateTime } from '@/lib/datetime'

/**
 * How this desk got in.
 *
 * The central device is the only authority since Phase D2, so there is one
 * banner and it describes a device. With no grant there is nothing to
 * announce: the gate below is already saying what is missing, and a second
 * notice above it would only repeat itself.
 *
 * The offline variant is amber and deliberately does NOT say "Authenticated":
 * nobody asked the server. What was proven is a signature and a clock, and
 * the wording says exactly that.
 */
const EventAccessBanner: React.FC = () => {
  const device = useDeviceEventAuthorization()

  if (device.grant === null) {
    return null
  }

  const { grant } = device
  const access = grant.attributes
    .map((entry) => DEVICE_ATTRIBUTE_LABELS[entry])
    .join(' · ')

  if (grant.source === 'device-online') {
    return (
      <div className="mb-6 rounded-2xl border border-border px-4 py-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <MonitorCheck className="size-4 shrink-0" />

          <span className="font-medium">
            Device access
          </span>

          <span className="text-muted-foreground">
            {device.deviceName ?? 'Central device'}
            {access === '' ? '' : ` · ${access}`} · Verified online
          </span>
        </p>
      </div>
    )
  }

  return (
    <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <CloudOff className="size-4" />
            Offline device access
          </p>

          <p className="mt-1 text-sm text-muted-foreground">
            {device.deviceName ?? 'Central device'}
            {access === '' ? '' : ` · ${access}`}
            {grant.expiresAt === undefined
              ? ''
              : ` · Authorization valid until ${formatEventDateTime(
                  new Date(grant.expiresAt * 1000).toISOString(),
                )}`}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          disabled={device.isRefreshing}
          onClick={device.refresh}
        >
          <RotateCcw data-icon="inline-start" />
          {device.isRefreshing ? 'Checking…' : 'Refresh Device Access'}
        </Button>
      </div>
    </div>
  )
}

export default EventAccessBanner
