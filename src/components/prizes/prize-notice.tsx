import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import type * as React from 'react'

export type PrizeNoticeKind = 'success' | 'error' | 'info'

export interface PrizeNoticeState {
  kind: PrizeNoticeKind
  message: string
}

interface PrizeNoticeProps {
  notice: PrizeNoticeState
}

/**
 * The outcome of the last award attempt.
 *
 * Semantic colours only, per the design system: green for a prize that was
 * actually recorded, red for a refusal, amber for the one case that is
 * neither — another device got there first, which is ordinary operational
 * news rather than an error anyone did wrong.
 */
const PrizeNotice: React.FC<PrizeNoticeProps> = ({ notice }) => {
  if (notice.kind === 'success') {
    return (
      <div className="rounded-2xl border border-green-600/30 bg-green-600/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
          <CircleCheck className="size-4" />
          {notice.message}
        </p>
      </div>
    )
  }

  if (notice.kind === 'info') {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <Info className="size-4" />
          {notice.message}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <CircleAlert className="size-4" />
        {notice.message}
      </p>
    </div>
  )
}

export default PrizeNotice
