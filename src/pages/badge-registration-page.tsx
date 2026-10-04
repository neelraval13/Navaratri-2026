import type * as React from 'react'

import DeviceLabel from '@/components/device/device-label'
import DeviceReadiness from '@/components/device/device-readiness'
import RegistrationForm from '@/components/registration/registration-form'

/**
 * The attendee badge workflow.
 *
 * There are no setup gates inside the page any more. Since Phase D2 the route
 * itself is only reachable once the central device has proven Registration
 * authority AND this browser's converged identity, badge range and central
 * binding all agree — so a device that reaches here is, by construction,
 * already provisioned. Anything missing is reported by the access gate, which
 * sends the operator to Device Sign-In rather than offering a local form that
 * would create a range central knows nothing about.
 *
 * The workflow itself is unchanged. The dominant element on screen remains
 * the live badge number in the form header.
 */
const BadgeRegistrationPage: React.FC = () => {
  return (
    <>
      {/* Device identity and its read-only diagnostics sit together. */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <DeviceLabel />

        <DeviceReadiness />
      </div>

      <RegistrationForm />
    </>
  )
}

export default BadgeRegistrationPage
