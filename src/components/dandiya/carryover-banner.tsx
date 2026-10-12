import { TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { outstandingBeforeDay } from '@/dandiya/dandiya-filters'
import type { DandiyaActiveLoan } from '@/shared/dandiya-contract'

interface CarryoverBannerProps {
  /** Every open loan for the event, with no day scoping. */
  active: readonly DandiyaActiveLoan[]
  /** The event's own today, as the SERVER reported it. */
  eventDay: string
  /** Opens Active, filtered to exactly these loans. */
  onShow: () => void
}

/**
 * WHAT NOBODY HAS BROUGHT BACK FROM AN EARLIER NIGHT.
 *
 * The one number a volunteer closing up needs that no single tab shows:
 * sticks still out from before today. It counts PAIRS and STICKS separately
 * because they are different jobs — two pairs with one stick each is two
 * people to find, not four.
 *
 * A PROJECTION, NEVER A STORED FIGURE. Derived from the open loans the board
 * already carries, so nothing is written at midnight and nothing needs to be.
 * If every stick comes back, this disappears on the next read without
 * anything having been reset.
 *
 * SILENT AT ZERO. A banner that is always there is furniture, and furniture
 * is not read.
 *
 * IT IS THE MORNING-AFTER REMINDER, not the end-of-night list. Before
 * midnight the sticks that have not come back are TODAY's, and
 * History → Today → Outstanding is where somebody works through them. This
 * appears once the event day has rolled over and those obligations have
 * become carryover — which is a change of label, never a change of state.
 */
const CarryoverBanner: React.FC<CarryoverBannerProps> = ({
  active,
  eventDay,
  onShow,
}) => {
  const { pairs, sticks } = outstandingBeforeDay(active, eventDay)

  if (pairs === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-4 shrink-0" />

        {`${String(pairs)} ${pairs === 1 ? 'pair' : 'pairs'} · ${String(sticks)} ${
          sticks === 1 ? 'stick' : 'sticks'
        } still outstanding from previous days`}
      </p>

      <Button
        type="button"
        variant="outline"
        className="h-10"
        onClick={onShow}
      >
        Show carryover
      </Button>
    </div>
  )
}

export default CarryoverBanner
