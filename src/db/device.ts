import { db } from '@/db/database'
import { EVENT_CONFIG_ID, type EventConfig } from '@/db/types'
import { formatBadgeNumber } from '@/lib/badge'
import {
  isValidDeviceId,
  isValidDeviceName,
  normalizeDeviceName,
} from '@/shared/device'

/**
 * Device identity and badge ownership are two DIFFERENT things.
 *
 * A physical event device has one stable identity. Whether it also hands out
 * badges is a property of the badge module, not of the device — a prize desk
 * or a dandiya desk is a perfectly real registered device that owns no badges
 * at all, and one device may later serve several modules at once.
 *
 * Modelling this as a single `deviceType` would be wrong for exactly that
 * reason, so the two questions are asked separately.
 */

/** A device that has completed generic registration. */
export interface RegisteredEventConfig extends EventConfig {
  deviceId: string
  deviceName: string
}

/** A registered device that additionally owns a finite badge range. */
export interface BadgeDistributionConfig extends RegisteredEventConfig {
  badgeEnd: number
}

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Is this a registered physical event device?
 *
 * Identity only: a name and a stable id. It deliberately says NOTHING about
 * badges, so a device registered for any module satisfies it.
 *
 * `deviceConfiguredAt` is not required. A legacy Phase 7 device that predates
 * the field is still a registered device, and re-registering one would mint a
 * new id for hardware that already has one.
 */
export const isDeviceRegistered = (
  config: EventConfig,
): config is RegisteredEventConfig => {
  return isValidDeviceId(config.deviceId) && isValidDeviceName(config.deviceName)
}

/**
 * May this device hand out physical badges?
 *
 * Requires registration PLUS a coherent finite range. `nextBadge === badgeEnd
 * + 1` is deliberately valid: that is how an exhausted range is represented,
 * and an exhausted desk still holds registrations.
 *
 * Bootstrap defaults — `badgeStart: 1`, `nextBadge: 1`, no `badgeEnd` — must
 * NOT satisfy this. Badge ownership is granted by a deliberate act, never
 * inferred from a default, and an open-ended range is never inferred at all:
 * it is precisely how two offline desks issue the same physical badge.
 */
export const isBadgeDistributionConfigured = (
  config: EventConfig,
): config is BadgeDistributionConfig => {
  return (
    isDeviceRegistered(config) &&
    isPositiveInteger(config.badgeStart) &&
    isPositiveInteger(config.badgeEnd) &&
    config.badgeStart <= config.badgeEnd &&
    isPositiveInteger(config.nextBadge) &&
    config.badgeStart <= config.nextBadge &&
    config.nextBadge <= config.badgeEnd + 1
  )
}

/** `#001–#250`. Never truncated above 999. */
export const formatBadgeRange = (start: number, end: number): string => {
  return `${formatBadgeNumber(start)}–${formatBadgeNumber(end)}`
}

/** Badges this desk can still issue. Zero once the range is exhausted. */
export const countRemainingBadges = (config: BadgeDistributionConfig): number => {
  return config.nextBadge > config.badgeEnd
    ? 0
    : config.badgeEnd - config.nextBadge + 1
}

export type RegisterDeviceResult =
  | { outcome: 'registered'; config: RegisteredEventConfig }
  | { outcome: 'missing-config' }
  | { outcome: 'already-registered'; config: RegisteredEventConfig }
  | { outcome: 'invalid-name' }
  | { outcome: 'existing-data'; registrationCount: number; outboxCount: number }

/**
 * One-time generic device registration. THE ONLY device-identity writer.
 *
 * It assigns a name and a stable id, and nothing else. It never asks for or
 * writes `badgeStart`, `badgeEnd` or `nextBadge`, because a registered device
 * does not necessarily distribute badges.
 *
 * Fails closed around existing data: if this browser already holds
 * registrations or queued outbox rows, a NEW identity is not stamped onto that
 * history. Nothing is deleted or modified — the operator is told
 * reconciliation is required.
 *
 * Every unrelated configuration field is carried through untouched.
 */
