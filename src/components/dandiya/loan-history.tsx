import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  filterDayHistory,
  loanStateOf,
  summariseDay,
  type HistoryView,
} from '@/dandiya/dandiya-filters'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDate, formatEventDateTime } from '@/lib/datetime'
import type { DandiyaLoanRecord } from '@/shared/dandiya-contract'
import { DANDIYA_OUTCOME_LABELS } from '@/shared/dandiya-contract'
import {
  isEventDayKey,
  nextEventDayKey,
  previousEventDayKey,
} from '@/shared/event-time'

interface LoanHistoryProps {
  /** The selected day's loans, newest issued first. */
  loans: readonly DandiyaLoanRecord[]
  /** The event-local day these loans belong to, as the SERVER reported it. */
  day: string
  /** The event's own today, which is as far forward as history can go. */
  eventDay: string
  view: HistoryView
  search: string
  /** A day change is a new request; the list says so rather than blanking. */
  isLoading: boolean
  onDayChange: (day: string) => void
  onViewChange: (view: HistoryView) => void
  onSearchChange: (search: string) => void
}

const VIEWS: { value: HistoryView; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'returned', label: 'Returned' },
  { value: 'losses', label: 'Losses' },
]

/**
 * ONE EVENT DAY'S LOANS, and what became of each.
 *
 * A DAY IS DECIDED BY WHEN THE PAIR WENT OUT. A pair handed over at 11:50 PM
 * and brought back at 12:20 AM belongs to the night it went out on, and says
 * it closed on the next day. That is the question volunteers actually ask at
 * the end of an evening — "what did we hand out, and what is still missing?"
 * — and grouping by the close would make it unanswerable, because a loan
 * would move between days as it was resolved.
 *
 * OPEN LOANS ARE HERE TOO. A day's record has to show what never came back;
 * that is the whole reason somebody opens this screen at midnight. Those
 * pairs are also in Active, where they stay until a person resolves them.
 * Nothing is moved out of either list, and midnight moves neither.
 *
 * READ-ONLY. There is no undo, no edit and no delete, and none is offered: a
 * stick that was resolved was resolved, and a ledger a volunteer can rewrite
 * is not a ledger. Correcting a mistaken resolution is a deliberate database
 * operation by a human.
 *
 * REPEATED PAIR CODES ARE EXPECTED. One pair goes out and comes back many
 * times an evening, so each loan is its own row keyed by its own id; nothing
 * is grouped or collapsed by pair.
 */
