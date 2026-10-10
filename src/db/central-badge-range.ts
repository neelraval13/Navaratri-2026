import { db } from '@/db/database'
import { isBadgeDistributionConfigured, isDeviceRegistered } from '@/db/device'
import {
  EVENT_CONFIG_ID,
  type CentralBadgeRangeBinding,
  type EventConfig,
} from '@/db/types'
import {
  withActiveBadgeRange,
  type DeviceSessionContext,
} from '@/device-auth/device-session-contract'
import {
  checkBadgeOwnership,
  grantFromDeviceSession,
  type BadgeSafetyConflict,
} from '@/device-auth/event-authorization'

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
 * A range the planner is handed purely to be judged, never to be stored.
 *
 * Adoption reads `assignedAt` from the CENTRAL assignment; a plan built from
 * a hypothetical range has no such value, and this marker makes a plan that
 * escaped into a write obvious instead of plausible. Nothing on these paths
 * writes, which the suite proves by observing the stored row.
 */
const HYPOTHETICAL_ASSIGNED_AT = 'hypothetical-range-never-persisted'

/**
 * A range this browser could probe its own local state against, when it has
 * no local range of its own. Any range is equally new to such a browser, so
 * the numbers carry no meaning beyond being valid.
 */
const PROBE_RANGE = { rangeStart: 1, rangeEnd: 1 }

/**
 * What a SELF-CLAIM could do, when central reports no assignment at all.
 *
 * It owns no safety rules of its own. Every verdict below is produced by
 * running the adoption planner above against the range a claim would create,
 * so "can this browser safely own range X?" has exactly ONE definition and
 * the claim UI cannot drift from the adoption UI.
 */
export type ClaimPlan =
  /** Central already owns a range here: adoption, not a claim, applies. */
  | { outcome: 'central-assignment-exists' }
  /** No local range and no issued badges: the operator types the stack. */
  | { outcome: 'claimable-fresh' }
  /**
   * A coherent local range exists. ONLY that exact range may be claimed —
   * letting the operator type a different one would leave the local
   * allocator immediately at odds with central ownership.
   */
  | {
      outcome: 'claimable-existing'
      rangeStart: number
      rangeEnd: number
      nextBadge: number
      issuedCount: number
    }
  /**
   * This browser believes it adopted a central range that central no longer
   * reports. Abnormal, and never resolved by claiming something new.
   */
  | { outcome: 'binding-without-assignment'; binding: CentralBadgeRangeBinding }
  /** Refused by the adoption planner, reported as exactly what it refused. */
  | { outcome: 'blocked'; plan: AdoptionPlan }

/**
 * Decides what a claim could do, without touching anything.
 *
 * The probe is the whole trick: an existing local range probes ITSELF,
 * because that is the only range it may claim; a browser with no range probes
 * a placeholder. Whatever the adoption planner then says about that range is
 * the answer.
 */
export const planCentralBadgeRangeClaim = (input: {
  config: EventConfig | undefined
  context: DeviceSessionContext
  issuedBadgeCount: number
}): ClaimPlan => {
  const { config, context, issuedBadgeCount } = input

  // A claim creates a FIRST assignment. With one already recorded there is
  // nothing to create, and adoption owns the situation.
  if (context.activeBadgeRange !== null) {
    return { outcome: 'central-assignment-exists' }
  }

  const coherentLocalRange =
    config !== undefined &&
    isPositiveInteger(config.badgeStart) &&
    isPositiveInteger(config.badgeEnd) &&
    config.badgeStart <= config.badgeEnd
      ? { rangeStart: config.badgeStart, rangeEnd: config.badgeEnd }
      : null

  const plan = planCentralBadgeRangeAdoption({
    config,
    context: withActiveBadgeRange(context, {
      ...(coherentLocalRange ?? PROBE_RANGE),
      assignedAt: HYPOTHETICAL_ASSIGNED_AT,
    }),
    issuedBadgeCount,
  })

  if (plan.outcome === 'adoptable') {
    return { outcome: 'claimable-fresh' }
  }

  if (plan.outcome === 'alignable') {
    return {
      outcome: 'claimable-existing',
      rangeStart: plan.assignment.rangeStart,
      rangeEnd: plan.assignment.rangeEnd,
      nextBadge: plan.nextBadge,
      issuedCount: issuedBadgeCount,
    }
  }

  /**
   * A binding exists and central reports nothing. The planner can only see
   * the probe, so it reports a match or a change; either way the real
   * situation is that local ownership history and central state disagree.
   */
  if (plan.outcome === 'already-adopted') {
    return { outcome: 'binding-without-assignment', binding: plan.binding }
  }

  if (plan.outcome === 'central-range-changed') {
    return { outcome: 'binding-without-assignment', binding: plan.binding }
  }

  return { outcome: 'blocked', plan }
}

