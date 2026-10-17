import type * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CngMember } from '@/shared/cng-contract'

interface RemoveCngMemberDialogProps {
  /** `null` closes it. The parent owns the selection. */
  member: CngMember | null
  /** How many prizes they already hold. Named, so removal is not feared. */
  previousAwardCount: number
  isSubmitting: boolean
  onCancel: () => void
  onRemove: (member: CngMember) => void
}

/**
 * Confirming that one volunteer leaves the CNG group.
 *
 * IT NAMES WHAT IS REMOVED AND, JUST AS IMPORTANTLY, WHAT IS NOT. A removal
 * takes the member off the active list and does nothing else: their prize
 * history stays, and every attendee, registration and badge is untouched. An
 * operator hesitating over this button is usually afraid of exactly that, so
 * the dialog says so rather than leaving them to guess.
 *
 * THE REMOVAL IS SOFT, which is what makes that promise keepable. The row
 * survives with a `removed_at` stamp, so a prize awarded last night can still
 * say who received it — and the award ledger's foreign key makes a hard
 * delete impossible anyway.
 *
 * REVERSIBLE IN THE WAY THAT MATTERS: somebody removed by mistake is added
 * again through Add. That new row is a NEW membership — it does not inherit
 * the old one's prizes — and the dialog does not pretend otherwise.
 */
const RemoveCngMemberDialog: React.FC<RemoveCngMemberDialogProps> = ({
  member,
  previousAwardCount,
  isSubmitting,
  onCancel,
  onRemove,
}) => {
  if (member === null) {
    return null
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) {
          onCancel()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Remove from CNG
          </DialogTitle>

          <DialogDescription>
            This removes the CNG membership only.
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

        <p className="text-sm leading-relaxed text-muted-foreground">
          {previousAwardCount === 0
            ? `${member.name} comes off the CNG list. No attendee, registration or
               prize record changes, and they can be added again at any time.`
            : previousAwardCount === 1
              ? `${member.name} comes off the CNG list. The 1 prize already
                 awarded to them stays in the history under their name, and
                 they can be added again at any time.`
              : `${member.name} comes off the CNG list. The ${String(previousAwardCount)}
                 prizes already awarded to them stay in the history under
                 their name, and they can be added again at any time.`}
        </p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            Keep in CNG
          </Button>

          <Button
            type="button"
            className="h-11 sm:min-w-44"
            disabled={isSubmitting}
            onClick={() => {
              onRemove(member)
            }}
          >
            {isSubmitting ? 'Removing…' : 'Remove from CNG'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default RemoveCngMemberDialog
