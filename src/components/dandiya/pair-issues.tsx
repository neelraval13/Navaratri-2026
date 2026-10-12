import { TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Search } from 'lucide-react'
import { matchesLoanSearch } from '@/dandiya/dandiya-filters'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'
import type { DandiyaLoanRecord } from '@/shared/dandiya-contract'
import { DANDIYA_OUTCOME_LABELS } from '@/shared/dandiya-contract'

interface PairIssuesProps {
  loans: readonly DandiyaLoanRecord[]
  search: string
  onSearchChange: (search: string) => void
}

/**
 * THE PAIRS THAT MUST NOT BE HANDED OUT.
 *
 * Every loan here finished with a stick lost and never released its pair, so
 * the pair code is quarantined. This is the same set the database's partial
 * unique index is enforcing — `pair_released_at IS NULL` on a closed loan —
 * which is why the list and the refusal cannot describe different pairs.
 *
 * It exists as its own tab because "which pairs are missing a stick" is a
 * question somebody asks while standing at the table, not a historical record
 * they scroll for. The same rows are in History too; nothing is erased or
 * moved.
 *
 * READ-ONLY. There is no Restore or Release control, deliberately: freeing a
 * quarantined pair means somebody physically repaired or replaced it, and
 * that is a decision with a person behind it rather than a button on the
 * floor.
 */
const PairIssues: React.FC<PairIssuesProps> = ({ loans, search, onSearchChange }) => {
  const visible = loans.filter((loan) => matchesLoanSearch(loan, search))

  return (
    <div className="space-y-4">
      <div className="space-y-1.5 rounded-2xl border border-border bg-card p-4">
        <Label htmlFor="dandiya-issues-search">
          Search unavailable pairs
        </Label>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

          <Input
            id="dandiya-issues-search"
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

        <p className="pt-1 text-sm text-muted-foreground">
          {visible.length === loans.length
            ? `${String(loans.length)} unavailable`
            : `${String(visible.length)} of ${String(loans.length)} unavailable`}
        </p>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {loans.length === 0
            ? 'Every pair is accounted for.'
            : 'No unavailable pairs match this search.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((loan) => (
            <li
              key={loan.id}
              className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-destructive">
                  <TriangleAlert className="size-3.5" />
                  {loan.outcome === null
                    ? 'Incident'
                    : DANDIYA_OUTCOME_LABELS[loan.outcome]}
                </p>

                <p className="font-heading text-xl font-semibold uppercase tracking-[0.08em]">
                  {`Pair ${loan.pairCode}`}
                </p>
              </div>

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
                        holder.resolution === 'lost'
                          ? 'text-sm font-medium text-destructive'
                          : 'text-sm text-muted-foreground'
                      }
                    >
                      {holder.resolution === null
                        ? 'Unresolved'
                        : `${holder.resolution === 'lost' ? 'Lost' : 'Returned'} ${
                            holder.resolvedAt === null
                              ? ''
                              : formatEventDateTime(holder.resolvedAt)
                          }`}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="text-sm font-medium text-destructive">
                Unavailable for issue
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default PairIssues
