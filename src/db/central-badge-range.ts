import { db } from '@/db/database'
import { isBadgeDistributionConfigured, isDeviceRegistered } from '@/db/device'
import {
  EVENT_CONFIG_ID,
  type CentralBadgeRangeBinding,
  type EventConfig,
} from '@/db/types'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'

/**
 * Adopting a CENTRAL badge assignment into this browser's LOCAL badge workflow.
 *
 * Central Postgres records which physical badge numbers a device owns. It is
 * NOT the allocator: `nextBadge` stays local, because issuing a badge must
 * work with no network. Adoption copies the RANGE once, deliberately, and then
 * the existing local model does all the work exactly as before.
 *
 * Nothing here is automatic. A database assignment proves ownership; it does
 * not prove the physical badge stack is sitting at this desk. Only an operator
 * confirming that can start local issuance.
 *
 * Every refusal writes NOTHING, and no path ever modifies a registration or an
 * outbox row — registrations are read only to establish safety.
 */

/** The central range as the session endpoint reports it. */
export interface CentralAssignment {
  rangeStart: number
  rangeEnd: number
  assignedAt: string
}

export type AdoptionPlan =
  /** Nothing local to adopt into. */
  | { outcome: 'missing-config' }
  /**
   * Transitional: this browser still needs its Phase 7 local identity. A local
   * id is NEVER generated here, and the central UUID is never copied into it.
   */
  | { outcome: 'device-not-registered' }
  /** The authenticated central device may not run the registration workflow. */
  | { outcome: 'registration-not-permitted' }
  /** No central assignment exists. Creating one is a later phase. */
  | { outcome: 'no-central-assignment' }
  /** Fresh, compatible browser: the range may be adopted. */
  | { outcome: 'adoptable'; assignment: CentralAssignment }
  /**
   * The local range already equals the central one. This is an alignment, not
   * a setup: `nextBadge` and the existing badge history are preserved.
   */
  | { outcome: 'alignable'; assignment: CentralAssignment; nextBadge: number }
  /** Already bound to this exact device and range. Idempotent. */
  | { outcome: 'already-adopted'; binding: CentralBadgeRangeBinding }
  /**
   * Badges have been issued locally while no range is configured. Historical
   * inconsistency: reconstructing a counter from issued numbers could skip a
   * badge already taken out of the stack, so it needs a human.
   */
  | { outcome: 'issued-badges-without-range'; issuedCount: number }
  /** The local range is not the central range. Never reconciled silently. */
  | {
      outcome: 'range-conflict'
      assignment: CentralAssignment
      local: { rangeStart: number; rangeEnd: number }
    }
  /** The local range matches but its counter is outside the valid interval. */
  | {
      outcome: 'incoherent-next-badge'
      assignment: CentralAssignment
      nextBadge: number
    }
  /** The local range came from a DIFFERENT central device. */
  | {
      outcome: 'binding-device-conflict'
      binding: CentralBadgeRangeBinding
      attemptedDeviceId: string
    }
  /** Central now reports a different range than the one bound locally. */
  | {
      outcome: 'central-range-changed'
      binding: CentralBadgeRangeBinding
      assignment: CentralAssignment
    }

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const sameRange = (
  left: { rangeStart: number; rangeEnd: number },
  right: { rangeStart: number; rangeEnd: number },
): boolean => {
  return left.rangeStart === right.rangeStart && left.rangeEnd === right.rangeEnd
}

/**
 * Decides what adoption WOULD do, without touching anything.
 *
 * Pure, so every branch of the safety matrix is testable without a database,
 * and so the UI can describe the situation before offering an action. The
 * transaction below re-runs it against the row it is about to write, so a
 * stale read can never let a refused case through.
 */
