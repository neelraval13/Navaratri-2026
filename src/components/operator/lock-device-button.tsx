import { Lock } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { lockOperatorDevice } from '@/auth/operator-access'
import { Button } from '@/components/ui/button'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { useOperatorAccess } from '@/hooks/use-operator-access'

/**
 * Ends the operator session on this device.
 *
 * Auth only: IndexedDB, registrations, the outbox, the event configuration,
 * `nextBadge` and the PWA cache are all left exactly as they are.
 *
 * Disabled while offline, deliberately. Logging out offline could only clear
 * the local marker while the server cookie stayed valid, which would look like
 * a completed logout and would not be one.
 */
const LockDeviceButton: React.FC = () => {
  const access = useOperatorAccess()
  const network = useNetworkStatus()
  const [isLocking, setIsLocking] = useState(false)

  if (access.phase === 'locked' || access.phase === 'checking') {
    return null
  }

  const isOffline = network === 'offline'

  const handleLock = async () => {
    setIsLocking(true)

    await lockOperatorDevice()

    setIsLocking(false)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={isOffline || isLocking}
      aria-label="Lock device"
      title={isOffline ? 'Lock device (needs a connection)' : 'Lock device'}
      onClick={() => {
        void handleLock()
      }}
    >
      <Lock />
    </Button>
  )
}

export default LockDeviceButton
