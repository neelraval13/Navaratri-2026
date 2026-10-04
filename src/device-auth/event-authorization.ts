import {
  isBadgeDistributionConfigured,
  isDeviceRegistered,
} from '@/db/device'
import type { CentralDeviceEnrollment, EventConfig } from '@/db/types'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'
import type { DeviceAttribute } from '@/shared/device-attributes'
import type { DeviceOfflineClaims } from '@/shared/device-offline-authorization'
import { CURRENT_EVENT_SLUG } from '@/shared/event'

/**
 * Whether a centrally enrolled device may run an event module, and on what
 * authority.
 *
 * PURE. No React, no database, no network — it is handed the facts and
 * returns a verdict, so every branch of a security decision is testable
 * without mounting anything.
 *
 * Two authorities are normalised into ONE grant before any rule runs:
 *
 *   device-online   the live `GET /api/device-auth` context
 *   device-offline  the claims of a CRYPTOGRAPHICALLY VERIFIED C3A lease
 *
 * Nothing else may produce a grant. A cached enrollment, a `localStorage`
 * flag or the mere existence of a token are not authority — the first two are
 * unsigned and the third means nothing until its signature is checked.
 */

export type DeviceGrantSource = 'device-online' | 'device-offline'

export interface GrantBadgeRange {
  rangeStart: number
  rangeEnd: number
  assignedAt: string
}

export interface DeviceOperationalGrant {
  source: DeviceGrantSource
  deviceId: string
  eventId: string
  eventSlug: string
  attributes: DeviceAttribute[]
  activeBadgeRange: GrantBadgeRange | null
  /** Epoch seconds. Present only for an offline lease, which must expire. */
  expiresAt?: number
}

/** The live server context. Authoritative while the browser is online. */
export const grantFromDeviceSession = (
  context: DeviceSessionContext,
): DeviceOperationalGrant => ({
  source: 'device-online',
  deviceId: context.device.id,
  eventId: context.device.eventId,
  eventSlug: context.event.slug,
  attributes: [...context.device.attributes],
  activeBadgeRange:
    context.activeBadgeRange === null
      ? null
      : {
          rangeStart: context.activeBadgeRange.rangeStart,
          rangeEnd: context.activeBadgeRange.rangeEnd,
          assignedAt: context.activeBadgeRange.assignedAt,
        },
})

/**
 * A VERIFIED lease. The caller must have checked the signature already — this
 * function takes claims, and claims only mean something once they have been
 * proven to come from the server.
 */
export const grantFromOfflineClaims = (
  claims: DeviceOfflineClaims,
): DeviceOperationalGrant => ({
  source: 'device-offline',
  deviceId: claims.deviceId,
  eventId: claims.eventId,
  eventSlug: claims.eventSlug,
  attributes: [...claims.attributes],
  activeBadgeRange:
    claims.activeBadgeRange === null
      ? null
      : {
          rangeStart: claims.activeBadgeRange.rangeStart,
          rangeEnd: claims.activeBadgeRange.rangeEnd,
          assignedAt: claims.activeBadgeRange.assignedAt,
        },
  expiresAt: claims.exp,
})

export type EventModule = 'home' | 'registration'

/**
 * Device authority is absent or insufficient, but nothing is WRONG.
 *
 * Operator Access remains available for these during the transition: they
 * describe who is asking, not whether the physical badges are safe.
 */
export type DeviceAuthorizationGap =
  | 'no-grant'
  | 'event-mismatch'
  | 'storage-unavailable'
  | 'no-enrollment'
  | 'local-device-not-registered'
  | 'not-permitted'
  | 'no-central-range'

/**
 * BADGE UNIQUENESS is at risk. These must NEVER fall back to Operator Access.
 *
 * The operator code authorizes a person at a browser. It cannot make two
 * desks owning the same physical badge numbers safe, so a credential is the
 * wrong instrument entirely — these need a human to reconcile the ledger.
 */
export type BadgeSafetyConflict =
  | 'enrollment-device-mismatch'
  | 'enrollment-event-mismatch'
  | 'binding-missing'
  | 'binding-device-mismatch'
  | 'binding-event-mismatch'
  | 'binding-range-mismatch'
  | 'binding-assigned-at-mismatch'
  | 'local-range-missing'
  | 'local-range-mismatch'
  | 'local-range-incoherent'
  | 'central-range-missing'