/**
 * Would this browser be able to adopt `requested`, if central accepted it?
 *
 * Asked BEFORE the central reservation, because reserving a range and only
 * then discovering an obvious local conflict leaves a desk owning numbers it
 * cannot issue — and nothing releases a central range in this phase.
 *
 * The answer is the real planner's, against the real stored row. There is no
 * second copy of the safety matrix anywhere.
 */
export const checkCentralBadgeRangeClaimable = async (input: {
  context: DeviceSessionContext
  requested: { rangeStart: number; rangeEnd: number }
}): Promise<{ ok: true } | { ok: false; plan: AdoptionPlan }> => {
  const config = await db.config.get(EVENT_CONFIG_ID)
  const issuedBadgeCount = await db.registrations
    .where('status')
    .equals('completed')
    .count()

  const plan = planCentralBadgeRangeAdoption({
    config,
    context: withActiveBadgeRange(input.context, {
      rangeStart: input.requested.rangeStart,
      rangeEnd: input.requested.rangeEnd,
      assignedAt: HYPOTHETICAL_ASSIGNED_AT,
    }),
    issuedBadgeCount,
  })

  return plan.outcome === 'adoptable' || plan.outcome === 'alignable'
    ? { ok: true }
    : { ok: false, plan }
}

/**
 * Reads the current plans for display, without adopting or claiming anything.
 *
 * The page needs to describe local badge state beside the central assignment,
 * and must never make the operator infer one from the other.
 */
export const readCentralBadgeRangePlan = async (
  context: DeviceSessionContext,
): Promise<{
  plan: AdoptionPlan
  claim: ClaimPlan
  /** What a contiguous refill could do. Added by Phase D2.1. */
  refill: RefillPlan
  config: EventConfig | undefined
}> => {
  const config = await db.config.get(EVENT_CONFIG_ID)
  const issuedBadgeCount = await db.registrations
    .where('status')
    .equals('completed')
    .count()

  return {
    plan: planCentralBadgeRangeAdoption({ config, context, issuedBadgeCount }),
    claim: planCentralBadgeRangeClaim({ config, context, issuedBadgeCount }),
    refill: planCentralBadgeRangeRefill({ config, context }),
    config,
  }
}

/* ------------------------------------------------- contiguous badge refill */

/**
 * CONTIGUOUS REFILL: a desk that already owns a range receives more physical
 * badges and extends its range upward.
 *
 * It is an EXTENSION, never a replacement and never a second range. The
 * previous assignment keeps its identity, its `rangeStart` and its
 * `assignedAt`, so every badge already issued stays owned by the same device
 * and every queued outbox snapshot stays valid.
 *
 * `nextBadge` IS NEVER TOUCHED, on any path here. It is the local allocator
 * and its existing value is authoritative: a desk at #037 that receives
 * #051-#100 still issues #037 next. Recomputing it from the new batch's start
 * would skip every badge between.
 */

export type RefillUnavailableReason =
  | 'missing-config'
  | 'device-not-registered'
  | 'registration-not-permitted'
  /** No central assignment, so there is nothing to extend. */
  | 'no-central-assignment'
  /** No local range: this browser has not adopted anything yet. */
  | 'no-local-range'
  /** A local range with no central provenance. Adoption comes first. */
  | 'not-adopted'

export type RefillPlan =
  /**
   * Central, local and the binding all agree. The operator chooses only the
   * new END; `refillStart` is derived and must never be typed.
   */
  | {
      outcome: 'refillable'
      current: CentralAssignment
      refillStart: number
      nextBadge: number
    }
  /**
   * CENTRAL IS ALREADY AHEAD, in the one shape that is safely recoverable:
   * same device, same event, same `rangeStart`, same `assignedAt`, and a
   * strictly greater end. This is what a refill whose central half committed
   * and whose local half did not leaves behind, and finishing it locally is
   * an extension rather than a reinterpretation.
   */
  | {
      outcome: 'extension-pending'
      central: CentralAssignment
      local: { rangeStart: number; rangeEnd: number }
      nextBadge: number
    }
  /** Nothing is wrong; this desk simply has no range to extend. */
  | { outcome: 'unavailable'; reason: RefillUnavailableReason }
  /** Central and local badge ownership DISAGREE. Refilling would compound it. */
  | { outcome: 'blocked'; conflict: BadgeSafetyConflict }

