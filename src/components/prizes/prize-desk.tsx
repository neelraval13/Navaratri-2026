import { CloudOff, RefreshCw } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import AttendeeFilters from '@/components/attendees/attendee-filters'
import AttendeeCard from '@/components/prizes/attendee-card'
import AwardHistory from '@/components/prizes/award-history'
import AwardPrizeDialog from '@/components/prizes/award-prize-dialog'
import EventNotice, { type EventNoticeState } from '@/components/event/event-notice'
import { Button, buttonVariants } from '@/components/ui/button'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { formatBadgeNumber } from '@/lib/badge'
import { cn } from '@/lib/utils'
import {
  EMPTY_ATTENDEE_FILTERS,
  filterAttendees,
  type AttendeeFilterState,
} from '@/attendees/attendee-filters'
import { awardPrize, fetchPrizeRoster, PRIZE_MESSAGES } from '@/prizes/prize-api'
import { previousAwardsFor } from '@/prizes/prize-filters'
import type { PrizeAttendee, PrizeAward } from '@/shared/prize-contract'

type RosterState =
  | { status: 'loading' }
  | { status: 'loaded'; attendees: PrizeAttendee[]; awards: PrizeAward[] }
  /** `signIn` offers Device Sign-In; nothing else here offers a credential. */
  | { status: 'error'; message: string; signIn: boolean }

type PrizeTab = 'attendees' | 'awards'

/**
 * THE PRIZE DESK.
 *
 * ONLINE ONLY, and the screen says so rather than pretending otherwise. There
 * is no offline queue, no optimistic local award, no local authoritative prize
 * state, no polling and no heartbeat. While the browser reports offline, NO
 * MUTATION IS EXPOSED AT ALL: there is no roster to award from and no button
 * to press, so nothing can appear to succeed locally.
 *
 * REPEAT PRIZES ARE LEGAL, since Phase P1.1, and the two tabs reflect that:
 *
 *   Attendees (45)   every registered attendee, winners included
 *   Awards (2)       every award RECORD, so one badge may appear twice
 *
 * The attendee count therefore does not move when a prize is given and the
 * award count does. An awarded badge is NEVER removed from Attendees and
 * stays findable by search and by the age and gender filters: a volunteer
 * looking up #9005 must find #9005 whatever #9005 has already won.
 *
 * THE WARNING COMES FROM THE LOADED HISTORY. After a successful award the
 * returned record is appended locally, so opening the same attendee again
 * immediately shows the prize just given — without a re-fetch, which would
 * discard the filters this volunteer is working through. An explicit Refresh
 * still re-reads everything from the server.
 *
 * Nothing here decides whether an award is ALLOWED. The server's only
 * attendee precondition is that the badge is in the Badge Register; this
 * screen informs and submits.
 */
