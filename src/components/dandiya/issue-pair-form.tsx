import type * as React from 'react'
import { useRef, useState } from 'react'

import HolderSlot, { type HolderMode } from '@/components/dandiya/holder-slot'
import {
  holderObligationFor,
  pairAvailability,
  priorLossesFor,
  type HolderObligation,
} from '@/dandiya/dandiya-filters'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatEventDateTime } from '@/lib/datetime'
import type { EventAttendee } from '@/shared/attendee-contract'
import { dandiyaHolderLabel } from '@/shared/dandiya-contract'
import { localPhoneDigits, parsePhoneNumber } from '@/shared/phone'
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
  onIssue: (input: {
    pairCode: string
    /** Slot 1 and slot 2. `null` is a guest with no badge. */
    badgeNumbers: [number | null, number | null]
    /** Ten digits, and only when both slots are guests. */
    contactPhone: string | null
  }) => void
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
  /**
   * WHICH KIND OF HOLDER EACH SLOT IS. Registered by default, because most
   * dancers have been through the desk — and because asking the question the
   * other way round would put "No badge" in front of an operator who has a
   * badge in their hand.
   */
  const [firstMode, setFirstMode] = useState<HolderMode>('attendee')
  const [secondMode, setSecondMode] = useState<HolderMode>('attendee')
  const [contact, setContact] = useState('')

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

  /**
   * WHAT THIS BADGE ALREADY OWES, through the one shared definition.
   *
   * It used to be "is this badge on any open loan", which was wrong in both
   * directions. It said "already holding" of a mixed loan's anchor whose own
   * stick had come back — they hold nothing, they are accountable — and it
   * BLOCKED a two-badge holder whose own stick had come back while their
   * partner's was still out, whom the server accepts.
   */
  const obligationOf = (attendee: EventAttendee | null): HolderObligation | null =>
    attendee === null ? null : holderObligationFor(active, attendee.badgeNumber)

  const firstObligation = obligationOf(first)
  const secondObligation = obligationOf(second)

  /** The badge each slot presents, or `null` for a guest. */
  const firstBadge = firstMode === 'guest' ? null : first?.badgeNumber ?? null
  const secondBadge = secondMode === 'guest' ? null : second?.badgeNumber ?? null

  /**
   * A CONTACT NUMBER IS ASKED FOR BY EXACTLY ONE CASE: neither person has a
   * badge, so neither is the accountability and the pair needs one.
   *
   * One badge is enough. Switching either slot back to a registered attendee
   * removes the requirement, and the number is not sent — collecting a phone
   * nobody needed would be persisting personal data for nothing.
   */
  const bothGuests = firstMode === 'guest' && secondMode === 'guest'
  const parsedContact = parsePhoneNumber(contact)

  /** Each slot is settled when it is a guest, or when somebody is chosen. */
  const slotReady = (mode: HolderMode, attendee: EventAttendee | null): boolean =>
    mode === 'guest' || attendee !== null

  const ready =
    code.ok &&
    availability.status === 'available' &&
    slotReady(firstMode, first) &&
    slotReady(secondMode, second) &&
    // Two guests are two different sticks; two badges must be two people.
    (firstBadge === null || secondBadge === null || firstBadge !== secondBadge) &&
    (firstMode === 'guest' || firstObligation === null) &&
    (secondMode === 'guest' || secondObligation === null) &&
    (!bothGuests || parsedContact.ok)

  return (
    <form
      className="space-y-5 rounded-2xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()

        if (!ready || isSubmitting || !code.ok) {
          return
        }

        onIssue({
          pairCode: code.value,
          badgeNumbers: [firstBadge, secondBadge],
          /**
           * CANONICAL, and only for a fully badgeless pair. The server
           * refuses a number beside a badge, and parses this one again — this
           * is the form agreeing with it in advance, not deciding.
           */
          contactPhone: bothGuests && parsedContact.ok ? parsedContact.value : null,
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
                .map((holder) => dandiyaHolderLabel(holder))
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

      <HolderSlot
        label="Person 1"
        inputId="dandiya-attendee-one"
        mode={firstMode}
        attendees={attendees}
        selected={first}
        excludedBadgeNumber={secondBadge}
        obligation={firstObligation}
        priorLosses={first === null ? [] : priorLossesFor([...active, ...issues], first.badgeNumber)}
        disabled={isSubmitting}
        onModeChange={(mode) => {
          setFirstMode(mode)

          if (mode === 'guest') {
            setFirst(null)
          }
        }}
        onSelect={setFirst}
      />

      <HolderSlot
        label="Person 2"
        inputId="dandiya-attendee-two"
        mode={secondMode}
        attendees={attendees}
        selected={second}
        excludedBadgeNumber={firstBadge}
        obligation={secondObligation}
        priorLosses={second === null ? [] : priorLossesFor([...active, ...issues], second.badgeNumber)}
        disabled={isSubmitting}
        onModeChange={(mode) => {
          setSecondMode(mode)

          if (mode === 'guest') {
            setSecond(null)
          }
        }}
        onSelect={setSecond}
      />

      {/*
        ONLY WHEN NEITHER PERSON HAS A BADGE. This is the pair's whole
        accountability in that case, so it is required — and it disappears the
        moment either slot becomes a registered attendee, because then a badge
        is the accountability and this number would be data nobody needed.
      */}
      {bothGuests ? (
        <div className="space-y-1.5">
          <Label htmlFor="dandiya-contact-phone">
            Contact phone
          </Label>

          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="font-heading text-base text-muted-foreground"
            >
              +91
            </span>

            <Input
              id="dandiya-contact-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="off"
              placeholder="98765 43210"
              className="h-11 font-heading text-lg"
              disabled={isSubmitting}
              aria-invalid={contact.trim() !== '' && !parsedContact.ok}
              value={contact}
              onChange={(event) => {
                /*
                  THE FIELD ALREADY SHOWS `+91`, so what sits beside it is the
                  LOCAL ten digits. A pasted `+91 98765 43210` would otherwise
                  read `+91  +91 98765 43210` — a number nobody could read
                  back to the two people it belongs to.

                  Presentation only. The parser is unchanged and the server
                  still accepts every operator-friendly form.
                */
                setContact(localPhoneDigits(event.target.value))
              }}
            />
          </div>

          <p className="text-sm text-muted-foreground">
            Neither person has a badge, so one number is needed to reach them.
          </p>

          {contact.trim() !== '' && !parsedContact.ok ? (
            <p className="text-sm text-destructive">
              {parsedContact.message}
            </p>
          ) : null}
        </div>
      ) : null}

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
