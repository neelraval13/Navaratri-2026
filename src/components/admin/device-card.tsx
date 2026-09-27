import type * as React from 'react'

import type { AdminDevice } from '@/admin/admin-api'
import AssignRangeDialog from '@/components/admin/assign-range-dialog'
import DeviceDialog from '@/components/admin/device-dialog'
import DevicePasswordDialog from '@/components/admin/device-password-dialog'
import { Badge } from '@/components/ui/badge'
import { formatBadgeRange } from '@/db/device'
import { formatEventDateTime } from '@/lib/datetime'
import { DEVICE_ATTRIBUTE_LABELS } from '@/shared/device-attributes'

interface DeviceCardProps {
  eventId: string
  device: AdminDevice
  /** The server-confirmed device, so only this card updates. */
  onChanged: (device: AdminDevice) => void
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
 * One central device.
 *
 * `lastSeenAt` is reported factually. It NEVER says Online or Offline: no
 * device authenticates centrally yet, so there is no trustworthy heartbeat
 * identity, and most devices will correctly read "Never seen".
 */
const DeviceCard: React.FC<DeviceCardProps> = ({ eventId, device, onChanged }) => {
  /**
   * Badge distribution is part of the registration workflow, not a permission
   * of its own: a registration desk issues the badge as the last step of
   * registering an attendee.
   */
  const registers = device.attributes.includes('registration')

  const canAssignRange =
    device.enabled && registers && device.activeBadgeRange === null

  return (
    <div className="space-y-4 rounded-3xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-heading text-xl font-semibold">
            {device.name}
          </h3>

          <p className="text-sm text-muted-foreground">
            {device.loginName ?? 'No login name'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={device.enabled ? 'default' : 'secondary'}>
            {device.enabled ? 'Enabled' : 'Disabled'}
          </Badge>

          <DeviceDialog
            eventId={eventId}
            device={device}
            onSaved={onChanged}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Access">
          {device.attributes.length === 0 ? (
            <span className="text-muted-foreground">
              None
            </span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {device.attributes.map((attribute) => (
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
          Operational STATE, not a permission: which physical numbers this
          device owns. Everything about it lives in this one section,
          including the assign control — it belongs with the state it changes,
          not floating below the card.
        */}
        <Field label="Badge Distribution">
          {!registers ? (
            <span className="text-muted-foreground">
              Not available
            </span>
          ) : device.activeBadgeRange === null ? (
            <>
              <span className="text-muted-foreground">
                Not assigned
              </span>

              {canAssignRange ? (
                <span className="mt-2 block">
                  <AssignRangeDialog
                    eventId={eventId}
                    device={device}
                    onAssigned={(activeBadgeRange) => {
                      onChanged({ ...device, activeBadgeRange })
                    }}
                  />
                </span>
              ) : (
                <span className="block text-xs text-muted-foreground">
                  Enable this device to assign a range.
                </span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium">
                {formatBadgeRange(
                  device.activeBadgeRange.rangeStart,
                  device.activeBadgeRange.rangeEnd,
                )}
              </span>

              {/* No edit or release control: reassigning a live range is how
                  two attendees end up with the same badge. */}
              <span className="block text-xs text-muted-foreground">
                {String(
                  device.activeBadgeRange.rangeEnd -
                    device.activeBadgeRange.rangeStart +
                    1,
                )}{' '}
                badges
              </span>
            </>
          )}
        </Field>

        {/*
          Whether credentials EXIST. Never the hash, never the salt, never a
          previous password, and never a generated secret echoed after a save.
        */}
        <Field label="Credentials">
          {device.credentialsConfigured ? (
            <span className="font-medium">
              Configured
            </span>
          ) : (
            <span className="text-muted-foreground">
              Not configured
            </span>
          )}

          <span className="mt-2 block">
            {device.loginName === null ? (
              <span className="text-xs text-muted-foreground">
                Give this device a login name first.
              </span>
            ) : (
              <DevicePasswordDialog
                eventId={eventId}
                device={device}
                onSaved={onChanged}
              />
            )}
          </span>
        </Field>

        <Field label="Last seen">
          <span className="text-muted-foreground">
            {device.lastSeenAt === null
              ? 'Never seen'
              : formatEventDateTime(device.lastSeenAt)}
          </span>
        </Field>

        <Field label="Created">
          <span className="text-muted-foreground">
            {formatEventDateTime(device.createdAt)}
          </span>
        </Field>
      </div>

    </div>
  )
}

export default DeviceCard