export interface AuthorizationFacts {
  grant: DeviceOperationalGrant | null
  config: EventConfig | undefined
  enrollment: CentralDeviceEnrollment | undefined
}

export type ModuleAuthorization =
  | { outcome: 'authorized'; source: DeviceGrantSource }
  /** Operator Access may still be offered. */
  | { outcome: 'unavailable'; gap: DeviceAuthorizationGap }
  /** HARD. No credential overrides it. */
  | {
      outcome: 'blocked'
      conflict: BadgeSafetyConflict
      central: GrantBadgeRange | null
      local: { rangeStart: number; rangeEnd: number } | null
    }

const sameRange = (
  left: { rangeStart: number; rangeEnd: number },
  right: { rangeStart: number; rangeEnd: number },
): boolean => left.rangeStart === right.rangeStart && left.rangeEnd === right.rangeEnd

/**
 * The central enrollment may RESTRICT authority but never CREATE it.
 *
 * It is unsigned, so it can never be a reason to allow anything. It is still
 * worth checking: if a signed grant says device B while this browser is
 * enrolled as device A, something is wrong that nobody has noticed, and
 * guessing which one is right is how a desk ends up operating as the wrong
 * device. It fails closed and sends the operator to `/device-login`.
 */
export const checkEnrollment = (
  grant: DeviceOperationalGrant,
  enrollment: CentralDeviceEnrollment | undefined,
): BadgeSafetyConflict | null => {
  if (enrollment === undefined) {
    return null
  }

  if (enrollment.deviceId !== grant.deviceId) {
    return 'enrollment-device-mismatch'
  }

  if (enrollment.eventId !== grant.eventId || enrollment.eventSlug !== grant.eventSlug) {
    return 'enrollment-event-mismatch'
  }

  return null
}

/**
 * Does central badge ownership agree with this browser's local allocator?
 *
 * EXPORTED so Phase D1's identity convergence asks the SAME question before
 * it rewrites the local device identity. Convergence must never be able to
 * hide or normalise a conflict this would have caught.
 *
 * Registration offline cannot rest on "this device once had Registration". It
 * must also prove that the numbers it is about to hand out are the numbers
 * central says it owns, and that its local provenance records exactly that
 * assignment. Every disagreement is a conflict, never a preference.
 */
export const checkBadgeOwnership = (
  grant: DeviceOperationalGrant,
  config: EventConfig,
): BadgeSafetyConflict | null => {
  const binding = config.centralBadgeRangeBinding
  const central = grant.activeBadgeRange
  const hasLocalRange = config.badgeEnd !== undefined

  if (central === null) {
    /**
     * Central owns nothing. A local BINDING says otherwise — it records an
     * assignment that has since gone — and that disagreement must be
     * reconciled before this browser issues anything.
     *
     * A local range WITHOUT a binding is the ordinary legacy Phase 7 desk: it
     * was never centrally assigned, so there is nothing to disagree with. It
     * simply has no device authority for registration and keeps using
     * Operator Access exactly as before.
     */
    return binding === undefined ? null : 'central-range-missing'
  }

  if (binding === undefined) {
    return 'binding-missing'
  }

  if (binding.deviceId !== grant.deviceId) {
    return 'binding-device-mismatch'
  }

  if (binding.eventId !== grant.eventId) {
    return 'binding-event-mismatch'
  }

  if (!sameRange(binding, central)) {
    return 'binding-range-mismatch'
  }

  // The exact assignment, not merely the same numbers: a range reassigned
  // after a release is a different grant with the same boundaries.
  if (binding.assignedAt !== central.assignedAt) {
    return 'binding-assigned-at-mismatch'
  }

  if (!hasLocalRange) {
    return 'local-range-missing'
  }

  if (!sameRange({ rangeStart: config.badgeStart, rangeEnd: config.badgeEnd ?? 0 }, central)) {
    return 'local-range-mismatch'
  }

  /**
   * The canonical allocator invariant, reused rather than restated. Note that
   * `nextBadge === badgeEnd + 1` is COHERENT: that is how an exhausted range
   * is represented, and it must reach the existing badge-range-exhausted
   * workflow rather than look like an authorization failure.
   */
  if (!isBadgeDistributionConfigured(config)) {
    return 'local-range-incoherent'
  }

  return null
}

