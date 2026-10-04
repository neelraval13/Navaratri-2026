import { MonitorSmartphone, ShieldAlert } from 'lucide-react'
import type * as React from 'react'

import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { formatBadgeRange } from '@/db/device'
import type { BadgeSafetyConflict, GrantBadgeRange } from '@/device-auth/event-authorization'

interface BadgeOwnershipBlockProps {
  conflict: BadgeSafetyConflict
  central: GrantBadgeRange | null
  local: { rangeStart: number; rangeEnd: number } | null
}

/**
 * Why each disagreement is dangerous, in the operator's terms. Never "error",
 * never a code — the person reading this has to decide what to do with a
 * stack of physical badges.
 */
const EXPLANATION: Record<BadgeSafetyConflict, string> = {
  'enrollment-device-mismatch':
    'This browser is signed in as one central device but enrolled as another. Resolve the identity before registering anyone.',
  'enrollment-event-mismatch':
    'This browser is enrolled for a different event than the one it is signed in to.',
  'binding-missing':
    'This device has a central badge assignment that has never been set up here.',
  'binding-device-mismatch':
    'The badge range on this browser was set up for a different central device.',
  'binding-event-mismatch':
    'The badge range on this browser was set up for a different event.',
  'binding-range-mismatch':
    'The badge range this browser recorded is not the range this device is centrally assigned.',
  'binding-assigned-at-mismatch':
    'The central badge assignment has been reissued since this browser set it up.',
  'local-range-missing':
    'This device is centrally assigned a badge range that this browser does not have.',
  'local-range-mismatch':
    'This device’s local badge setup does not match its central assignment.',
  'local-range-incoherent':
    'This browser’s badge range and its next badge number do not agree.',
  'central-range-missing':
    'This browser holds a badge range that is no longer centrally assigned to this device.',
}

/**
 * `binding-missing` is the ONE state here that is ordinary setup rather than
 * a disagreement: central has assigned a range this browser has simply never
 * adopted. It is still a hard refusal with no override — adopting a range is
 * a physically confirmed act and nothing here can see the badge stack — but
 * reporting it in the language of a ledger conflict would send someone
 * hunting for a problem that does not exist.
 */
const SETUP_REQUIRED: readonly BadgeSafetyConflict[] = ['binding-missing']

/**
 * The hard stop. Badge registration is closed and NOTHING here opens it.
 *
 * There is deliberately no Continue, no Override and no credential of any
 * kind — since Phase D2 there is not even one to offer. Two desks holding the
 * same physical badge numbers is not a problem an identity can solve, so the
 * only way out is a human reconciling the ledger.
 */
const BadgeOwnershipBlock: React.FC<BadgeOwnershipBlockProps> = ({
  conflict,
  central,
  local,
}) => SETUP_REQUIRED.includes(conflict) ? (
  <Card>
    <CardContent className="space-y-4">
      <p className="flex items-center gap-2 font-heading text-xl font-semibold">
        <MonitorSmartphone className="size-5 text-muted-foreground" />
        Badge setup required
      </p>

      <p className="text-sm leading-relaxed text-muted-foreground">
        The central Device is verified, but this browser has not adopted its
        assigned badge range
        {central === null
          ? ''
          : ` (${formatBadgeRange(central.rangeStart, central.rangeEnd)})`}
        . Confirm the physical badges are at this desk and adopt the range at
        Device Sign-In.
      </p>

      <Link
        href={ROUTES.deviceLogin}
        className={buttonVariants({ className: 'h-12 w-full sm:w-auto sm:min-w-52' })}
      >
        Open Device Sign-In
      </Link>
    </CardContent>
  </Card>
) : (
  <Card>
    <CardContent className="space-y-5">
      <p className="flex items-center gap-2 font-heading text-xl font-semibold text-destructive">
        <ShieldAlert className="size-6" />
        Badge registration blocked
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Central assignment
          </p>

          <p className="mt-0.5 font-heading text-lg font-semibold">
            {central === null
              ? 'Not assigned'
              : formatBadgeRange(central.rangeStart, central.rangeEnd)}
          </p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Local range
          </p>

          <p className="mt-0.5 font-heading text-lg font-semibold">
            {local === null
              ? 'Not configured'
              : formatBadgeRange(local.rangeStart, local.rangeEnd)}
          </p>
        </div>
      </div>

      <p className="text-sm leading-relaxed">
        {EXPLANATION[conflict]} Badge registration is blocked to protect badge
        uniqueness.
      </p>

      <p className="text-sm leading-relaxed text-muted-foreground">
        There is no override for this. Two desks holding the same physical
        badge numbers would hand the same badge to two people, and no
        credential or sign-in changes that.
      </p>

      <div>
        <Link
          href={ROUTES.deviceLogin}
          className={buttonVariants({ variant: 'outline' })}
        >
          Open Device Sign-In
        </Link>
      </div>
    </CardContent>
  </Card>
)

export default BadgeOwnershipBlock
