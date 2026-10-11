import { Search } from 'lucide-react'
import type * as React from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'
import { filterPrizeAwards } from '@/prizes/prize-filters'
import type { PrizeAward } from '@/shared/prize-contract'

interface AwardHistoryProps {
  awards: readonly PrizeAward[]
  search: string
  onSearchChange: (search: string) => void
}

/**
 * Permanent prize history, newest first.
 *
 * ONE ROW PER AWARD, never one per person. Since Phase P1.1 an attendee may
 * win several prizes, so repeated badge numbers are expected and each record
 * is listed independently — nothing is grouped, collapsed or counted into a
 * single entry, because three prizes for #9005 are three things that
 * happened. The React key is the award's own id for the same reason: a badge
 * number no longer identifies a row.
 *
 * APPEND-ONLY from this screen: there is no undo, no delete and no edit, and
 * none is offered — a prize that has been handed over has been handed over,
 * and a ledger a volunteer can rewrite is not a ledger.
 *
 * Times are shown in the EVENT's timezone, not the browser's, through the
 * same formatter the rest of the application uses. A visitor's laptop set to
 * another zone must not make the history read differently.
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
  const visible = filterPrizeAwards(awards, search)

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

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {awards.length === 0
            ? 'No prizes have been awarded yet.'
            : 'No awards match this search.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((award) => (
            <li
              key={award.id}
              className="rounded-2xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-heading text-xl font-semibold tracking-tight">
                  {formatBadgeNumber(award.badgeNumber)}
                </p>

                <p className="text-sm text-muted-foreground">
                  {formatEventDateTime(award.awardedAt)}
                </p>
              </div>

              <p className="mt-1 text-base font-medium text-primary">
                {award.prizeName}
              </p>

              <p className="text-sm text-muted-foreground">
                {award.attendee === null
                  ? 'Attendee no longer in the register'
                  : award.attendee.name}
              </p>

              <p className="mt-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
                {`Awarded by ${award.awardedBy.name}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default AwardHistory
