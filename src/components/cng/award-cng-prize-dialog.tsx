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
import type { CngMember, CngPrizeAward } from '@/shared/cng-contract'
import { parsePrizeName } from '@/shared/prize-contract'

interface AwardCngPrizeDialogProps {
  member: CngMember | null
  /** Everything this member already holds, newest first. May be empty. */
  previousAwards: readonly CngPrizeAward[]
  isSubmitting: boolean
  onCancel: () => void
  onAward: (prizeName: string) => void
}

/**
 * Confirming one prize for one CNG volunteer.
 *
 * THE SAME EIGHT PRIZES, THROUGH THE SAME CHOOSER. A volunteer's prize is the
 * same prize an attendee's is — the catalog is one allow-list in
 * `src/shared/prize-contract.ts` and both ledgers store its canonical label.
 * Only the RECIPIENT differs, which is exactly why there are two tables and
 * two methods rather than one with a nullable badge.
 *
 * NO DEMOGRAPHIC SUGGESTION, because there is nothing to derive one from. An
 * attendee's age and gender come from the Badge Register and highlight the
 * usual division; a volunteer has neither recorded, and this phase is not
 * going to start collecting them to light up a button. So `suggestedDivision`
 * is `null` and no button is marked — all eight stay equally available.
 *
 * THE MEMBER IS NAMED IN THE CONFIRMATION, because this is the last moment
 * before a permanent append-only row exists and "are you sure?" without
 * saying who is not a confirmation. The name is all there is: no badge, no
 * age, no gender.
 *
 * A PREVIOUS PRIZE IS A WARNING AND NOTHING MORE, exactly as for attendees.
 * Repeat prizes are legal, so it appears above the chooser, names each
 * earlier prize with its time and awarding device, and changes nothing else.
 * It is drawn by MEMBER ID rather than by name, because two volunteers may
 * share a name and showing one of them the other's prizes would be worse than
 * showing none.
 *
 * Duplicate submission is impossible while a request is in flight: every
 * button including the chooser's is disabled, so a double tap cannot produce
 * two awards.
 */
const AwardCngPrizeDialog: React.FC<AwardCngPrizeDialogProps> = ({
  member,
  previousAwards,
  isSubmitting,
  onCancel,
  onAward,
}) => {
  /** `null` until the volunteer taps one. NOTHING is preselected. */
  const [prizeName, setPrizeName] = useState<string | null>(null)

  if (member === null) {
    return null
  }

  /** The SAME shared allow-list the endpoint enforces. */
  const chosen = parsePrizeName(prizeName)

  const close = (): void => {
    setPrizeName(null)
    onCancel()
  }

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
          <p className="font-heading text-xl font-semibold tracking-tight">
            {member.name}
          </p>

          <p className="text-sm text-muted-foreground">
            CNG Member
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
            suggestedDivision={null}
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

export default AwardCngPrizeDialog
