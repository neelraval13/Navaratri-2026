import { CircleAlert, MonitorSmartphone } from 'lucide-react'
import type * as React from 'react'

import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { buttonVariants } from '@/components/ui/button'
import type { AdoptionPlan } from '@/db/central-badge-range'
import { formatBadgeRange } from '@/db/device'

interface AdoptionBlockProps {
  plan: AdoptionPlan
}

/**
 * Every state in which this browser may NOT take on a central badge range.
 *
 * One rendering, used by both the adoption section and the self-claim
 * section, because the refusals are the same refusals — the claim planner
 * produces them by asking the adoption planner. Each one says what is wrong
 * and offers no override: a range mismatch is a badge-uniqueness risk, not a
 * preference, and nothing here can tell which numbers are physically present.
 */
const AdoptionBlock: React.FC<AdoptionBlockProps> = ({ plan }) => {
  if (plan.outcome === 'device-not-registered') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold">
          <MonitorSmartphone className="size-5" />
          Local device setup required
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          This browser still needs its local device setup before a central
          badge range can be used here in this transitional phase.
        </p>

        <Link
          href={ROUTES.deviceRegistration}
          className={buttonVariants({ variant: 'outline' })}
        >
          Set Up Local Device
        </Link>
      </div>
    )
  }

  if (plan.outcome === 'registration-not-permitted') {
    return (
      <div className="space-y-2">
        <p className="font-semibold">
          Not available
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          This device does not have Registration access, so it cannot hold a
          badge range. An administrator grants it.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'range-conflict') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Badge ranges do not match
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Central">
            <span className="font-medium">
              {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Local">
            <span className="font-medium">
              {formatBadgeRange(plan.local.rangeStart, plan.local.rangeEnd)}
            </span>
          </BadgeStateRow>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          These ranges do not match. Automatic adoption is blocked to protect
          badge uniqueness. An administrator must reconcile them.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'incoherent-next-badge') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Local badge counter needs attention
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          This browser&rsquo;s badge range and its next badge number do not
          agree. Setting up a range here is blocked rather than guessing a
          replacement, because a wrong counter reissues a physical badge.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'issued-badges-without-range') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Badges already issued on this browser
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          This browser has issued {String(plan.issuedCount)} badge
          {plan.issuedCount === 1 ? '' : 's'} but has no coherent local range.
          Automatic central claiming is blocked, because continuing could
          reissue a badge already handed out.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'binding-device-conflict') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          This badge range belongs to a different central device
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          The local range{' '}
          {formatBadgeRange(plan.binding.rangeStart, plan.binding.rangeEnd)} was
          adopted for another central device. It is never reassigned silently —
          an administrator must reconcile it.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'central-range-changed') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Central assignment changed
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Adopted">
            <span className="font-medium">
              {formatBadgeRange(plan.binding.rangeStart, plan.binding.rangeEnd)}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Central now">
            <span className="font-medium">
              {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
            </span>
          </BadgeStateRow>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          The local range is left exactly as it is. Changing it here could
          reissue or orphan physical badges, so this needs reconciliation.
        </p>
      </div>
    )
  }

  if (plan.outcome === 'missing-config') {
    return (
      <p className="text-sm text-muted-foreground">
        Local storage is not ready. Reload and try again.
      </p>
    )
  }

  /**
   * `adoptable`, `alignable`, `already-adopted` and `no-central-assignment`
   * are not refusals and are rendered by their own sections. Nothing is shown
   * rather than inventing a message for a state that is not a problem.
   */
  return null
}

export default AdoptionBlock
