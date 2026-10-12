import { CloudOff, RefreshCw, Search } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import ActiveLoanCard, { type DandiyaRequest } from '@/components/dandiya/active-loan-card'
import CarryoverBanner from '@/components/dandiya/carryover-banner'
import IssuePairForm from '@/components/dandiya/issue-pair-form'
import LoanHistory from '@/components/dandiya/loan-history'
import PairIssues from '@/components/dandiya/pair-issues'
import ResolvePairDialog from '@/components/dandiya/resolve-pair-dialog'
import EventNotice, { type EventNoticeState } from '@/components/event/event-notice'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DANDIYA_MESSAGES,
  fetchDandiyaBoard,
  issueDandiyaPair,
  resolveDandiyaPair,
} from '@/dandiya/dandiya-api'
import {
  outstandingBeforeDay,
  selectActiveLoans,
  type ActiveView,
  type HistoryView,
} from '@/dandiya/dandiya-filters'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { formatBadgeNumber } from '@/lib/badge'
import { cn } from '@/lib/utils'
import type { DandiyaBoardResponse } from '@/shared/dandiya-contract'

type BoardState =
  | { status: 'loading' }
  | { status: 'loaded'; board: DandiyaBoardResponse }
  /** `signIn` offers Device Sign-In; nothing else here offers a credential. */
  | { status: 'error'; message: string; signIn: boolean }

type DandiyaTab = 'issue' | 'active' | 'issues' | 'history'

/**
 * THE DANDIYA DESK.
 *
 * ONLINE ONLY, and the screen says so rather than pretending otherwise. There
 * is no offline queue, no optimistic issue, no optimistic return, no local
 * authoritative state, no polling and no heartbeat — two disconnected desks
 * must never be able to issue the same physical pair or the same attendee,
 * and any of those would make that possible.
 *
 * While the browser reports offline, NO MUTATION IS EXPOSED AT ALL: there is
 * no board, no form and no Return button, so nothing can appear to succeed
 * locally and no stale list is presented as current.
 *
 * EACH STICK MOVES INDEPENDENTLY, since Phase D3.1. One can come back while
 * the other stays out, or be reported LOST — which frees that attendee and
 * quarantines the physical pair. Whether a resolution CLOSES the loan, and as
 * what, is decided by the database from the two sticks, so this screen always
 * RE-READS after one rather than predicting the answer.
 *
 * THE DATABASE IS THE AUTHORITY, every time. The form warns from the loaded
 * board — that pair is out, that pair is quarantined, that attendee is
 * holding a stick — but those are messages. When another desk wins the race,
 * this screen is TOLD, says so plainly, and re-reads.
 *
 * A PRIOR LOSS NEVER BLOCKS AN ISSUE. It is shown beside the attendee as
 * information; the person at the desk decides.
 *
 * MIDNIGHT CHANGES THE COUNTERS AND THE HISTORY FILTER, AND NOTHING ELSE. A
 * pair issued yesterday with a stick still out stays in Active, labelled
 * outstanding. Nothing here resolves a stick on a date.
 *
 * THE ISSUE FORM REMOUNTS AFTER A SUCCESSFUL ISSUE, keyed on a counter, which
 * is what clears all three inputs and returns focus to the pair field. A
 * volunteer issues the next pair without clearing anything by hand, and no
 * attendee can be carried into the next loan by accident.
 */
