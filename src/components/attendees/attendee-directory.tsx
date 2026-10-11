import { CloudOff, RefreshCw } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import { ATTENDEE_MESSAGES, fetchAttendeeDirectory } from '@/attendees/attendee-api'
import {
  EMPTY_ATTENDEE_FILTERS,
  filterAttendees,
  type AttendeeFilterState,
} from '@/attendees/attendee-filters'
import AttendeeCard from '@/components/attendees/attendee-card'
import AttendeeFilters from '@/components/attendees/attendee-filters'
import { Button, buttonVariants } from '@/components/ui/button'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { cn } from '@/lib/utils'
import type { EventAttendee } from '@/shared/attendee-contract'

type DirectoryState =
  | { status: 'loading' }
  | { status: 'loaded'; attendees: EventAttendee[] }
  /** `signIn` offers Device Sign-In; nothing else here offers a credential. */
  | { status: 'error'; message: string; signIn: boolean }

/**
 * THE READ-ONLY ATTENDEE DIRECTORY.
 *
 * IT MUTATES NOTHING, and there is nothing here that could. No award, no
 * edit, no delete, no badge control, no form and no submit: the only request
 * this screen can make is the `GET` behind Refresh.
 *
 * ONLINE ONLY, and the screen says so rather than showing an old list. There
 * is no IndexedDB cache, no offline roster, no service-worker copy, no
 * polling and no heartbeat — a directory presenting a stale register as
 * current would tell a volunteer somebody is registered who is not, or hide
 * somebody who is. While the browser reports offline there is no list at all.
 *
 * AN EMPTY REGISTER AND AN UNREADABLE ONE ARE DIFFERENT SCREENS. `Attendees
 * (0)` with "No attendees have been registered yet" is a fact about the
 * event; a register that could not be read is an error with a Try again. The
 * endpoint keeps them apart and so does this.
 *
 * Filtering is client-side over one fetch, through the SAME filter functions
 * the prize desk uses, so the two screens cannot disagree about which search
 * finds Meera.
 */
const AttendeeDirectory: React.FC = () => {
  const network = useNetworkStatus()

  const [directory, setDirectory] = useState<DirectoryState>({ status: 'loading' })
  const [filters, setFilters] = useState<AttendeeFilterState>(EMPTY_ATTENDEE_FILTERS)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)

  /**
   * LATEST READ WINS, by sequence rather than by timing. A Refresh can start
   * while the mount read is still in flight, and an older response answering
   * last would put a staler register on screen than the one already shown.
   */
  const sequence = useRef(0)

  /**
   * ONE read per trigger, and the triggers are EVENTS: mounting, connectivity
   * returning, and an explicit Refresh — which is a counter rather than a
   * direct call, so there is exactly one place a request originates.
   *
   * There is deliberately no interval. A directory that re-fetched itself on
   * a timer would be a second kind of pressure on the Sheets quota for no
   * operational gain: the register changes when a registration desk does
   * something, and whoever is reading this can press Refresh.
   */
  useEffect(() => {
    if (network === 'offline') {
      return
    }

    const ticket = sequence.current + 1

    sequence.current = ticket

    void (async () => {
      const result = await fetchAttendeeDirectory()

      if (sequence.current !== ticket) {
        return
      }

      setIsRefreshing(false)

      if (result.status === 'loaded') {
        setDirectory({ status: 'loaded', attendees: result.attendees })

        return
      }

      setDirectory({
        status: 'error',
        message: result.message,
        /**
         * Only an expired session is answered by signing in. A register that
         * could not be read, or a device that was never granted `attendees`,
         * is not a credential problem and must not be presented as one.
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
          {ATTENDEE_MESSAGES.offline}
        </p>

        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The directory is read live from the attendee register, so nothing is
          stored on this device and no list is shown while it is offline — a
          stale directory would be worse than none. Reconnect to continue.
        </p>
      </div>
    )
  }

  if (directory.status === 'loading') {
    return (
      <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        Loading attendees…
      </p>
    )
  }

  if (directory.status === 'error') {
    return (
      <div className="space-y-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-6">
        <p className="text-sm font-medium text-destructive">
          {directory.message}
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

          {directory.signIn ? (
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

  const visible = filterAttendees(directory.attendees, filters)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-heading text-lg font-semibold">
          {`Attendees (${String(directory.attendees.length)})`}
        </p>

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

      {/* The register really is empty. A read that FAILED took the error
          branch above, so this never stands in for "could not be read". */}
      {directory.attendees.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No attendees have been registered yet.
        </p>
      ) : (
        <>
          <AttendeeFilters
            state={filters}
            resultCount={visible.length}
            totalCount={directory.attendees.length}
            onChange={setFilters}
            onClear={() => {
              setFilters(EMPTY_ATTENDEE_FILTERS)
            }}
          />

          {visible.length === 0 ? (
            <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              No attendees match these filters.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((attendee) => (
                <AttendeeCard
                  key={attendee.badgeNumber}
                  attendee={attendee}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default AttendeeDirectory
