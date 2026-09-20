import { WifiOff } from 'lucide-react'
import { useEffect } from 'react'
import type * as React from 'react'

import {
  OPERATOR_ACCESS_MESSAGES,
  refreshOperatorAccess,
} from '@/auth/operator-access'
import OperatorAccessForm from '@/components/operator/operator-access-form'
import { Card, CardContent } from '@/components/ui/card'
import { useNetworkStatus } from '@/hooks/use-network-status'
import { useOperatorAccess } from '@/hooks/use-operator-access'

interface OperatorAccessGateProps {
  children: React.ReactNode
}

/**
 * The hard access gate, and ONLY for a device that has never been unlocked.
 *
 * A device that has been unlocked before always renders the application, even
 * when the server later rejects its session: the desk is local-first, and
 * replacing a half-filled registration form with a login screen would lose an
 * attendee's details. That case is handled by the banner instead.
 */
const OperatorAccessGate: React.FC<OperatorAccessGateProps> = ({ children }) => {
  const access = useOperatorAccess()
  const network = useNetworkStatus()

  useEffect(() => {
    // Re-runs when connectivity returns, which is exactly when a device that
    // could not verify offline can finally be checked.
    void refreshOperatorAccess()
  }, [network])

  if (access.phase !== 'locked') {
    return <>{children}</>
  }

  if (access.lockReason === 'offline-first-use') {
    return (
      <Card>
        <CardContent className="space-y-3 text-center">
          <p className="flex items-center justify-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
            <WifiOff className="size-5" />
            Connect to the internet once to unlock this event device.
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            After the first unlock this device keeps working without a network.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <h2 className="font-heading text-2xl font-semibold">
            Operator Access
          </h2>

          <p className="text-sm text-muted-foreground">
            Unlock this event device to begin registration.
          </p>
        </div>

        {access.lockReason === 'not-configured' ? (
          <p className="text-sm text-destructive">
            {OPERATOR_ACCESS_MESSAGES.notConfigured}
          </p>
        ) : null}

        {access.lockReason === 'unreachable' ? (
          <p className="text-sm text-destructive">
            {OPERATOR_ACCESS_MESSAGES.unreachable}
          </p>
        ) : null}

        <OperatorAccessForm
          idPrefix="operator-gate"
          autoFocus
        />
      </CardContent>
    </Card>
  )
}

export default OperatorAccessGate
