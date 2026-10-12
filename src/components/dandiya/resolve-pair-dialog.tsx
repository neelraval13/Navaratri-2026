import type * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DandiyaRequest } from '@/components/dandiya/active-loan-card'
import { unresolvedHolders } from '@/dandiya/dandiya-filters'
import { formatEventDateTime } from '@/lib/datetime'
import type { DandiyaHolder } from '@/shared/dandiya-contract'
import { dandiyaHolderDetail, dandiyaHolderLabel } from '@/shared/dandiya-contract'

interface ResolvePairDialogProps {
  request: DandiyaRequest | null
  isSubmitting: boolean
  onCancel: () => void
  onConfirm: (request: DandiyaRequest) => void
}

/**
 * Confirming what happened to a stick, or to a pair.
 *
 * ONE DIALOG, FOUR CONFIRMATIONS, because they are the same decision asked
 * about different scopes — and a volunteer should read the same shape of
 * sentence every time.
 *
 * A LOSS SAYS WHAT IT COSTS. Marking a stick lost frees the attendee and
 * QUARANTINES the physical pair, and those two consequences pull in opposite
 * directions: one is a relief and one is a problem. Saying only "are you
 * sure?" would leave somebody surprised when the pair stops being issuable,
 * so the copy states both.
 *
 * WHAT IS ALREADY RESOLVED IS NAMED, NOT HIDDEN. `Return Whole Pair` on a
 * loan with a lost stick resolves only the remaining one and closes as a
 * partial loss — the dialog says so, because the button's name alone would
 * promise more than the action does.
 *
 * Nothing here is reversible, and the dialog does not pretend otherwise.
 */
const ResolvePairDialog: React.FC<ResolvePairDialogProps> = ({
  request,
  isSubmitting,
  onCancel,
  onConfirm,
}) => {
  if (request === null) {
    return null
  }

  const { loan, action, holder, resolution } = request
  const remaining = unresolvedHolders(loan)
  const alreadyLost = loan.holders.filter((entry) => entry.resolution === 'lost')
  const alreadyReturned = loan.holders.filter((entry) => entry.resolution === 'returned')

  /**
   * `#042 Meera Patel`, or `Guest 1` when there is no badge and therefore no
   * name. One label helper, so a confirmation names a stick the same way the
   * card the operator tapped did.
   */
  const nameOf = (entry: DandiyaHolder): string =>
    `${dandiyaHolderLabel(entry)}${
      entry.attendee === null ? '' : ` ${entry.attendee.name}`
    }`

  const title =
    action === 'resolve-holder' && holder !== undefined
      ? resolution === 'lost'
        ? `Mark ${nameOf(holder)}’s stick as lost?`
        : `Return ${nameOf(holder)}’s stick?`
      : action === 'lost-pair'
        ? `Report pair ${loan.pairCode} lost?`
        : remaining.length === loan.holders.length
          ? `Return pair ${loan.pairCode}?`
          : `Return the remaining stick of ${loan.pairCode}?`

  const destructive = action === 'lost-pair' || resolution === 'lost'

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A request in flight must not be abandoned by a backdrop tap: the
        // resolution may already have committed.
        if (!open && !isSubmitting) {
          onCancel()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {title}
          </DialogTitle>

          <DialogDescription>
            {destructive
              ? 'This releases the attendee from their holding, but the physical pair will remain unavailable.'
              : 'This records the stick as returned. It cannot be undone here.'}
          </DialogDescription>
        </DialogHeader>

        <p className="font-heading text-lg font-semibold uppercase tracking-[0.08em]">
          {`Pair ${loan.pairCode}`}
        </p>

        {/* Exactly which sticks this will touch, and which it will not. */}
        <ul className="space-y-1">
          {(action === 'resolve-holder' && holder !== undefined ? [holder] : remaining).map(
            (entry) => (
              <li key={entry.slot} className="flex items-baseline gap-3">
                <span className="font-heading text-base font-semibold">
                  {dandiyaHolderLabel(entry)}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {dandiyaHolderDetail(entry)}
                </span>

                <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  {`Stick ${String(entry.slot)}`}
                </span>
              </li>
            ),
          )}
        </ul>

        {/*
          A SHORTCUT NEVER OVERWRITES A RESOLUTION, and saying so here is the
          difference between a confirmation and a surprise: `Return Whole
          Pair` on a loan with a lost stick closes it as a partial loss.
        */}
        {action !== 'resolve-holder' && alreadyLost.length > 0 ? (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            {`${alreadyLost
              .map((entry) => dandiyaHolderLabel(entry))
              .join(' and ')} already recorded as lost — that stays, and this pair will stay unavailable.`}
          </p>
        ) : null}

        {action === 'lost-pair' && alreadyReturned.length > 0 ? (
          <p className="rounded-xl border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            {`${alreadyReturned
              .map((entry) => dandiyaHolderLabel(entry))
              .join(' and ')} already returned — that stays.`}
          </p>
        ) : null}

        <p className="text-sm text-muted-foreground">
          {`Issued ${formatEventDateTime(loan.issuedAt)} by ${loan.issuedBy.name}`}
        </p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            Cancel
          </Button>

          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            className="h-11 sm:min-w-44"
            disabled={isSubmitting}
            onClick={() => {
              onConfirm(request)
            }}
          >
            {isSubmitting
              ? 'Recording…'
              : action === 'lost-pair'
                ? 'Report Pair Lost'
                : resolution === 'lost'
                  ? 'Mark Lost'
                  : action === 'return-pair'
                    ? 'Confirm Return'
                    : 'Return Stick'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ResolvePairDialog
