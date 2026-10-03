import { ClipboardCheck, Copy, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { formatBadgeRange } from '@/db/device'
import { readLocalReadiness } from '@/db/readiness'
import { useDeviceEventAuthorization } from '@/device-auth/device-event-authorization-context'
import {
  authorizeEventModule,
  type DeviceOperationalGrant,
  type ModuleAuthorization,
} from '@/device-auth/event-authorization'
import {
  readVerifiedOfflineAuthorization,
  type CachedOfflineLease,
} from '@/device-auth/offline-lease'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { useOperatorAccess } from '@/hooks/use-operator-access'
import { formatBadgeNumber } from '@/lib/badge'
import { formatEventDateTime } from '@/lib/datetime'
import { readDeviceEnvironment } from '@/lib/device-environment'
import {
  buildDeviceSummary,
  DISPLAY_MODE_LABELS,
  PERSISTENCE_LABELS,
  SERVICE_WORKER_LABELS,
  type ReadinessSnapshot,
  type ReadinessTone,
} from '@/lib/device-readiness-summary'
import { cn } from '@/lib/utils'

/**
 * How a verified lease reads in diagnostics.
 *
 * Every state that is not a held, in-date signature says so plainly: an
 * unverifiable lease grants nothing, and a readiness screen that implied
 * otherwise would be worse than showing nothing at all.
 */
const OFFLINE_LEASE_LABELS: Record<
  CachedOfflineLease['status'],
  { value: string; tone: ReadinessTone; hint?: string }
> = {
  none: { value: 'None issued', tone: 'neutral' },
  'not-configured': { value: 'Not configured', tone: 'neutral' },
  valid: { value: 'Signature valid', tone: 'good' },
  expired: { value: 'Expired', tone: 'attention', hint: 'Sign in online to receive a new lease.' },
  invalid: { value: 'Signature invalid', tone: 'attention' },
  unverifiable: { value: 'Unable to verify', tone: 'attention' },
}

/**
 * How this desk is currently authorized, and whether registration is open to
 * it. Both are DERIVED at render time from the same pure evaluator the gate
 * uses, so the diagnostic and the actual decision cannot disagree.
 */
const EVENT_ACCESS_LABEL = (
  grant: DeviceOperationalGrant | null,
  operatorPhase: string,
): { value: string; tone: ReadinessTone; hint?: string } => {
  if (grant?.source === 'device-online') {
    return { value: 'Device online', tone: 'good' }
  }

  if (grant?.source === 'device-offline') {
    return {
      value: 'Device offline',
      tone: 'warning',
      hint: 'Signed authorization lease, verified on this device.',
    }
  }

  return operatorPhase === 'unlocked' || operatorPhase === 'expired'
    ? { value: 'Operator fallback', tone: 'neutral' }
    : { value: 'None', tone: 'attention' }
}

const REGISTRATION_LABEL = (
  authorization: ModuleAuthorization,
): { value: string; tone: ReadinessTone; hint?: string } => {
  if (authorization.outcome === 'authorized') {
    return { value: 'Ready', tone: 'good' }
  }

  if (authorization.outcome === 'blocked') {
    return {
      value: 'Badge setup conflict',
      tone: 'attention',
      hint: 'Central and local badge ownership disagree. Resolve at Device Sign-In.',
    }
  }

  return { value: 'Not permitted', tone: 'neutral' }
}

const TONE_CLASS: Record<ReadinessTone, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  attention: 'text-destructive',
  neutral: 'text-foreground',
}

interface ReadinessRowProps {
  label: string
  value: string
  tone?: ReadinessTone
  hint?: string
}

const ReadinessRow: React.FC<ReadinessRowProps> = ({
  label,
  value,
  tone = 'neutral',
  hint,
}) => {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">
        {label}
      </span>

      <span className="text-right">
        <span className={cn('text-sm font-medium', TONE_CLASS[tone])}>
          {value}
        </span>

        {hint === undefined ? null : (
          <span className="block text-xs text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </div>
  )
}

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </p>
  )
}

