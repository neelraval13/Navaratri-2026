import { TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import { formatEventDateTime } from '@/lib/datetime'
import type { PrizeAward } from '@/shared/prize-contract'

interface PreviousAwardsWarningProps {
  awards: readonly PrizeAward[]
}

/**
 * What this attendee has ALREADY been given.
 *
 * A WARNING, NEVER A REFUSAL. Since Phase P1.1 repeat prizes are legal — the
 * same attendee may win Best Dance and Best Dress, or the same prize twice —
 * so this section exists to make a volunteer pause, not to stop them. It
 * disables nothing, hides nothing and asks for no override, and the award
 * button below it stays available in every case.
 *
 * Amber, not red: a previous prize is a fact worth noticing, not an error
 * anybody made.
 *
 * Each previous prize is named with its TIME and its AWARDING DEVICE, because
 * "has already received one" is not actionable on its own. Knowing it was
 * Best Dress at 1:15 PM from the other desk is what lets a volunteer decide
 * whether a second prize is intended.
 *
 * Newest first, like the history tab, and every record is listed rather than
 * summarised — three prizes is exactly the case somebody needs to see in
 * full.
 */
const PreviousAwardsWarning: React.FC<PreviousAwardsWarningProps> = ({ awards }) => {
  if (awards.length === 0) {
    return null
  }

  return (
    <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
      <p className="flex items-center gap-2 font-heading text-sm font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-4" />
        Previous prizes
      </p>

      <ul className="space-y-2">
        {awards.map((award) => (
          <li key={award.id} className="space-y-0.5">
            <p className="text-base font-medium">
              {award.prizeName}
            </p>

            <p className="text-sm text-muted-foreground">
              {formatEventDateTime(award.awardedAt)}
            </p>

            <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              {`Awarded by ${award.awardedBy.name}`}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-sm leading-relaxed text-amber-700 dark:text-amber-400">
        {awards.length === 1
          ? 'This attendee has already received 1 prize. You can still award another.'
          : `This attendee has already received ${String(awards.length)} prizes. You can still award another.`}
      </p>
    </div>
  )
}

export default PreviousAwardsWarning
