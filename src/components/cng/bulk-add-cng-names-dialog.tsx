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
import { Label } from '@/components/ui/label'
import {
  parsePastedCngNames,
  type CngMemberDraft,
} from '@/shared/cng-contract'

interface BulkAddCngNamesDialogProps {
  isSubmitting: boolean
  onCancel: () => void
  onAdd: (drafts: readonly CngMemberDraft[]) => void
}

/**
 * ADDING THE VOLUNTEER LIST IN ONE PASTE.
 *
 * The organiser has their volunteers written down somewhere. This turns that
 * list into memberships in one action.
 *
 * IT IS NO LONGER A RESOLVER. Phase CNG1 matched each pasted name against the
 * Badge Register, because it assumed a volunteer was a registered attendee —
 * so a name that matched nothing was "unresolved" and a name that matched
 * twice needed a badge chosen. That whole problem was an artefact of the
 * wrong model. A CNG member is a NAME: there is nothing to resolve, nothing
 * to look up, and no badge, age or gender to find. Every non-empty line is a
 * volunteer.
 *
 * SO THERE IS NO MATCHING OF ANY KIND HERE. No Badge Register read, no fuzzy
 * matching, no edit distance, no "did you mean", no badge lookup. The preview
 * below is simply the lines, trimmed.
 *
 * THE PASTED TEXT LIVES IN THIS COMPONENT'S MEMORY AND NOWHERE ELSE. It is
 * never written to Postgres as text, the Google Sheet, IndexedDB,
 * `localStorage`, `sessionStorage`, a URL or query parameter, a log line or
 * an analytics call. What reaches the server is one `{ name }` per member,
 * through the SAME single-member call the individual Add uses — there is
 * deliberately no bulk endpoint. The parent renders this dialog
 * CONDITIONALLY rather than passing an `open` flag, so closing it UNMOUNTS it
 * and React discards the list.
 *
 * THE PREVIEW IS EXACTLY WHAT WILL BE ADDED, numbered, in order, before
 * anything is written. A duplicate line appears twice, because the list said
 * it twice and two volunteers may genuinely share a name — de-duplicating
 * would quietly edit the organiser's list.
 *
 * EACH PREVIEWED NAME GETS ITS OWN ID, MINTED ONCE, and it is stable for as
 * long as this dialog stays open. That is what makes a partially failed run
 * safe to repeat: twenty-three `PUT`s where the ninth lost its response can
 * be sent again, the first eight answer `already-member`, the ninth lands
 * once, and nobody is added twice. Minting per submission would turn every
 * retry into a duplicate — and because duplicate NAMES are legal, nothing
 * downstream could have detected it.
 */
const BulkAddCngNamesDialog: React.FC<BulkAddCngNamesDialogProps> = ({
  isSubmitting,
  onCancel,
  onAdd,
}) => {
  /** The paste. Component memory only — see the note above. */
  const [text, setText] = useState('')
  /**
   * `null` until the operator asks to see what will be added. Each entry
   * carries the id that will be used, minted when the preview is built and
   * reused on every attempt from then on.
   */
  const [preview, setPreview] = useState<readonly CngMemberDraft[] | null>(null)

  /** The SHARED parser, so the preview cannot differ from what is sent. */
  const names = parsePastedCngNames(text)

  const discard = (): void => {
    setText('')
    setPreview(null)
  }

  const close = (): void => {
    discard()
    onCancel()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A request in flight must not be abandoned by a backdrop tap: some
        // of the members may already have been added.
        if (!open && !isSubmitting) {
          close()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Bulk Add Names
          </DialogTitle>

          <DialogDescription>
            Paste the volunteer list, one name per line. Each line becomes one
            CNG member — nothing is matched against the attendee register.
          </DialogDescription>
        </DialogHeader>

        {preview === null ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cng-bulk-names">
                CNG names
              </Label>

              {/*
                A plain textarea: there is no shadcn textarea primitive in
                this project and one control does not justify adding one.
                `autoComplete` is off and there is no `name`, so a browser
                never offers to remember what was pasted here.
              */}
              <textarea
                id="cng-bulk-names"
                rows={8}
                autoComplete="off"
                spellCheck={false}
                placeholder={'One name per line'}
                className="w-full rounded-2xl border border-border bg-input/30 px-3 py-2 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                disabled={isSubmitting}
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                }}
              />

              <p className="text-sm text-muted-foreground">
                {names.length === 0
                  ? 'Blank lines are ignored.'
                  : `${String(names.length)} ${names.length === 1 ? 'name' : 'names'} · blank lines ignored`}
              </p>
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
                type="button"
                className="h-11 sm:min-w-44"
                disabled={isSubmitting || names.length === 0}
                onClick={() => {
                  setPreview(names.map((name) => ({
                    cngMemberId: crypto.randomUUID(),
                    name,
                  })))
                }}
              >
                {names.length === 0
                  ? 'Preview'
                  : `Preview ${String(names.length)}`}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {preview.length === 1
                ? '1 CNG member will be added:'
                : `${String(preview.length)} CNG members will be added:`}
            </p>

            <ol className="max-h-[22rem] space-y-1 overflow-y-auto">
              {preview.map((draft, index) => (
                <li
                  key={draft.cngMemberId}
                  className="flex items-baseline gap-3 rounded-xl border border-border bg-card px-3 py-2"
                >
                  <span className="text-xs text-muted-foreground">
                    {String(index + 1)}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-base font-medium">
                    {draft.name}
                  </span>
                </li>
              ))}
            </ol>

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
                type="button"
                variant="outline"
                className="h-11"
                disabled={isSubmitting}
                onClick={() => {
                  setPreview(null)
                }}
              >
                Edit list
              </Button>

              <Button
                type="button"
                className="h-11 sm:min-w-52"
                disabled={isSubmitting || preview.length === 0}
                onClick={() => {
                  onAdd(preview)
                }}
              >
                {isSubmitting
                  ? 'Adding…'
                  : `Add ${String(preview.length)} to CNG`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default BulkAddCngNamesDialog
