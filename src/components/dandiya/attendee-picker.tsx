import { Search, X } from 'lucide-react'
import type * as React from 'react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'
import { filterAttendees, EMPTY_ATTENDEE_FILTERS } from '@/attendees/attendee-filters'
import type { HolderObligation } from '@/dandiya/dandiya-filters'
import type { EventAttendee } from '@/shared/attendee-contract'

/** A stick this badge has lost before. INFORMATION, never blocking. */
export interface PriorLoss {
  pairCode: string
  resolvedAt: string
}

interface AttendeePickerProps {
  label: string
  inputId: string
  attendees: readonly EventAttendee[]
  selected: EventAttendee | null
  /** Already chosen in the other slot: one pair goes to two people. */
  excludedBadgeNumber: number | null
  /**
   * WHAT THIS BADGE ALREADY OWES THE EVENT, if anything. BLOCKING.
   *
   * Two different facts, and the wording must not conflate them: `holding`
   * means their own stick is out, `accountable` means a pair went out ON
   * their badge and has not come back — which outlives their own stick.
   */
  obligation: HolderObligation | null
  /** Newest first. Shown when the attendee is selected; never blocking. */
  priorLosses: readonly PriorLoss[]
  disabled: boolean
  onSelect: (attendee: EventAttendee | null) => void
}

const GENDER_LABEL = { male: 'Male', female: 'Female' } as const

const MAX_SUGGESTIONS = 6

/**
 * Picking one of the two attendees a pair goes to.
 *
 * SEARCH, THEN CONFIRM. Typing searches the current Badge Register by badge
 * number or name — through the SAME filter the prize desk and the directory
 * use, so one query cannot find somebody on one screen and miss them on
 * another. Choosing a result replaces the field with a confirmed identity
 * card, because the thing a volunteer must be sure of is WHO they are handing
 * sticks to, and a half-typed badge number in a text box is not that.
 *
 * THE SAME BADGE CANNOT BE PICKED TWICE. The attendee already chosen in the
 * other slot is removed from these results and named if it is searched for,
 * so the mistake is prevented rather than refused after the fact — though the
 * endpoint and `UNIQUE(loan_id, badge_number)` both refuse it anyway.
 *
 * AN ATTENDEE WHO IS ALREADY HOLDING A STICK is selectable and then clearly
 * blocked, with the pair and the time. That is deliberate: a volunteer who
 * searches for Meera needs to find out that she has D-007 out, not to have
 * her silently missing from the list. An attendee is holding only while their
 * OWN stick is unresolved — a lost stick frees them exactly as a returned one
 * does.
 *
 * A PRIOR LOSS IS A WARNING AND NEVER A BLOCK. Somebody who lost a stick last
 * night may absolutely be handed another pair; the desk just deserves to know
 * before they do it. So the note names the pair and the time, says in words
 * that it does not block, and changes nothing about whether Issue is
 * available.
 */
