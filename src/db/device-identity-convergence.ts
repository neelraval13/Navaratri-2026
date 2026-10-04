import { db } from '@/db/database'
import { isDeviceRegistered } from '@/db/device'
import { EVENT_CONFIG_ID, type EventConfig } from '@/db/types'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'
import {
  checkBadgeOwnership,
  checkEnrollment,
  grantFromDeviceSession,
  hasLocalBadgeOwnership,
  type BadgeSafetyConflict,
} from '@/device-auth/event-authorization'

/**
 * PHASE D1 — converging this browser's transitional Phase 7 identity onto the
 * central device identity.
 *
 * Until now a browser carried two identities: a locally generated UUID that
 * stamps attendee records, and the central device it authenticates as. D1
 * makes the central UUID the browser's durable operational identity, so there
 * is one identity rather than two.
 *
 * THE ONLY IDENTITY MIGRATION WRITER. It touches `deviceId`, `deviceName` and
 * `deviceConfiguredAt` and nothing else: not the badge range, not
 * `nextBadge`, not the central binding, not the enrollment, not the lease,
 * not a single registration or outbox row.
 *
 * It is NEVER automatic. The identity stamped onto future attendee records is
 * a meaningful migration, so it happens on one explicit operator action
 * against a LIVE device session — never from a cached enrollment and never
 * from a signed offline lease.
 */

/** Why convergence cannot be offered. Not a conflict — just not possible yet. */
export type ConvergenceGap =
  | 'missing-config'
  | 'no-enrollment'
  | 'event-mismatch'

/**
 * Why convergence must NOT happen. Each means local and central disagree
 * about something that identity cannot paper over.
 */
export type ConvergenceConflict =
  | BadgeSafetyConflict
  /** Local event data exists with no local identity to attribute it to. */
  | 'local-data-without-identity'
  /** A badge-distributing desk cannot adopt a device that owns no range. */
  | 'local-range-without-central-range'

export interface ConvergenceIdentity {
  deviceId: string
  deviceName: string
}

export type ConvergencePlan =
  /** No local identity, nothing operated yet: adopt the central one. */
  | { outcome: 'fresh-setup'; to: ConvergenceIdentity }
  /** A legacy local identity exists and may be migrated. */
  | { outcome: 'ready'; from: ConvergenceIdentity; to: ConvergenceIdentity }
  /** Already the central identity. The name may still be refreshable. */
  | {
      outcome: 'already-converged'
      identity: ConvergenceIdentity
      /** The central name has changed since it was last stored. */
      nameRefreshAvailable: boolean
    }
  | { outcome: 'unavailable'; gap: ConvergenceGap }
  | { outcome: 'blocked'; conflict: ConvergenceConflict }

export interface ConvergenceFacts {
  config: EventConfig | undefined
  /** A LIVE session context. A cached enrollment is never acceptable here. */
  context: DeviceSessionContext
  registrationCount: number
  outboxCount: number
}

/**
 * Decides what convergence would do, without touching anything.
 *
 * Pure, so every branch of a migration decision is testable without a
 * database. The transaction below re-runs it against the row it is about to
 * write, so a stale read can never let a refused case through.
 */
export const planDeviceIdentityConvergence = (
  facts: ConvergenceFacts,
): ConvergencePlan => {
  const { config, context, registrationCount, outboxCount } = facts

  if (config === undefined) {
    return { outcome: 'unavailable', gap: 'missing-config' }
  }

  const grant = grantFromDeviceSession(context)

  /**
   * The enrollment is not authority and never creates any, but it must agree:
   * a browser enrolled as one device must not quietly take another's
   * identity. C1's own mismatch handling owns that case, and this refuses
   * rather than racing it.
   */
  const enrollment = config.centralDeviceEnrollment

  if (enrollment === undefined) {
    return { outcome: 'unavailable', gap: 'no-enrollment' }
  }

  const enrollmentConflict = checkEnrollment(grant, enrollment)

  if (enrollmentConflict !== null) {
    return { outcome: 'blocked', conflict: enrollmentConflict }
  }

  if (context.event.slug !== enrollment.eventSlug) {
    return { outcome: 'unavailable', gap: 'event-mismatch' }
  }

  /**
   * The SAME badge-ownership question C3B asks before authorizing
   * registration — but only when this browser HAS badge ownership to
   * protect. A browser with no range and no binding cannot conflict with a
   * central assignment, and C3B's `binding-missing` is about authorizing
   * issuance, not about whose identity this browser carries.
   *
   * That distinction is exactly §17: a central device may own #501-#600
   * while this browser has no range at all, and converging identity first is
   * safe. Adopting the range stays C2A's separate, physically confirmed act.
   */
  if (hasLocalBadgeOwnership(config)) {
    const badgeConflict = checkBadgeOwnership(grant, config)

    if (badgeConflict !== null) {
      return { outcome: 'blocked', conflict: badgeConflict }
    }
  }

  /**
   * Stricter than the badge-safety check on one point, deliberately. That
   * check tolerates a legacy hand-configured range with no binding and no
   * central assignment, because such a desk simply has no device authority
   * for registration. Pointing its allocator at a central device that owns
   * NO range is a different act, and it is the one this refuses.
   */
  if (config.badgeEnd !== undefined && grant.activeBadgeRange === null) {
    return { outcome: 'blocked', conflict: 'local-range-without-central-range' }
  }

  const to: ConvergenceIdentity = {
    deviceId: context.device.id,
    deviceName: context.device.name,
  }

  if (!isDeviceRegistered(config)) {
    /**
     * No local identity. If this browser has nonetheless operated, its
     * history cannot be attributed and stamping an identity onto it now
     * would be a guess. Reconciliation is a human's job.
     *
     * Not a race: a registration can only be written by a device that has an
     * identity, so with none present these counts cannot change underneath.
     */
    if (registrationCount > 0 || outboxCount > 0) {
      return { outcome: 'blocked', conflict: 'local-data-without-identity' }
    }

    return { outcome: 'fresh-setup', to }
  }

  if (config.deviceId === to.deviceId) {
    return {
      outcome: 'already-converged',
      identity: { deviceId: config.deviceId, deviceName: config.deviceName ?? '' },
      nameRefreshAvailable: config.deviceName !== to.deviceName,
    }
  }

  return {
    outcome: 'ready',
    from: { deviceId: config.deviceId ?? '', deviceName: config.deviceName ?? '' },
    to,
  }
}

