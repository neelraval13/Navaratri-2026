import type * as React from 'react'
import { useRef, useState } from 'react'

import AttendeePicker, { type HoldingNote } from '@/components/dandiya/attendee-picker'
import { pairAvailability, priorLossesFor } from '@/dandiya/dandiya-filters'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'
import type { EventAttendee } from '@/shared/attendee-contract'
import type { DandiyaActiveLoan, DandiyaLoanRecord } from '@/shared/dandiya-contract'
import { PAIR_CODE_MAX_LENGTH, parsePairCode } from '@/shared/dandiya-contract'

interface IssuePairFormProps {
  attendees: readonly EventAttendee[]
  active: readonly DandiyaActiveLoan[]
  /**
   * Quarantined pairs: closed with a loss and never released.
   *
   * Also the complete record of EVERY loss this event has seen, which is why
   * the prior-loss warning reads `active` and `issues` and not the day's
   * history. A lost stick forbids `pairReleasedAt` — the database enforces
   * it — so a loan containing one is either still open or sitting here,
   * whatever night it happened on. History is one day; this is not.
   */
  issues: readonly DandiyaLoanRecord[]
  isSubmitting: boolean
  onIssue: (input: { pairCode: string; badgeNumbers: [number, number] }) => void
}

/**
 * ISSUING A PAIR, optimised for the same three keystrokes a hundred times.
 *
 * Pair number, attendee one, attendee two, Issue — in that order, because
 * that is the order the desk has them: the sticks are in the volunteer's hand
 * before the two people are identified.
 *
 * AFTER A SUCCESSFUL ISSUE everything clears and focus returns to the pair
 * field, so the next pair is one keystroke away. That reset is driven by the
 * desk remounting this form, which is also what guarantees no attendee can be
 * carried into the next loan by accident.
 *
 * IT WARNS FROM THE LOADED BOARD, AND REFUSES LOCALLY. A pair that is out, a
 * pair QUARANTINED after a loss, or an attendee already holding a stick each
 * block Issue and say why. A PRIOR LOSS does not: that attendee is free, and
 * the note beside them is information for the person deciding. That is INFORMATION for a better message — the authority is
 * the database's two partial unique indexes, and the endpoint consults no
 * precheck at all. When another desk wins the race anyway, the screen is
 * told, says so, and re-reads.
 *
 * THE PAIR CODE IS CANONICALISED — trimmed, then uppercased — because it
 * identifies one physical object and the index that stops it going out twice
 * compares bytes. `d-014` and `D-014` are the same sticks, so they must
 * collide. The field uppercases on blur as a courtesy; the server's answer is
 * the authority, and it is what the success message and the board show.
 */