/**
 * Read-only operational diagnostics for one physical event device.
 *
 * Every dynamic value is read FRESH from IndexedDB when the panel opens, when
 * Refresh is pressed, and when connectivity changes. Nothing here is copied
 * from another component's configuration hook, because `nextBadge` and the
 * outbox count change while the desk works.
 *
 * There is deliberately NO control here that edits a range, resets a badge
 * number, changes a device id, deletes anything, clears storage or logs out.
 * Diagnostics observe; they never mutate.
 *
 * Mounted INSIDE DeviceSetupGate, which is itself inside DatabaseGate. That
 * placement is load-bearing: it means this component cannot render — and so
 * cannot touch Dexie — until bootstrap has succeeded AND the device is
 * configured. It therefore needs no configuration read of its own to decide
 * whether to appear, which is exactly the kind of pre-bootstrap database work
 * a component outside DatabaseGate must never do.
 */
interface DeviceReadinessProps {
  /**
   * `icon` is the compact trigger beside the device label on the badge page;
   * `button` is the labelled action on the device registration page. Only the
   * trigger differs — the panel and its reads are identical.
   */
  trigger?: 'icon' | 'button'
}

const DeviceReadiness: React.FC<DeviceReadinessProps> = ({ trigger = 'icon' }) => {
  const access = useOperatorAccess()
  const network = useNetworkStatus()
  /**
   * READ-ONLY. Diagnostics report how this desk is authorized; they never
   * refresh, revoke, issue or repair anything.
   */
  const device = useDeviceEventAuthorization()

  const [isOpen, setIsOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{
    attempt: number
    snapshot: ReadinessSnapshot
  } | null>(null)
  /**
   * READ-ONLY, and re-verified at the moment it is shown. Diagnostics never
   * issue, refresh, repair or clear a lease — they only report what the
   * pinned public key says about the bytes currently stored.
   */
  const [offlineLease, setOfflineLease] = useState<CachedOfflineLease | null>(null)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    let cancelled = false

    void (async () => {
      const [local, environment, lease] = await Promise.all([
        readLocalReadiness(),
        readDeviceEnvironment(),
        readVerifiedOfflineAuthorization(),
      ])

      if (!cancelled) {
        setSettled({ attempt, snapshot: { local, environment } })
        setOfflineLease(lease)
      }
    })()

    return () => {
      cancelled = true
    }
    // `network` re-runs the checks when connectivity changes while open.
  }, [isOpen, attempt, network])

  const snapshot = settled !== null && settled.attempt === attempt ? settled.snapshot : null

  const handleCopy = async () => {
    if (snapshot === null) {
      return
    }

    try {
      await navigator.clipboard.writeText(buildDeviceSummary(snapshot))
      setCopyMessage('Device summary copied.')
    } catch {
      setCopyMessage('Could not copy. Select the details manually.')
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        setIsOpen(open)

        if (open) {
          // A fresh read every time the panel is opened.
          setAttempt((previous) => previous + 1)
          setCopyMessage(null)
        }
      }}
    >
      <DialogTrigger
        render={
          trigger === 'button' ? (
            <Button
              type="button"
              variant="outline"
              className="h-12 w-full sm:w-auto sm:min-w-52"
            >
              <ClipboardCheck data-icon="inline-start" />
              Open Device Readiness
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Device readiness"
              title="Device readiness"
            >
              <ClipboardCheck />
            </Button>
          )
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Device Readiness
          </DialogTitle>

          <DialogDescription>
            Read-only checks for this event device. Nothing here changes any
            stored data.
          </DialogDescription>
        </DialogHeader>

        {snapshot === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Checking device…
          </p>
        ) : (
          <div className="space-y-5">
            <section className="space-y-1">
              <SectionHeading>
                Device
              </SectionHeading>

              {snapshot.local.ok ? (
                <>
                  <ReadinessRow
                    label="Device name"
                    value={snapshot.local.device.deviceName}
                  />

                  <ReadinessRow
                    label="Device ID"
                    value={snapshot.local.device.deviceId}
                  />

                  <ReadinessRow
                    label="Registered"
                    value={
                      formatEventDateTime(
                        snapshot.local.device.deviceConfiguredAt ?? '',
                      ) || 'Unknown'
                    }
                  />
                </>
              ) : (
                <ReadinessRow
                  label="Device registration"
                  value="Not registered"
                  tone="attention"
                  hint={
                    snapshot.local.reason === 'missing-config'
                      ? 'No event configuration was found on this device.'
                      : 'This physical device has not been registered.'
                  }
                />
              )}
            </section>

            {/*
              The badge module's own state, kept separate from identity. A
              registered device that distributes no badges is healthy, so
              nothing here invents a range, a next badge or a remaining count
              for it.
            */}
            <section className="space-y-1">
              <SectionHeading>
                Badge distribution
              </SectionHeading>

              {!snapshot.local.ok || !snapshot.local.badgeDistribution.configured ? (
                <ReadinessRow
                  label="Badge distribution"
                  value="Not configured"
                  tone="neutral"
                  hint="This device has not been assigned a badge range."
                />
              ) : (
                <>
                  <ReadinessRow
                    label="Badge distribution"
                    value="Configured"
                    tone="good"
                  />

                  <ReadinessRow
                    label="Assigned badges"
                    value={formatBadgeRange(
                      snapshot.local.badgeDistribution.badgeStart,
                      snapshot.local.badgeDistribution.badgeEnd,
                    )}
                  />

                  <ReadinessRow
                    label="Next badge"
                    value={formatBadgeNumber(snapshot.local.badgeDistribution.nextBadge)}
                  />

                  <ReadinessRow
                    label="Remaining"
                    value={String(snapshot.local.badgeDistribution.remaining)}
                    tone={
                      snapshot.local.badgeDistribution.status === 'exhausted'
                        ? 'warning'
                        : 'good'
                    }
                    hint={
                      snapshot.local.badgeDistribution.status === 'exhausted'
                        ? 'Range exhausted. Hold Registration still works.'
                        : undefined
                    }
                  />
                </>
              )}
            </section>

            <section className="space-y-1">
              <SectionHeading>
                Local state
              </SectionHeading>

              <ReadinessRow
                label="Completed"
                value={String(snapshot.local.counts.completed)}
              />

              <ReadinessRow
                label="Held"
                value={String(snapshot.local.counts.held)}
              />

              <ReadinessRow
                label="Pending sync"
                value={
                  snapshot.local.counts.pendingSync === 0
                    ? 'Synced'
                    : `${String(snapshot.local.counts.pendingSync)} records`
                }
                tone={snapshot.local.counts.pendingSync === 0 ? 'good' : 'warning'}
              />
            </section>

            <section className="space-y-1">
              <SectionHeading>
                Event device
              </SectionHeading>

              <ReadinessRow
                label="Network"
                value={snapshot.environment.network === 'online' ? 'Online' : 'Offline'}
                tone={snapshot.environment.network === 'online' ? 'good' : 'warning'}
                hint={
                  snapshot.environment.network === 'online'
                    ? undefined
                    : 'Local registration remains available. Synchronization resumes when connected.'
                }
              />

              <ReadinessRow
                label="Service worker"
                {...SERVICE_WORKER_LABELS[snapshot.environment.serviceWorker]}
              />

              <ReadinessRow
                label="App mode"
                {...DISPLAY_MODE_LABELS[snapshot.environment.displayMode]}
              />

              <ReadinessRow
                label="Persistent storage"
                {...PERSISTENCE_LABELS[snapshot.environment.persistentStorage]}
              />

              <ReadinessRow
                label="Operator access"
                value={access.phase === 'expired' ? 'Session expired' : 'Unlocked'}
                tone={access.phase === 'expired' ? 'warning' : 'good'}
              />

              <ReadinessRow
                label="Event access"
                {...EVENT_ACCESS_LABEL(device.grant, access.phase)}
              />

              <ReadinessRow
                label="Registration authorization"
                {...REGISTRATION_LABEL(
                  authorizeEventModule('registration', {
                    grant: device.grant,
                    config: device.config,
                    enrollment: device.enrollment,
                  }),
                )}
              />

              {offlineLease === null ? null : (
                <>
                  <ReadinessRow
                    label="Central offline authorization"
                    {...OFFLINE_LEASE_LABELS[offlineLease.status]}
                  />

                  {offlineLease.status === 'valid' || offlineLease.status === 'expired' ? (
                    <ReadinessRow
                      label="Expires"
                      value={formatEventDateTime(
                        new Date(offlineLease.claims.exp * 1000).toISOString(),
                      )}
                      tone={offlineLease.status === 'valid' ? 'good' : 'attention'}
                    />
                  ) : null}
                </>
              )}
            </section>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAttempt((previous) => previous + 1)
              setCopyMessage(null)
            }}
          >
            <RotateCcw data-icon="inline-start" />
            Refresh checks
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={snapshot === null}
            onClick={() => {
              void handleCopy()
            }}
          >
            <Copy data-icon="inline-start" />
            Copy device summary
          </Button>

          {copyMessage === null ? null : (
            <span
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {copyMessage}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default DeviceReadiness
