import { CloudOff, MonitorSmartphone } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { DeviceAuthorizationGap } from '@/device-auth/event-authorization'
import { useNetworkStatus } from '@/hooks/use-network-status'

interface DeviceAccessRequiredProps {
  gap: DeviceAuthorizationGap
}

/**
 * This browser is not authorized, and there is nothing WRONG — it simply has
 * not finished becoming an event device.
 *
 * Since Phase D2 there is no operator code to offer, so this screen's whole
 * job is to name the ONE step that is missing and point at Device Sign-In.
 * It never offers an override, never explains the device model, and never
 * claims a conflict it has not found.
 */
const HEADING: Record<DeviceAuthorizationGap, string> = {
  'no-grant': 'Device access required',
  'event-mismatch': 'Device access required',
  'storage-unavailable': 'Local storage is not ready',
  'no-enrollment': 'Device access required',
  'missing-local-identity': 'Device setup required',
  'identity-convergence-required': 'Device setup required',
  'not-permitted': 'Not available on this device',
  'no-central-range': 'Badge setup required',
}

const EXPLANATION: Record<DeviceAuthorizationGap, string> = {
  'no-grant': 'Sign in with this event Device to continue.',
  'event-mismatch':
    'This Device is signed in for a different event than the one running here.',
  'storage-unavailable': 'Reload this page and try again.',
  'no-enrollment':
    'This browser is not connected to a central Device yet. Sign in with this event Device to continue.',
  'missing-local-identity':
    'This browser has not been set up as an event Device. Open Device Sign-In and complete the Device setup there.',
  'identity-convergence-required':
    'This browser still uses an older local identity. Open Device Sign-In and connect it to the central Device before continuing.',
  'not-permitted':
    'This Device does not have access to this module. An administrator grants it.',
  'no-central-range':
    'The central Device is verified, but this browser has not adopted its assigned badge range.',
}

const DeviceAccessRequired: React.FC<DeviceAccessRequiredProps> = ({ gap }) => {
  const network = useNetworkStatus()

  /**
   * Offline with no grant is a DIFFERENT problem from offline with a stale
   * one, and telling someone with no connection to go and sign in would send
   * them somewhere that cannot help. An expired or absent lease is reported
   * as needing verification instead.
   */
  const isUnverifiableOffline = network === 'offline' && gap === 'no-grant'

  return (
    <Card>
      <CardContent className="space-y-4">
        <p className="flex items-center gap-2 font-heading text-xl font-semibold">
          {isUnverifiableOffline ? (
            <CloudOff className="size-5 text-amber-700 dark:text-amber-400" />
          ) : (
            <MonitorSmartphone className="size-5 text-muted-foreground" />
          )}
          {isUnverifiableOffline ? 'Device verification required' : HEADING[gap]}
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          {isUnverifiableOffline
            ? 'Connect to the internet and verify this Device.'
            : EXPLANATION[gap]}
        </p>

        {/* A real link styled as a button — see device-login-page for why it
            is not routed through the Button component. */}
        <Link
          href={ROUTES.deviceLogin}
          className={buttonVariants({ className: 'h-12 w-full sm:w-auto sm:min-w-52' })}
        >
          Open Device Sign-In
        </Link>
      </CardContent>
    </Card>
  )
}

export default DeviceAccessRequired