const IssuePairForm: React.FC<IssuePairFormProps> = ({
  attendees,
  active,
  issues,
  isSubmitting,
  onIssue,
}) => {
  const [pairCode, setPairCode] = useState('')
  const [first, setFirst] = useState<EventAttendee | null>(null)
  const [second, setSecond] = useState<EventAttendee | null>(null)

  const pairInput = useRef<HTMLInputElement>(null)

  const code = parsePairCode(pairCode)

  /**
   * IS THIS PAIR AVAILABLE? Two ways it may not be, and they read
   * differently: it is OUT on an open loan, or it is QUARANTINED because its
   * last loan lost a stick. The operator's next action differs — wait, or
   * take the pair out of the stock — so the warning says which.
   *
   * Derived from the loaded board, so it is a warning. The database remains
   * the authority and refuses either case on its own.
   */
  const availability = code.ok
    ? pairAvailability(code.value, { active, issues })
    : ({ status: 'available' } as const)

  const holdingOf = (attendee: EventAttendee | null): HoldingNote | null => {
    if (attendee === null) {
      return null
    }

    const loan = active.find((entry) =>
      entry.holders.some((holder) => holder.badgeNumber === attendee.badgeNumber))

    return loan === undefined
      ? null
      : { pairCode: loan.pairCode, issuedAt: loan.issuedAt }
  }

  const firstHolding = holdingOf(first)
  const secondHolding = holdingOf(second)

  const ready =
    code.ok &&
    availability.status === 'available' &&
    first !== null &&
    second !== null &&
    first.badgeNumber !== second.badgeNumber &&
    firstHolding === null &&
    secondHolding === null

  return (
    <form
      className="space-y-5 rounded-2xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()

        if (!ready || isSubmitting || first === null || second === null || !code.ok) {
          return
        }

        onIssue({
          pairCode: code.value,
          badgeNumbers: [first.badgeNumber, second.badgeNumber],
        })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="dandiya-pair-code">
          Pair Number / Code
        </Label>

        <Input
          id="dandiya-pair-code"
          ref={pairInput}
          type="text"
          autoComplete="off"
          autoFocus
          maxLength={PAIR_CODE_MAX_LENGTH}
          placeholder="D-014"
          className="h-11 font-heading text-lg"
          disabled={isSubmitting}
          aria-invalid={availability.status !== 'available'}
          value={pairCode}
          onChange={(event) => {
            setPairCode(event.target.value)
          }}
          onBlur={() => {
            /**
             * COMFORT ONLY, and on blur rather than per keystroke so nobody
             * is typing against a field that rewrites itself. The SERVER
             * canonicalises on the request and its answer is what is stored
             * and shown — this just lets a volunteer see what the ledger will
             * record before they submit.
             */
            if (code.ok && pairCode !== code.value) {
              setPairCode(code.value)
            }
          }}
        />

        {/* OUT: say which attendees have it, and since when. */}
        {availability.status === 'out' ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
            <p className="text-sm font-medium text-destructive">
              This pair is already out.
            </p>

            <p className="text-sm text-muted-foreground">
              {availability.loan.holders
                .map((holder) => formatBadgeNumber(holder.badgeNumber))
                .join(' + ')}
            </p>

            <p className="text-sm text-muted-foreground">
              {`Issued ${formatEventDateTime(availability.loan.issuedAt)}`}
            </p>
          </div>
        ) : null}

        {/*
          QUARANTINED: the pair came back incomplete, so it is not a pair. The
          database refuses it too — this just explains why before the attempt.
        */}
        {availability.status === 'quarantined' ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
            <p className="text-sm font-medium text-destructive">
              {`${availability.loan.pairCode} is unavailable.`}
            </p>

            <p className="text-sm text-muted-foreground">
              {availability.loan.outcome === 'lost'
                ? 'Its previous loan ended with both sticks lost.'
                : 'Its previous loan ended with a partial loss.'}
            </p>
          </div>
        ) : null}

        {pairCode.trim() !== '' && !code.ok ? (
          <p className="text-sm text-destructive">
            {code.message}
          </p>
        ) : null}
      </div>

      <AttendeePicker
        label="Attendee 1"
        inputId="dandiya-attendee-one"
        attendees={attendees}
        selected={first}
        excludedBadgeNumber={second?.badgeNumber ?? null}
        holding={firstHolding}
        priorLosses={first === null ? [] : priorLossesFor([...active, ...issues], first.badgeNumber)}
        disabled={isSubmitting}
        onSelect={setFirst}
      />

      <AttendeePicker
        label="Attendee 2"
        inputId="dandiya-attendee-two"
        attendees={attendees}
        selected={second}
        excludedBadgeNumber={first?.badgeNumber ?? null}
        holding={secondHolding}
        priorLosses={second === null ? [] : priorLossesFor([...active, ...issues], second.badgeNumber)}
        disabled={isSubmitting}
        onSelect={setSecond}
      />

      <Button
        type="submit"
        className="h-12 w-full sm:w-auto sm:min-w-48"
        disabled={isSubmitting || !ready}
      >
        {isSubmitting ? 'Issuing…' : 'Issue Pair'}
      </Button>
    </form>
  )
}

export default IssuePairForm
