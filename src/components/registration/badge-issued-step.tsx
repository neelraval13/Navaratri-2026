import { CircleCheck } from 'lucide-react'
import type * as React from 'react'

import type { CompletedRegistration } from '@/db/types'
import { formatBadgeNumber } from '@/lib/badge'

const PAYMENT_METHOD_LABELS = {
  upi: 'UPI',
  cash: 'Cash',
} as const

interface BadgeIssuedStepProps {
  registration: CompletedRegistration
}

/**
 * The completion state, shown in place of the two-step form once a badge has
 * actually been allocated.
 *
 * Its whole job is to leave no ambiguity about which physical badge to hand
 * over, so the number is the dominant element and the attendee is named right
 * beneath it. The draft is deliberately NOT cleared until the operator chooses
 * Next Person.
 */
const BadgeIssuedStep: React.FC<BadgeIssuedStepProps> = ({ registration }) => {
  return (
    <div className="space-y-6">
      <p className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">
        <CircleCheck className="size-4" />
        Registration complete
      </p>

      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-6 py-8 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-400">
          Give badge
        </p>

        <p className="mt-2 text-6xl font-bold leading-none tracking-tight text-emerald-700 sm:text-7xl dark:text-emerald-400">
          {formatBadgeNumber(registration.badgeNumber)}
        </p>

        <p className="mt-6 text-sm text-muted-foreground">
          to
        </p>

        <p className="mt-1 text-2xl font-semibold">
          {registration.name}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-muted/30 px-5 py-4 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Payment
        </p>

        <p className="mt-1 font-semibold">
          ₹{registration.amount} via{' '}
          {PAYMENT_METHOD_LABELS[registration.paymentMethod]}
        </p>
      </div>
    </div>
  )
}

export default BadgeIssuedStep
