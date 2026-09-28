import { db } from '@/db/database'
import { EVENT_CONFIG_ID, type CentralDeviceEnrollment } from '@/db/types'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'

/**
 * The local store of "which central device is this browser?".
 *
 * Three narrow operations on the EXISTING config row. No new object store, no
 * new index, no Dexie version bump — the enrollment is plain metadata on a row
 * that already exists.
 *
 * These are the ONLY writers of `centralDeviceEnrollment`, and they write
 * nothing else. In particular they never touch the Phase 7 local identity
 * (`deviceId`, `deviceName`, `deviceConfiguredAt`) or the badge state
 * (`badgeStart`, `badgeEnd`, `nextBadge`, `badgeConfiguredAt`): those belong
 * to this browser's own offline workflow and to Sheets provenance, and a
 * central value must never silently replace one of them. They never open the
 * registrations or outbox tables at all.
 */

/**
 * Projects the SAFE fields, one by one, from a validated session context.
 *
 * Explicit rather than a spread, so nothing arrives by accident. Three things
 * are deliberately excluded and must stay excluded:
 *
 * - `activeBadgeRange` — importing a central range into local state would
 *   change which physical badges this desk believes it owns. Phase 9C-C2.
 * - `authenticated` / `configured` — transport facts, not identity.
 * - anything the server adds later.
 */
const toEnrollment = (context: DeviceSessionContext): CentralDeviceEnrollment => ({
  deviceId: context.device.id,
  eventId: context.event.id,
  eventSlug: context.event.slug,
  deviceName: context.device.name,
  loginName: context.device.loginName,
  attributes: [...context.device.attributes],
  verifiedAt: new Date().toISOString(),
})

export const readCentralDeviceEnrollment = async (): Promise<
  CentralDeviceEnrollment | undefined
> => {
  const config = await db.config.get(EVENT_CONFIG_ID)

  return config?.centralDeviceEnrollment
}

export type SaveEnrollmentResult =
  | { outcome: 'saved'; enrollment: CentralDeviceEnrollment }
  | { outcome: 'missing-config' }
  /**
   * This browser is already bound to a DIFFERENT central device. It is never
   * rebound silently: later phases make badge ownership depend on this
   * binding, so switching it is an explicit operator decision.
   */
  | {
      outcome: 'device-mismatch'
      enrolled: CentralDeviceEnrollment
      attempted: { deviceId: string; deviceName: string }
    }

/**
 * Binds this browser to a verified central device, or refreshes the binding
 * it already has.
 *
 * Only ever called with a context the runtime validator accepted, and only
 * after the SERVER confirmed the session — never from a cached value.
 *
 * Re-verifying the SAME device refreshes its name, login name, attributes and
 * `verifiedAt`, because those are exactly the facts that change centrally.
 */
export const saveCentralDeviceEnrollment = async (
  context: DeviceSessionContext,
): Promise<SaveEnrollmentResult> => {
  return await db.transaction('rw', db.config, async (): Promise<SaveEnrollmentResult> => {
    const config = await db.config.get(EVENT_CONFIG_ID)

    if (config === undefined) {
      return { outcome: 'missing-config' }
    }

    const existing = config.centralDeviceEnrollment

    if (existing !== undefined && existing.deviceId !== context.device.id) {
      return {
        outcome: 'device-mismatch',
        enrolled: existing,
        attempted: { deviceId: context.device.id, deviceName: context.device.name },
      }
    }

    const enrollment = toEnrollment(context)

    // Every other field is carried through untouched, local identity and
    // badge state included.
    await db.config.put({
      ...config,
      centralDeviceEnrollment: enrollment,
      updatedAt: new Date().toISOString(),
    })

    return { outcome: 'saved', enrollment }
  })
}

/**
 * Unbinds this browser from its central device.
 *
 * ONLY the enrollment snapshot. This is not Reset Device, not Clear Event
 * Data, not Clear Badge Range and not an operator logout: the local device
 * identity, the badge range, `nextBadge`, every registration, every outbox row
 * and the trusted-operator marker are all untouched.
 */
export const clearCentralDeviceEnrollment = async (): Promise<{
  outcome: 'cleared' | 'missing-config'
}> => {
  return await db.transaction('rw', db.config, async () => {
    const config = await db.config.get(EVENT_CONFIG_ID)

    if (config === undefined) {
      return { outcome: 'missing-config' as const }
    }

    const next = { ...config, updatedAt: new Date().toISOString() }

    // Removed rather than set to undefined, so the stored row carries no
    // empty enrollment key at all.
    delete next.centralDeviceEnrollment

    await db.config.put(next)

    return { outcome: 'cleared' as const }
  })
}
