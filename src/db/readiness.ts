import { db } from '@/db/database'
import {
  countRemainingBadges,
  isBadgeDistributionConfigured,
  isDeviceRegistered,
} from '@/db/device'
import { EVENT_CONFIG_ID } from '@/db/types'

export type BadgeRangeStatus = 'available' | 'exhausted'

/** Counts only. No attendee name, phone, age or badge detail is ever read. */
export interface LocalDataCounts {
  completed: number
  held: number
  pendingSync: number
}

/**
 * Exactly the identity fields the readiness view needs — a deliberate
 * projection rather than the whole configuration row.
 *
 * `upiId`, `payeeName`, `amount` and the rest never enter the snapshot, so
 * they can never reach a copied summary or a diagnostics screenshot.
 */
export interface ReadinessDevice {
  deviceId: string
  deviceName: string
  /** ISO 8601 UTC. Absent on a record registered before this field existed. */
  deviceConfiguredAt?: string
}

/**
 * The badge module's own state, kept SEPARATE from device identity.
 *
 * A registered prize or dandiya desk reports `configured: false` and is
 * perfectly healthy. No range, next badge or remaining count is invented for
 * it — an absent range is an absent range, never an open-ended one.
 */
export type ReadinessBadgeDistribution =
  | { configured: false }
  | {
      configured: true
      badgeStart: number
      badgeEnd: number
      nextBadge: number
      remaining: number
      status: BadgeRangeStatus
    }

export type LocalReadiness =
  | {
      ok: true
      /** ISO 8601 UTC of the moment these values were read. */
      readAt: string
      device: ReadinessDevice
      badgeDistribution: ReadinessBadgeDistribution
      counts: LocalDataCounts
    }
  | {
      ok: false
      readAt: string
      /**
       * `missing-config` means the row is absent entirely; `not-registered`
       * means this device has never completed device registration.
       */
      reason: 'missing-config' | 'not-registered'
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

  /**
   * Fails closed on IDENTITY only. A registered device with no badge range is
   * a normal, healthy device — a prize or dandiya desk — not a broken one, so
   * readiness must work for it.
   */
  if (!isDeviceRegistered(config)) {
    return { ok: false, readAt, reason: 'not-registered', counts }
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
    },
    badgeDistribution: isBadgeDistributionConfigured(config)
      ? {
          configured: true,
          badgeStart: config.badgeStart,
          badgeEnd: config.badgeEnd,
          nextBadge: config.nextBadge,
          remaining: countRemainingBadges(config),
          status: config.nextBadge > config.badgeEnd ? 'exhausted' : 'available',
        }
      : { configured: false },
    counts,
  }
}
