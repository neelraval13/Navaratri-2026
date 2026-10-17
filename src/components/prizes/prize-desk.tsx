import { CloudOff, RefreshCw } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import AttendeeFilters from '@/components/attendees/attendee-filters'
import AddCngMemberDialog from '@/components/cng/add-cng-member-dialog'
import AwardCngPrizeDialog from '@/components/cng/award-cng-prize-dialog'
import BulkAddCngNamesDialog from '@/components/cng/bulk-add-cng-names-dialog'
import CngRoster from '@/components/cng/cng-roster'
import RemoveCngMemberDialog from '@/components/cng/remove-cng-member-dialog'
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
import { withCngMember, withoutCngMember } from '@/cng/cng-group'
import { combineAwardHistory } from '@/prizes/award-groups'
import {
  addCngMember,
  awardCngPrize,
  awardPrize,
  fetchPrizeRoster,
  removeCngMember,
  PRIZE_MESSAGES,
} from '@/prizes/prize-api'
import { previousAwardsFor, previousCngAwardsFor } from '@/prizes/prize-filters'
import type {
  CngMember,
  CngMemberDraft,
  CngPrizeAward,
} from '@/shared/cng-contract'
import type { PrizeAttendee, PrizeAward } from '@/shared/prize-contract'

type RosterState =
  | { status: 'loading' }
  | {
      status: 'loaded'
      attendees: PrizeAttendee[]
      awards: PrizeAward[]
      /** The ACTIVE CNG volunteer group, oldest first. Named, not badged. */
      cng: CngMember[]
      /** The volunteer prize ledger, separate from `awards` on the wire. */
      cngAwards: CngPrizeAward[]
    }
  /** `signIn` offers Device Sign-In; nothing else here offers a credential. */
  | { status: 'error'; message: string; signIn: boolean }

type PrizeTab = 'attendees' | 'cng' | 'awards'