export type SupersetRefusal =
  | 'missing-config'
  | 'device-not-registered'
  | 'no-central-assignment'
  | 'no-binding'
  | 'no-local-range'
  | 'binding-device-mismatch'
  | 'binding-event-mismatch'
  | 'range-start-mismatch'
  | 'assigned-at-mismatch'
  | 'local-binding-disagree'
  /** Central is not ahead. Equal is a no-op; smaller is never applied. */
  | 'not-an-extension'

export type SupersetCheck =
  | { ok: true; from: number; to: number }
  | { ok: false; reason: SupersetRefusal }

/**
 * Is the central range a SAFE SUPERSET extension of this browser's local
 * state?
 *
 * The whole rule, in one place, used both by the normal refill write and by
 * the recovery path. Every clause is load-bearing:
 *
 * - same device and event, or this is somebody else's range
 * - same `rangeStart`, or the start moved and badges already issued from the
 *   old start would belong to numbers this desk no longer owns
 * - same `assignedAt`, or this is a DIFFERENT grant that happens to begin at
 *   the same number
 * - the local range and the binding must already agree, or local state is
 *   inconsistent with its own provenance and nothing may be layered on it
 * - central strictly ahead, so a range is never decreased and an equal range
 *   is recognised as the no-op it is
 *
 * PURE, and it never reinterprets an unrelated central range as an extension.
 */
export const checkCentralRangeSuperset = (input: {
  config: EventConfig | undefined
  context: DeviceSessionContext
}): SupersetCheck => {
  const { config, context } = input

  if (config === undefined) {
    return { ok: false, reason: 'missing-config' }
  }

  if (!isDeviceRegistered(config)) {
    return { ok: false, reason: 'device-not-registered' }
  }

  const central = context.activeBadgeRange

  if (
    central === null ||
    !isPositiveInteger(central.rangeStart) ||
    !isPositiveInteger(central.rangeEnd) ||
    central.rangeStart > central.rangeEnd
  ) {
    return { ok: false, reason: 'no-central-assignment' }
  }

  const binding = config.centralBadgeRangeBinding

  if (binding === undefined) {
    return { ok: false, reason: 'no-binding' }
  }

  if (binding.deviceId !== context.device.id) {
    return { ok: false, reason: 'binding-device-mismatch' }
  }

  if (binding.eventId !== context.event.id) {
    return { ok: false, reason: 'binding-event-mismatch' }
  }

  if (
    !isPositiveInteger(config.badgeStart) ||
    !isPositiveInteger(config.badgeEnd) ||
    config.badgeStart > config.badgeEnd
  ) {
    return { ok: false, reason: 'no-local-range' }
  }

  if (binding.rangeStart !== central.rangeStart || config.badgeStart !== central.rangeStart) {
    return { ok: false, reason: 'range-start-mismatch' }
  }

  if (binding.assignedAt !== central.assignedAt) {
    return { ok: false, reason: 'assigned-at-mismatch' }
  }

  if (config.badgeEnd !== binding.rangeEnd) {
    return { ok: false, reason: 'local-binding-disagree' }
  }

  if (central.rangeEnd <= config.badgeEnd) {
    return { ok: false, reason: 'not-an-extension' }
  }

  return { ok: true, from: config.badgeEnd, to: central.rangeEnd }
}

/**
 * Decides what a refill COULD do, without touching anything.
 *
 * It owns no badge-safety rules of its own: whether central and local agree
 * is asked of `checkBadgeOwnership`, the SAME check the event access gate
 * runs before it authorizes registration. A refill UI that disagreed with the
 * gate would offer an action the desk could not then use.
 *
 * The superset check runs FIRST, because an extension already committed
 * centrally looks to the ownership check exactly like a mismatch — and
 * reporting it as a conflict would hide the one case that is recoverable.
 */
