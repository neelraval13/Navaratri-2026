import { db } from '@/db/database'
import { countRemainingBadges, isDeviceConfigured } from '@/db/device'
import { EVENT_CONFIG_ID } from '@/db/types'

export type BadgeRangeStatus = 'available' | 'exhausted'

/**
 * Exactly the device fields the readiness view needs — a deliberate projection
 * rather than the whole configuration row.
 *
 * `upiId`, `payeeName`, `amount` and the rest never enter the snapshot, so they
 * can never reach a copied summary or a diagnostics screenshot by accident.
 */
export interface ReadinessDevice {
  deviceId: string
  deviceName: string
  /** ISO 8601 UTC. Absent on a record configured before this field existed. */
  deviceConfiguredAt?: string
  badgeStart: number
  badgeEnd: number
  nextBadge: number
}

/** Counts only. No attendee name, phone, age or badge detail is ever read. */
export interface LocalDataCounts {
  completed: number
  held: number
  pendingSync: number
}

export type LocalReadiness =
  | {
      ok: true
      /** ISO 8601 UTC of the moment these values were read. */
      readAt: string
      device: ReadinessDevice
      rangeStatus: BadgeRangeStatus
      remaining: number
      counts: LocalDataCounts
    }
  | {
      ok: false
      readAt: string
      /**
       * `missing-config` means the row is absent entirely; `not-configured`
       * means it exists but this device has never completed Device Setup, or
       * its stored range no longer satisfies the configured-device rule.
       */
      reason: 'missing-config' | 'not-configured'
      counts: LocalDataCounts
    }

/**
 * Reads the CURRENT local operational state, directly from IndexedDB.
 *
 * Deliberately not derived from any component's `useEventConfig()` instance.
 * `nextBadge` and the outbox count change as the desk works, and a second hook
 * instance is not refreshed by the one the registration form updates after an
 * issue — a diagnostics screen showing a stale badge number is worse than
 * showing none.
 *
 * READ ONLY. This function performs no write of any kind: no config write, no
 * registration write, no outbox write, and nothing is created or repaired.
 */
export const readLocalReadiness = async (): Promise<LocalReadiness> => {
  const readAt = new Date().toISOString()

  const [config, completed, held, pendingSync] = await Promise.all([
    db.config.get(EVENT_CONFIG_ID),
    db.registrations.where('status').equals('completed').count(),
    db.registrations.where('status').equals('held').count(),
    db.outbox.count(),
  ])

  const counts: LocalDataCounts = { completed, held, pendingSync }

  if (config === undefined) {
    return { ok: false, readAt, reason: 'missing-config', counts }
  }

  // Fails closed: an unconfigured or incoherent range is reported as invalid
  // rather than guessed at, and an open-ended range is never inferred.
  if (!isDeviceConfigured(config)) {
    return { ok: false, readAt, reason: 'not-configured', counts }
  }

  return {
    ok: true,
    readAt,
    device: {
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      ...(config.deviceConfiguredAt === undefined
        ? {}
        : { deviceConfiguredAt: config.deviceConfiguredAt }),
      badgeStart: config.badgeStart,
      badgeEnd: config.badgeEnd,
      nextBadge: config.nextBadge,
    },
    rangeStatus: config.nextBadge > config.badgeEnd ? 'exhausted' : 'available',
    remaining: countRemainingBadges(config),
    counts,
  }
}
