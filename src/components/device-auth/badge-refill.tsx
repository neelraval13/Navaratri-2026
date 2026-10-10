import { CircleAlert, Ticket } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { RefillPlan } from '@/db/central-badge-range'
import { formatBadgeRange } from '@/db/device'
import { formatBadgeNumber } from '@/lib/badge'

interface BadgeRefillProps {
  plan: RefillPlan
  isBusy: boolean
  onRefill: (input: { newRangeEnd: number; physicalStackConfirmed: boolean }) => void
  onFinishExtension: () => void
  /** Editing the new end invalidates whatever the last attempt reported. */
  onRangeEdited: () => void
}

const parseBadgeNumber = (value: string): number | null => {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Adding more physical badges to a desk that already owns a range.
 *
 * The range is EXTENDED upward and contiguously. The operator chooses only
 * the new LAST badge; the first badge of the new batch is derived from the
 * current end and is deliberately read-only — a refill with a gap is not a
 * contiguous range, and this phase implements no multi-range ownership.
 *
 * `nextBadge` is shown but never offered for editing. A desk part-way through
 * its range keeps its place: receiving #051-#100 does not move it to #051.
 */
const BadgeRefill: React.FC<BadgeRefillProps> = ({
  plan,
  isBusy,
  onRefill,
  onFinishExtension,
  onRangeEdited,
}) => {
  const [newEnd, setNewEnd] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  /**
   * Editing the new end invalidates BOTH the physical confirmation and the
   * last result. The confirmation was a statement about one exact batch:
   * someone who ticked "I have #003-#050" and then typed #100 has confirmed
   * nothing about #051-#100.
   */
  const editEnd = (raw: string) => {
    setNewEnd(raw.replace(/\D/g, ''))
    setConfirmed(false)
    onRangeEdited()
  }

  /**
   * THE RECOVERY STATE. Central already records the extension and this
   * browser does not, which is what a refill whose central half committed
   * and whose local half failed leaves behind.
   *
   * Loud, because the desk must not issue badges until local state catches
   * up: locally it still believes its range ends where it did.
   */
  if (plan.outcome === 'extension-pending') {
    const pending = plan.central.rangeEnd - plan.local.rangeEnd

    return (
      <div className="space-y-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-4">
        <p className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
          <CircleAlert className="size-5" />
          Central badge range was extended, but this browser did not finish
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Central assignment">
            <span className="font-heading text-lg font-semibold">
              {formatBadgeRange(plan.central.rangeStart, plan.central.rangeEnd)}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="This browser">
            <span className="font-medium">
              {formatBadgeRange(plan.local.rangeStart, plan.local.rangeEnd)}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Still to add">
            {`${String(pending)} ${pending === 1 ? 'badge' : 'badges'}`}
          </BadgeStateRow>

          <BadgeStateRow label="Next badge stays">
            <span className="font-medium">
              {formatBadgeNumber(plan.nextBadge)}
            </span>
          </BadgeStateRow>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Do not issue badges from this device until local setup is finished.
          Finishing adds only the extra numbers at the end of the range — the
          next badge and every registration stay exactly as they are.
        </p>

        <Button
          type="button"
          disabled={isBusy}
          onClick={onFinishExtension}
          className="h-12 w-full sm:w-auto sm:min-w-64"
        >
          <Ticket data-icon="inline-start" />
          {isBusy
            ? 'Finishing…'
            : `Finish Local Setup ${formatBadgeRange(plan.central.rangeStart, plan.central.rangeEnd)}`}
        </Button>
      </div>
    )
  }

  if (plan.outcome !== 'refillable') {
    /**
     * `unavailable` is not an error — this desk simply has no range to
     * extend — and `blocked` is already reported in full by the shared
     * ownership block. Neither needs a second voice here.
     */
    return null
  }

  const endNumber = parseBadgeNumber(newEnd)
  const isValid = endNumber !== null && endNumber >= plan.refillStart
  const added = isValid ? endNumber - plan.current.rangeEnd : null
  const refillRange = isValid ? formatBadgeRange(plan.refillStart, endNumber) : null

  return (
    <div className="space-y-4">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Badge Refill
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <BadgeStateRow label="Current range">
          <span className="font-heading text-lg font-semibold">
            {formatBadgeRange(plan.current.rangeStart, plan.current.rangeEnd)}
          </span>
        </BadgeStateRow>

        {/* DERIVED and read-only: the next batch starts where this one ends. */}
        <BadgeStateRow label="Next refill starts">
          <span className="font-medium">
            {formatBadgeNumber(plan.refillStart)}
          </span>
        </BadgeStateRow>
      </div>

      <div className="max-w-xs space-y-2">
        <Label htmlFor="refill-range-end">
          New last badge
        </Label>

        <Input
          id="refill-range-end"
          type="text"
          inputMode="numeric"
          value={newEnd}
          onChange={(event) => {
            editEnd(event.target.value)
          }}
          className="h-12"
        />
      </div>

      <p className="text-sm text-muted-foreground">
        {added === null
          ? `Enter the last number of the new physical badge stack. It must be ${formatBadgeNumber(plan.refillStart)} or higher.`
          : `${String(added)} additional ${added === 1 ? 'badge' : 'badges'}`}
      </p>

      <Label htmlFor="refill-stack" className="flex items-start gap-3 font-normal">
        {/* A native checkbox: the design system has no checkbox primitive. */}
        <input
          id="refill-stack"
          type="checkbox"
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked)
          }}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />

        <span className="text-sm leading-relaxed">
          {refillRange === null
            ? 'I have the additional physical badges at this device.'
            : `I have physical badges ${refillRange} at this device.`}
        </span>
      </Label>

      <p className="text-xs leading-relaxed text-muted-foreground">
        The extra badges are added online first. The next badge number stays at{' '}
        {formatBadgeNumber(plan.nextBadge)} and no registration changes.
      </p>

      <Button
        type="button"
        disabled={!isValid || !confirmed || isBusy}
        onClick={() => {
          if (endNumber === null) {
            return
          }

          onRefill({ newRangeEnd: endNumber, physicalStackConfirmed: confirmed })
        }}
        className="h-12 w-full sm:w-auto sm:min-w-64"
      >
        <Ticket data-icon="inline-start" />
        {isBusy
          ? 'Adding…'
          : refillRange === null
            ? 'Add More Badges'
            : `Add ${refillRange}`}
      </Button>
    </div>
  )
}

export default BadgeRefill
