import { db } from '@/db/database'
import { EVENT_CONFIG_ID, type EventConfig } from '@/db/types'

const DEFAULT_EVENT_NAME = 'Navaratri 2026'

const DEFAULT_CURRENCY = 'INR'

const DEFAULT_AMOUNT = 20

const DEFAULT_TIMEZONE = 'Asia/Kolkata'

const DEFAULT_BADGE_START = 1

/**
 * `badgeEnd`, `upiId` and `payeeName` are deliberately left undefined until the
 * operator supplies them in a later phase.
 */
const createDefaultEventConfig = (): EventConfig => {
  return {
    id: EVENT_CONFIG_ID,
    eventName: DEFAULT_EVENT_NAME,
    currency: DEFAULT_CURRENCY,
    amount: DEFAULT_AMOUNT,
    timezone: DEFAULT_TIMEZONE,
    badgeStart: DEFAULT_BADGE_START,
    nextBadge: DEFAULT_BADGE_START,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Opens the local database and seeds the event configuration row exactly once.
 *
 * Idempotent by construction: the row is only ever created with `add`, never
 * `put`, and only when the read inside the same transaction finds nothing. An
 * existing config row is left untouched, so `nextBadge`, badge ranges and any
 * future UPI details survive every reload.
 *
 * Nothing here deletes, clears or resets data.
 */
export const bootstrapDatabase = async (): Promise<void> => {
  await db.open()

  await db.transaction('rw', db.config, async () => {
    const existingConfig = await db.config.get(EVENT_CONFIG_ID)

    if (existingConfig !== undefined) {
      return
    }

    await db.config.add(createDefaultEventConfig())
  })
}
