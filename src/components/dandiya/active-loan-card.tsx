import { Check, TriangleAlert, X } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { formatEventDate, formatEventDateTime } from '@/lib/datetime'
import { formatPhoneNumber } from '@/lib/phone'
import {
  currentEventDayKey,
  eventDayKey,
  eventDayWindow,
} from '@/shared/event-time'
import {
  isOutstandingFromEarlierDay,
  isPartiallyResolved,
  unresolvedHolders,
} from '@/dandiya/dandiya-filters'
import type { DandiyaActiveLoan, DandiyaHolder } from '@/shared/dandiya-contract'
import { dandiyaHolderDetail, dandiyaHolderLabel } from '@/shared/dandiya-contract'

/** What the desk can ask for from this card. */
export interface DandiyaRequest {
  loan: DandiyaActiveLoan
  action: 'resolve-holder' | 'return-pair' | 'lost-pair'
  holder?: DandiyaHolder
  resolution?: 'returned' | 'lost'
}

interface ActiveLoanCardProps {
  loan: DandiyaActiveLoan
  isBusy: boolean
  onRequest: (request: DandiyaRequest) => void
}

/**
 * One loan with at least one stick still OUT.
 *
 * EACH STICK HAS ITS OWN ROW AND ITS OWN ACTIONS, which is the whole of Phase
 * D3.1 on screen: one attendee can finish while the other has not, and the
 * card has to show that rather than averaging it into "out". A stick already
 * resolved shows its ending and its time and offers nothing — a resolution is
 * final, and a button to change it would be a button to rewrite the ledger.
 *
 * THE PAIR IS NEVER SHOWN AS AVAILABLE while any stick is out. A partially
 * resolved loan reads INCOMPLETE rather than OUT, because somebody scanning
 * the board needs to know a stick is missing from this pair and not just that
 * the pair is somewhere.
 *
 * A LOAN FROM AN EARLIER EVENT DAY IS LABELLED OUTSTANDING, in amber, with
 * the day named. That is a LABEL and nothing more: the loan is untouched and
 * the sticks are still out. Midnight returns nothing — a stick is resolved
 * when a person resolves it — but a leftover must not look like part of
 * tonight's traffic, or nobody will chase it.
 *
 * Both whole-pair shortcuts are offered beneath the sticks, because that is
 * usually what a desk has in its hands. Report Pair Lost is secondary and
 * destructive-looking on purpose.
 */
