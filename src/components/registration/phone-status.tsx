import {
  CircleAlert,
  CircleCheck,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import type { RegistrationRecord } from '@/db/types'
import type { PhoneLookupStatus } from '@/hooks/use-phone-lookup'
import { formatBadgeNumber } from '@/lib/badge'

interface PhoneStatusProps {
  status: PhoneLookupStatus
  registrations: RegistrationRecord[]
  onRetry: () => void
}

/**
 * "Aarav Sharma · Held" or "Rahul Sharma · Badge #042". Internal ids are never
 * shown to the operator.
 */
const describeRegistration = (registration: RegistrationRecord): string => {
  if (registration.status === 'completed') {
    return `${registration.name} · Badge ${formatBadgeNumber(registration.badgeNumber)}`
  }

  return `${registration.name} · Held`
}

/**
 * Phone usage for the current 10-digit number.
 *
 * A shared family phone number is expected and allowed, so reuse is amber and
 * informational — never an error. This says nothing about WhatsApp.
 */
const PhoneStatus: React.FC<PhoneStatusProps> = ({
  status,
  registrations,
  onRetry,
}) => {
  if (status === 'idle') {
    return null
  }

  if (status === 'checking') {
    return (
      <p className="text-sm text-muted-foreground">
        Checking registrations…
      </p>
    )
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <CircleAlert className="size-4" />
          Unable to check existing registrations.
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
        >
          <RotateCcw data-icon="inline-start" />
          Retry
        </Button>
      </div>
    )
  }

  if (registrations.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
        <CircleCheck className="size-4" />
        New number
      </p>
    )
  }

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-4" />
        Used by {registrations.length}{' '}
        {registrations.length === 1 ? 'attendee' : 'attendees'}
      </p>

      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {registrations.map((registration) => (
          <li key={registration.id}>
            {describeRegistration(registration)}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default PhoneStatus
