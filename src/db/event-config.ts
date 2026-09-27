import { db } from '@/db/database'
import { isDeviceConfigured } from '@/db/device'
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
 * Whether a badge can still be allocated from this desk's assigned range.
 *
 * An UNCONFIGURED device never has a badge available. Phase 7 permits no
 * open-ended range: badge uniqueness across offline devices rests entirely on
 * each desk owning a finite, non-overlapping slice, so a desk with no assigned
 * end owns nothing and must issue nothing.
 *
 * Allocation never wraps back to `badgeStart` and never skips to another free
 * number.
 *
 * The UI and the issuance transaction share this one rule so a stale UI can
 * never disagree with what the database will actually allow.
 */
export const hasBadgeAvailable = (config: EventConfig): boolean => {
  return isDeviceConfigured(config) && config.nextBadge <= config.badgeEnd
}

export interface UpiEnvironment {
  upiId?: string
  payeeName?: string
}

/**
 * Merges environment-supplied UPI details into the stored configuration.
 *
 * Returns the SAME object reference when nothing changes, so the caller can skip
 * the write entirely — startup must not rewrite the config row on every reload.
 *
 * Rules, deliberately conservative because this runs on every start:
 *
 * - environment value absent or blank → the stored value is left alone, so a
 *   missing `.env.local` never wipes details that are already configured
 * - environment value identical to the stored one → no write
 * - environment value different → ONLY that field changes
 *
 * Every unrelated field — `nextBadge`, `badgeStart`, `badgeEnd`, `amount`,
 * `eventName`, `timezone`, `currency` — is carried through untouched, so
 * correcting the UPI details later never disturbs badge state.
 */
export const applyUpiEnvironment = (
  config: EventConfig,
  environment: UpiEnvironment,
): EventConfig => {
  const upiId = environment.upiId?.trim() ?? ''
  const payeeName = environment.payeeName?.trim() ?? ''

  const nextUpiId = upiId === '' ? config.upiId : upiId
  const nextPayeeName = payeeName === '' ? config.payeeName : payeeName

  if (nextUpiId === config.upiId && nextPayeeName === config.payeeName) {
    return config
  }

  return {
    ...config,
    ...(nextUpiId === undefined ? {} : { upiId: nextUpiId }),
    ...(nextPayeeName === undefined ? {} : { payeeName: nextPayeeName }),
    updatedAt: new Date().toISOString(),
  }
}
