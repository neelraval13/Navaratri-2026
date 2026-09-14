import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import type { IdentityMatch } from '@/components/registration/identity-match'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'

interface IdentityStatusProps {
  match: IdentityMatch
  /** How many registrations already use the same phone number. */
  existingRegistrationCount: number
}

/**
 * Whether this phone + name identity is already registered.
 *
 * A completed match is a hard duplicate and a held match already exists, so
 * both block progression. Resume is Phase 2C, so no Resume control is offered
 * here rather than showing one that does nothing.
 */
const IdentityStatus: React.FC<IdentityStatusProps> = ({
  match,
  existingRegistrationCount,
}) => {
  if (match.kind === 'completed') {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <CircleAlert className="size-4" />
          Already registered · Badge{' '}
          {formatBadgeNumber(match.registration.badgeNumber)}
        </p>

        <p className="mt-1 text-sm text-muted-foreground">
          {match.registration.name} already has a badge.
        </p>
      </div>
    )
  }

  if (match.kind === 'held') {
    const heldAt = formatEventDateTime(match.registration.heldAt)

    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-4" />
          Registration on hold
        </p>

        <p className="mt-1 text-sm text-muted-foreground">
          {match.registration.name}
          {heldAt === '' ? '' : ` · Held ${heldAt}`}
        </p>
      </div>
    )
  }

  if (match.kind === 'new') {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <CircleCheck className="size-4" />
          New attendee
        </p>

        {/*
          Sharing a phone number is still worth mentioning, but it is only
          supporting detail once the identity itself has resolved, so it stays
          neutral and muted rather than amber.
        */}
        {existingRegistrationCount > 0 ? (
          <p className="pl-6 text-sm text-muted-foreground">
            Shared phone number · {existingRegistrationCount}{' '}
            {existingRegistrationCount === 1
              ? 'existing attendee'
              : 'existing attendees'}
          </p>
        ) : null}
      </div>
    )
  }

  return null
}

export default IdentityStatus
