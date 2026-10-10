import { CircleAlert, CircleCheck, Ticket } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import AdoptionBlock from '@/components/device-auth/adoption-block'
import BadgeRangeClaim from '@/components/device-auth/badge-range-claim'
import BadgeRefill from '@/components/device-auth/badge-refill'
import BadgeStateRow from '@/components/device-auth/badge-state-row'
import ClaimResult from '@/components/device-auth/claim-result'
import RefillResult from '@/components/device-auth/refill-result'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import type { AdoptionPlan, ClaimPlan, RefillPlan } from '@/db/central-badge-range'
import { formatBadgeRange } from '@/db/device'
import type { CentralBadgeRangeBinding, EventConfig } from '@/db/types'
import type { BadgeClaimFlowResult } from '@/device-auth/badge-claim'
import type { BadgeRefillFlowResult } from '@/device-auth/badge-refill'
import type { OfflineLeaseOutcome } from '@/device-auth/offline-lease'
import { formatBadgeNumber } from '@/lib/badge'

interface LocalBadgeSetupProps {
  deviceName: string
  plan: AdoptionPlan
  claimPlan: ClaimPlan
  refillPlan: RefillPlan
  claimResult: BadgeClaimFlowResult | null
  refillResult: BadgeRefillFlowResult | null
  /** What became of the lease, for reporting offline readiness after a refill. */
  offline: OfflineLeaseOutcome
  config: EventConfig | undefined
  isBusy: boolean
  error: string | null
  onAdopt: (physicalStackConfirmed: boolean) => void
  onClaim: (input: {
    rangeStart: number
    rangeEnd: number
    physicalStackConfirmed: boolean
  }) => void
  onRefill: (input: { newRangeEnd: number; physicalStackConfirmed: boolean }) => void
  onFinishExtension: () => void
  onRangeEdited: () => void
  onRefresh: () => void
}

/**
 * The confirmation an operator must give before this browser starts issuing
 * physical badges.
 *
 * The central assignment proves this device OWNS the numbers. It cannot prove
 * the badges are on the table, and only the person standing at the desk can.
 * The action stays unavailable until they say so.
 */
