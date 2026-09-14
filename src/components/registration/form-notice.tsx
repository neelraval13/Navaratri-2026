import { CircleAlert, CircleCheck } from 'lucide-react'
import type * as React from 'react'

import type { FormNotice as FormNoticeState } from '@/components/registration/types'

interface FormNoticeProps {
  notice: FormNoticeState
}

/**
 * Reports the outcome of the last Hold or Issue Badge attempt, so the operator
 * is never left guessing whether a write succeeded.
 *
 * A successful hold is amber, not green: it is a held state, not a completed
 * one, and it says plainly that no badge was assigned. Badge issuance has its
 * own full completion screen, so only its failures appear here.
 */
const FormNotice: React.FC<FormNoticeProps> = ({ notice }) => {
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

export default FormNotice