export const registerDevice = async (input: {
  deviceName: string
}): Promise<RegisterDeviceResult> => {
  const deviceName = normalizeDeviceName(input.deviceName)

  if (!isValidDeviceName(deviceName)) {
    return { outcome: 'invalid-name' }
  }

  return await db.transaction(
    'rw',
    db.registrations,
    db.config,
    db.outbox,
    async (): Promise<RegisterDeviceResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)

      if (config === undefined) {
        return { outcome: 'missing-config' }
      }

      if (isDeviceRegistered(config)) {
        return { outcome: 'already-registered', config }
      }

      const registrationCount = await db.registrations.count()
      const outboxCount = await db.outbox.count()

      if (registrationCount > 0 || outboxCount > 0) {
        return { outcome: 'existing-data', registrationCount, outboxCount }
      }

      const now = new Date().toISOString()

      const registered: RegisteredEventConfig = {
        ...config,
        deviceId: crypto.randomUUID(),
        deviceName,
        deviceConfiguredAt: now,
        updatedAt: now,
      }

      await db.config.put(registered)

      return { outcome: 'registered', config: registered }
    },
  )
}

export interface BadgeDistributionInput {
  badgeStart: number
  badgeEnd: number
  /** The operator must confirm the matching physical stack is at this desk. */
  physicalStackConfirmed: boolean
}

export type ConfigureBadgeDistributionResult =
  | { outcome: 'configured'; config: BadgeDistributionConfig }
  | { outcome: 'missing-config' }
  | { outcome: 'device-not-registered' }
  | { outcome: 'already-configured'; config: BadgeDistributionConfig }
  | { outcome: 'invalid-range' }
  | { outcome: 'stack-not-confirmed' }

/**
 * One-time badge-range assignment. THE ONLY badge-range writer.
 *
 * Requires an already-registered device: badge ownership attaches to an
 * existing identity rather than creating one, so re-running it can never mint
 * a second device id.
 *
 * The physical-stack confirmation is mandatory here rather than at device
 * registration, because it is a statement about badges, not about hardware.
 * The software cannot verify it; only the person placing the stack can.
 *
 * Assignment is one-time. There is deliberately no edit, extension or reset
 * path — changing a range while other desks operate offline is how two
 * attendees end up with the same badge number. That is Phase 7C.
 *
 * `deviceId`, `deviceName`, `deviceConfiguredAt`, the UPI details and every
 * event setting are preserved exactly.
 */
export const configureBadgeDistribution = async (
  input: BadgeDistributionInput,
): Promise<ConfigureBadgeDistributionResult> => {
  if (
    !isPositiveInteger(input.badgeStart) ||
    !isPositiveInteger(input.badgeEnd) ||
    input.badgeStart > input.badgeEnd
  ) {
    return { outcome: 'invalid-range' }
  }

  if (!input.physicalStackConfirmed) {
    return { outcome: 'stack-not-confirmed' }
  }

  return await db.transaction(
    'rw',
    db.config,
    async (): Promise<ConfigureBadgeDistributionResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)

      if (config === undefined) {
        return { outcome: 'missing-config' }
      }

      if (!isDeviceRegistered(config)) {
        return { outcome: 'device-not-registered' }
      }

      if (isBadgeDistributionConfigured(config)) {
        return { outcome: 'already-configured', config }
      }

      const now = new Date().toISOString()

      const configured: BadgeDistributionConfig = {
        ...config,
        badgeStart: input.badgeStart,
        badgeEnd: input.badgeEnd,
        nextBadge: input.badgeStart,
        badgeConfiguredAt: now,
        updatedAt: now,
      }

      await db.config.put(configured)

      return { outcome: 'configured', config: configured }
    },
  )
}
