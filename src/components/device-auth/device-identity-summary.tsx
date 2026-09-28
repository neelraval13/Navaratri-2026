import type * as React from 'react'

import { Badge } from '@/components/ui/badge'
import { formatBadgeRange } from '@/db/device'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'
import { formatEventDateTime } from '@/lib/datetime'
import { DEVICE_ATTRIBUTE_LABELS } from '@/shared/device-attributes'

interface DeviceIdentitySummaryProps {
  context: DeviceSessionContext
  verifiedAt: string
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
      {label}
    </p>

    <div className="mt-0.5 text-sm">
      {children}
    </div>
  </div>
)

/**
 * What this browser has verified itself to be.
 *
 * Operator-facing: names, not UUIDs. The central device id is available in a
 * collapsed technical detail for someone reconciling against Admin, but it is
 * never the primary reading.
 *
 * Nothing sensitive appears — no password, hash, session version, token or
 * cookie ever reaches the browser, so none of it can be displayed.
 */
const DeviceIdentitySummary: React.FC<DeviceIdentitySummaryProps> = ({
  context,
  verifiedAt,
}) => {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Device">
          <span className="font-heading text-lg font-semibold">
            {context.device.name}
          </span>
        </Field>

        <Field label="Login">
          <span className="text-muted-foreground">
            {context.device.loginName}
          </span>
        </Field>

        <Field label="Event">
          {context.event.name}
        </Field>

        <Field label="Last verified">
          <span className="text-muted-foreground">
            {formatEventDateTime(verifiedAt)}
          </span>
        </Field>

        <Field label="Access">
          {context.device.attributes.length === 0 ? (
            <span className="text-muted-foreground">
              None
            </span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {context.device.attributes.map((attribute) => (
                <Badge
                  key={attribute}
                  variant="outline"
                >
                  {DEVICE_ATTRIBUTE_LABELS[attribute]}
                </Badge>
              ))}
            </span>
          )}
        </Field>

        {/*
          READ-ONLY, and said so plainly. The central assignment is what Admin
          recorded; this desk's own badge range is separate local state and
          has not been touched. Adopting one into the other is a deliberate
          later step, so there is no action here to do it.
        */}
        <Field label="Central badge assignment">
          {context.activeBadgeRange === null ? (
            <span className="text-muted-foreground">
              Not assigned
            </span>
          ) : (
            <span className="font-medium">
              {formatBadgeRange(
                context.activeBadgeRange.rangeStart,
                context.activeBadgeRange.rangeEnd,
              )}
            </span>
          )}

          <span className="mt-1 block text-xs text-muted-foreground">
            Central assignment only. Local badge range has not been changed.
          </span>
        </Field>
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Technical details
        </summary>

        <dl className="mt-2 space-y-1">
          <div>
            <dt className="inline font-medium">
              Central device ID:{' '}
            </dt>

            <dd className="inline font-mono">
              {context.device.id}
            </dd>
          </div>

          <div>
            <dt className="inline font-medium">
              Central event ID:{' '}
            </dt>

            <dd className="inline font-mono">
              {context.event.id}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  )
}

export default DeviceIdentitySummary
