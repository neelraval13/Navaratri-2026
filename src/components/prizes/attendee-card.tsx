import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { formatBadgeNumber } from '@/lib/badge'
import type { PrizeAttendee } from '@/shared/prize-contract'

interface AttendeeCardProps {
  attendee: PrizeAttendee
  /** How many prizes this badge already holds. Informational only. */
  previousAwardCount: number
  isBusy: boolean
  onGivePrize: (attendee: PrizeAttendee) => void
}

const GENDER_LABEL = { male: 'Male', female: 'Female' } as const

/**
 * One registered attendee.
 *
 * EVERY attendee has Give Prize, always. Since Phase P1.1 a previous prize
 * disqualifies nobody — an attendee may win Best Dance and Best Dress, or the
 * same prize twice — so the button is never hidden, never disabled on those
 * grounds and the card is never removed from the list after an award.
 *
 * A previous prize is shown as a COUNT, so a volunteer can see it before
 * opening the dialog. The dialog then names each one. It is information: the
 * warning lives there precisely so it cannot be mistaken for a refusal here.
 *
 * THE BADGE NUMBER DOMINATES, for the same reason it does on the registration
 * form header: the volunteer is matching a card in somebody's hand, and the
 * name is how they confirm it rather than how they find it.
 *
 * A card in a responsive grid, not a row in a dense table: this is a tablet
 * at a noisy prize table, and a touch target has to be a touch target.
 */
const AttendeeCard: React.FC<AttendeeCardProps> = ({
  attendee,
  previousAwardCount,
  isBusy,
  onGivePrize,
}) => {
  return (
    <div className="flex flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-4">
      <div className="space-y-0.5">
        <p className="font-heading text-2xl font-semibold tracking-tight">
          {formatBadgeNumber(attendee.badgeNumber)}
        </p>

        <p className="truncate text-base font-medium" title={attendee.name}>
          {attendee.name}
        </p>

        <p className="text-sm text-muted-foreground">
          {`Age ${String(attendee.age)} · ${GENDER_LABEL[attendee.gender]}`}
        </p>

        {previousAwardCount === 0 ? null : (
          /* Amber: worth noticing, never an error and never a refusal. */
          <p className="pt-1 text-sm font-medium text-amber-700 dark:text-amber-400">
            {previousAwardCount === 1
              ? '1 prize already received'
              : `${String(previousAwardCount)} prizes already received`}
          </p>
        )}
      </div>

      <Button
        type="button"
        className="h-11 w-full"
        disabled={isBusy}
        onClick={() => {
          onGivePrize(attendee)
        }}
      >
        Give Prize
      </Button>
    </div>
  )
}

export default AttendeeCard