const AdoptDialog: React.FC<{
  deviceName: string
  rangeStart: number
  rangeEnd: number
  /** Present for an alignment: the counter that must survive it. */
  existingNextBadge?: number
  isBusy: boolean
  error: string | null
  onAdopt: (physicalStackConfirmed: boolean) => void
}> = ({ deviceName, rangeStart, rangeEnd, existingNextBadge, isBusy, error, onAdopt }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const range = formatBadgeRange(rangeStart, rangeEnd)
  const count = rangeEnd - rangeStart + 1
  const isAlignment = existingNextBadge !== undefined

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        setIsOpen(open)
        // The confirmation never persists across openings: it is a statement
        // about the stack right now, not a setting.
        setConfirmed(false)
      }}
    >
      <DialogTrigger
        render={
          <Button type="button">
            <Ticket data-icon="inline-start" />
            {isAlignment ? 'Link Existing Range To Central Assignment' : `Set Up ${range} On This Device`}
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isAlignment ? 'Link Existing Badge Range' : 'Adopt Badge Range'}
          </DialogTitle>

          <DialogDescription>
            {isAlignment
              ? 'This desk already issues from this exact range. Linking records where it came from and changes nothing else.'
              : 'This browser will issue these physical badges locally.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Device">
            {deviceName}
          </BadgeStateRow>

          <BadgeStateRow label="Central assignment">
            <span className="font-heading text-lg font-semibold">
              {range}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Badge count">
            {String(count)}
          </BadgeStateRow>

          <BadgeStateRow label={isAlignment ? 'Next badge stays' : 'Local next badge after setup'}>
            <span className="font-medium">
              {formatBadgeNumber(existingNextBadge ?? rangeStart)}
            </span>
          </BadgeStateRow>
        </div>

        <Label
          htmlFor="adopt-physical-stack"
          className="flex items-start gap-3 font-normal"
        >
          <input
            id="adopt-physical-stack"
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked)
            }}
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />

          <span className="text-sm leading-relaxed">
            I have physical badges {range} at this device.
          </span>
        </Label>

        <p className="text-xs leading-relaxed text-muted-foreground">
          After adoption, this browser will issue badges from this range locally,
          including while offline.
        </p>

        {error === null ? null : (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        <Button
          type="button"
          /* No valid action exists until the stack is confirmed. */
          disabled={!confirmed || isBusy}
          onClick={() => {
            onAdopt(confirmed)
          }}
          className="h-12 w-full sm:w-auto sm:min-w-52"
        >
          {isBusy ? 'Setting up…' : isAlignment ? `Link ${range}` : `Adopt ${range}`}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

const BindingProvenance: React.FC<{ binding: CentralBadgeRangeBinding }> = ({
  binding,
}) => (
  <BadgeStateRow label="Central binding">
    <span className="flex items-center gap-1.5 font-medium">
      <CircleCheck className="size-4" />
      Aligned with central assignment
    </span>

    <span className="mt-1 block text-xs text-muted-foreground">
      {formatBadgeRange(binding.rangeStart, binding.rangeEnd)}
    </span>
  </BadgeStateRow>
)

/**
 * This desk's LOCAL badge state, shown beside the central assignment.
 *
 * Deliberately its own section: the operator must never have to infer whether
 * this browser can issue badges from the fact that Postgres says it owns some.
 * Every blocked state says what is wrong and offers no override — a range
 * mismatch is a badge-uniqueness risk, not a preference.
 *
 * When central reports NO assignment the section becomes the self-claim
 * surface instead, because that is the one situation a device can resolve by
 * itself while online.
 */
const LocalBadgeSetup: React.FC<LocalBadgeSetupProps> = ({
  deviceName,
  plan,
  claimPlan,
  refillPlan,
  claimResult,
  refillResult,
  offline,
  config,
  isBusy,
  error,
  onAdopt,
  onClaim,
  onRefill,
  onFinishExtension,
  onRangeEdited,
  onRefresh,
}) => {
  const localRange =
    config?.badgeEnd === undefined
      ? null
      : formatBadgeRange(config.badgeStart, config.badgeEnd)

  /**
   * A refill whose central half committed and whose local half did not makes
   * the adoption planner report `central-range-changed` — correctly, since
   * the two ranges differ, but as an unreconcilable conflict. The refill
   * section explains the same facts and offers the safe recovery, so the
   * harder block is suppressed rather than stacked on top of it.
   *
   * Only for THIS exact shape. Every other disagreement keeps its block.
   */
  const isPendingExtension = refillPlan.outcome === 'extension-pending'

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Local Badge Setup
      </p>

      {plan.outcome === 'no-central-assignment' ? (
        <BadgeRangeClaim
          plan={claimPlan}
          isBusy={isBusy}
          onClaim={onClaim}
          onRangeEdited={onRangeEdited}
        />
      ) : null}

      {plan.outcome === 'adoptable' ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <BadgeStateRow label="Local badge range">
              <span className="text-muted-foreground">
                Not configured
              </span>
            </BadgeStateRow>

            <BadgeStateRow label="Central assignment">
              <span className="font-heading text-lg font-semibold">
                {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
              </span>
            </BadgeStateRow>
          </div>

          <p className="text-sm leading-relaxed">
            This browser can adopt the central assignment for offline badge
            issuance.
          </p>

          <AdoptDialog
            deviceName={deviceName}
            rangeStart={plan.assignment.rangeStart}
            rangeEnd={plan.assignment.rangeEnd}
            isBusy={isBusy}
            error={error}
            onAdopt={onAdopt}
          />
        </div>
      ) : null}

      {plan.outcome === 'alignable' ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <BadgeStateRow label="Local badge range">
              <span className="font-medium">
                {localRange}
              </span>
            </BadgeStateRow>

            <BadgeStateRow label="Central assignment">
              <span className="font-medium">
                {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
              </span>
            </BadgeStateRow>

            <BadgeStateRow label="Status">
              Ranges match
            </BadgeStateRow>

            <BadgeStateRow label="Next badge">
              <span className="font-medium">
                {formatBadgeNumber(plan.nextBadge)}
              </span>
            </BadgeStateRow>
          </div>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Linking records that this range came from the central assignment. The
            next badge stays where it is.
          </p>

          <AdoptDialog
            deviceName={deviceName}
            rangeStart={plan.assignment.rangeStart}
            rangeEnd={plan.assignment.rangeEnd}
            existingNextBadge={plan.nextBadge}
            isBusy={isBusy}
            error={error}
            onAdopt={onAdopt}
          />
        </div>
      ) : null}

      {plan.outcome === 'already-adopted' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <BadgeStateRow label="Badge range">
            <span className="font-medium">
              {localRange}
            </span>
          </BadgeStateRow>

          <BadgeStateRow label="Next badge">
            <span className="font-medium">
              {config === undefined ? '' : formatBadgeNumber(config.nextBadge)}
            </span>
          </BadgeStateRow>

          <BindingProvenance binding={plan.binding} />
        </div>
      ) : null}

      {/*
        Adding more physical badges to a range this desk already owns, and
        finishing an extension whose central half is already real.
      */}
      <BadgeRefill
        plan={refillPlan}
        isBusy={isBusy}
        onRefill={onRefill}
        onFinishExtension={onFinishExtension}
        onRangeEdited={onRangeEdited}
      />

      {/* Every refusal, rendered once, shared with the self-claim section. */}
      {isPendingExtension ? null : <AdoptionBlock plan={plan} />}

      {/*
        Outside the claim form on purpose. A successful reservation moves this
        section onto the adoption view, and the report of what just happened —
        above all "central claimed, local setup failed" — has to survive that
        move rather than disappear with the form that triggered it.
      */}
      {claimResult === null ? null : (
        <ClaimResult result={claimResult} onRefresh={onRefresh} />
      )}

      {refillResult === null ? null : (
        <RefillResult result={refillResult} offline={offline} onRefresh={onRefresh} />
      )}
    </div>
  )
}

export default LocalBadgeSetup
