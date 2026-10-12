import type * as React from 'react'

import AttendeePicker, { type PriorLoss } from '@/components/dandiya/attendee-picker'
import type { HolderObligation } from '@/dandiya/dandiya-filters'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { EventAttendee } from '@/shared/attendee-contract'

/** Which kind of person is holding this stick. */
export type HolderMode = 'attendee' | 'guest'

interface HolderSlotProps {
  label: string
  inputId: string
  mode: HolderMode
  attendees: readonly EventAttendee[]
  selected: EventAttendee | null
  excludedBadgeNumber: number | null
  obligation: HolderObligation | null
  priorLosses: readonly PriorLoss[]
  disabled: boolean
  onModeChange: (mode: HolderMode) => void
  onSelect: (attendee: EventAttendee | null) => void
}

/**
 * ONE STICK'S HOLDER: a registered attendee, or somebody with no badge.
 *
 * Not everybody dancing has been through the registration desk, and a pair
 * still has to be accountable to somebody. So each slot asks WHICH KIND of
 * holder first, and only then for an identity — rather than making an
 * operator type "Guest" into a badge search, which would search for an
 * attendee called Guest and find nobody.
 *
 * A GUEST HAS NO IDENTITY TO COLLECT. No name, no age, no number: the slot
 * exists so the stick can be returned or lost on its own, and the pair's
 * accountability is either the other holder's badge or — when neither has one
 * — the single contact number the form then asks for.
 *
 * SWITCHING TO NO BADGE CLEARS THE SELECTION, because leaving an attendee
 * selected behind a guest toggle is a form that shows one thing and submits
 * another.
 */
const HolderSlot: React.FC<HolderSlotProps> = ({
  label,
  inputId,
  mode,
  attendees,
  selected,
  excludedBadgeNumber,
  obligation,
  priorLosses,
  disabled,
  onModeChange,
  onSelect,
}) => {
  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label={`${label} type`}
        className="flex flex-wrap gap-2"
      >
        <Button
          type="button"
          variant={mode === 'attendee' ? 'default' : 'outline'}
          className="h-10 flex-1 sm:flex-none"
          aria-pressed={mode === 'attendee'}
          disabled={disabled}
          onClick={() => {
            onModeChange('attendee')
          }}
        >
          Registered attendee
        </Button>

        <Button
          type="button"
          variant={mode === 'guest' ? 'default' : 'outline'}
          className="h-10 flex-1 sm:flex-none"
          aria-pressed={mode === 'guest'}
          disabled={disabled}
          onClick={() => {
            onModeChange('guest')
          }}
        >
          No badge
        </Button>
      </div>

      {mode === 'attendee' ? (
        <AttendeePicker
          label={label}
          inputId={inputId}
          attendees={attendees}
          selected={selected}
          excludedBadgeNumber={excludedBadgeNumber}
          obligation={obligation}
          priorLosses={priorLosses}
          disabled={disabled}
          onSelect={onSelect}
        />
      ) : (
        <div className="space-y-1.5">
          <Label>
            {label}
          </Label>

          <div className="rounded-xl border border-border bg-muted/40 px-3 py-2">
            <p className="font-heading text-base font-semibold">
              No badge
            </p>

            <p className="text-sm text-muted-foreground">
              This stick can still be returned or marked lost on its own.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default HolderSlot