/**
 * Does this browser hold badge ownership of its own — a configured range, or
 * provenance recording one?
 *
 * EXPORTED for Phase D1. Convergence must run the full badge-safety check
 * whenever there is local ownership to protect, and must NOT when there is
 * none: a browser that has never been given a range cannot conflict with a
 * central assignment, and demanding one would block the very case D1 exists
 * to make easy — a freshly provisioned central device adopting its identity
 * before any badges are at the desk.
 */
export const hasLocalBadgeOwnership = (config: EventConfig): boolean => {
  return config.badgeEnd !== undefined || config.centralBadgeRangeBinding !== undefined
}

const localRangeOf = (
  config: EventConfig | undefined,
): { rangeStart: number; rangeEnd: number } | null => {
  return config?.badgeEnd === undefined
    ? null
    : { rangeStart: config.badgeStart, rangeEnd: config.badgeEnd }
}

/**
 * May this grant run this module?
 *
 * ORDER MATTERS. The badge-safety checks run BEFORE the permission check, so
 * a browser whose local badge state disagrees with central is blocked even
 * when the device could not have registered anyway — the conflict is about
 * the physical badges on the table, not about who is holding the tablet, and
 * Operator Access must not be able to open that desk.
 */
export const authorizeEventModule = (
  module: EventModule,
  facts: AuthorizationFacts,
): ModuleAuthorization => {
  const { grant, config, enrollment } = facts

  if (grant === null) {
    return { outcome: 'unavailable', gap: 'no-grant' }
  }

  if (grant.eventSlug !== CURRENT_EVENT_SLUG) {
    return { outcome: 'unavailable', gap: 'event-mismatch' }
  }

  const enrollmentConflict = checkEnrollment(grant, enrollment)

  if (enrollmentConflict !== null) {
    return {
      outcome: 'blocked',
      conflict: enrollmentConflict,
      central: grant.activeBadgeRange,
      local: localRangeOf(config),
    }
  }

  /**
   * A lease can be cryptographically perfect and still belong to a browser
   * that has forgotten which device it is. Enrollment is never reconstructed
   * from signed claims: binding this browser to a central device is a
   * deliberate act at `/device-login`.
   */
  if (enrollment === undefined) {
    return { outcome: 'unavailable', gap: 'no-enrollment' }
  }

  if (module === 'home') {
    /**
     * The launcher needs no badge range. A prizes-only desk must be able to
     * reach Event Operations even though badge registration stays closed to
     * it; each module authorizes itself.
     */
    return grant.attributes.length > 0
      ? { outcome: 'authorized', source: grant.source }
      : { outcome: 'unavailable', gap: 'not-permitted' }
  }

  if (config === undefined) {
    return { outcome: 'unavailable', gap: 'storage-unavailable' }
  }

  /**
   * Transitional until Phase D: registrations are still stamped with this
   * browser's own Phase 7 identity, so it must exist.
   *
   * Checked BEFORE badge ownership on purpose. Without it the allocator
   * invariant below reports an incoherent RANGE, which is both misleading
   * and the wrong severity — a browser that was never set up locally cannot
   * issue anything at all, so it is an ordinary fallback rather than a badge
   * conflict needing reconciliation.
   */
  if (!isDeviceRegistered(config)) {
    return { outcome: 'unavailable', gap: 'local-device-not-registered' }
  }

  const conflict = checkBadgeOwnership(grant, config)

  if (conflict !== null) {
    return {
      outcome: 'blocked',
      conflict,
      central: grant.activeBadgeRange,
      local: localRangeOf(config),
    }
  }

  if (!grant.attributes.includes('registration')) {
    return { outcome: 'unavailable', gap: 'not-permitted' }
  }

  if (grant.activeBadgeRange === null) {
    return { outcome: 'unavailable', gap: 'no-central-range' }
  }

  return { outcome: 'authorized', source: grant.source }
}