const LoanHistory: React.FC<LoanHistoryProps> = ({
  loans,
  day,
  eventDay,
  view,
  search,
  isLoading,
  onDayChange,
  onViewChange,
  onSearchChange,
}) => {
  const visible = filterDayHistory(loans, { view, search })
  const summary = summariseDay(loans)
  const previousDay = previousEventDayKey(day)
  const nextDay = nextEventDayKey(day)
  const isToday = day === eventDay
  /** Never past the event's own today: there is nothing there to read. */
  const canGoForward = nextDay !== null && nextDay <= eventDay

  const step = (target: string | null): void => {
    if (target !== null && isEventDayKey(target)) {
      onDayChange(target)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
        {/* DAY NAVIGATION. The day is a stable event-local key, never a
            browser-formatted date: the server grouped the rows by it. */}
        <div className="space-y-1.5">
          <Label htmlFor="dandiya-history-day">
            Event day
          </Label>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 px-3"
              aria-label="Previous day"
              disabled={previousDay === null}
              onClick={() => {
                step(previousDay)
              }}
            >
              <ChevronLeft className="size-4" />
            </Button>

            <Input
              id="dandiya-history-day"
              type="date"
              className="h-11 w-auto flex-1"
              value={day}
              max={eventDay}
              onChange={(event) => {
                step(event.target.value)
              }}
            />

            <Button
              type="button"
              variant="outline"
              className="h-11 px-3"
              aria-label="Next day"
              disabled={!canGoForward}
              onClick={() => {
                step(nextDay)
              }}
            >
              <ChevronRight className="size-4" />
            </Button>

            <Button
              type="button"
              variant={isToday ? 'default' : 'outline'}
              className="h-11"
              aria-pressed={isToday}
              onClick={() => {
                onDayChange(eventDay)
              }}
            >
              Today
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {isToday ? `Today · ${formatEventDate(day)}` : formatEventDate(day)}
          </p>
        </div>

        {/*
          THE DAY'S SUMMARY, counted from the rows above rather than sent
          beside them: one list, one set of numbers, nothing that can
          disagree. Outstanding is named first and loudest — it is the only
          one somebody has to act on.
        */}
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { label: 'Issued', value: summary.issued, urgent: false },
            { label: 'Outstanding', value: summary.outstanding, urgent: summary.outstanding > 0 },
            { label: 'Returned', value: summary.fullyReturned, urgent: false },
            { label: 'Partial loss', value: summary.partialLosses, urgent: summary.partialLosses > 0 },
            { label: 'Pair lost', value: summary.lostPairs, urgent: summary.lostPairs > 0 },
          ].map((stat) => (
            <div
              key={stat.label}
              className={
                stat.urgent
                  ? 'rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2'
                  : 'rounded-xl border border-border px-3 py-2'
              }
            >
              <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                {stat.label}
              </dt>

              <dd
                className={
                  stat.urgent
                    ? 'font-heading text-xl font-semibold text-destructive'
                    : 'font-heading text-xl font-semibold'
                }
              >
                {String(stat.value)}
              </dd>
            </div>
          ))}
        </dl>

        {summary.outstandingSticks === 0 ? null : (
          <p className="text-sm font-medium text-destructive">
            {`${String(summary.outstandingSticks)} ${
              summary.outstandingSticks === 1 ? 'stick' : 'sticks'
            } from this day ${
              summary.outstandingSticks === 1 ? 'is' : 'are'
            } still unaccounted for.`}
          </p>
        )}

        <div
          role="group"
          aria-label="History filter"
          className="flex flex-wrap gap-2"
        >
          {VIEWS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={view === option.value ? 'default' : 'outline'}
              className="h-11 flex-1 sm:flex-none"
              aria-pressed={view === option.value}
              onClick={() => {
                onViewChange(option.value)
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dandiya-history-search">
            Search this day
          </Label>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

            <Input
              id="dandiya-history-search"
              type="text"
              inputMode="search"
              autoComplete="off"
              placeholder="Pair, badge or name"
              className="h-11 pl-9"
              value={search}
              onChange={(event) => {
                onSearchChange(event.target.value)
              }}
            />
          </div>
        </div>

        {/* A count of LOANS, not of pairs: one pair appears many times. */}
        <p className="text-sm text-muted-foreground">
          {visible.length === loans.length
            ? `${String(loans.length)} loans`
            : `${String(visible.length)} of ${String(loans.length)} loans`}
        </p>
      </div>

      {isLoading ? (
        <p
          role="status"
          className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground"
        >
          Loading this day…
        </p>
      ) : visible.length === 0 ? (
        /*
          AN EMPTY DAY IS NOT AN ERROR. A quiet afternoon and a broken request
          must never read the same way, so this says what it means and the
          error state stays the error state.
        */
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {loans.length === 0
            ? 'No pairs were issued on this day.'
            : view === 'outstanding' && search.trim() === ''
              ? 'No outstanding pairs from this day.'
              : 'No loans match this search.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((loan) => {
            const state = loanStateOf(loan)

            return (
              <li
                key={loan.id}
                className={
                  state === 'outstanding'
                    ? 'space-y-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-4'
                    : 'space-y-3 rounded-2xl border border-border bg-card p-4'
                }
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="font-heading text-xl font-semibold uppercase tracking-[0.08em]">
                    {loan.pairCode}
                  </p>

                  {/* The state, in its own colour: an incident is not a
                      return, and a pair still out is neither. */}
                  <span
                    className={
                      state === 'returned'
                        ? 'rounded-full bg-green-600/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-green-700 dark:text-green-400'
                        : 'rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-destructive'
                    }
                  >
                    {loan.outcome === null
                      ? 'Outstanding'
                      : DANDIYA_OUTCOME_LABELS[loan.outcome]}
                  </span>
                </div>

                {/* EACH STICK'S OWN ENDING, which is what makes a partial loss
                    readable: one person brought theirs back and one did not. */}
                <ul className="space-y-1">
                  {loan.holders.map((holder) => (
                    <li key={holder.slot} className="flex items-baseline gap-3">
                      <span className="font-heading text-base font-semibold">
                        {formatBadgeNumber(holder.badgeNumber)}
                      </span>

                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {holder.attendee === null
                          ? 'Attendee no longer in the register'
                          : holder.attendee.name}
                      </span>

                      <span
                        className={
                          holder.resolution === 'returned'
                            ? 'text-sm text-muted-foreground'
                            : 'text-sm font-medium text-destructive'
                        }
                      >
                        {holder.resolution === null
                          ? 'Still out'
                          : `${holder.resolution === 'lost' ? 'Lost' : 'Returned'} ${
                              holder.resolvedAt === null
                                ? ''
                                : formatEventDateTime(holder.resolvedAt)
                            }`}
                      </span>
                    </li>
                  ))}
                </ul>

                <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                  <dt className="text-muted-foreground">
                    Issued
                  </dt>

                  <dd>
                    {formatEventDateTime(loan.issuedAt)}
                  </dd>

                  {loan.closedAt === null ? null : (
                    <>
                      <dt className="text-muted-foreground">
                        Closed
                      </dt>

                      {/*
                        The close may be on a LATER day than this one, and
                        saying so is the point: the loan still belongs to the
                        day it went out on.
                      */}
                      <dd>
                        {formatEventDateTime(loan.closedAt)}
                      </dd>
                    </>
                  )}
                </dl>

                <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  <p>
                    {`Issued by ${loan.issuedBy.name}`}
                  </p>

                  {loan.closedBy === null ? null : (
                    <p>
                      {`Closed by ${loan.closedBy.name}`}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default LoanHistory