const PrizeDesk: React.FC = () => {
  const network = useNetworkStatus()

  const [roster, setRoster] = useState<RosterState>({ status: 'loading' })
  const [tab, setTab] = useState<PrizeTab>('attendees')
  const [filters, setFilters] = useState<AttendeeFilterState>(EMPTY_ATTENDEE_FILTERS)
  const [historySearch, setHistorySearch] = useState('')
  const [selected, setSelected] = useState<PrizeAttendee | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const [notice, setNotice] = useState<EventNoticeState | null>(null)

  /**
   * LATEST READ WINS, by sequence rather than by timing.
   *
   * A Refresh can start while the mount read is still in flight. If an older
   * response answered last it would replace the history a warning is drawn
   * from with a staler one, so every read is stamped and a stale one dropped.
   */
  const sequence = useRef(0)

  /**
   * ONE read per trigger, and the triggers are EVENTS: mounting, connectivity
   * returning, and an explicit Refresh — which is a counter rather than a
   * direct call, so there is exactly one place a request originates.
   *
   * There is deliberately no interval and no heartbeat. A prize roster that
   * re-fetched itself on a timer would be a second kind of pressure on the
   * Sheets quota for no operational gain: the list only changes when somebody
   * at a desk does something, and that somebody can press Refresh.
   */
  useEffect(() => {
    if (network === 'offline') {
      return
    }

    const ticket = sequence.current + 1

    sequence.current = ticket

    void (async () => {
      const result = await fetchPrizeRoster()

      if (sequence.current !== ticket) {
        return
      }

      setIsRefreshing(false)

      if (result.status === 'loaded') {
        setRoster({
          status: 'loaded',
          attendees: result.attendees,
          awards: result.awards,
        })

        return
      }

      setRoster({
        status: 'error',
        message: result.message,
        /**
         * Only an expired session is answered by signing in. A roster that
         * could not be read, or a device that was never granted `prizes`, is
         * not a credential problem and must not be presented as one.
         */
        signIn: result.status === 'unauthenticated',
      })
    })()
  }, [network, readAttempt])

  const refresh = useCallback((): void => {
    setIsRefreshing(true)
    setReadAttempt((previous) => previous + 1)
  }, [])

  if (network === 'offline') {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-6">
        <p className="flex items-center gap-2 font-heading text-lg font-semibold text-amber-700 dark:text-amber-400">
          <CloudOff className="size-5" />
          {PRIZE_MESSAGES.offline}
        </p>

        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Prizes are recorded centrally, so the ledger is the only record of
          what has been given. Reconnect to continue; nothing is queued, and no
          prize can be given while this device is offline.
        </p>
      </div>
    )
  }

  if (roster.status === 'loading') {
    return (
      <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        Loading attendees…
      </p>
    )
  }

  if (roster.status === 'error') {
    return (
      <div className="space-y-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-6">
        <p className="text-sm font-medium text-destructive">
          {roster.message}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isRefreshing}
            onClick={refresh}
          >
            <RefreshCw
              data-icon="inline-start"
              className={cn(isRefreshing && 'animate-spin')}
            />
            {isRefreshing ? 'Retrying…' : 'Try again'}
          </Button>

          {roster.signIn ? (
            /* A real link styled as a button — see device-login-page. */
            <Link
              href={ROUTES.deviceLogin}
              className={buttonVariants({ variant: 'outline' })}
            >
              Open Device Sign-In
            </Link>
          ) : null}
        </div>
      </div>
    )
  }

  const visible = filterAttendees(roster.attendees, filters)

  const award = async (prizeName: string): Promise<void> => {
    if (selected === null || isSubmitting) {
      return
    }

    const attendee = selected

    setIsSubmitting(true)

    try {
      const result = await awardPrize({
        badgeNumber: attendee.badgeNumber,
        prizeName,
      })

      setSelected(null)

      if (result.status === 'awarded') {
        /**
         * Applied locally rather than re-fetched: the response already
         * carries the authoritative record, and a reload here would discard
         * the filters this volunteer is working through.
         *
         * THE ATTENDEE LIST IS UNTOUCHED. Only the award list grows, which is
         * exactly the product rule — the attendee may win again.
         *
         * The sequence is bumped first so a read that was ALREADY in flight
         * cannot answer afterwards and drop the record just added.
         */
        sequence.current += 1

        setRoster({
          status: 'loaded',
          attendees: roster.attendees,
          awards: [result.award, ...roster.awards],
        })

        setNotice({
          kind: 'success',
          message: `${result.award.prizeName} awarded to ${formatBadgeNumber(attendee.badgeNumber)}.`,
        })

        return
      }

      setNotice({ kind: 'error', message: result.message })

      /**
       * THE ANSWER NEVER ARRIVED, and an unanswered request may have
       * committed. Re-read rather than guess, so the history a later warning
       * is drawn from matches the ledger.
       */
      if (result.status === 'unreachable') {
        refresh()
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const tabClass = (value: PrizeTab): string =>
    cn(
      'h-11 flex-1 rounded-4xl px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-none',
      tab === value
        ? 'bg-primary text-primary-foreground'
        : 'border border-border bg-input/30 text-muted-foreground hover:text-foreground',
    )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Prizes"
          className="flex w-full gap-2 sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'attendees'}
            className={tabClass('attendees')}
            onClick={() => {
              setTab('attendees')
            }}
          >
            {`Attendees (${String(roster.attendees.length)})`}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'awards'}
            className={tabClass('awards')}
            onClick={() => {
              setTab('awards')
            }}
          >
            {`Awards (${String(roster.awards.length)})`}
          </button>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isRefreshing}
          onClick={refresh}
        >
          <RefreshCw
            data-icon="inline-start"
            className={cn(isRefreshing && 'animate-spin')}
          />
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {notice === null ? null : <EventNotice notice={notice} />}

      {tab === 'attendees' ? (
        <div
          role="tabpanel"
          className="space-y-4"
        >
          <AttendeeFilters
            state={filters}
            resultCount={visible.length}
            totalCount={roster.attendees.length}
            onChange={setFilters}
            onClear={() => {
              setFilters(EMPTY_ATTENDEE_FILTERS)
            }}
          />

          {visible.length === 0 ? (
            <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              {roster.attendees.length === 0
                ? 'No attendees have been registered yet.'
                : 'No attendees match these filters.'}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((attendee) => (
                <AttendeeCard
                  key={attendee.badgeNumber}
                  attendee={attendee}
                  previousAwardCount={
                    previousAwardsFor(roster.awards, attendee.badgeNumber).length
                  }
                  isBusy={isSubmitting}
                  onGivePrize={(next) => {
                    setNotice(null)
                    setSelected(next)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div role="tabpanel">
          <AwardHistory
            awards={roster.awards}
            search={historySearch}
            onSearchChange={setHistorySearch}
          />
        </div>
      )}

      {/*
        KEYED BY BADGE, so nothing is selected when the dialog opens for each
        attendee. Carrying the previous choice over would be convenient for a
        run of one prize and dangerous everywhere else: the row is permanent
        and there is no undo, so the prize is tapped deliberately each time.

        The warning reads from the CURRENTLY LOADED history, so a prize given
        a moment ago is already listed the next time this opens.
      */}
      <AwardPrizeDialog
        key={selected === null ? 'none' : String(selected.badgeNumber)}
        attendee={selected}
        previousAwards={
          selected === null ? [] : previousAwardsFor(roster.awards, selected.badgeNumber)
        }
        isSubmitting={isSubmitting}
        onCancel={() => {
          setSelected(null)
        }}
        onAward={(prizeName) => {
          void award(prizeName)
        }}
      />
    </div>
  )
}

export default PrizeDesk
