import { CircleAlert, CircleCheck, ShieldOff } from 'lucide-react'
import type * as React from 'react'

import BadgeStateRow from '@/components/device-auth/badge-state-row'
import { formatBadgeRange } from '@/db/device'
import type { CachedOfflineLease, OfflineLeaseOutcome } from '@/device-auth/offline-lease'
import { DEVICE_ATTRIBUTE_LABELS } from '@/shared/device-attributes'
import type { DeviceOfflineClaims } from '@/shared/device-offline-authorization'
import { formatEventDateTime } from '@/lib/datetime'

interface OfflineAuthorizationSummaryProps {
  /** Freshly issued on an online check, or re-verified from the cache. */
  state: OfflineLeaseOutcome | CachedOfflineLease
  /** Offline, a lease is the strongest thing on screen; say so carefully. */
  isOffline: boolean
}

/**
 * The signed facts, shown only once the signature has been checked.
 *
 * Everything here comes from VERIFIED claims. Decoded-but-unverified claims
 * are never displayed: a readout an operator trusts must not be forgeable by
 * editing IndexedDB.
 */
const VerifiedClaims: React.FC<{ claims: DeviceOfflineClaims }> = ({ claims }) => (
  <div className="grid gap-4 sm:grid-cols-2">
    <BadgeStateRow label="Access">
      {claims.attributes.length === 0
        ? 'None'
        : claims.attributes.map((entry) => DEVICE_ATTRIBUTE_LABELS[entry]).join(' · ')}
    </BadgeStateRow>

    <BadgeStateRow label="Central badge assignment">
      {claims.activeBadgeRange === null
        ? 'Not assigned'
        : formatBadgeRange(
            claims.activeBadgeRange.rangeStart,
            claims.activeBadgeRange.rangeEnd,
          )}
    </BadgeStateRow>

    <BadgeStateRow label="Valid until">
      {formatEventDateTime(new Date(claims.exp * 1000).toISOString())}
    </BadgeStateRow>
  </div>
)

/**
 * This browser's signed offline authorization lease.
 *
 * INFORMATIONAL IN THIS PHASE. It unlocks nothing: `/`,
 * `/badge-registration` and `/device-registration` still answer to Operator
 * Access, and a valid lease changes none of that. It exists so an organizer
 * can see, before the venue's internet fails, whether this desk would still
 * be authorized.
 *
 * The wording is deliberate. A verified lease offline is never called
 * "Authenticated": nobody asked the server. It says the LEASE is valid,
 * which is the only thing that was actually proven.
 */
const OfflineAuthorizationSummary: React.FC<OfflineAuthorizationSummaryProps> = ({
  state,
  isOffline,
}) => (
  <div className="space-y-4 border-t border-border pt-6">
    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
      Offline Authorization
    </p>

    {state.status === 'not-configured' ? (
      <div className="space-y-2">
        <p className="flex items-center gap-2 font-semibold">
          <ShieldOff className="size-5" />
          Not configured
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Offline authorization signing is not set up for this deployment.
          Online device sign-in is unaffected, and event operations continue to
          use Operator Access.
        </p>
      </div>
    ) : null}

    {state.status === 'none' ? (
      <p className="text-sm leading-relaxed text-muted-foreground">
        No offline authorization has been issued to this browser yet. Sign in
        while online to receive one.
      </p>
    ) : null}

    {state.status === 'cached' || state.status === 'valid' ? (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold">
          <CircleCheck className="size-5" />
          {isOffline ? 'Offline authorization lease valid' : 'Available offline'}
        </p>

        <VerifiedClaims claims={state.claims} />

        <p className="text-sm leading-relaxed text-muted-foreground">
          {isOffline
            ? 'The live device session was not checked. This is a signed lease verified on this device, not a confirmation from the server.'
            : 'This browser holds a signed authorization it can verify without a network, until the time above.'}
        </p>
      </div>
    ) : null}

    {state.status === 'expired' ? (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Expired
        </p>

        <VerifiedClaims claims={state.claims} />

        <p className="text-sm leading-relaxed text-muted-foreground">
          This lease has run out and is no longer authorization. Connect and
          sign in again to receive a new one — it is never extended here.
        </p>
      </div>
    ) : null}

    {state.status === 'invalid' || state.status === 'inconsistent' ? (
      <div className="space-y-2">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Invalid
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          {state.status === 'inconsistent'
            ? 'The offline authorization did not match this device session, so it was not stored. Nothing else changed.'
            : 'The stored offline authorization could not be verified, so it grants nothing.'}
        </p>
      </div>
    ) : null}

    {state.status === 'unverifiable' ? (
      <div className="space-y-2">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Unavailable to verify
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          This browser cannot check the signature, so the offline
          authorization grants nothing. It is never assumed valid.
        </p>
      </div>
    ) : null}

    {state.status === 'missing-config' ? (
      <p className="text-sm text-muted-foreground">
        Local storage is not ready, so the offline authorization was not
        stored.
      </p>
    ) : null}

    <p className="text-xs leading-relaxed text-muted-foreground">
      Event operations still use Operator Access. An offline authorization
      lease does not unlock them yet.
    </p>
  </div>
)

export default OfflineAuthorizationSummary
