import type * as React from 'react'

import DeviceLabel from '@/components/device/device-label'
import DeviceReadiness from '@/components/device/device-readiness'
import BadgeDistributionGate from '@/components/device/badge-distribution-gate'
import DeviceRegisteredGate from '@/components/device/device-registered-gate'
import RegistrationForm from '@/components/registration/registration-form'

/**
 * The attendee badge workflow.
 *
 * Three states, in order: an unregistered device is sent to register; a
 * registered device with no badge range is offered Badge Distribution Setup;
 * a badge-owning device gets the workflow.
 *
 * The workflow itself is unchanged. The dominant element on screen remains
 * the live badge number in the form header.
 */
const BadgeRegistrationPage: React.FC = () => {
  return (
    <DeviceRegisteredGate>
      <BadgeDistributionGate>
        {/* Device identity and its diagnostics sit together, and both only
            after bootstrap, device registration AND badge assignment. */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <DeviceLabel />

          <DeviceReadiness />
        </div>

        <RegistrationForm />
      </BadgeDistributionGate>
    </DeviceRegisteredGate>
  )
}

export default BadgeRegistrationPage
