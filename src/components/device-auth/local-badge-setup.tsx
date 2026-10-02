import { CircleAlert, CircleCheck, MonitorSmartphone, Ticket } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import type { AdoptionPlan } from '@/db/central-badge-range'
import { formatBadgeRange } from '@/db/device'
import type { CentralBadgeRangeBinding, EventConfig } from '@/db/types'
import { formatBadgeNumber } from '@/lib/badge'

interface LocalBadgeSetupProps {
  deviceName: string
  plan: AdoptionPlan
  config: EventConfig | undefined
  isBusy: boolean
  error: string | null
  onAdopt: (physicalStackConfirmed: boolean) => void
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
      {label}
    </p>

    <div className="mt-0.5 text-sm">
      {children}
    </div>
  </div>
)

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
          <Row label="Device">
            {deviceName}
          </Row>

          <Row label="Central assignment">
            <span className="font-heading text-lg font-semibold">
              {range}
            </span>
          </Row>

          <Row label="Badge count">
            {String(count)}
          </Row>

          <Row label={isAlignment ? 'Next badge stays' : 'Local next badge after setup'}>
            <span className="font-medium">
              {formatBadgeNumber(existingNextBadge ?? rangeStart)}
            </span>
          </Row>
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
  <Row label="Central binding">
    <span className="flex items-center gap-1.5 font-medium">
      <CircleCheck className="size-4" />
      Aligned with central assignment
    </span>

    <span className="mt-1 block text-xs text-muted-foreground">
      {formatBadgeRange(binding.rangeStart, binding.rangeEnd)}
    </span>
  </Row>
)

/**
 * This desk's LOCAL badge state, shown beside the central assignment.
 *
 * Deliberately its own section: the operator must never have to infer whether
 * this browser can issue badges from the fact that Postgres says it owns some.
 * Every blocked state says what is wrong and offers no override — a range
 * mismatch is a badge-uniqueness risk, not a preference.
 */
const LocalBadgeSetup: React.FC<LocalBadgeSetupProps> = ({
  deviceName,
  plan,
  config,
  isBusy,
  error,
  onAdopt,
}) => {
  const localRange =
    config?.badgeEnd === undefined
      ? null
      : formatBadgeRange(config.badgeStart, config.badgeEnd)

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Local Badge Setup
      </p>

      {plan.outcome === 'device-not-registered' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 font-semibold">
            <MonitorSmartphone className="size-5" />
            Local device setup required
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            This browser still needs its local device setup before a central
            badge range can be adopted in this transitional phase.
          </p>

          <Link
            href={ROUTES.deviceRegistration}
            className={buttonVariants({ variant: 'outline' })}
          >
            Set Up Local Device
          </Link>
        </div>
      ) : null}

      {plan.outcome === 'registration-not-permitted' ? (
        <div className="space-y-2">
          <p className="font-semibold">
            Not available
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            This device does not have Registration access, so it cannot hold a
            badge range. An administrator grants it.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'no-central-assignment' ? (
        <div className="space-y-2">
          <Row label="Central assignment">
            <span className="text-muted-foreground">
              Not assigned
            </span>
          </Row>

          <p className="text-sm leading-relaxed text-muted-foreground">
            An administrator assigns this device a badge range centrally. There
            is nothing to adopt yet.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'adoptable' ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Row label="Local badge range">
              <span className="text-muted-foreground">
                Not configured
              </span>
            </Row>

            <Row label="Central assignment">
              <span className="font-heading text-lg font-semibold">
                {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
              </span>
            </Row>
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
            <Row label="Local badge range">
              <span className="font-medium">
                {localRange}
              </span>
            </Row>

            <Row label="Central assignment">
              <span className="font-medium">
                {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
              </span>
            </Row>

            <Row label="Status">
              Ranges match
            </Row>

            <Row label="Next badge">
              <span className="font-medium">
                {formatBadgeNumber(plan.nextBadge)}
              </span>
            </Row>
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
          <Row label="Badge range">
            <span className="font-medium">
              {localRange}
            </span>
          </Row>

          <Row label="Next badge">
            <span className="font-medium">
              {config === undefined ? '' : formatBadgeNumber(config.nextBadge)}
            </span>
          </Row>

          <BindingProvenance binding={plan.binding} />
        </div>
      ) : null}

      {plan.outcome === 'range-conflict' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            Badge ranges do not match
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Row label="Central">
              <span className="font-medium">
                {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
              </span>
            </Row>

            <Row label="Local">
              <span className="font-medium">
                {formatBadgeRange(plan.local.rangeStart, plan.local.rangeEnd)}
              </span>
            </Row>
          </div>

          <p className="text-sm leading-relaxed text-muted-foreground">
            These ranges do not match. Automatic adoption is blocked to protect
            badge uniqueness. An administrator must reconcile them.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'incoherent-next-badge' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            Local badge counter needs attention
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            The local range matches the central assignment, but the next badge
            number sits outside it. Adoption is blocked rather than guessing a
            replacement, because a wrong counter reissues a physical badge.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'issued-badges-without-range' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            Badges already issued on this browser
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            {String(plan.issuedCount)} badge
            {plan.issuedCount === 1 ? ' has' : 's have'} been issued here with no
            configured range. Adopting now could reissue a badge already handed
            out, so it is blocked and needs reconciliation.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'binding-device-conflict' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            This badge range belongs to a different central device
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            The local range {formatBadgeRange(plan.binding.rangeStart, plan.binding.rangeEnd)}{' '}
            was adopted for another central device. It is never reassigned
            silently — an administrator must reconcile it.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'central-range-changed' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            Central assignment changed
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Row label="Adopted">
              <span className="font-medium">
                {formatBadgeRange(plan.binding.rangeStart, plan.binding.rangeEnd)}
              </span>
            </Row>

            <Row label="Central now">
              <span className="font-medium">
                {formatBadgeRange(plan.assignment.rangeStart, plan.assignment.rangeEnd)}
              </span>
            </Row>
          </div>

          <p className="text-sm leading-relaxed text-muted-foreground">
            The local range is left exactly as it is. Changing it here could
            reissue or orphan physical badges, so this needs reconciliation.
          </p>
        </div>
      ) : null}

      {plan.outcome === 'missing-config' ? (
        <p className="text-sm text-muted-foreground">
          Local storage is not ready. Reload and try again.
        </p>
      ) : null}
    </div>
  )
}

export default LocalBadgeSetup
