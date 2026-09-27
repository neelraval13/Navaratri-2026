import { CircleAlert, Ticket } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import {
  assignBadgeRange,
  type AdminBadgeRange,
  type AdminDevice,
} from '@/admin/admin-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBadgeRange } from '@/db/device'

interface AssignRangeDialogProps {
  eventId: string
  device: AdminDevice
  /** The range the server actually reserved, never the one that was typed. */
  onAssigned: (range: AdminBadgeRange) => void
}

const parseBadge = (value: string): number | null => {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Assigns a device its FIRST badge range.
 *
 * There is no edit, replace, release or extend here, and none appears once a
 * range exists. Changing a range while devices operate offline is how two
 * attendees end up with the same physical badge.
 *
 * Overlap is refused by PostgreSQL, not by this form — two Admins can race.
 */
const AssignRangeDialog: React.FC<AssignRangeDialogProps> = ({
  eventId,
  device,
  onAssigned,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startNumber = parseBadge(start)
  const endNumber = parseBadge(end)
  const range =
    startNumber !== null && endNumber !== null && startNumber <= endNumber
      ? { start: startNumber, end: endNumber }
      : null
  const count = range === null ? null : range.end - range.start + 1

  const assign = async () => {
    if (isSaving) {
      return
    }

    if (range === null) {
      setError('Enter a valid badge range. The first badge must not be after the last.')

      return
    }

    setIsSaving(true)
    setError(null)

    const result = await assignBadgeRange({
      eventId,
      deviceId: device.id,
      rangeStart: range.start,
      rangeEnd: range.end,
    })

    setIsSaving(false)

    if (!result.ok) {
      setError(result.message)

      return
    }

    setIsOpen(false)
    onAssigned(result.value)
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        setIsOpen(open)

        if (open) {
          setStart('')
          setEnd('')
          setError(null)
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
          >
            <Ticket data-icon="inline-start" />
            Assign Badge Range
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Assign Badge Range
          </DialogTitle>

          <DialogDescription>
            {device.name} · assigned once, and not editable afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="assign-range-start">
              From
            </Label>

            <Input
              id="assign-range-start"
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
            <Label htmlFor="assign-range-end">
              To
            </Label>

            <Input
              id="assign-range-end"
              inputMode="numeric"
              placeholder="200"
              value={end}
              onChange={(event) => {
                setEnd(event.target.value.replace(/\D/g, ''))
              }}
              className="h-12"
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {range === null || count === null
            ? 'Enter the first and last badge number for this device.'
            : `${String(count)} ${count === 1 ? 'badge' : 'badges'} · ${formatBadgeRange(range.start, range.end)}`}
        </p>

        {error === null ? null : (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        <Button
          type="button"
          disabled={isSaving}
          onClick={() => {
            void assign()
          }}
          className="h-12 w-full sm:w-auto sm:min-w-40"
        >
          {isSaving ? 'Assigning…' : 'Assign Range'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export default AssignRangeDialog
