import { useEffect, useState } from 'react'

export type NetworkStatus = 'online' | 'offline'

const readNetworkStatus = (): NetworkStatus => {
  return navigator.onLine ? 'online' : 'offline'
}

/**
 * Browser-reported connectivity, nothing more.
 *
 * This is `navigator.onLine` plus the `online`/`offline` events: no polling, no
 * ping endpoint, no backend request. It says the browser believes it has a
 * network — NOT that anything has been synchronized, because no synchronization
 * exists yet.
 *
 * Kept deliberately separate from the rest of the application so real sync state
 * can be added later without reinterpreting this one.
 */
export const useNetworkStatus = (): NetworkStatus => {
  const [status, setStatus] = useState<NetworkStatus>(readNetworkStatus)

  useEffect(() => {
    const handleOnline = () => {
      setStatus('online')
    }

    const handleOffline = () => {
      setStatus('offline')
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return status
}