const AttendeePicker: React.FC<AttendeePickerProps> = ({
  label,
  inputId,
  attendees,
  selected,
  excludedBadgeNumber,
  obligation,
  priorLosses,
  disabled,
  onSelect,
}) => {
  const [search, setSearch] = useState('')

  if (selected !== null) {
    return (
      <div className="space-y-1.5">
        <span className="flex items-center gap-2 text-sm leading-none font-medium">
          {label}
        </span>

        <div
          className={
            obligation === null
              ? 'flex items-start justify-between gap-3 rounded-2xl border border-green-600/40 bg-green-600/10 p-4'
              : 'flex items-start justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4'
          }
        >
          <div className="min-w-0 space-y-0.5">
            <p className="font-heading text-xl font-semibold tracking-tight">
              {formatBadgeNumber(selected.badgeNumber)}
            </p>

            <p className="truncate text-base font-medium" title={selected.name}>
              {selected.name}
            </p>

            <p className="text-sm text-muted-foreground">
              {`Age ${String(selected.age)} · ${GENDER_LABEL[selected.gender]}`}
            </p>

            {obligation === null ? (
              <>
                <p className="pt-1 text-sm font-medium text-green-700 dark:text-green-400">
                  Registered
                </p>

                {/* INFORMATION. Issue stays available: see the note above. */}
                {priorLosses.length === 0 ? null : (
                  <div className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                      {priorLosses.length === 1
                        ? 'Previous Dandiya loss'
                        : `${String(priorLosses.length)} previous Dandiya losses`}
                    </p>

                    {priorLosses.map((loss) => (
                      <p
                        key={`${loss.pairCode}-${loss.resolvedAt}`}
                        className="text-sm text-muted-foreground"
                      >
                        {`${loss.pairCode} · ${formatEventDateTime(loss.resolvedAt)}`}
                      </p>
                    ))}

                    <p className="pt-1 text-xs text-muted-foreground">
                      This does not block issuing another pair.
                    </p>
                  </div>
                )}
              </>
            ) : (
              /*
                BLOCKING, and it says WHICH obligation and since when.

                A pair issued on ONE badge stays that badge's responsibility
                until the loan closes, so after their own stick comes back
                they are accountable and holding NOTHING. Saying "already
                holding" there would be plainly false to a volunteer who has
                just taken the stick off them.
              */
              <div className="pt-1">
                <p className="text-sm font-medium text-destructive">
                  {obligation.kind === 'holding'
                    ? `Already holding ${obligation.pairCode}`
                    : `Still accountable for ${obligation.pairCode}`}
                </p>

                <p className="text-sm text-muted-foreground">
                  {obligation.kind === 'holding'
                    ? `Issued ${formatEventDateTime(obligation.issuedAt)}`
                    : `Guest stick still out · issued ${formatEventDateTime(obligation.issuedAt)}`}
                </p>
              </div>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setSearch('')
              onSelect(null)
            }}
          >
            Change
          </Button>
        </div>
      </div>
    )
  }

  const query = search.trim()
  const available = attendees.filter(
    (attendee) => attendee.badgeNumber !== excludedBadgeNumber,
  )
  const matches =
    query === ''
      ? []
      : filterAttendees(available, { ...EMPTY_ATTENDEE_FILTERS, search: query })

  /** Named rather than silently absent: the volunteer typed it for a reason. */
  const isExcluded =
    excludedBadgeNumber !== null &&
    query !== '' &&
    filterAttendees(
      attendees.filter((attendee) => attendee.badgeNumber === excludedBadgeNumber),
      { ...EMPTY_ATTENDEE_FILTERS, search: query },
    ).length > 0

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>
        {label}
      </Label>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

        <Input
          id={inputId}
          type="text"
          inputMode="search"
          autoComplete="off"
          placeholder="Badge number or name"
          className="h-11 pl-9"
          disabled={disabled}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
          }}
        />

        {query === '' ? null : (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => {
              setSearch('')
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {isExcluded ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          That attendee is already the other holder of this pair.
        </p>
      ) : null}

      {query === '' ? null : (
        <div className="space-y-1">
          {matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No registered attendee matches that.
            </p>
          ) : (
            matches.slice(0, MAX_SUGGESTIONS).map((attendee) => (
              <button
                key={attendee.badgeNumber}
                type="button"
                disabled={disabled}
                className="flex w-full items-baseline gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left outline-none transition-colors hover:border-primary/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => {
                  onSelect(attendee)
                }}
              >
                <span className="font-heading text-base font-semibold">
                  {formatBadgeNumber(attendee.badgeNumber)}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {attendee.name}
                </span>

                <span className="text-xs text-muted-foreground">
                  {`${String(attendee.age)} · ${GENDER_LABEL[attendee.gender]}`}
                </span>
              </button>
            ))
          )}

          {matches.length > MAX_SUGGESTIONS ? (
            <p className="text-xs text-muted-foreground">
              {`${String(matches.length - MAX_SUGGESTIONS)} more — keep typing to narrow.`}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default AttendeePicker