export const planCentralBadgeRangeRefill = (input: {
  config: EventConfig | undefined
  context: DeviceSessionContext
}): RefillPlan => {
  const { config, context } = input

  if (config === undefined) {
    return { outcome: 'unavailable', reason: 'missing-config' }
  }

  if (!isDeviceRegistered(config)) {
    return { outcome: 'unavailable', reason: 'device-not-registered' }
  }

  // Read from the CURRENT authenticated session, never the cached enrollment.
  if (!context.device.attributes.includes('registration')) {
    return { outcome: 'unavailable', reason: 'registration-not-permitted' }
  }

  const central = context.activeBadgeRange

  if (central === null) {
    return { outcome: 'unavailable', reason: 'no-central-assignment' }
  }

  if (config.badgeEnd === undefined) {
    return { outcome: 'unavailable', reason: 'no-local-range' }
  }

  if (config.centralBadgeRangeBinding === undefined) {
    return { outcome: 'unavailable', reason: 'not-adopted' }
  }

  const superset = checkCentralRangeSuperset({ config, context })

  if (superset.ok === true) {
    return {
      outcome: 'extension-pending',
      central: {
        rangeStart: central.rangeStart,
        rangeEnd: central.rangeEnd,
        assignedAt: central.assignedAt,
      },
      local: { rangeStart: config.badgeStart, rangeEnd: config.badgeEnd },
      nextBadge: config.nextBadge,
    }
  }

  const conflict = checkBadgeOwnership(grantFromDeviceSession(context), config)

  if (conflict !== null) {
    return { outcome: 'blocked', conflict }
  }

  return {
    outcome: 'refillable',
    current: {
      rangeStart: central.rangeStart,
      rangeEnd: central.rangeEnd,
      assignedAt: central.assignedAt,
    },
    // DERIVED, never typed: a refill with a gap is not a contiguous range.
    refillStart: central.rangeEnd + 1,
    nextBadge: config.nextBadge,
  }
}

export type RangeExtensionResult =
  /** `badgeEnd` and the binding's end advanced. Nothing else changed. */
  | { outcome: 'extended'; config: EventConfig; from: number; to: number }
  /** Local already matched the central end. Nothing was written. */
  | { outcome: 'already-extended'; config: EventConfig }
  /** Refused. Nothing was written. */
  | { outcome: 'refused'; reason: SupersetRefusal }

/**
 * Advances this browser's local range to the central one, atomically.
 *
 * ONE transaction over `config` ALONE. `registrations` and `outbox` are not
 * named, because they are not read and not written: a refill adds numbers to
 * the end of a range and says nothing about any badge already issued.
 *
 * It writes EXACTLY three things: `badgeEnd`, the binding's `rangeEnd`, and
 * `updatedAt`. `badgeStart`, `nextBadge`, `badgeConfiguredAt`, the device
 * identity, and every other binding and configuration field are carried
 * through by spread.
 *
 * The superset rule is re-run INSIDE the transaction against the row it is
 * about to write, so a stale read can never widen a range the planner would
 * have refused.
 */
export const extendLocalBadgeRange = async (input: {
  context: DeviceSessionContext
}): Promise<RangeExtensionResult> => {
  return await db.transaction(
    'rw',
    db.config,
    async (): Promise<RangeExtensionResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)
      const superset = checkCentralRangeSuperset({ config, context: input.context })

      if (superset.ok === false) {
        /**
         * Idempotent: a repeat, or a reload after the write landed, finds
         * local already at the central end. `not-an-extension` is only that
         * when the two are EQUAL — a central range that is somehow behind
         * local is a refusal, because nothing here ever shrinks a range.
         */
        if (
          superset.reason === 'not-an-extension' &&
          config?.badgeEnd === input.context.activeBadgeRange?.rangeEnd
        ) {
          return { outcome: 'already-extended', config: config as EventConfig }
        }

        return { outcome: 'refused', reason: superset.reason }
      }

      const current = config as EventConfig
      const binding = current.centralBadgeRangeBinding as CentralBadgeRangeBinding
      const now = new Date().toISOString()

      const widened: EventConfig = {
        ...current,
        badgeEnd: superset.to,
        centralBadgeRangeBinding: { ...binding, rangeEnd: superset.to },
        updatedAt: now,
      }

      await db.config.put(widened)

      return { outcome: 'extended', config: widened, from: superset.from, to: superset.to }
    },
  )
}
