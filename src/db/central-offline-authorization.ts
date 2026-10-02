import { db } from '@/db/database'
import {
  EVENT_CONFIG_ID,
  type CentralDeviceOfflineAuthorization,
} from '@/db/types'

/**
 * The local store of this browser's signed offline authorization lease.
 *
 * ONE optional field on the EXISTING config row — no new store, no index, no
 * Dexie version bump. It is kept apart from `centralDeviceEnrollment` and
 * from `centralBadgeRangeBinding` on purpose: those are unsigned local
 * metadata, this is a cryptographic artifact, and merging them would blur
 * which of the three can be trusted without a key.
 *
 * ONLY THE TOKEN IS STORED. Decoded claims are never written alongside it:
 * a second, unsigned copy of "what this device may do" is exactly the thing
 * an attacker would edit, and it would be indistinguishable from the real
 * answer. Every read verifies the signature again.
 */

export const readCentralDeviceOfflineAuthorization = async (): Promise<
  CentralDeviceOfflineAuthorization | undefined
> => {
  const config = await db.config.get(EVENT_CONFIG_ID)

  return config?.centralDeviceOfflineAuthorization
}

/**
 * Replaces the cached lease.
 *
 * The caller must already have VERIFIED the token and checked it against the
 * authenticated context — this function is the write, not the gate.
 *
 * It replaces rather than accumulates: the newest verified server lease
 * supersedes the old one, and keeping two would mean choosing between them
 * later, which is a decision with no safe default.
 */
export const saveCentralDeviceOfflineAuthorization = async (
  token: string,
): Promise<{ outcome: 'saved' | 'missing-config' }> => {
  return await db.transaction('rw', db.config, async () => {
    const config = await db.config.get(EVENT_CONFIG_ID)

    if (config === undefined) {
      return { outcome: 'missing-config' as const }
    }

    await db.config.put({
      ...config,
      centralDeviceOfflineAuthorization: {
        token,
        receivedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    })

    return { outcome: 'saved' as const }
  })
}

/**
 * Removes the cached lease and nothing else.
 *
 * Called when central state DEFINITIVELY says this device is no longer
 * authorized — a real server answer, never a failed request. The local device
 * identity, the badge range, `nextBadge`, `centralBadgeRangeBinding`, every
 * registration and every outbox row are untouched.
 */
export const clearCentralDeviceOfflineAuthorization = async (): Promise<{
  outcome: 'cleared' | 'missing-config'
}> => {
  return await db.transaction('rw', db.config, async () => {
    const config = await db.config.get(EVENT_CONFIG_ID)

    if (config === undefined) {
      return { outcome: 'missing-config' as const }
    }

    const next = { ...config, updatedAt: new Date().toISOString() }

    // Removed, so the row carries no empty authorization key at all.
    delete next.centralDeviceOfflineAuthorization

    await db.config.put(next)

    return { outcome: 'cleared' as const }
  })
}
