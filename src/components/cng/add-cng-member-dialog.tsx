import type * as React from 'react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  parseCngMemberName,
  type CngMemberDraft,
} from '@/shared/cng-contract'

interface AddCngMemberDialogProps {
  isSubmitting: boolean
  onCancel: () => void
  onAdd: (draft: CngMemberDraft) => void
}

/**
 * Adding one CNG volunteer, by name.
 *
 * ONE FIELD, AND NO SEARCH. Phase CNG1 made this a search over the Badge
 * Register, on the assumption that a volunteer was a registered attendee.
 * They are not — they wear no numbered badge and most never pass the
 * registration desk — so there is nothing to search and nothing to match. The
 * operator types the name, and that name IS the member.
 *
 * NOTHING ELSE IS ASKED FOR. No badge, no age, no gender, no phone number:
 * none of those are needed to hand somebody a prize, and the only reason to
 * collect them would be that a form had a space for them.
 *
 * THE NAME IS SHOWN BACK BEFORE THE ROW EXISTS. The trimmed form — exactly
 * what will be stored — appears under the field as it is typed, so an
 * operator sees a stray double space or a trailing tab resolved before they
 * commit. The SAME shared validator the server uses decides whether the
 * button is available, so the form cannot offer to submit something the
 * endpoint would refuse.
 *
 * A DUPLICATE NAME IS ACCEPTED, because two volunteers may genuinely share
 * one. There is no uniqueness to warn about: the row's id is the identity,
 * and an operator who adds somebody twice removes one.
 *
 * THE ID IS GENERATED ONCE, WHEN THIS DIALOG OPENS, and kept for as long as
 * it stays open. That is what makes the `PUT` retryable: if the response is
 * lost the operator can submit again, the same id arrives, and the server
 * answers `already-member` with the row that exists rather than creating a
 * second one. Generating it per submission would defeat the whole mechanism,
 * and generating it on the server could not work at all — the point is that
 * the CLIENT can repeat itself.
 */
const AddCngMemberDialog: React.FC<AddCngMemberDialogProps> = ({
  isSubmitting,
  onCancel,
  onAdd,
}) => {
  const [name, setName] = useState('')
  /**
   * ONE id for this open dialog, from the lazy initialiser so it is minted
   * exactly once — not on every render, and not per submission.
   */
  const [cngMemberId] = useState(() => crypto.randomUUID())

  /** The SHARED policy — trim, non-empty, bounded — not a second copy. */
  const parsed = parseCngMemberName(name)

  const close = (): void => {
    setName('')
    onCancel()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A request in flight must not be abandoned by a backdrop tap: the
        // row may already have committed.
        if (!open && !isSubmitting) {
          close()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Add a CNG Member
          </DialogTitle>

          <DialogDescription>
            CNG members are event volunteers. They have no attendee badge, so
            only a name is recorded.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()

            if (parsed.ok && !isSubmitting) {
              onAdd({ cngMemberId, name: parsed.value })
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cng-member-name">
              Name
            </Label>

            <Input
              id="cng-member-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Full name"
              className="h-11"
              disabled={isSubmitting}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
            />

            {/*
              WHAT WILL BE STORED, shown back before it is. Silent while the
              field is untouched: a validation message on first render is
              noise, not help.
            */}
            {name === '' ? (
              <p className="text-sm text-muted-foreground">
                This name is stored for the event’s CNG list.
              </p>
            ) : parsed.ok ? (
              <p className="text-sm text-muted-foreground">
                {`Will be added as “${parsed.value}”.`}
              </p>
            ) : (
              <p className="text-sm font-medium text-destructive">
                {parsed.message}
              </p>
            )}
          </div>

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
              className="h-11 sm:min-w-44"
              disabled={isSubmitting || !parsed.ok}
            >
              {isSubmitting ? 'Adding…' : 'Add CNG Member'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default AddCngMemberDialog
