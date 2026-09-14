import { db } from '@/db/database'
import { EVENT_CONFIG_ID, type EventConfig } from '@/db/types'

/**
 * Reads the single deterministic event configuration row.
 *
 * Bootstrap creates it, so `undefined` means something is wrong rather than
 * "not set up yet". Callers must fail closed rather than invent defaults.
 */
export const readEventConfig = async (): Promise<EventConfig | undefined> => {
  return await db.config.get(EVENT_CONFIG_ID)
}

/**
 * Whether a badge can still be allocated from this desk's configured range.
 *
 * `badgeEnd` is optional; when it is absent the range is open-ended. Allocation
 * never wraps back to `badgeStart`.
 *
 * The UI and the issuance transaction share this one rule so a stale UI can
 * never disagree with what the database will actually allow.
 */
export const hasBadgeAvailable = (config: EventConfig): boolean => {
  return config.badgeEnd === undefined || config.nextBadge <= config.badgeEnd
}
