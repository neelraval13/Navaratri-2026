import { CircleAlert, Ticket } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import AdoptionBlock from '@/components/device-auth/adoption-block'
import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ClaimPlan } from '@/db/central-badge-range'
import { formatBadgeRange } from '@/db/device'
import { formatBadgeNumber } from '@/lib/badge'

interface BadgeRangeClaimProps {
  plan: ClaimPlan
  isBusy: boolean
  onClaim: (input: {
    rangeStart: number
    rangeEnd: number
    physicalStackConfirmed: boolean
  }) => void
  /** Editing the range invalidates whatever the last attempt reported. */
  onRangeEdited: () => void
}

const parseBadgeNumber = (value: string): number | null => {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const PhysicalStackConfirmation: React.FC<{
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}> = ({ id, label, checked, onChange }) => (
  <Label htmlFor={id} className="flex items-start gap-3 font-normal">
    {/* A native checkbox: the design system has no checkbox primitive, and
        one control does not justify adding a registry component. */}
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => {
        onChange(event.target.checked)
      }}
      className="mt-0.5 size-5 shrink-0 accent-primary"
    />

    <span className="text-sm leading-relaxed">
      {label}
    </span>
  </Label>
)

const RESERVED_FIRST =
  'The range is reserved online first. After the central reservation succeeds, this browser will use the same range locally for offline badge issuance.'

/**
 * Claiming a badge range centrally, for a device that owns none.
 *
 * Online only, and never automatic. Postgres decides OWNERSHIP; this browser
 * keeps allocating locally afterwards, including offline.
 *
 * There is deliberately no suggested range and no "next free range" button.
 * No global allocator exists, and inventing one here would quietly make the
 * software, rather than the physical badge stack on the table, decide which
 * numbers this desk hands out.
 */
const BadgeRangeClaim: React.FC<BadgeRangeClaimProps> = ({
  plan,
  isBusy,
  onClaim,
  onRangeEdited,
}) => {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  /**
   * Editing either boundary invalidates BOTH the physical confirmation and the
   * last result.
   *
   * The confirmation was a statement about one exact stack: someone who
   * ticked "I have physical badges #401-#500" and then typed #501-#600 has
   * confirmed nothing about the second stack, and carrying the tick across
   * would let one confirmation reserve a range nobody looked at. The previous
   * result goes too, because it described the old numbers.
   */
  const editRange = (setValue: (value: string) => void) => (raw: string) => {
    setValue(raw.replace(/\D/g, ''))
    setConfirmed(false)
    onRangeEdited()
  }

  if (plan.outcome === 'binding-without-assignment') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Local badge ownership history does not match the current central
          state
        </p>

        <BadgeStateRow label="Adopted here">
          <span className="font-medium">
            {formatBadgeRange(plan.binding.rangeStart, plan.binding.rangeEnd)}
          </span>
        </BadgeStateRow>

        <BadgeStateRow label="Central assignment">
          <span className="text-muted-foreground">
            Not assigned
          </span>
        </BadgeStateRow>

        <p className="text-sm leading-relaxed text-muted-foreground">
          This browser adopted a central badge range that central no longer
          reports. Claiming a range again could hand these physical numbers to
          two desks, so it is blocked and needs reconciliation.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'claimable-existing') {
    const range = formatBadgeRange(plan.rangeStart, plan.rangeEnd)

    return (
      <div className="space-y-4">
        <p className="font-semibold">
          Claim this desk&rsquo;s existing range centrally
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Existing local badge range">
            <span className="font-heading text-lg font-semibold">
              {range}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Central assignment">
            <span className="text-muted-foreground">
              Not assigned
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Next badge">
            <span className="font-medium">
              {formatBadgeNumber(plan.nextBadge)}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Completed badges">
            {String(plan.issuedCount)}
          </BadgeStateRow>
        </div>

        {/*
          The range is shown, never edited. Typing a different one here would
          leave the local allocator immediately at odds with what central
          records this device as owning.
        */}
        <p className="text-sm leading-relaxed text-muted-foreground">
          Only this exact range can be claimed. The next badge stays at{' '}
          {formatBadgeNumber(plan.nextBadge)} and no registration changes.
        </p>

        <PhysicalStackConfirmation
          id="claim-existing-stack"
          label={`The physical ${range} badge stack belongs to this device.`}
          checked={confirmed}
          onChange={setConfirmed}
        />

        <Button
          type="button"
          disabled={!confirmed || isBusy}
          onClick={() => {
            onClaim({
              rangeStart: plan.rangeStart,
              rangeEnd: plan.rangeEnd,
              physicalStackConfirmed: confirmed,
            })
          }}
          className="h-12 w-full sm:w-auto sm:min-w-64"
        >
          <Ticket data-icon="inline-start" />
          {isBusy ? 'Claiming…' : `Claim Existing ${range} Centrally`}
        </Button>
      </div>
    )
  }

  if (plan.outcome === 'claimable-fresh') {
    const startNumber = parseBadgeNumber(start)
    const endNumber = parseBadgeNumber(end)
    const isRangeValid =
      startNumber !== null && endNumber !== null && startNumber <= endNumber
    const range = isRangeValid ? formatBadgeRange(startNumber, endNumber) : null
    const badgeCount = isRangeValid ? endNumber - startNumber + 1 : null

    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Local badge range">
            <span className="text-muted-foreground">
              Not configured
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Central assignment">
            <span className="text-muted-foreground">
              Not assigned
            </span>
          </BadgeStateRow>
        </div>

        <p className="font-semibold">
          Badge Range Setup
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="claim-range-start">
              Range start
            </Label>

            <Input
              id="claim-range-start"
              type="text"
              inputMode="numeric"
              value={start}
              onChange={(event) => {
                editRange(setStart)(event.target.value)
              }}
              className="h-12"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="claim-range-end">
              Range end
            </Label>

            <Input
              id="claim-range-end"
              type="text"
              inputMode="numeric"
              value={end}
              onChange={(event) => {
                editRange(setEnd)(event.target.value)
              }}
              className="h-12"
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {badgeCount === null
            ? 'Enter the first and last number of the physical badge stack at this device.'
            : `${String(badgeCount)} ${badgeCount === 1 ? 'badge' : 'badges'}`}
        </p>

        <PhysicalStackConfirmation
          id="claim-fresh-stack"
          label={
            range === null
              ? 'I have the physical badges for this range at this device.'
              : `I have physical badges ${range} at this device.`
          }
          checked={confirmed}
          onChange={setConfirmed}
        />

        <p className="text-xs leading-relaxed text-muted-foreground">
          {RESERVED_FIRST}
        </p>

        <Button
          type="button"
          disabled={!isRangeValid || !confirmed || isBusy}
          onClick={() => {
            if (startNumber === null || endNumber === null) {
              return
            }

            onClaim({
              rangeStart: startNumber,
              rangeEnd: endNumber,
              physicalStackConfirmed: confirmed,
            })
          }}
          className="h-12 w-full sm:w-auto sm:min-w-64"
        >
          <Ticket data-icon="inline-start" />
          {isBusy
            ? 'Claiming…'
            : range === null
              ? 'Claim & Set Up Badge Range'
              : `Claim & Set Up ${range}`}
        </Button>
      </div>
    )
  }

  if (plan.outcome === 'blocked') {
    return <AdoptionBlock plan={plan.plan} />
  }

  /**
   * `central-assignment-exists` cannot be reached from here: the adoption
   * section renders whenever central reports a range, and this component is
   * only mounted when it reports none.
   */
  return null
}

export default BadgeRangeClaim