const ActiveLoanCard: React.FC<ActiveLoanCardProps> = ({ loan, isBusy, onRequest }) => {
  const outstanding = isOutstandingFromEarlierDay(loan)
  /**
   * HOW MANY EVENT DAYS AGO, counted on the event's calendar rather than in
   * elapsed hours: "1 day" for last night is what a volunteer chasing a stick
   * means, and 23 hours is not.
   */
  const nights = ((): string | null => {
    const window = eventDayWindow(eventDayKey(loan.issuedAt))
    const todayWindow = eventDayWindow(currentEventDayKey())

    if (!outstanding || window === null || todayWindow === null) {
      return null
    }

    const days = Math.round(
      (todayWindow.start.getTime() - window.start.getTime()) / 86_400_000,
    )

    return days < 1 ? null : `${String(days)} ${days === 1 ? 'day' : 'days'}`
  })()
  const incomplete = isPartiallyResolved(loan)
  const remaining = unresolvedHolders(loan)

  return (
    <div
      className={
        outstanding
          ? 'flex flex-col justify-between gap-4 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4'
          : 'flex flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-4'
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-heading text-xl font-semibold uppercase tracking-[0.08em]">
            {`Pair ${loan.pairCode}`}
          </p>

          {/*
            A LEFTOVER SAYS WHICH NIGHT IT IS FROM, and for how long. Midnight
            changed nothing about this loan — it is still open, still this
            pair, still those two attendees — but "Outstanding" alone leaves
            somebody scrolling to the issue time to work out whether it is
            from an hour ago or from Tuesday. The age is derived from
            `issuedAt` at render; it is a reading aid, never the state.
          */}
          {outstanding ? (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3.5" />
              {`Outstanding since ${formatEventDate(eventDayKey(loan.issuedAt))}${
                nights === null ? '' : ` · ${nights}`
              }`}
            </span>
          ) : (
            <span
              className={
                incomplete
                  ? 'rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400'
                  : 'rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-primary'
              }
            >
              {incomplete ? 'Incomplete' : 'Out'}
            </span>
          )}
        </div>

        <ul className="space-y-3">
          {loan.holders.map((holder) => (
            <li
              key={holder.slot}
              className="space-y-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-heading text-base font-semibold">
                  {dandiyaHolderLabel(holder)}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {dandiyaHolderDetail(holder)}
                </span>

                {/*
                  WHO ANSWERS FOR THE WHOLE PAIR, on a MIXED loan only. One
                  badge and one guest goes out ON THE BADGE, so that
                  attendee's obligation outlives their own stick — the label
                  is there so a volunteer taking the first stick back does not
                  read the pair as settled.

                  Read from the server's own `accountabilityBadgeNumber`
                  rather than inferred here, and absent for the other two
                  modes, where it would be noise.
                */}
                {loan.accountabilityBadgeNumber === null ||
                holder.badgeNumber !== loan.accountabilityBadgeNumber ? null : (
                  <span className="shrink-0 text-xs uppercase tracking-[0.12em] text-muted-foreground">
                    Accountability badge
                  </span>
                )}
              </div>

              {holder.resolution === null ? (
                <>
                  <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                    {`Stick ${String(holder.slot)} · Out`}
                  </p>

                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => {
                        onRequest({
                          loan,
                          action: 'resolve-holder',
                          holder,
                          resolution: 'returned',
                        })
                      }}
                    >
                      Return Stick
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => {
                        onRequest({
                          loan,
                          action: 'resolve-holder',
                          holder,
                          resolution: 'lost',
                        })
                      }}
                    >
                      Mark Lost
                    </Button>
                  </div>
                </>
              ) : (
                /* RESOLVED, and final: its ending, its time, and no control. */
                <p
                  className={
                    holder.resolution === 'returned'
                      ? 'flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400'
                      : 'flex items-center gap-1.5 text-sm font-medium text-destructive'
                  }
                >
                  {holder.resolution === 'returned' ? (
                    <Check className="size-4" />
                  ) : (
                    <X className="size-4" />
                  )}

                  {`${holder.resolution === 'returned' ? 'Returned' : 'Lost'} · ${
                    holder.resolvedAt === null ? '' : formatEventDateTime(holder.resolvedAt)
                  }`}
                </p>
              )}
            </li>
          ))}
        </ul>

        {/*
          THE CONTACT NUMBER, when neither holder has a badge. It is how the
          team finds two people who were never through the registration desk,
          so it belongs on the card somebody is already looking at — not in a
          database a volunteer cannot open. Shown only when it exists, which
          is only for a fully badgeless pair.
        */}
        {typeof loan.contactPhone !== 'string' ? null : (
          <div className="rounded-xl border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              Contact
            </p>

            <a
              href={`tel:+91${loan.contactPhone}`}
              className="font-heading text-base font-semibold underline-offset-4 hover:underline"
            >
              {`+91 ${formatPhoneNumber(loan.contactPhone)}`}
            </a>
          </div>
        )}

        <div className="text-sm text-muted-foreground">
          <p className={outstanding ? 'font-medium text-amber-700 dark:text-amber-400' : ''}>
            {`Issued ${formatEventDateTime(loan.issuedAt)}`}
          </p>

          <p>
            {`by ${loan.issuedBy.name}`}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Button
          type="button"
          className="h-11 w-full"
          disabled={isBusy}
          onClick={() => {
            onRequest({ loan, action: 'return-pair' })
          }}
        >
          {remaining.length === loan.holders.length
            ? 'Return Whole Pair'
            : 'Return Remaining Stick'}
        </Button>

        {/* Secondary, and deliberately not styled like the happy path. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-destructive hover:text-destructive"
          disabled={isBusy}
          onClick={() => {
            onRequest({ loan, action: 'lost-pair' })
          }}
        >
          Report Pair Lost
        </Button>
      </div>
    </div>
  )
}

export default ActiveLoanCard