export const planCentralBadgeRangeAdoption = (input: {
  config: EventConfig | undefined
  context: DeviceSessionContext
  issuedBadgeCount: number
}): AdoptionPlan => {
  const { config, context, issuedBadgeCount } = input

  if (config === undefined) {
    return { outcome: 'missing-config' }
  }

  // Transitional: the local identity stamps registration provenance and is
  // still this browser's own. It must exist first, and is never invented here.
  if (!isDeviceRegistered(config)) {
    return { outcome: 'device-not-registered' }
  }

  /**
   * Read from the CURRENT authenticated session, never from the cached
   * enrollment: an Admin can remove the capability without a new cookie.
   */
  if (!context.device.attributes.includes('registration')) {
    return { outcome: 'registration-not-permitted' }
  }

  const range = context.activeBadgeRange

  if (
    range === null ||
    !isPositiveInteger(range.rangeStart) ||
    !isPositiveInteger(range.rangeEnd) ||
    range.rangeStart > range.rangeEnd
  ) {
    return { outcome: 'no-central-assignment' }
  }

  const assignment: CentralAssignment = {
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    assignedAt: range.assignedAt,
  }

  const binding = config.centralBadgeRangeBinding

  if (binding !== undefined) {
    // A range adopted for one central device is never silently handed to
    // another, whatever the browser is currently signed in as.
    if (binding.deviceId !== context.device.id) {
      return {
        outcome: 'binding-device-conflict',
        binding,
        attemptedDeviceId: context.device.id,
      }
    }

    if (!sameRange(binding, assignment)) {
      return { outcome: 'central-range-changed', binding, assignment }
    }
  }

  /**
   * Whether a local range EXISTS, which is a different question from whether
   * it is usable. `isBadgeDistributionConfigured` answers the second, and
   * keying the branch on it would send a desk whose counter has drifted down
   * the fresh-setup path — silently resetting `nextBadge` and reissuing badges
   * already handed out. A present `badgeEnd` means the operator configured a
   * range, so it is examined rather than overwritten.
   */
  const hasLocalRange = config.badgeEnd !== undefined

  if (hasLocalRange) {
    if (
      !isPositiveInteger(config.badgeStart) ||
      !isPositiveInteger(config.badgeEnd) ||
      config.badgeStart > config.badgeEnd
    ) {
      return {
        outcome: 'incoherent-next-badge',
        assignment,
        nextBadge: config.nextBadge,
      }
    }

    const local = { rangeStart: config.badgeStart, rangeEnd: config.badgeEnd }

    if (!sameRange(local, assignment)) {
      return { outcome: 'range-conflict', assignment, local }
    }

    // The range matches, so the counter decides. Checked against the
    // ASSIGNMENT's interval and against the local model's own invariant, so a
    // drift in either definition fails closed instead of being papered over.
    if (
      !isBadgeDistributionConfigured(config) ||
      config.nextBadge < assignment.rangeStart ||
      config.nextBadge > assignment.rangeEnd + 1
    ) {
      return {
        outcome: 'incoherent-next-badge',
        assignment,
        nextBadge: config.nextBadge,
      }
    }

    if (binding !== undefined) {
      return { outcome: 'already-adopted', binding }
    }

    return { outcome: 'alignable', assignment, nextBadge: config.nextBadge }
  }

  /**
   * No configured range, yet badges have been issued. Historical state that
   * needs a human: see the outcome's own note.
   */
  if (issuedBadgeCount > 0) {
    return { outcome: 'issued-badges-without-range', issuedCount: issuedBadgeCount }
  }

  return { outcome: 'adoptable', assignment }
}

export type AdoptionResult =
  /** Fresh setup: the range was written and `nextBadge` starts at its first. */
  | { outcome: 'adopted'; config: EventConfig }
  /** Existing identical range linked to central; `nextBadge` preserved. */
  | { outcome: 'aligned'; config: EventConfig }
  /** Nothing to do; the binding already matched. */
  | { outcome: 'already-adopted'; config: EventConfig }
  /** The operator has not confirmed the physical badges are present. */
  | { outcome: 'stack-not-confirmed' }
  | Exclude<AdoptionPlan, { outcome: 'adoptable' | 'alignable' | 'already-adopted' }>

