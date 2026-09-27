import { db } from '@/db/database'
import { EVENT_CONFIG_ID, type EventConfig } from '@/db/types'
import { formatBadgeNumber } from '@/lib/badge'
import {
  isValidDeviceId,
  isValidDeviceName,
  normalizeDeviceName,
} from '@/shared/device'

/**
 * An EventConfig belonging to a device that has completed Device Setup.
 *
 * The narrowed type is what lets the write path state, in the type system, that
 * a configured device always has an identity and a finite range.
 */
export interface ConfiguredEventConfig extends EventConfig {
  deviceId: string
  deviceName: string
  badgeEnd: number
}

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * The single definition of "this device may register attendees".
 *
 * `nextBadge === badgeEnd + 1` is deliberately valid: it is how an exhausted
 * range is represented, and an exhausted desk is still a configured desk that
 * may hold registrations.
 *
 * The bootstrap defaults — `badgeStart: 1`, `nextBadge: 1`, no `badgeEnd`, no
 * device identity — must NOT satisfy this. That is what makes the existing
 * production device show Device Setup after deployment instead of silently
 * behaving as if it owned an open-ended range.
 */
export const isDeviceConfigured = (
  config: EventConfig,
): config is ConfiguredEventConfig => {
  return (
    isValidDeviceId(config.deviceId) &&
    isValidDeviceName(config.deviceName) &&
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
export const countRemainingBadges = (config: ConfiguredEventConfig): number => {
  return config.nextBadge > config.badgeEnd
    ? 0
    : config.badgeEnd - config.nextBadge + 1
}

export interface DeviceSetupInput {
  /** Raw operator input; normalized here. */
  deviceName: string
  badgeStart: number
  badgeEnd: number
}

export type ConfigureDeviceResult =
  | { outcome: 'configured'; config: ConfiguredEventConfig }
  | { outcome: 'missing-config' }
  | { outcome: 'already-configured'; config: ConfiguredEventConfig }
  | { outcome: 'invalid-name' }
  | { outcome: 'invalid-range' }
  | {
      outcome: 'existing-data'
      registrationCount: number
      outboxCount: number
    }

/**
 * One-time initial Device Setup.
 *
 * Fails closed around existing data: if this browser already holds
 * registrations or queued outbox rows, a device identity is NOT stamped onto
 * that history. Nothing is deleted or modified — the operator is told
 * reconciliation is required.
 *
 * Every unrelated configuration field — `eventName`, `currency`, `amount`,
 * `timezone`, `upiId`, `payeeName` — is carried through untouched.
 *
 * Range assignment is one-time in Phase 7A. There is deliberately no edit or
 * reset path: changing a range while other devices are operating offline is
 * exactly how two desks hand out the same physical badge.
 */
export const configureDevice = async (
  input: DeviceSetupInput,
): Promise<ConfigureDeviceResult> => {
  const deviceName = normalizeDeviceName(input.deviceName)

  if (!isValidDeviceName(deviceName)) {
    return { outcome: 'invalid-name' }
  }

  if (
    !isPositiveInteger(input.badgeStart) ||
    !isPositiveInteger(input.badgeEnd) ||
    input.badgeStart > input.badgeEnd
  ) {
    return { outcome: 'invalid-range' }
  }

  return await db.transaction(
    'rw',
    db.registrations,
    db.config,
    db.outbox,
    async (): Promise<ConfigureDeviceResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)

      if (config === undefined) {
        return { outcome: 'missing-config' }
      }

      if (isDeviceConfigured(config)) {
        return { outcome: 'already-configured', config }
      }

      const registrationCount = await db.registrations.count()
      const outboxCount = await db.outbox.count()

      if (registrationCount > 0 || outboxCount > 0) {
        return { outcome: 'existing-data', registrationCount, outboxCount }
      }

      const now = new Date().toISOString()

      const configured: ConfiguredEventConfig = {
        ...config,
        deviceId: crypto.randomUUID(),
        deviceName,
        badgeStart: input.badgeStart,
        badgeEnd: input.badgeEnd,
        nextBadge: input.badgeStart,
        deviceConfiguredAt: now,
        updatedAt: now,
      }

      await db.config.put(configured)

      return { outcome: 'configured', config: configured }
    },
  )
}