const DandiyaDesk: React.FC = () => {
  const network = useNetworkStatus()

  const [state, setState] = useState<BoardState>({ status: 'loading' })
  const [tab, setTab] = useState<DandiyaTab>('issue')
  const [activeSearch, setActiveSearch] = useState('')
  /**
   * `all` or `carryover`. A VIEW over the open loans already loaded, never a
   * second request — and the banner sets it, so the number somebody taps and
   * the rows they land on are the same set.
   */
  const [activeView, setActiveView] = useState<ActiveView>('all')
  /**
   * WHICH DAY HISTORY IS SHOWING.
   *
   * `null` means "today", and the SERVER decides which day that is — a tablet
   * with a wrong clock or an unexpected locale must not be able to label one
   * night's pairs with another night's date. Once a day has been chosen it is
   * sent explicitly, and changing it is a NEW REQUEST: a day is server-scoped
   * data, not a client-side filter over everything that ever happened.
   */
  const [historyDay, setHistoryDay] = useState<string | null>(null)
  const [historyView, setHistoryView] = useState<HistoryView>('all')
  const [historySearch, setHistorySearch] = useState('')
  const [issuesSearch, setIssuesSearch] = useState('')
  const [pending, setPending] = useState<DandiyaRequest | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const [issueAttempt, setIssueAttempt] = useState(0)
  const [notice, setNotice] = useState<EventNoticeState | null>(null)

  /**
   * LATEST READ WINS, by sequence rather than by timing. A Refresh can start
   * while the mount read is still in flight, and an older response answering
   * last would put a returned pair back into Active.
   */
  const sequence = useRef(0)

  /**
   * ONE read per trigger, and the triggers are EVENTS: mounting, connectivity
   * returning, and an explicit Refresh — which is a counter rather than a
   * direct call, so there is exactly one place a request originates.
   *
   * There is deliberately no interval. A board that re-fetched itself on a
   * timer would be a second kind of pressure on the Sheets quota for no
   * operational gain: it changes when somebody at a desk does something.
   */
  useEffect(() => {
    if (network === 'offline') {
      return
    }

    const ticket = sequence.current + 1

    sequence.current = ticket

    void (async () => {
      const result = await fetchDandiyaBoard(historyDay ?? undefined)

      if (sequence.current !== ticket) {
        return
      }

      setIsRefreshing(false)

      if (result.status === 'loaded') {
        setState({ status: 'loaded', board: result.board })

        return
      }

      /**
       * A REFUSED DAY IS THE SCREEN'S OWN INPUT, so it falls back to today
       * rather than leaving `Try again` to resend the value that was just
       * refused. Only the day resets; the error still says what happened.
       */
      if (result.status === 'invalid-day') {
        setHistoryDay(null)
      }

      setState({
        status: 'error',
        message: result.message,
        signIn: result.status === 'unauthenticated',
      })
    })()
  }, [network, readAttempt, historyDay])

  const refresh = useCallback((): void => {
    setIsRefreshing(true)
    setReadAttempt((previous) => previous + 1)
  }, [])

  /**
   * A DAY CHANGE IS A READ, not a filter. The effect above owns every
   * request, so this only moves the state it depends on.
   */
  const showDay = useCallback((day: string): void => {
    setIsRefreshing(true)
    setHistoryDay(day)
  }, [])

  if (network === 'offline') {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-6">
        <p className="flex items-center gap-2 font-heading text-lg font-semibold text-amber-700 dark:text-amber-400">
          <CloudOff className="size-5" />
          {DANDIYA_MESSAGES.offline}
        </p>

        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Pairs and sticks are tracked centrally so that two desks can never
          hand out the same pair, or the same attendee, at once. Reconnect to
          continue; nothing is queued, and nothing can be issued or resolved
          while this device is offline.
        </p>
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        Loading the dandiya board…
      </p>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-6">
        <p className="text-sm font-medium text-destructive">
          {state.message}
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

          {state.signIn ? (
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

  const { board } = state
  const carryover = outstandingBeforeDay(board.active, board.eventDay)
  const visibleActive = selectActiveLoans(board.active, {
    view: activeView,
    search: activeSearch,
    eventDay: board.eventDay,
  })

  const issue = async (input: {
    pairCode: string
    badgeNumbers: [number, number]
  }): Promise<void> => {
    if (isSubmitting) {
      return
    }

    setIsSubmitting(true)

    try {
      const result = await issueDandiyaPair(input)

      if (result.status === 'issued') {
        setNotice({
          kind: 'success',
          message: `Pair ${result.loan.pairCode} issued to ${result.loan.holders
            .map((holder) => formatBadgeNumber(holder.badgeNumber))
            .join(' + ')}`,
        })
        /** Clears all three inputs and refocuses the pair field. */
        setIssueAttempt((previous) => previous + 1)
        refresh()

        return
      }

      setNotice({
        kind:
          result.status === 'pair-in-use' || result.status === 'attendee-holding'
            ? 'info'
            : 'error',
        message: result.message,
      })

      /**
       * ANOTHER DESK GOT THERE FIRST, or the answer never arrived — and an
       * unanswered request may have committed. Both are re-read rather than
       * guessed, so the board matches the ledger before the next attempt.
       */
      if (
        result.status === 'pair-in-use' ||
        result.status === 'attendee-holding' ||
        result.status === 'unreachable'
      ) {
        refresh()
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * ONE HANDLER FOR ALL FOUR ACTIONS, because they are one decision asked
   * about different scopes — and because every one of them ends the same way:
   * re-read the board. Whether the loan closed, and as what, was derived by
   * the database from the two sticks; predicting it here would be a second
   * opinion that can disagree with the ledger.
   */
  const resolve = async (request: DandiyaRequest): Promise<void> => {
    if (isSubmitting) {
      return
    }

    setIsSubmitting(true)

    try {
      const result = await resolveDandiyaPair(
        request.action === 'resolve-holder' && request.holder !== undefined
          ? {
              action: 'resolve-holder',
              loanId: request.loan.id,
              badgeNumber: request.holder.badgeNumber,
              resolution: request.resolution ?? 'returned',
            }
          : { action: request.action === 'lost-pair' ? 'lost-pair' : 'return-pair', loanId: request.loan.id },
      )

      setPending(null)

      if (result.status === 'resolved') {
        setNotice({
          kind: request.resolution === 'lost' || request.action === 'lost-pair'
            ? 'info'
            : 'success',
          message:
            request.action === 'resolve-holder' && request.holder !== undefined
              ? `${formatBadgeNumber(request.holder.badgeNumber)} recorded as ${
                  request.resolution === 'lost' ? 'lost' : 'returned'
                } on pair ${request.loan.pairCode}.`
              : request.action === 'lost-pair'
                ? `Pair ${request.loan.pairCode} reported lost. It will stay unavailable.`
                : `Pair ${request.loan.pairCode} returned.`,
        })
      } else {
        setNotice({
          kind:
            result.status === 'holder-already-resolved' ||
            result.status === 'loan-already-closed' ||
            result.status === 'loan-not-found'
              ? 'info'
              : 'error',
          message: result.message,
        })
      }

      /**
       * ALWAYS re-read. The counters, Active, Issues and History all move
       * together, and an unanswered request may have committed — so the board
       * is asked rather than patched.
       */
      refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  const tabClass = (value: DandiyaTab): string =>
    cn(
      'h-11 flex-1 rounded-4xl px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-none',
      tab === value
        ? 'bg-primary text-primary-foreground'
        : 'border border-border bg-input/30 text-muted-foreground hover:text-foreground',
    )

  return (
    <div className="space-y-5">
      {/*
        Operational stats, answering two different questions. `Active` and
        `Sticks out` have no date in them at all — a pair issued yesterday and
        still out is still an obligation tonight — while the other four are
        today's traffic in the EVENT's timezone, counted by the day a loan was
        issued or closed.
      */}
      {/*
        WHAT IS STILL OUT FROM AN EARLIER NIGHT, above everything else and
        outside every tab panel: a volunteer closing up should not have to
        pick the right tab to discover it. Opening Active is the right
        destination — every open loan lives there, oldest first, and each
        leftover already says which night it is from.
      */}
      <CarryoverBanner
        active={board.active}
        eventDay={board.eventDay}
        onShow={() => {
          setTab('active')
          setActiveView('carryover')
        }}
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Active', value: board.today.activeLoans },
          { label: 'Sticks out', value: board.today.sticksOut },
          { label: 'Issued today', value: board.today.issued },
          { label: 'Returned today', value: board.today.fullyReturned },
          { label: 'Partial losses', value: board.today.partialLosses },
          { label: 'Pairs lost', value: board.today.lostPairs },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-2xl border border-border bg-card px-4 py-3"
          >
            <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              {stat.label}
            </dt>

            <dd className="font-heading text-2xl font-semibold">
              {String(stat.value)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Dandiya"
          className="flex w-full gap-2 sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'issue'}
            className={tabClass('issue')}
            onClick={() => {
              setTab('issue')
            }}
          >
            Issue Pair
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'active'}
            className={tabClass('active')}
            onClick={() => {
              setTab('active')
            }}
          >
            {`Active (${String(board.active.length)})`}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'issues'}
            className={tabClass('issues')}
            onClick={() => {
              setTab('issues')
            }}
          >
            {`Issues (${String(board.issues.length)})`}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'history'}
            className={tabClass('history')}
            onClick={() => {
              setTab('history')
            }}
          >
            History
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

      {tab === 'issue' ? (
        <div role="tabpanel">
          <IssuePairForm
            key={issueAttempt}
            attendees={board.attendees}
            active={board.active}
            issues={board.issues}
            isSubmitting={isSubmitting}
            onIssue={(input) => {
              setNotice(null)
              void issue(input)
            }}
          />
        </div>
      ) : null}

      {tab === 'active' ? (
        <div role="tabpanel" className="space-y-4">
          <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
            {/*
              ALL or CARRYOVER. The second is the morning-after list: open
              loans issued before the SERVER's event day. Switching is
              client-side over rows already loaded — no request, and nothing
              about a loan changes.
            */}
            <div
              role="group"
              aria-label="Active filter"
              className="flex flex-wrap gap-2"
            >
              <Button
                type="button"
                variant={activeView === 'all' ? 'default' : 'outline'}
                className="h-11 flex-1 sm:flex-none"
                aria-pressed={activeView === 'all'}
                onClick={() => {
                  setActiveView('all')
                }}
              >
                All
              </Button>

              <Button
                type="button"
                variant={activeView === 'carryover' ? 'default' : 'outline'}
                className="h-11 flex-1 sm:flex-none"
                aria-pressed={activeView === 'carryover'}
                onClick={() => {
                  setActiveView('carryover')
                }}
              >
                {`Carryover (${String(carryover.pairs)})`}
              </Button>
            </div>

            <Label htmlFor="dandiya-active-search">
              Search active pairs
            </Label>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

              <Input
                id="dandiya-active-search"
                type="text"
                inputMode="search"
                autoComplete="off"
                placeholder="Pair, badge or name"
                className="h-11 pl-9"
                value={activeSearch}
                onChange={(event) => {
                  setActiveSearch(event.target.value)
                }}
              />
            </div>

            <p className="text-sm text-muted-foreground">
              {visibleActive.length === board.active.length
                ? `${String(board.active.length)} out`
                : `${String(visibleActive.length)} of ${String(board.active.length)} out`}
            </p>

            {activeView === 'carryover' && carryover.pairs > 0 ? (
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                {`${String(carryover.sticks)} ${
                  carryover.sticks === 1 ? 'stick' : 'sticks'
                } still out from previous days.`}
              </p>
            ) : null}
          </div>

          {visibleActive.length === 0 ? (
            /*
              CARRYOVER EMPTIES ITSELF as the last leftover is resolved, and
              an empty filter must not read as an empty event — so it says
              what happened and offers the way back rather than silently
              switching the view somebody chose.
            */
            <div className="space-y-4 rounded-2xl border border-border bg-card px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {activeView === 'carryover' && carryover.pairs === 0
                  ? 'Nothing is outstanding from previous days.'
                  : activeView === 'carryover'
                    ? 'No carryover pairs match this search.'
                    : board.active.length === 0
                      ? 'No dandiya pairs are out.'
                      : 'No active pairs match this search.'}
              </p>

              {activeView === 'carryover' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setActiveView('all')
                  }}
                >
                  Show all active pairs
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleActive.map((loan) => (
                <ActiveLoanCard
                  key={loan.id}
                  loan={loan}
                  isBusy={isSubmitting}
                  onRequest={(next) => {
                    setNotice(null)
                    setPending(next)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'issues' ? (
        <div role="tabpanel">
          <PairIssues
            loans={board.issues}
            search={issuesSearch}
            onSearchChange={setIssuesSearch}
          />
        </div>
      ) : null}

      {tab === 'history' ? (
        <div role="tabpanel">
          <LoanHistory
            loans={board.history}
            day={board.historyDay}
            eventDay={board.eventDay}
            view={historyView}
            search={historySearch}
            isLoading={isRefreshing}
            onDayChange={showDay}
            onViewChange={setHistoryView}
            onSearchChange={setHistorySearch}
          />
        </div>
      ) : null}

      <ResolvePairDialog
        request={pending}
        isSubmitting={isSubmitting}
        onCancel={() => {
          setPending(null)
        }}
        onConfirm={(request) => {
          void resolve(request)
        }}
      />
    </div>
  )
}

export default DandiyaDesk
