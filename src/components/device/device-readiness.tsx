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
const DeviceReadiness: React.FC = () => {
  const access = useOperatorAccess()
  const network = useNetworkStatus()

  const [isOpen, setIsOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{
    attempt: number
    snapshot: ReadinessSnapshot
  } | null>(null)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    let cancelled = false

    void (async () => {
      const [local, environment] = await Promise.all([
        readLocalReadiness(),
        readDeviceEnvironment(),
      ])

      if (!cancelled) {
        setSettled({ attempt, snapshot: { local, environment } })
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Device readiness"
            title="Device readiness"
          >
            <ClipboardCheck />
          </Button>
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
                    label="Configured"
                    value={
                      formatEventDateTime(
                        snapshot.local.device.deviceConfiguredAt ?? '',
                      ) || 'Unknown'
                    }
                  />

                  <ReadinessRow
                    label="Assigned badges"
                    value={formatBadgeRange(
                      snapshot.local.device.badgeStart,
                      snapshot.local.device.badgeEnd,
                    )}
                  />

                  <ReadinessRow
                    label="Next badge"
                    value={formatBadgeNumber(snapshot.local.device.nextBadge)}
                  />

                  <ReadinessRow
                    label="Remaining"
                    value={String(snapshot.local.remaining)}
                    tone={snapshot.local.rangeStatus === 'exhausted' ? 'warning' : 'good'}
                    hint={
                      snapshot.local.rangeStatus === 'exhausted'
                        ? 'Range exhausted. Hold Registration still works.'
                        : undefined
                    }
                  />
                </>
              ) : (
                <ReadinessRow
                  label="Device configuration"
                  value="Invalid"
                  tone="attention"
                  hint={
                    snapshot.local.reason === 'missing-config'
                      ? 'No event configuration was found on this device.'
                      : 'Device Setup has not been completed on this device.'
                  }
                />
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
