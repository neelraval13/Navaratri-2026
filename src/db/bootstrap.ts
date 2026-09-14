import { db } from '@/db/database'
import { applyUpiEnvironment } from '@/db/event-config'
import { EVENT_CONFIG_ID, type EventConfig } from '@/db/types'

const DEFAULT_EVENT_NAME = 'Navaratri 2026'

const DEFAULT_CURRENCY = 'INR'

const DEFAULT_AMOUNT = 20

const DEFAULT_TIMEZONE = 'Asia/Kolkata'

const DEFAULT_BADGE_START = 1

/**
 * `badgeEnd` is deliberately left undefined until the operator supplies a badge
 * range. `upiId` and `payeeName` come from the environment, applied separately.
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
 * The organizer's personal UPI details, supplied per environment so real values
 * are never committed. Read once here rather than anywhere else, so EventConfig
 * remains the application's single source of truth for them.
 */
const readUpiEnvironment = () => {
  return {
    upiId: import.meta.env.VITE_UPI_ID,
    payeeName: import.meta.env.VITE_UPI_PAYEE_NAME,
  }
}

/**
 * Opens the local database, seeds the event configuration row exactly once, and
 * brings the stored UPI details in line with the environment.
 *
 * Idempotent by construction: the row is created only when the read inside the
 * same transaction finds nothing, and the UPI merge rewrites it only when a
 * supplied value actually differs. Badge state — `nextBadge`, `badgeStart`,
 * `badgeEnd` — is never touched, so correcting the UPI details and restarting
 * costs nothing.
 *
 * Nothing here deletes, clears or resets data.
 */
const runBootstrap = async (): Promise<void> => {
  await db.open()

  await db.transaction('rw', db.config, async () => {
    const existingConfig = await db.config.get(EVENT_CONFIG_ID)
    const environment = readUpiEnvironment()

    if (existingConfig === undefined) {
      // Applied before the insert, so a first run is a single write.
      await db.config.add(
        applyUpiEnvironment(createDefaultEventConfig(), environment),
      )

      return
    }

    const patchedConfig = applyUpiEnvironment(existingConfig, environment)

    // Same reference means nothing changed; do not rewrite on every startup.
    if (patchedConfig === existingConfig) {
      return
    }

    await db.config.put(patchedConfig)
  })
}

let bootstrapPromise: Promise<void> | null = null

/**
 * The application's single bootstrap entry point.
 *
 * The first caller starts the work and every later caller awaits the same
 * promise, so remounts, StrictMode double effects and a retry can never run two
 * bootstraps concurrently. A failed attempt clears the memo so a retry starts a
 * genuinely new attempt.
 */
export const bootstrapDatabase = (): Promise<void> => {
  bootstrapPromise ??= runBootstrap().catch((error: unknown) => {
    bootstrapPromise = null

    throw error
  })

  return bootstrapPromise
}
