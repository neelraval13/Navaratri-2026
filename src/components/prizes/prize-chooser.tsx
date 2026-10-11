import { Check } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  PRIZE_CATALOG,
  PRIZE_CATEGORIES,
  PRIZE_CATEGORY_LABELS,
  PRIZE_DIVISION_LABELS,
  type PrizeDivision,
} from '@/shared/prize-contract'

interface PrizeChooserProps {
  /** The selected canonical label, or `null` when nothing is chosen yet. */
  value: string | null
  /** The division age and gender suggest. Highlighted, never enforced. */
  suggestedDivision: PrizeDivision
  disabled: boolean
  onChange: (prizeName: string) => void
}

/**
 * THE EIGHT FIXED PRIZES, in their two groups.
 *
 * Free text is gone — see `src/shared/prize-contract.ts`. A typo at one desk
 * and a different spelling at another produced two prizes where the organiser
 * meant one, and nothing downstream could tell them apart. The buttons are
 * rendered FROM the shared catalog, so the chooser cannot offer a prize the
 * server would refuse, nor miss one it would accept.
 *
 * ONE SELECTION ACROSS BOTH GROUPS, which is why the whole thing is a single
 * `radiogroup`: a prize is Best Dance *or* Best Dress, never both in one
 * submission. The groups are visual, so the volunteer finds the right half at
 * a glance.
 *
 * THE SUGGESTION IS A HINT. The division derived from the attendee's age and
 * gender is marked in both groups so the usual choice is one tap away, but
 * every button stays enabled, nothing is preselected and nothing is
 * auto-submitted. The volunteer at the table knows things the Badge Register
 * does not, and an award is never refused for disagreeing with the hint.
 */
const PrizeChooser: React.FC<PrizeChooserProps> = ({
  value,
  suggestedDivision,
  disabled,
  onChange,
}) => {
  return (
    <div
      role="radiogroup"
      aria-label="Prize"
      className="space-y-4"
    >
      {PRIZE_CATEGORIES.map((category) => (
        <div key={category} className="space-y-2">
          <p className="font-heading text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {PRIZE_CATEGORY_LABELS[category]}
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PRIZE_CATALOG.filter((entry) => entry.category === category).map((entry) => {
              const isSelected = value === entry.label
              const isSuggested = entry.division === suggestedDivision

              return (
                <Button
                  key={entry.code}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={entry.label}
                  variant={isSelected ? 'default' : 'outline'}
                  disabled={disabled}
                  className={cn(
                    'h-14 flex-col gap-0.5 px-2',
                    // Unmistakable: filled, ringed and ticked, all three.
                    isSelected && 'ring-3 ring-ring/50',
                    !isSelected && isSuggested && 'border-primary/60',
                  )}
                  onClick={() => {
                    onChange(entry.label)
                  }}
                >
                  <span className="flex items-center gap-1 text-base font-medium">
                    {isSelected ? <Check className="size-4" /> : null}
                    {PRIZE_DIVISION_LABELS[entry.division]}
                  </span>

                  {isSuggested ? (
                    <span
                      className={cn(
                        'text-[0.625rem] uppercase tracking-[0.12em]',
                        isSelected ? 'text-primary-foreground/80' : 'text-primary',
                      )}
                    >
                      Suggested
                    </span>
                  ) : null}
                </Button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export default PrizeChooser
