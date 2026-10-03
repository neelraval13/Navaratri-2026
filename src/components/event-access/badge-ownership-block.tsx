import { ShieldAlert } from 'lucide-react'
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
 * The hard stop. Badge registration is closed and NOTHING here opens it.
 *
 * There is deliberately no Continue, no Override and no Operator Access
 * button. The operator code authorizes a person at a browser; it cannot make
 * two desks owning the same physical badge numbers safe, so offering it would
 * be offering the wrong instrument for the actual problem.
 */
const BadgeOwnershipBlock: React.FC<BadgeOwnershipBlockProps> = ({
  conflict,
  central,
  local,
}) => (
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
        This cannot be unlocked with an operator code. Two desks holding the
        same physical badge numbers would hand the same badge to two people,
        and no credential changes that.
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
