import {
  clearCentralDeviceOfflineAuthorization,
  readCentralDeviceOfflineAuthorization,
  saveCentralDeviceOfflineAuthorization,
} from '@/db/central-offline-authorization'
import { verifyOfflineAuthorization } from '@/device-auth/offline-authorization'
import type {
  DeviceBadgeRange,
  DeviceSessionContext,
  OfflineAuthorizationEnvelope,
} from '@/device-auth/device-session-contract'
import type { DeviceOfflineClaims } from '@/shared/device-offline-authorization'

/**
 * Deciding whether a freshly received lease may be cached, and reading back
 * the cached one.
 *
 * SAVE ONLY WHAT VERIFIES. A token is persisted only after its signature
 * holds against the pinned public key, its claims parse, its clock is sane,
 * and it describes the SAME device, event and permissions the server just
 * returned in the same response. A lease that disagrees with its own context
 * is not a lease this browser understands, so it is dropped rather than
 * stored for something later to trust.
 */

export type OfflineLeaseOutcome =
  | { status: 'cached'; claims: DeviceOfflineClaims }
  /** Either side has no key. Online device authentication is unaffected. */
  | { status: 'not-configured' }
  | { status: 'unverifiable' }
  | { status: 'invalid' }
  /** Signed, but it does not describe the context it arrived with. */
  | { status: 'inconsistent' }
  /** Correctly signed and out of time. The claims are safe to show. */
  | { status: 'expired'; claims: DeviceOfflineClaims }
  | { status: 'missing-config' }

const sameRange = (
  left: DeviceBadgeRange | null,
  right: { rangeStart: number; rangeEnd: number; assignedAt: string } | null,
): boolean => {
  if (left === null || right === null) {
    return left === null && right === null
  }

  return (
    left.rangeStart === right.rangeStart &&
    left.rangeEnd === right.rangeEnd &&
    left.assignedAt === right.assignedAt
  )
}

const sameAttributes = (left: readonly string[], right: readonly string[]): boolean => {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

/**
 * Verifies a lease and caches it, or explains why it was not cached.
 *
 * `expectedBadgeRange` lets a self-claim response be checked against the
 * range IT just established rather than the one the session was loaded with
 * — the claim is precisely what made those differ.
 */
export const acceptOfflineAuthorization = async (input: {
  context: DeviceSessionContext
  envelope: OfflineAuthorizationEnvelope
  expectedBadgeRange?: DeviceBadgeRange | null
}): Promise<OfflineLeaseOutcome> => {
  if (input.envelope.configured === false) {
    return { status: 'not-configured' }
  }

  const verification = await verifyOfflineAuthorization(input.envelope.token)

  if (verification.status === 'expired') {
    // Reported as itself: the signature held, so it was genuinely issued —
    // the clock is what failed, and saying "invalid" would misdescribe it.
    return { status: 'expired', claims: verification.claims }
  }

  if (verification.status !== 'valid') {
    return { status: verification.status }
  }

  const { claims } = verification
  const expectedRange =
    input.expectedBadgeRange === undefined
      ? input.context.activeBadgeRange
      : input.expectedBadgeRange

  /**
   * The lease must describe the device the server just authenticated. A
   * signed statement about some OTHER device is correctly signed and still
   * wrong here, and caching it would bind this browser to authority it was
   * never granted.
   */
  if (
    claims.deviceId !== input.context.device.id ||
    claims.eventId !== input.context.event.id ||
    claims.eventSlug !== input.context.event.slug ||
    !sameAttributes(claims.attributes, input.context.device.attributes) ||
    !sameRange(expectedRange, claims.activeBadgeRange)
  ) {
    return { status: 'inconsistent' }
  }

  const saved = await saveCentralDeviceOfflineAuthorization(input.envelope.token)

  return saved.outcome === 'saved' ? { status: 'cached', claims } : { status: 'missing-config' }
}

export type CachedOfflineLease =
  | { status: 'none' }
  | { status: 'not-configured' }
  | { status: 'unverifiable' }
  | { status: 'invalid' }
  | { status: 'expired'; claims: DeviceOfflineClaims }
  | { status: 'valid'; claims: DeviceOfflineClaims; receivedAt: string }

/**
 * Reads the cached lease and VERIFIES it again.
 *
 * Never a plain read. The bytes in IndexedDB are editable by anyone with the
 * device, so the signature is what makes them mean anything — and an expired
 * lease stays non-authoritative however intact its bytes are.
 */
export const readVerifiedOfflineAuthorization = async (
  now: Date = new Date(),
): Promise<CachedOfflineLease> => {
  const stored = await readCentralDeviceOfflineAuthorization()

  if (stored === undefined) {
    return { status: 'none' }
  }

  const verification = await verifyOfflineAuthorization(stored.token, now)

  if (verification.status === 'valid') {
    return { status: 'valid', claims: verification.claims, receivedAt: stored.receivedAt }
  }

  if (verification.status === 'expired') {
    return { status: 'expired', claims: verification.claims }
  }

  return { status: verification.status }
}

/**
 * Central state DEFINITIVELY says this device is no longer authorized.
 *
 * Only ever called for a real server answer — a session the server declined.
 * A timeout, an unreachable host or a 5xx is NOT revocation: treating a bad
 * network as a revocation would disable a desk precisely when its offline
 * authority is the thing keeping it running.
 */
export const revokeOfflineAuthorization = async (): Promise<void> => {
  await clearCentralDeviceOfflineAuthorization()
}
