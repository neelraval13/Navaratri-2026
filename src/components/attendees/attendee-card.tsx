import type * as React from 'react'

import { formatBadgeNumber } from '@/lib/badge'
import type { EventAttendee } from '@/shared/attendee-contract'

interface AttendeeCardProps {
  attendee: EventAttendee
}

const GENDER_LABEL = { male: 'Male', female: 'Female' } as const

/**
 * One registered attendee, read-only.
 *
 * IT HAS NO ACTION AT ALL — no Give Prize, no edit, no delete, no badge
 * control, and no handler of any kind. The component takes ONE prop, so there
 * is nothing to call: the directory cannot change an attendee because nothing
 * here is capable of asking.
 *
 * It shows the three things a viewer needs and NOTHING MORE: the badge, the
 * name, and the age and gender. No phone number, no WhatsApp link, no payment
 * method, no amount, no registration id, no device id and no prize history —
 * several of those are not even read from the Sheet, and the rest are not this
 * screen's business.
 *
 * (The prize desk's own card lives at `src/components/prizes/attendee-card.tsx`
 * and is a different component: it carries prize state and an award action.)
 *
 * THE BADGE NUMBER DOMINATES, for the same reason it does on the registration
 * form header: somebody is being matched against a card in their hand, and
 * the name is how that is confirmed rather than how they are found.
 */
const AttendeeCard: React.FC<AttendeeCardProps> = ({ attendee }) => {
  return (
    <div className="space-y-0.5 rounded-2xl border border-border bg-card p-4">
      <p className="font-heading text-2xl font-semibold tracking-tight">
        {formatBadgeNumber(attendee.badgeNumber)}
      </p>

      <p className="truncate text-base font-medium" title={attendee.name}>
        {attendee.name}
      </p>

      <p className="text-sm text-muted-foreground">
        {`Age ${String(attendee.age)} · ${GENDER_LABEL[attendee.gender]}`}
      </p>
    </div>
  )
}

export default AttendeeCard
