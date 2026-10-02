import { CircleAlert, RotateCcw, TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import AdoptionBlock from '@/components/device-auth/adoption-block'
import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { Button } from '@/components/ui/button'
import { formatBadgeRange } from '@/db/device'
import type { BadgeClaimFlowResult } from '@/device-auth/badge-claim'

interface ClaimResultProps {
  result: BadgeClaimFlowResult
  onRefresh: () => void
}

/**
 * What happened to the last badge-range claim.
 *
 * Rendered BESIDE the badge sections rather than inside the claim form, because
 * a successful reservation changes which section the page shows. A claim that
 * succeeded centrally and failed locally moves the page onto the ordinary
 * adoption or conflict view, and this report has to survive that move — it is
 * the only thing telling the operator that central ownership is real.
 *
 * The two distributed-failure states get the most room on purpose. Showing
 * "failed" for either of them would be a lie an operator acts on.
 */
const ClaimResult: React.FC<ClaimResultProps> = ({ result, onRefresh }) => {
  if (result.outcome === 'claimed') {
    return null
  }

  if (result.outcome === 'claimed-not-adopted') {
    return (
      <div className="space-y-3 rounded-2xl border border-destructive/40 p-4">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <TriangleAlert className="size-5" />
          Central range claimed, but local setup could not be completed
        </p>

        <BadgeStateRow label="Central assignment">
          <span className="font-medium">
            {formatBadgeRange(
              result.activeBadgeRange.rangeStart,
              result.activeBadgeRange.rangeEnd,
            )}
          </span>
        </BadgeStateRow>

        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Local state
          </p>

          <div className="mt-1">
            {result.plan === null ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Local setup was not completed.
              </p>
            ) : (
              <AdoptionBlock plan={result.plan} />
            )}
          </div>
        </div>

        <p className="text-sm leading-relaxed text-destructive">
          Do not issue badges from this device until the conflict is
          reconciled. The central assignment is real and has NOT been released.
        </p>
      </div>
    )
  }

  if (result.outcome === 'unconfirmed') {
    return (
      <div className="space-y-3 rounded-2xl border border-border p-4">
        <p className="flex items-center gap-2 font-semibold">
          <CircleAlert className="size-5" />
          Claim status could not be confirmed
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          {result.message} The reservation may already have been recorded
          centrally, so nothing was changed locally and nothing was retried.
        </p>

        <Button type="button" variant="outline" className="h-12" onClick={onRefresh}>
          <RotateCcw data-icon="inline-start" />
          Refresh Device Status
        </Button>
      </div>
    )
  }

  if (result.outcome === 'preflight-blocked') {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-destructive">
          Nothing was claimed centrally. This browser could not safely use that
          range:
        </p>

        <AdoptionBlock plan={result.plan} />
      </div>
    )
  }

  /**
   * An overlapping range is an ORDINARY operational conflict, not a technical
   * error: somebody else's badges carry those numbers. It names the range the
   * operator typed — their own input — and never which device holds it, which
   * would leak the registry to answer a question about a stack of card.
   */
  if (result.reason === 'range-overlap') {
    const range = formatBadgeRange(
      result.requested.rangeStart,
      result.requested.rangeEnd,
    )

    return (
      <div className="space-y-2 rounded-2xl border border-destructive/40 p-4">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Badge range already assigned
        </p>

        <p className="text-sm leading-relaxed">
          Badges {range} overlap a range already assigned to another device.
          Check the physical badge stack at this desk and enter a different
          range.
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Nothing was changed on this device.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        {result.message}
      </p>

      {/*
        Labelled as the EXISTING assignment: this range was already there, and
        the claim section above still reports central as unassigned until the
        operator refreshes. Two rows reading "Central assignment" with
        different answers would be the page arguing with itself.
      */}
      {result.activeBadgeRange === null ? null : (
        <BadgeStateRow label="Existing central assignment">
          <span className="font-medium">
            {formatBadgeRange(
              result.activeBadgeRange.rangeStart,
              result.activeBadgeRange.rangeEnd,
            )}
          </span>
        </BadgeStateRow>
      )}

      {/*
        Three refusals mean CENTRAL STATE MOVED while this form was open: the
        device gained a range, lost Registration, or lost its session. Each is
        resolved by re-reading the server, never by trying the claim again.
      */}
      {result.reason === 'already-assigned' ||
      result.reason === 'registration-required' ||
      result.reason === 'unauthenticated' ? (
        <Button type="button" variant="outline" className="h-12" onClick={onRefresh}>
          <RotateCcw data-icon="inline-start" />
          Refresh Device Status
        </Button>
      ) : null}
    </div>
  )
}

export default ClaimResult
