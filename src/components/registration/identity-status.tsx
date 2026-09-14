import { CircleAlert, CircleCheck, Play, TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import type { IdentityMatch } from '@/components/registration/identity-match'
import { Button } from '@/components/ui/button'
import {
  isCompletedRegistration,
  type HeldRegistration,
  type RegistrationRecord,
} from '@/db/types'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'

interface IdentityStatusProps {
  match: IdentityMatch
  /** How many registrations already use the same phone number. */
  existingRegistrationCount: number
  /** True from Resume until Clear, a successful Hold, or another reset. */
  isEditingHeldRegistration: boolean
  /** The DIFFERENT held/completed record this identity collides with, if any. */
  otherRegistrationConflict: RegistrationRecord | null
  onResume: (registration: HeldRegistration) => void
}

/**
 * Who this attendee is, relative to what is already stored.
 *
 * Priority, highest first:
 *
 * 1. a conflict with ANOTHER registration — completed is a hard duplicate, held
 *    offers Resume for THAT record instead of a second registration. This comes
 *    from the full phone result set, so a second held record for one identity
 *    cannot hide behind the active one.
 * 2. editing a resumed held registration — true even once the operator has
 *    corrected the phone or name, because re-holding still updates that row
 * 3. a plain new attendee
 *
 * The same two flags drive progression in RegistrationForm, so what is shown
 * and what Next allows cannot drift apart.
 */
const IdentityStatus: React.FC<IdentityStatusProps> = ({
  match,
  existingRegistrationCount,
  isEditingHeldRegistration,
  otherRegistrationConflict,
  onResume,
}) => {
  if (
    otherRegistrationConflict !== null &&
    isCompletedRegistration(otherRegistrationConflict)
  ) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <CircleAlert className="size-4" />
          Already registered · Badge{' '}
          {formatBadgeNumber(otherRegistrationConflict.badgeNumber)}
        </p>

        <p className="mt-1 text-sm text-muted-foreground">
          {otherRegistrationConflict.name} already has a badge.
        </p>
      </div>
    )
  }

  if (otherRegistrationConflict !== null) {
    const registration = otherRegistrationConflict
    const heldAt = formatEventDateTime(registration.heldAt)

    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-4" />
          Registration on hold
        </p>

        <p className="mt-1 text-sm text-muted-foreground">
          {registration.name}
          {heldAt === '' ? '' : ` · Held ${heldAt}`}
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => onResume(registration)}
        >
          <Play data-icon="inline-start" />
          Resume Registration
        </Button>
      </div>
    )
  }

  if (isEditingHeldRegistration) {
    // No conflict here, so a held match can only be the record being edited.
    const ownRecord = match.kind === 'held' ? match.registration : null
    const heldAt = ownRecord === null ? '' : formatEventDateTime(ownRecord.heldAt)

    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-4" />
          Editing held registration
        </p>

        <p className="mt-1 text-sm text-muted-foreground">
          {ownRecord === null
            ? 'Holding again updates this saved registration.'
            : `${ownRecord.name}${heldAt === '' ? '' : ` · Held ${heldAt}`}`}
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