export type ConvergenceResult =
  | { outcome: 'converged'; config: EventConfig }
  | { outcome: 'already-converged'; config: EventConfig }
  | Exclude<ConvergencePlan, { outcome: 'fresh-setup' | 'ready' | 'already-converged' }>

/**
 * Rewrites the local identity, atomically.
 *
 * ONE transaction over `config` ALONE. The registrations and outbox tables
 * are deliberately absent from it: they are not being mutated, and naming
 * them would suggest otherwise. Their counts are read beforehand and only
 * matter for a browser with no identity, where nothing can write them.
 *
 * `deviceConfiguredAt` is re-stamped because the operational identity
 * genuinely changed at that moment. Every other field is carried through.
 */
export const convergeDeviceIdentity = async (input: {
  context: DeviceSessionContext
}): Promise<ConvergenceResult> => {
  const [registrationCount, outboxCount] = await Promise.all([
    db.registrations.count(),
    db.outbox.count(),
  ])

  return await db.transaction('rw', db.config, async (): Promise<ConvergenceResult> => {
    const config = await db.config.get(EVENT_CONFIG_ID)

    const plan = planDeviceIdentityConvergence({
      config,
      context: input.context,
      registrationCount,
      outboxCount,
    })

    if (plan.outcome === 'already-converged') {
      // Idempotent: a second click churns no timestamp and writes nothing.
      return { outcome: 'already-converged', config: config as EventConfig }
    }

    if (plan.outcome !== 'fresh-setup' && plan.outcome !== 'ready') {
      return plan
    }

    const now = new Date().toISOString()

    const converged: EventConfig = {
      ...(config as EventConfig),
      deviceId: plan.to.deviceId,
      deviceName: plan.to.deviceName,
      deviceConfiguredAt: now,
      updatedAt: now,
    }

    await db.config.put(converged)

    return { outcome: 'converged', config: converged }
  })
}

export type NameRefreshResult =
  | { outcome: 'refreshed'; deviceName: string }
  | { outcome: 'unchanged' }
  | { outcome: 'not-converged' }
  | { outcome: 'missing-config' }

/**
 * Brings a CONVERGED browser's stored device name in line with the central
 * one, after a live verification.
 *
 * The central UUID is the stable authority; the name is editable Admin
 * metadata, so an Admin rename should show up here without a second
 * migration. It runs only when the identity already matches, changes only the
 * name, and leaves `deviceConfiguredAt` alone — a rename is not a new
 * identity.
 *
 * Never driven by an offline lease or by the cached enrollment: both can be
 * stale, and a name is not worth trusting unverified state for.
 */
export const refreshConvergedDeviceName = async (input: {
  context: DeviceSessionContext
}): Promise<NameRefreshResult> => {
  return await db.transaction('rw', db.config, async (): Promise<NameRefreshResult> => {
    const config = await db.config.get(EVENT_CONFIG_ID)

    if (config === undefined) {
      return { outcome: 'missing-config' }
    }

    if (config.deviceId !== input.context.device.id) {
      return { outcome: 'not-converged' }
    }

    if (config.deviceName === input.context.device.name) {
      return { outcome: 'unchanged' }
    }

    await db.config.put({
      ...config,
      deviceName: input.context.device.name,
      updatedAt: new Date().toISOString(),
    })

    return { outcome: 'refreshed', deviceName: input.context.device.name }
  })
}

/** The current plan, for display. Reads only. */
export const readDeviceIdentityConvergencePlan = async (
  context: DeviceSessionContext,
): Promise<{ plan: ConvergencePlan; config: EventConfig | undefined }> => {
  const [config, registrationCount, outboxCount] = await Promise.all([
    db.config.get(EVENT_CONFIG_ID),
    db.registrations.count(),
    db.outbox.count(),
  ])

  return {
    plan: planDeviceIdentityConvergence({ config, context, registrationCount, outboxCount }),
    config,
  }
}
