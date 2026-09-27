import { CircleAlert, Save } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { configureBadgeDistribution, formatBadgeRange } from '@/db/device'

interface BadgeDistributionFormProps {
  onConfigured: () => void
}

const parseBadgeNumber = (value: string): number | null => {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * One-time badge-range assignment for an ALREADY-REGISTERED device.
 *
 * It asks nothing about device identity — that already exists. The range
 * entered here must match the PHYSICAL badge stack placed at this desk. The
 * software cannot verify that, which is why the confirmation is mandatory
 * rather than advisory: two desks given overlapping physical stacks will hand
 * out duplicate badges no matter what the application does.
 */
const BadgeDistributionForm: React.FC<BadgeDistributionFormProps> = ({
  onConfigured,
}) => {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startNumber = parseBadgeNumber(start)
  const endNumber = parseBadgeNumber(end)

  const isRangeValid =
    startNumber !== null && endNumber !== null && startNumber <= endNumber

  const badgeCount = isRangeValid ? endNumber - startNumber + 1 : null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSaving) {
      return
    }

    if (!isRangeValid) {
      setError('Enter a valid badge range. The start must not be after the end.')

      return
    }

    if (!confirmed) {
      setError('Confirm the matching physical badges are at this device.')

      return
    }

    setIsSaving(true)
    setError(null)

    const result = await configureBadgeDistribution({
      badgeStart: startNumber,
      badgeEnd: endNumber,
      physicalStackConfirmed: confirmed,
    })

    setIsSaving(false)

    if (result.outcome === 'configured' || result.outcome === 'already-configured') {
      onConfigured()

      return
    }

    if (result.outcome === 'device-not-registered') {
      setError('Register this device before assigning it a badge range.')

      return
    }

    if (result.outcome === 'stack-not-confirmed') {
      setError('Confirm the matching physical badges are at this device.')

      return
    }

    if (result.outcome === 'invalid-range') {
      setError('Enter a valid badge range.')

      return
    }

    setError('Event configuration is unavailable. Reload the app and try again.')
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="space-y-6"
    >
      <div className="space-y-2">
        <p className="text-sm font-medium">
          Badge range
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="device-badge-start">
              From
            </Label>

            <Input
              id="device-badge-start"
              type="text"
              inputMode="numeric"
              placeholder="001"
              value={start}
              onChange={(event) => {
                setStart(event.target.value.replace(/\D/g, ''))
              }}
              className="h-12"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="device-badge-end">
              To
            </Label>

            <Input
              id="device-badge-end"
              type="text"
              inputMode="numeric"
              placeholder="250"
              value={end}
              onChange={(event) => {
                setEnd(event.target.value.replace(/\D/g, ''))
              }}
              className="h-12"
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {badgeCount === null
            ? 'Enter the first and last badge number assigned to this device.'
            : `${String(badgeCount)} ${badgeCount === 1 ? 'badge' : 'badges'} assigned`}
        </p>
      </div>

      <Label
        htmlFor="device-physical-confirmed"
        className="flex items-start gap-3 font-normal"
      >
        {/* A native checkbox: the design system has no checkbox primitive, and
            one control does not justify adding a registry component. */}
        <input
          id="device-physical-confirmed"
          type="checkbox"
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked)
          }}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />

        <span className="text-sm leading-relaxed">
          I have the matching physical badges
          {isRangeValid ? ` ${formatBadgeRange(startNumber, endNumber)}` : ''} at
          this device
        </span>
      </Label>

      {error === null ? null : (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSaving}
        className="h-12 w-full sm:w-auto sm:min-w-64"
      >
        <Save data-icon="inline-start" />
        {isSaving ? 'Saving…' : 'Configure Badge Distribution'}
      </Button>
    </form>
  )
}

export default BadgeDistributionForm
