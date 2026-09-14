import { CircleAlert, CircleCheck } from 'lucide-react'
import type * as React from 'react'

import type { HoldNotice as HoldNoticeState } from '@/components/registration/types'

interface HoldNoticeProps {
  notice: HoldNoticeState
}

/**
 * Confirms the outcome of the last Hold so the operator is never left guessing.
 *
 * Success is amber because a hold is a held state, not a completed one, and it
 * says plainly that no badge was assigned.
 */
const HoldNotice: React.FC<HoldNoticeProps> = ({ notice }) => {
  if (notice.kind === 'error') {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <CircleAlert className="size-4" />
          {notice.message}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <CircleCheck className="size-4" />
        Registration held for {notice.name}.
      </p>

      <p className="mt-1 pl-6 text-sm text-muted-foreground">
        No badge assigned.
      </p>
    </div>
  )
}

export default HoldNotice
