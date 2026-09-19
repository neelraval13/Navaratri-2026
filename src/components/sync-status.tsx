import {
  CloudCheck,
  CloudOff,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import type * as React from 'react'

import { useNetworkStatus } from '@/hooks/use-network-status'
import { useSyncStatus } from '@/hooks/use-sync-status'
import { requestOutboxSync } from '@/sync/outbox-sync'
import { cn } from '@/lib/utils'

interface SyncAppearance {
  label: string
  icon: React.ReactNode
  className: string
}

/**
 * A compact, truthful synchronization indicator.
 *
 * `Synced` means ONLY that no local outbox snapshot is pending. It does not
 * claim Google is reachable, that the browser is online, that the Sheet has not
 * been edited by hand, or that other devices are up to date.
 */
const SyncStatus: React.FC = () => {
  const status = useSyncStatus()
  const network = useNetworkStatus()

  const describe = (): SyncAppearance => {
    // Never assert success before the queue has actually been read.
    if (status.phase === 'loading') {
      return {
        label: 'Checking sync',
        icon: <RefreshCw className="size-4" />,
        className: 'text-muted-foreground',
      }
    }

    if (status.attentionCount > 0) {
      return {
        label: `Sync issue · ${String(status.attentionCount)}`,
        icon: <TriangleAlert className="size-4" />,
        className: 'text-amber-700 dark:text-amber-400',
      }
    }

    if (status.phase === 'syncing' && status.pendingCount > 0) {
      return {
        label: `Syncing · ${String(status.pendingCount)}`,
        icon: <RefreshCw className="size-4" />,
        className: 'text-muted-foreground',
      }
    }

    if (status.pendingCount > 0) {
      return {
        label: `${String(status.pendingCount)} pending`,
        icon: <CloudOff className="size-4" />,
        className:
          network === 'offline'
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground',
      }
    }

    return {
      label: 'Synced',
      icon: <CloudCheck className="size-4" />,
      className: 'text-muted-foreground',
    }
  }

  const appearance = describe()
  const canRetry = status.phase !== 'loading' && status.pendingCount > 0

  return (
    <div className="flex items-center gap-1">
      <p
        aria-live="polite"
        className={cn(
          'flex items-center gap-1.5 text-xs font-medium',
          appearance.className,
        )}
      >
        {appearance.icon}

        {/* The icon carries the meaning on narrow screens; the label returns at
            sm and up, and stays available to screen readers either way. */}
        <span className="hidden sm:inline">
          {appearance.label}
        </span>

        <span className="sr-only sm:hidden">
          {appearance.label}
        </span>
      </p>

      {canRetry ? (
        <button
          type="button"
          aria-label="Retry synchronization"
          title="Retry synchronization"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => {
            void requestOutboxSync({ manual: true })
          }}
        >
          <RotateCcw className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export default SyncStatus
