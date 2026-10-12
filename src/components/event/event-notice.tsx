import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import type * as React from 'react'

export type EventNoticeKind = 'success' | 'error' | 'info'

export interface EventNoticeState {
  kind: EventNoticeKind
  message: string
}

interface EventNoticeProps {
  notice: EventNoticeState
}

/**
 * The outcome of the last desk action.
 *
 * Semantic colours only, per the design system: green for something that
 * actually happened, red for a refusal, amber for the cases that are neither
 * — another device got there first, which is ordinary operational news rather
 * than an error anyone did wrong.
 *
 * SHARED, because every event desk needs the same three. Phase P1 wrote it
 * for prizes; Phase D3 moved it here rather than copying a colour map, since
 * the two would drift into saying the same thing differently.
 */
const EventNotice: React.FC<EventNoticeProps> = ({ notice }) => {
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

export default EventNotice
