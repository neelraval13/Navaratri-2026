import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import type * as React from 'react'
import { useState } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateLong, formatEventTime } from '@/lib/datetime'
import {
  groupAwardsByEventDay,
  isDefaultExpandedAwardGroup,
  type HistoryAward,
} from '@/prizes/award-groups'
import { filterPrizeAwards } from '@/prizes/prize-filters'

interface AwardHistoryProps {
  /** The COMBINED history: attendee prizes and CNG prizes, newest first. */
  awards: readonly HistoryAward[]
  search: string
  onSearchChange: (search: string) => void
}

/**
 * Permanent prize history, GROUPED BY EVENT-LOCAL DAY, newest day first.
 *
 * ONE ROW PER AWARD, never one per person. Since Phase P1.1 an attendee may
 * win several prizes, so repeated badge numbers are expected and each record
 * is listed independently — nothing is grouped, collapsed or counted into a
 * single entry, because three prizes for #9005 are three things that
 * happened. The React key is the award's own id for the same reason: a badge
 * number no longer identifies a row.
 *
 * PHASE CNG1 GROUPED THE ROWS BY DATE, AND CHANGED NOTHING ELSE. The event
 * runs several nights and every card used to repeat the same date, so the
 * list read as one undifferentiated run. Each card now shows the TIME only
 * and the date is a heading above its night — the same records, the same
 * order, the same ledger facts.
 *
 * PHASE CNG1.1 ADDED THE VOLUNTEER PRIZES BESIDE THEM, and changed nothing
 * about the grouping. Both ledgers appear under the same date headings,
 * sorted together by award time, newest first. An attendee row leads with the
 * BADGE and a CNG row with the word `CNG` and the member's name: no badge is
 * fabricated for a volunteer, which is the whole reason the two ledgers are
 * separate tables.
 *
 * THE LATEST NIGHT IS OPEN AND THE OLDER ONES ARE SHUT, because tonight is
 * what a volunteer at the table is looking at. Every heading is a real button
 * with its own award count, so an older night is one tap away.
 *
 * THE DAY IS THE EVENT'S, through the shared `eventDayKey` the counters and
 * the server both use — never the browser's zone. A tablet set to UTC must
 * not file an 11:30 PM award under the previous night, and two tablets must
 * not disagree about which night a prize was given on.
 *
 * APPEND-ONLY from this screen: there is no undo, no delete and no edit, and
 * none is offered — a prize that has been handed over has been handed over,
 * and a ledger a volunteer can rewrite is not a ledger.
 *
 * The attendee's name may be absent: history must survive a Sheet row being
 * edited away, and the badge, the prize, the time and the awarding device are
 * the facts the ledger itself owns.
 */
const AwardHistory: React.FC<AwardHistoryProps> = ({
  awards,
  search,
  onSearchChange,
}) => {
  /**
   * ONLY THE HEADINGS THE OPERATOR HAS TOUCHED, as explicit overrides.
   *
   * Storing "which groups are open" outright would need a default computed at
   * mount, which would then be wrong after a search changed which night is
   * newest — and wrong again after midnight. An override map keeps the
   * default a property of POSITION and remembers only deliberate taps.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  const visible = filterPrizeAwards(awards, search)
  const groups = groupAwardsByEventDay(visible)

  return (
    <div className="space-y-4">
      <div className="space-y-1.5 rounded-2xl border border-border bg-card p-4">
        <Label htmlFor="award-search">
          Search history
        </Label>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

          <Input
            id="award-search"
            type="text"
            inputMode="search"
            autoComplete="off"
            placeholder="Badge, name or prize"
            className="h-11 pl-9"
            value={search}
            onChange={(event) => {
              onSearchChange(event.target.value)
            }}
          />
        </div>

        {/* A count of AWARD RECORDS, not of people. */}
        <p className="pt-1 text-sm text-muted-foreground">
          {visible.length === awards.length
            ? `${String(awards.length)} awards`
            : `${String(visible.length)} of ${String(awards.length)} awards`}
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {awards.length === 0
            ? 'No prizes have been awarded yet.'
            : 'No awards match this search.'}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group, index) => {
            const expanded = toggled[group.dayKey] ?? isDefaultExpandedAwardGroup(index)
            const heading = group.dayKey === '' ? 'Date unavailable' : formatEventDateLong(group.dayKey)
            const count =
              group.awards.length === 1
                ? '1 award'
                : `${String(group.awards.length)} awards`

            return (
              <section
                key={group.dayKey}
                className="overflow-hidden rounded-2xl border border-border bg-card"
              >
                <h3>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-input/30 focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => {
                      setToggled((previous) => ({
                        ...previous,
                        [group.dayKey]: !expanded,
                      }))
                    }}
                  >
                    {expanded ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}

                    <span className="min-w-0 flex-1 truncate font-heading text-base font-semibold tracking-tight">
                      {heading}
                    </span>

                    <span className="shrink-0 text-sm text-muted-foreground">
                      {count}
                    </span>
                  </button>
                </h3>

                {expanded ? (
                  <ul className="divide-y divide-border border-t border-border">
                    {group.awards.map((award) => (
                      <li key={`${award.source}-${award.id}`} className="px-4 py-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          {/*
                            THE RECIPIENT'S OWN IDENTITY, never a fabricated
                            one. An attendee has a badge; a volunteer has
                            not, and says `CNG` instead of pretending to.
                          */}
                          <p className="font-heading text-xl font-semibold tracking-tight">
                            {award.source === 'attendee'
                              ? formatBadgeNumber(award.badgeNumber)
                              : 'CNG'}
                          </p>

                          {/* THE TIME ONLY. The date is the heading above. */}
                          <p className="text-sm text-muted-foreground">
                            {formatEventTime(award.awardedAt)}
                          </p>
                        </div>

                        <p className="mt-1 text-base font-medium text-primary">
                          {award.prizeName}
                        </p>

                        <p className="text-sm text-muted-foreground">
                          {award.source === 'cng'
                            ? award.memberName
                            : award.attendee === null
                              ? 'Attendee no longer in the register'
                              : award.attendee.name}
                        </p>

                        <p className="mt-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
                          {`Awarded by ${award.awardedBy.name}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default AwardHistory
