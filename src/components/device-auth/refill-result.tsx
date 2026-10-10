import { CircleAlert, CircleCheck, RotateCcw, TriangleAlert } from 'lucide-react'
import type * as React from 'react'

import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { Button } from '@/components/ui/button'
import { formatBadgeRange } from '@/db/device'
import type { BadgeRefillFlowResult } from '@/device-auth/badge-refill'
import type { OfflineLeaseOutcome } from '@/device-auth/offline-lease'

interface RefillResultProps {
  result: BadgeRefillFlowResult
  /** What became of the lease the server re-issued for the new range. */
  offline: OfflineLeaseOutcome
  onRefresh: () => void
}

/**
 * What happened to the last badge refill.
 *
 * Rendered BESIDE the refill form rather than inside it, because a successful
 * extension changes what the form shows and a half-finished one moves the
 * page onto the recovery view. This report has to survive either move — it is
 * the only thing telling the operator that central ownership grew.
 *
 * OFFLINE READINESS IS REPORTED SEPARATELY from the range. The extension can
 * be entirely successful while the re-issued signed lease fails to verify, and
 * calling that "done" would leave a desk believing it can work through an
 * outage it cannot.
 */
const RefillResult: React.FC<RefillResultProps> = ({ result, offline, onRefresh }) => {
  if (result.outcome === 'refilled') {
    const range = formatBadgeRange(
      result.activeBadgeRange.rangeStart,
      result.activeBadgeRange.rangeEnd,
    )

    /**
     * `not-configured` is not a failure: a deployment with no offline signing
     * key never had a lease to refresh, and saying otherwise would report a
     * missing feature as a broken one.
     */
    const offlineReady = offline.status === 'cached' || offline.status === 'not-configured'

    return (
      <div className="space-y-3 rounded-2xl border border-border p-4">
        <p className="flex items-center gap-2 font-semibold">
          <CircleCheck className="size-5 text-emerald-700 dark:text-emerald-400" />
          Badge range now {range}
        </p>

        {offlineReady ? null : (
          <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            The range is extended, but offline authorization for the new badges
            could not be verified on this browser. It still needs an online
            refresh before this desk works through a network outage.
          </p>
        )}
      </div>
    )
  }

  /**
   * THE DISTRIBUTED FAILURE. Central ownership is REAL and local state did
   * not follow. It is never rolled back, and reporting it as a failure would
   * be a lie the operator acts on.
   */
  if (result.outcome === 'refilled-not-extended') {
    return (
      <div className="space-y-3 rounded-2xl border border-destructive/40 p-4">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <TriangleAlert className="size-5" />
          Central badge range was extended, but this browser could not finish
          local setup
        </p>

        <BadgeStateRow label="Central assignment">
          <span className="font-medium">
            {formatBadgeRange(
              result.activeBadgeRange.rangeStart,
              result.activeBadgeRange.rangeEnd,
            )}
          </span>
        </BadgeStateRow>

        <p className="text-sm leading-relaxed">
          Refresh Device Status before issuing badges. The extra numbers are
          already recorded centrally, and the refresh offers to finish the
          local half safely.
        </p>

        <Button type="button" variant="outline" onClick={onRefresh}>
          <RotateCcw data-icon="inline-start" />
          Refresh Device Status
        </Button>
      </div>
    )
  }

  /**
   * AMBIGUOUS. The request may have committed with the response lost, so this
   * is never reported as a refusal and nothing is retried automatically.
   */
  if (result.outcome === 'unconfirmed') {
    return (
      <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <CircleAlert className="size-4" />
          {result.message}
        </p>

        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
          <RotateCcw data-icon="inline-start" />
          Refresh Device Status
        </Button>
      </div>
    )
  }

  if (result.outcome === 'preflight-blocked') {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        This browser&rsquo;s badge state could not safely be extended, so
        nothing was requested. See the badge status above.
      </p>
    )
  }

  /**
   * A refusal. Nothing changed anywhere, and the last badge the operator
   * typed is named back to them — it is their own input, so showing it
   * reveals nothing about the registry.
   */
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        {result.message}
      </p>

      {result.activeBadgeRange === null ? null : (
        <BadgeStateRow label="This device currently owns">
          <span className="font-medium">
            {formatBadgeRange(
              result.activeBadgeRange.rangeStart,
              result.activeBadgeRange.rangeEnd,
            )}
          </span>
        </BadgeStateRow>
      )}
    </div>
  )
}

export default RefillResult
