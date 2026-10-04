import { ArrowRight, CircleAlert, CircleCheck, MonitorSmartphone } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type {
  ConvergenceConflict,
  ConvergencePlan,
} from '@/db/device-identity-convergence'
import type { ConvergenceFlowResult } from '@/device-auth/identity-convergence'

interface DeviceIdentitySectionProps {
  plan: ConvergencePlan | null
  result: ConvergenceFlowResult | null
  isBusy: boolean
  /** Offline: the identity is shown read-only and nothing may be migrated. */
  isOffline: boolean
  onConverge: () => void
}

/** Why each disagreement blocks a migration, in the operator's terms. */
const CONFLICT: Record<ConvergenceConflict, string> = {
  'local-data-without-identity':
    'This browser contains event data without a valid local device identity. Automatic identity convergence is blocked.',
  'local-range-without-central-range':
    'This browser issues badges from a local range, but the signed-in central device owns no badge range. Reconcile that first.',
  'enrollment-device-mismatch':
    'This browser is enrolled as a different central device than the one signed in.',
  'enrollment-event-mismatch':
    'This browser is enrolled for a different event than the one signed in.',
  'binding-missing':
    'The central device has a badge assignment this browser has never set up.',
  'binding-device-mismatch':
    'This browser’s badge range was set up for a different central device.',
  'binding-event-mismatch':
    'This browser’s badge range was set up for a different event.',
  'binding-range-mismatch':
    'This browser’s recorded badge range is not the range this device is centrally assigned.',
  'binding-assigned-at-mismatch':
    'The central badge assignment has been reissued since this browser set it up.',
  'local-range-missing':
    'The central device is assigned a badge range this browser does not have.',
  'local-range-mismatch':
    'This browser’s local badge range does not match its central assignment.',
  'local-range-incoherent':
    'This browser’s badge range and its next badge number do not agree.',
  'central-range-missing':
    'This browser holds a badge range that is no longer centrally assigned to this device.',
}

const Identity: React.FC<{ label: string; name: string; id: string }> = ({
  label,
  name,
  id,
}) => (
  <BadgeStateRow label={label}>
    <span className="font-medium">
      {name}
    </span>

    <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">
      {id}
    </span>
  </BadgeStateRow>
)

const ResultNote: React.FC<{ result: ConvergenceFlowResult }> = ({ result }) => {
  if (result.outcome === 'converged') {
    return null
  }

  const message =
    result.outcome === 'session-invalid'
      ? 'This device is no longer signed in centrally. Nothing was changed. Sign in again and retry.'
      : result.outcome === 'unreachable'
        ? 'The server could not be reached, so nothing was changed. Identity convergence needs a live connection.'
        : result.outcome === 'device-changed'
          ? 'The signed-in central device changed while this page was open. Nothing was changed.'
          : 'Identity convergence was refused. See the status above.'

  return (
    <p className="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  )
}

/**
 * This browser's operational device identity, and the one deliberate action
 * that migrates it onto the central device.
 *
 * NEVER AUTOMATIC. The identity here is what gets stamped onto every future
 * attendee record, so signing in, reconnecting or verifying a lease must not
 * change it — only an operator pressing this button does, and only against a
 * live session that is re-checked at the moment they press it.
 *
 * It migrates IDENTITY ONLY. The badge range, `nextBadge` and the central
 * binding are untouched, and adopting a central range stays C2A's separate,
 * physically confirmed act. Existing registrations and queued sync rows keep
 * the identity they were created with, which is the truth about where they
 * came from.
 */
const DeviceIdentitySection: React.FC<DeviceIdentitySectionProps> = ({
  plan,
  result,
  isBusy,
  isOffline,
  onConverge,
}) => {
  const [understood, setUnderstood] = useState(false)

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Device Identity
      </p>

      {/*
        Offline, this browser's own identity is deliberately NOT asserted
        here: the only name available without a live session is the enrolled
        CENTRAL one, and labelling that as the local identity would be the
        exact confusion convergence exists to end.
      */}
      {isOffline || plan === null ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Identity convergence needs a live central device session. It is
          unavailable while offline.
        </p>
      ) : null}

      {plan === null || isOffline ? null : (
        <>
          {plan.outcome === 'unavailable' ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {plan.gap === 'no-enrollment'
                ? 'Sign this browser in to a central device first. Identity convergence uses the enrolled device.'
                : plan.gap === 'event-mismatch'
                  ? 'This browser is enrolled for a different event than the one signed in.'
                  : 'Local storage is not ready. Reload and try again.'}
            </p>
          ) : null}

          {plan.outcome === 'blocked' ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 font-semibold text-destructive">
                <CircleAlert className="size-5" />
                Identity conflict
              </p>

              <p className="text-sm leading-relaxed text-muted-foreground">
                {CONFLICT[plan.conflict]}
              </p>

              <p className="text-sm leading-relaxed text-muted-foreground">
                Identity convergence is blocked rather than hiding this. It
                cannot be unlocked with an operator code.
              </p>
            </div>
          ) : null}

          {plan.outcome === 'already-converged' ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 font-semibold">
                <CircleCheck className="size-5" />
                Unified with central device
              </p>

              <Identity
                label="Device identity"
                name={plan.identity.deviceName}
                id={plan.identity.deviceId}
              />

              <p className="text-sm leading-relaxed text-muted-foreground">
                This browser already uses the central device identity. New
                registrations are stamped with it.
              </p>
            </div>
          ) : null}

          {plan.outcome === 'fresh-setup' ? (
            <div className="space-y-4">
              <p className="flex items-center gap-2 font-semibold">
                <MonitorSmartphone className="size-5" />
                Set up this device
              </p>

              <Identity
                label="This browser will use"
                name={plan.to.deviceName}
                id={plan.to.deviceId}
              />

              <p className="text-sm leading-relaxed text-muted-foreground">
                No separate local device setup is needed. Badge ownership stays
                separate: a central badge range is still adopted deliberately,
                with the physical badges confirmed at this desk.
              </p>

              {result === null ? null : <ResultNote result={result} />}

              <Button
                type="button"
                disabled={isBusy}
                className="h-12 w-full sm:w-auto sm:min-w-64"
                onClick={onConverge}
              >
                {isBusy ? 'Setting up…' : 'Set Up This Device'}
              </Button>
            </div>
          ) : null}

          {plan.outcome === 'ready' ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Identity
                  label="Current local identity"
                  name={plan.from.deviceName}
                  id={plan.from.deviceId}
                />

                <Identity
                  label="Central device"
                  name={plan.to.deviceName}
                  id={plan.to.deviceId}
                />
              </div>

              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <ArrowRight className="size-4 shrink-0" />
                Future registrations from this browser will use the central
                device identity.
              </p>

              <p className="text-sm leading-relaxed text-muted-foreground">
                Existing registrations and queued sync records keep their
                original historical identity. The badge range, the next badge
                number and the central badge binding are not changed.
              </p>

              <Label
                htmlFor="converge-understood"
                className="flex items-start gap-3 font-normal"
              >
                <input
                  id="converge-understood"
                  type="checkbox"
                  checked={understood}
                  onChange={(event) => {
                    setUnderstood(event.target.checked)
                  }}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                />

                <span className="text-sm leading-relaxed">
                  I understand this changes the device identity used for future
                  registrations.
                </span>
              </Label>

              {result === null ? null : <ResultNote result={result} />}

              <Button
                type="button"
                disabled={!understood || isBusy}
                className="h-12 w-full sm:w-auto sm:min-w-64"
                onClick={onConverge}
              >
                {isBusy ? 'Converging…' : 'Converge Device Identity'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export default DeviceIdentitySection