/**
 * Adopts a verified central assignment into local badge state, atomically.
 *
 * ONE transaction over `config` decides and writes, re-planning against the
 * row it is about to modify, so the range and its provenance can never land
 * separately. `registrations` is opened read-only, to count issued badges.
 *
 * The caller must pass a context the server has just confirmed. A cached
 * enrollment is never sufficient: a device may not establish central ownership
 * while offline.
 */
export const adoptCentralBadgeRange = async (input: {
  context: DeviceSessionContext
  physicalStackConfirmed: boolean
}): Promise<AdoptionResult> => {
  return await db.transaction(
    'rw',
    db.config,
    db.registrations,
    async (): Promise<AdoptionResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)

      /**
       * A completed registration is exactly one consumed physical badge; a held
       * one never carries a number. Counted by status, the domain invariant,
       * rather than inferred from the registration total.
       */
      const issuedBadgeCount = await db.registrations
        .where('status')
        .equals('completed')
        .count()

      const plan = planCentralBadgeRangeAdoption({
        config,
        context: input.context,
        issuedBadgeCount,
      })

      if (plan.outcome === 'already-adopted') {
        // Idempotent: `adoptedAt` is NOT re-stamped, so a reload or a second
        // click does not rewrite when this desk took the badges.
        return { outcome: 'already-adopted', config: config as EventConfig }
      }

      if (plan.outcome !== 'adoptable' && plan.outcome !== 'alignable') {
        return plan
      }

      // Checked after the plan so a refusal is reported for the real reason
      // rather than hidden behind an unticked box.
      if (!input.physicalStackConfirmed) {
        return { outcome: 'stack-not-confirmed' }
      }

      const now = new Date().toISOString()
      const current = config as EventConfig

      const binding: CentralBadgeRangeBinding = {
        deviceId: input.context.device.id,
        eventId: input.context.event.id,
        rangeStart: plan.assignment.rangeStart,
        rangeEnd: plan.assignment.rangeEnd,
        assignedAt: plan.assignment.assignedAt,
        adoptedAt: now,
      }

      if (plan.outcome === 'alignable') {
        /**
         * ALIGNMENT, not setup. The range already matches, so `nextBadge`,
         * `badgeConfiguredAt` and every issued registration stay exactly as
         * they are — this desk has already handed badges out, and restarting
         * its counter would reissue them.
         */
        const aligned: EventConfig = {
          ...current,
          centralBadgeRangeBinding: binding,
          updatedAt: now,
        }

        await db.config.put(aligned)

        return { outcome: 'aligned', config: aligned }
      }

      /**
       * FRESH setup. `nextBadge` starts at `badgeStart`, the same canonical
       * invariant `configureBadgeDistribution` uses, and `badgeConfiguredAt`
       * records the deliberate act — including the physical confirmation,
       * which the local model expresses through that timestamp rather than a
       * field of its own.
       */
      const adopted: EventConfig = {
        ...current,
        badgeStart: plan.assignment.rangeStart,
        badgeEnd: plan.assignment.rangeEnd,
        nextBadge: plan.assignment.rangeStart,
        badgeConfiguredAt: now,
        centralBadgeRangeBinding: binding,
        updatedAt: now,
      }

      await db.config.put(adopted)

      return { outcome: 'adopted', config: adopted }
    },
  )
}

/** The adopted-range provenance, if this browser has any. Read-only. */
export const readCentralBadgeRangeBinding = async (): Promise<
  CentralBadgeRangeBinding | undefined
> => {
  const config = await db.config.get(EVENT_CONFIG_ID)

  return config?.centralBadgeRangeBinding
}

/**
 * Reads the current plan for display, without adopting anything.
 *
 * The page needs to describe local badge state beside the central assignment,
 * and must never make the operator infer one from the other.
 */
export const readCentralBadgeRangePlan = async (
  context: DeviceSessionContext,
): Promise<{ plan: AdoptionPlan; config: EventConfig | undefined }> => {
  const config = await db.config.get(EVENT_CONFIG_ID)
  const issuedBadgeCount = await db.registrations
    .where('status')
    .equals('completed')
    .count()

  return {
    plan: planCentralBadgeRangeAdoption({ config, context, issuedBadgeCount }),
    config,
  }
}
