import { Wifi, WifiOff } from 'lucide-react'
import type * as React from 'react'

import { useNetworkStatus } from '@/hooks/use-network-status'
import { cn } from '@/lib/utils'

/**
 * A compact connectivity indicator for the application header.
 *
 * Offline is amber, not destructive: the desk is designed to keep working
 * without a network, so this is information rather than an error.
 *
 * "Online" means only that the browser reports connectivity. It deliberately
 * never says "Synced" or "Connected" — nothing is uploaded anywhere yet.
 */
const ConnectivityStatus: React.FC = () => {
  const status = useNetworkStatus()

  const isOffline = status === 'offline'
  const label = isOffline ? 'Offline mode' : 'Online'

  return (
    <p
      aria-live="polite"
      className={cn(
        'flex items-center gap-1.5 text-xs font-medium',
        isOffline
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground',
      )}
    >
      {isOffline ? (
        <WifiOff className="size-4" />
      ) : (
        <Wifi className="size-4" />
      )}

      {/* The icon carries the meaning on narrow screens; the label returns at
          sm and up, and stays available to screen readers either way. */}
      <span className="hidden sm:inline">
        {label}
      </span>

      <span className="sr-only sm:hidden">
        {label}
      </span>
    </p>
  )
}

export default ConnectivityStatus