/**
 * THE PRIZE DESK.
 *
 * ONLINE ONLY, and the screen says so rather than pretending otherwise. There
 * is no offline queue, no optimistic local award, no local authoritative prize
 * state, no polling and no heartbeat. While the browser reports offline, NO
 * MUTATION IS EXPOSED AT ALL: there is no roster to award from and no button
 * to press, so nothing can appear to succeed locally.
 *
 * REPEAT PRIZES ARE LEGAL, since Phase P1.1, and the three tabs reflect that:
 *
 *   Attendees (45)   every registered attendee, winners included
 *   CNG (23)         the volunteer group: a curated SUBSET of the same people
 *   Awards (2)       every award RECORD, so one badge may appear twice
 *
 * The attendee count therefore does not move when a prize is given and the
 * award count does. An awarded badge is NEVER removed from Attendees and
 * stays findable by search and by the age and gender filters: a volunteer
 * looking up #9005 must find #9005 whatever #9005 has already won.
 *
 * NOR DOES THE CNG TAB SUBTRACT ANYBODY. A volunteer appears in Attendees and
 * in CNG, and may be given a prize from either — through the SAME dialog and
 * the SAME single writer. Phase CNG1 added membership as a third list in the
 * one request this screen already makes, because the CNG cards need the same
 * joined names and a second endpoint would read the same Sheet twice.
 *
 * MEMBERSHIP IS THE ONE MUTABLE THING HERE. A member may be added and
 * removed; an award may not be edited or deleted, and nothing on this screen
 * offers to. Removing a volunteer removes a membership row and nothing else:
 * not the attendee, not their prizes, not their registration.
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
  /** The ATTENDEE award dialog's subject: a badge. */
  const [selected, setSelected] = useState<PrizeAttendee | null>(null)
  /** The VOLUNTEER award dialog's subject: a member. Separate on purpose. */
  const [cngAwarding, setCngAwarding] = useState<CngMember | null>(null)
  /** `true` renders the one-name Add form. */
  const [isAddingCng, setIsAddingCng] = useState(false)
  /**
   * The pasted-list workflow. `false` means the dialog is NOT RENDERED rather
   * than hidden, so closing it unmounts the component and React discards the
   * pasted list — the discard is structural rather than a reset somebody has
   * to remember to call.
   */
  const [isBulkAddingCng, setIsBulkAddingCng] = useState(false)
  const [cngRemoving, setCngRemoving] = useState<CngMember | null>(null)
  /**
   * ONE in-flight guard for the whole desk, deliberately. Awarding either
   * kind of prize, adding a volunteer and removing one are all writes to the
   * same endpoint, and a second tap during any of them must not start
   * another.
   */
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
          cng: result.cng,
          cngAwards: result.cngAwards,
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
          /** Untouched: an attendee prize changes nothing about the group. */
          cng: roster.cng,
          /** And nothing about the VOLUNTEER ledger, which is separate. */
          cngAwards: roster.cngAwards,
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

  /**
   * ADDS VOLUNTEERS, BY NAME, EACH UNDER ITS OWN IDEMPOTENCY KEY.
   *
   * ONE WRITE PATH FOR BOTH ROUTES. The single Add passes one draft and the
   * pasted list passes several; each is still ONE
   * `PUT /api/prizes { cngMemberId, name }`, sent sequentially through the
   * same client call. There is deliberately no bulk endpoint — and so no
   * second writer to drift from this one.
   *
   * SEQUENTIAL, NOT PARALLEL. Twenty-three parallel writes would gain
   * nothing, and a partial failure would be impossible to describe. Each
   * answer is applied as it arrives, so a failure halfway through leaves the
   * members that did succeed on screen.
   *
   * THE DRAFT IDS COME FROM THE DIALOG AND ARE STABLE WHILE IT IS OPEN, so
   * repeating a partially failed run is safe: the ones that already landed
   * answer `already-member` and the rest are created. A name could not do
   * that job — two volunteers may genuinely share one.
   *
   * Applied locally rather than re-fetched, for the same reason an award is:
   * the responses carry the authoritative rows, and a reload would discard
   * the filters and the search this volunteer is working through. Nothing
   * else in the roster moves — the attendee list and both award histories are
   * carried through untouched.
   */
  const addMembers = async (
    drafts: readonly CngMemberDraft[],
  ): Promise<void> => {
    if (isSubmitting || drafts.length === 0) {
      return
    }

    setIsSubmitting(true)

    try {
      let group = roster.cng
      let added = 0
      let unchanged = 0
      let failure: string | null = null
      let reread = false

      for (const draft of drafts) {
        const result = await addCngMember(draft)

        if (result.status === 'member') {
          group = withCngMember(group, result.member)

          if (result.outcome === 'added') {
            added += 1
          } else {
            unchanged += 1
          }

          continue
        }

        /**
         * THE FIRST FAILURE STOPS THE RUN. Carrying on would usually mean
         * repeating the same failure for every remaining name — an expired
         * session, a lost `prizes` attribute — and burying the one thing the
         * operator has to fix.
         */
        failure = result.message

        /**
         * THE ANSWER NEVER ARRIVED, and an unanswered request may have
         * committed. Re-read rather than guess, so the group on screen
         * matches the ledger.
         */
        reread = result.status === 'unreachable'

        break
      }

      setIsAddingCng(false)

      if (added + unchanged > 0) {
        // Bumped first so a read ALREADY in flight cannot answer afterwards
        // and drop the members just added.
        sequence.current += 1

        setRoster({
          status: 'loaded',
          attendees: roster.attendees,
          awards: roster.awards,
          cng: group,
          cngAwards: roster.cngAwards,
        })
      }

      if (failure !== null) {
        setNotice({ kind: 'error', message: failure })

        if (reread) {
          refresh()
        }

        return
      }

      /** The group is now what was asked for, so the dialog has nothing left. */
      setIsBulkAddingCng(false)

      if (added === 0) {
        setNotice({
          kind: 'info',
          message:
            unchanged === 1
              ? `${drafts[0].name} was already added.`
              : `All ${String(unchanged)} were already added.`,
        })

        return
      }

      setNotice({
        kind: 'success',
        message:
          added === 1 && unchanged === 0
            ? `${drafts[0].name} added to CNG.`
            : `${String(added)} CNG members added${unchanged === 0 ? '' : `, ${String(unchanged)} already there`}.`,
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * REMOVES ONE MEMBERSHIP, SOFTLY, and nothing else.
   *
   * `not-a-member` is ordinary operational news — another desk got there
   * first, or this screen was stale — so the member is dropped from the
   * active list either way: the group genuinely does not contain them. The
   * attendee list and BOTH award histories are carried through untouched,
   * because a removal cannot affect any of them: the row survives with a
   * `removed_at` stamp precisely so their prizes keep naming them.
   */
  const removeMember = async (member: CngMember): Promise<void> => {
    if (isSubmitting) {
      return
    }

    setIsSubmitting(true)

    try {
      const result = await removeCngMember({ cngMemberId: member.id })

      setCngRemoving(null)

      if (result.status === 'removed' || result.status === 'not-a-member') {
        sequence.current += 1

        setRoster({
          status: 'loaded',
          attendees: roster.attendees,
          /** Both ledgers are append-only. A removal never touches either. */
          awards: roster.awards,
          cng: withoutCngMember(roster.cng, member.id),
          cngAwards: roster.cngAwards,
        })

        setNotice(
          result.status === 'removed'
            ? {
                kind: 'success',
                message: `${member.name} removed from CNG. Their prize history is unchanged.`,
              }
            : { kind: 'info', message: result.message },
        )

        return
      }

      setNotice({ kind: 'error', message: result.message })

      if (result.status === 'unreachable') {
        refresh()
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * AWARDS ONE PRIZE TO ONE VOLUNTEER, through `PATCH` and the volunteer
   * ledger.
   *
   * A SEPARATE PATH FROM `award` above, which carries a BADGE NUMBER to
   * `POST` and the attendee ledger. Neither can reach the other's table, and
   * no badge is invented for a volunteer — which is the whole reason Phase
   * CNG1.1 added a second table rather than widening the first.
   *
   * Applied locally rather than re-fetched, exactly as an attendee award is.
   * ONLY the CNG award list grows: the attendee list, the attendee history
   * and the group itself are carried through, because a prize changes nothing
   * about any of them.
   */
  const awardCng = async (prizeName: string): Promise<void> => {
    if (cngAwarding === null || isSubmitting) {
      return
    }

    const member = cngAwarding

    setIsSubmitting(true)

    try {
      const result = await awardCngPrize({
        cngMemberId: member.id,
        prizeName,
      })

      setCngAwarding(null)

      if (result.status === 'awarded') {
        sequence.current += 1

        setRoster({
          status: 'loaded',
          attendees: roster.attendees,
          /** The ATTENDEE ledger is untouched by a volunteer's prize. */
          awards: roster.awards,
          cng: roster.cng,
          cngAwards: [result.award, ...roster.cngAwards],
        })

        setNotice({
          kind: 'success',
          message: `${result.award.prizeName} awarded to ${member.name}.`,
        })

        return
      }

      setNotice({
        kind: result.status === 'member-unavailable' ? 'info' : 'error',
        message: result.message,
      })

      /**
       * THE ANSWER NEVER ARRIVED, and an unanswered request may have
       * committed. Re-read rather than guess.
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
            aria-selected={tab === 'cng'}
            className={tabClass('cng')}
            onClick={() => {
              setTab('cng')
            }}
          >
            {`CNG (${String(roster.cng.length)})`}
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
            {/*
              THE COMBINED COUNT: attendee prizes plus volunteer prizes, which
              is exactly how many records the history below shows. Counting
              one ledger would make the tab disagree with its own contents.
            */}
            {`Awards (${String(roster.awards.length + roster.cngAwards.length)})`}
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
      ) : tab === 'cng' ? (
        <div role="tabpanel">
          <CngRoster
            members={roster.cng}
            cngAwards={roster.cngAwards}
            isBusy={isSubmitting}
            onAdd={() => {
              setNotice(null)
              setIsAddingCng(true)
            }}
            onBulkAdd={() => {
              setNotice(null)
              setIsBulkAddingCng(true)
            }}
            onGivePrize={(member) => {
              setNotice(null)
              setCngAwarding(member)
            }}
            onRemove={(member) => {
              setNotice(null)
              setCngRemoving(member)
            }}
          />
        </div>
      ) : (
        <div role="tabpanel">
          {/*
            BOTH LEDGERS, COMBINED FOR DISPLAY ONLY. They arrive as separate
            lists because they are separate tables with different identities;
            merging them here keeps the grouping logic — which was reviewed
            and approved — exactly as it was, and invents no badge for a
            volunteer.
          */}
          <AwardHistory
            awards={combineAwardHistory(roster.awards, roster.cngAwards)}
            search={historySearch}
            onSearchChange={setHistorySearch}
          />
        </div>
      )}

      {/*
        RENDERED CONDITIONALLY AND KEYED BY THE BADGE, so nothing is selected
        when the dialog opens for each attendee. Carrying the previous choice
        over would be convenient for a run of one prize and dangerous
        everywhere else: the row is permanent and there is no undo, so the
        prize is tapped deliberately each time.

        THE KEY IDENTIFIES THE ATTENDEE AND NOTHING ELSE. It used to fall back
        to a literal when no attendee was selected, which is a key describing
        the UI's STATE rather than the item — and the volunteer dialog below
        then reached for the same fallback, so with neither open the two
        siblings carried one key and React warned about it.

        There is no fallback now because there is nothing to fall back for:
        with no attendee there is no dialog. Both dialogs already render
        nothing for a null target, so unmounting them is what was happening
        anyway.

        The warning reads from the CURRENTLY LOADED history, so a prize given
        a moment ago is already listed the next time this opens.
      */}
      {selected === null ? null : (
        <AwardPrizeDialog
          key={String(selected.badgeNumber)}
          attendee={selected}
          previousAwards={previousAwardsFor(roster.awards, selected.badgeNumber)}
          isSubmitting={isSubmitting}
          onCancel={() => {
            setSelected(null)
          }}
          onAward={(prizeName) => {
            void award(prizeName)
          }}
        />
      )}

      {/*
        ONE NAME, TYPED. Rendered conditionally so each open starts empty: a
        name carried over from the last member is exactly the mistake a
        volunteer list invites.
      */}
      {isAddingCng ? (
        <AddCngMemberDialog
          isSubmitting={isSubmitting}
          onCancel={() => {
            setIsAddingCng(false)
          }}
          onAdd={(draft) => {
            void addMembers([draft])
          }}
        />
      ) : null}

      {/*
        RENDERED CONDITIONALLY, never hidden behind an `open` prop. Closing it
        UNMOUNTS it, so React discards the pasted list — the discard is
        structural rather than a reset somebody has to remember to call. The
        text never leaves this component: what is sent is one name per
        member, through the ordinary single-member call.
      */}
      {isBulkAddingCng ? (
        <BulkAddCngNamesDialog
          isSubmitting={isSubmitting}
          onCancel={() => {
            setIsBulkAddingCng(false)
          }}
          onAdd={(drafts) => {
            void addMembers(drafts)
          }}
        />
      ) : null}

      {/*
        THE VOLUNTEER AWARD DIALOG, rendered conditionally and keyed by the
        MEMBER ID, so nothing is selected when it opens for each one — the
        same rule the attendee dialog follows, and for the same reason: the
        row is permanent and there is no undo.

        BY ID RATHER THAN BY NAME, because two volunteers may share a name,
        and by the id ALONE: the literal fallback this used to carry when no
        member was selected was the same literal the attendee dialog used, so
        the two siblings collided on it.
      */}
      {cngAwarding === null ? null : (
        <AwardCngPrizeDialog
          key={cngAwarding.id}
          member={cngAwarding}
          previousAwards={previousCngAwardsFor(roster.cngAwards, cngAwarding.id)}
          isSubmitting={isSubmitting}
          onCancel={() => {
            setCngAwarding(null)
          }}
          onAward={(prizeName) => {
            void awardCng(prizeName)
          }}
        />
      )}

      <RemoveCngMemberDialog
        member={cngRemoving}
        previousAwardCount={
          cngRemoving === null
            ? 0
            : previousCngAwardsFor(roster.cngAwards, cngRemoving.id).length
        }
        isSubmitting={isSubmitting}
        onCancel={() => {
          setCngRemoving(null)
        }}
        onRemove={(member) => {
          void removeMember(member)
        }}
      />
    </div>
  )
}

export default PrizeDesk
