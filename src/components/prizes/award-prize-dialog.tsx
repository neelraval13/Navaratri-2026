import type * as React from 'react'
import { useState } from 'react'

import PreviousAwardsWarning from '@/components/prizes/previous-awards-warning'
import PrizeChooser from '@/components/prizes/prize-chooser'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatBadgeNumber } from '@/lib/badge'
import {
  parsePrizeName,
  suggestedPrizeDivision,
  type PrizeAttendee,
  type PrizeAward,
} from '@/shared/prize-contract'

interface AwardPrizeDialogProps {
  attendee: PrizeAttendee | null
  /** Everything this badge already holds, newest first. May be empty. */
  previousAwards: readonly PrizeAward[]
  isSubmitting: boolean
  onCancel: () => void
  onAward: (prizeName: string) => void
}

const GENDER_LABEL = { male: 'Male', female: 'Female' } as const

/**
 * Confirming one prize for one badge.
 *
 * THE BADGE IS NAMED IN THE CONFIRMATION, prominently, because this is the
 * last moment before a permanent append-only ledger row exists. There is no
 * undo, and "are you sure?" without saying which attendee is not a
 * confirmation.
 *
 * A PREVIOUS PRIZE IS A WARNING AND NOTHING MORE. Since Phase P1.1 repeat
 * awards are legal, so the warning appears ABOVE the chooser, names each
 * earlier prize with its time and awarding device, and changes nothing else:
 * the chooser stays complete, the button stays available, and no override,
 * approval or extra permission is asked for. The only thing that moves is the
 * button's copy — `Award Another Prize` — so a volunteer who is doing this
 * deliberately sees that it is deliberate.
 *
 * THE PRIZE IS CHOSEN FROM EIGHT FIXED VALUES, never typed. The chooser
 * renders the shared catalog, the submit stays unavailable until one is
 * selected, and the value is re-validated against the same shared allow-list
 * on the way out — so a stale or tampered selection cannot be submitted.
 *
 * Duplicate submission is impossible while a request is in flight: every
 * button including the chooser's is disabled, so a double tap cannot produce
 * two awards.
 */
const AwardPrizeDialog: React.FC<AwardPrizeDialogProps> = ({
  attendee,
  previousAwards,
  isSubmitting,
  onCancel,
  onAward,
}) => {
  /** `null` until the volunteer taps one. NOTHING is preselected. */
  const [prizeName, setPrizeName] = useState<string | null>(null)

  if (attendee === null) {
    return null
  }

  const chosen = parsePrizeName(prizeName)

  const close = (): void => {
    setPrizeName(null)
    onCancel()
  }

  /**
   * The copy the spec asks for, with the selected prize appended when there
   * is one: a volunteer confirming a repeat should read what they are about
   * to give, not just that it is another.
   */
  const action = previousAwards.length === 0 ? 'Award Prize' : 'Award Another Prize'
  const label = chosen.ok ? `${action} · ${chosen.value}` : action

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A request in flight must not be abandoned by a backdrop tap: the
        // award may already have committed.
        if (!open && !isSubmitting) {
          close()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Award a Prize
          </DialogTitle>

          <DialogDescription>
            This is recorded permanently and cannot be undone here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-0.5">
          <p className="font-heading text-2xl font-semibold tracking-tight">
            {formatBadgeNumber(attendee.badgeNumber)}
          </p>

          <p className="text-base font-medium">
            {attendee.name}
          </p>

          <p className="text-sm text-muted-foreground">
            {`Age ${String(attendee.age)} · ${GENDER_LABEL[attendee.gender]}`}
          </p>
        </div>

        {/* BEFORE the chooser, so it is read before a prize is picked. */}
        <PreviousAwardsWarning awards={previousAwards} />

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()

            if (chosen.ok && !isSubmitting) {
              onAward(chosen.value)
            }
          }}
        >
          <PrizeChooser
            value={prizeName}
            suggestedDivision={suggestedPrizeDivision(attendee)}
            disabled={isSubmitting}
            onChange={setPrizeName}
          />

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={isSubmitting}
              onClick={close}
            >
              Cancel
            </Button>

            <Button
              type="submit"
              className="h-auto min-h-11 py-2 text-wrap sm:min-w-56"
              disabled={isSubmitting || !chosen.ok}
            >
              {isSubmitting ? 'Awarding…' : label}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default AwardPrizeDialog
