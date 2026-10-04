import { loadDeviceSessionContext } from '../device-auth/authenticate.js'
import { readDeviceSessionCookie } from '../device-auth/cookies.js'
import { readDeviceAuthEnvironment } from '../device-auth/environment.js'
import { verifyDeviceSessionToken } from '../device-auth/session.js'
import { isDatabaseConfigured } from '../db/client.js'
import { BADGE_RANGE_REQUIRED_ATTRIBUTE } from '../../src/shared/device-attributes.js'

/**
 * THE authorization for `/api/sync-registration`: a live central device
 * session. Since Phase D2 there is no other.
 *
 * ONLINE ONLY, AND LIVE. The signed offline lease is never sent and would
 * never be accepted here: it is local authorization, and the server has no
 * reason to trust a statement it made yesterday when it can read Postgres
 * now. Every check below is against CURRENT central state, which is what
 * makes a device disabled while it was offline fail the moment it reconnects
 * — before any attendee row reaches the Sheet.
 */

export interface SyncDeviceAuthorization {
  deviceId: string
  eventId: string
  activeBadgeRange: { rangeStart: number; rangeEnd: number }
}

export type SyncDeviceAuthorizationResult =
  | { ok: true; authorization: SyncDeviceAuthorization }
  /** No usable device session. The caller answers with its generic 401. */
  | { ok: false; reason: 'unauthorized' }
  /** Proven device, but it may not register. Typed, because it is actionable. */
  | { ok: false; reason: 'device-not-permitted' }

export const authorizeSyncByDevice = async (
  request: Request,
): Promise<SyncDeviceAuthorizationResult> => {
  const configuration = readDeviceAuthEnvironment()

  if (configuration.ok === false || !isDatabaseConfigured()) {
    return { ok: false, reason: 'unauthorized' }
  }

  const token = readDeviceSessionCookie(request.headers.get('cookie'))

  if (token === undefined) {
    return { ok: false, reason: 'unauthorized' }
  }

  const claims = verifyDeviceSessionToken(token, configuration.environment.sessionSecret)

  if (claims === null) {
    return { ok: false, reason: 'unauthorized' }
  }

  /**
   * Re-read from Postgres: `session_version`, `enabled`, the event's
   * `active`, and still-provisioned credentials are all checked here, so a
   * revoked device cannot sync on the strength of a cookie it still holds.
   */
  const state = await loadDeviceSessionContext({
    deviceId: claims.deviceId,
    eventId: claims.eventId,
    sessionVersion: claims.sv,
  })

  if (state === null) {
    return { ok: false, reason: 'unauthorized' }
  }

  const { device, activeBadgeRange } = state.context

  if (!device.attributes.includes(BADGE_RANGE_REQUIRED_ATTRIBUTE)) {
    return { ok: false, reason: 'device-not-permitted' }
  }

  /**
   * A device with no central badge assignment owns no numbers, so nothing it
   * produced belongs in the ledger under its name — including a held record,
   * which is a registration in progress at a desk that should not have one.
   */
  if (activeBadgeRange === null) {
    return { ok: false, reason: 'device-not-permitted' }
  }

  return {
    ok: true,
    authorization: {
      deviceId: device.id,
      eventId: device.eventId,
      activeBadgeRange: {
        rangeStart: activeBadgeRange.rangeStart,
        rangeEnd: activeBadgeRange.rangeEnd,
      },
    },
  }
}

/**
 * A completed snapshot must carry a badge this device CURRENTLY owns.
 *
 * The decisive case is a reconnect race: a desk issues #501 offline, an Admin
 * reassigns or revokes while it is away, and the outbox flushes the moment it
 * returns — possibly before the browser has processed its own revocation. The
 * ledger must refuse that row on the server's own authority, not on the
 * client having noticed in time.
 *
 * A held registration has consumed no badge, so there is nothing to check and
 * none is ever invented for it.
 */
export const isBadgeWithinDeviceRange = (
  authorization: SyncDeviceAuthorization,
  badgeNumber: number | undefined,
): boolean => {
  if (badgeNumber === undefined) {
    return true
  }

  return (
    badgeNumber >= authorization.activeBadgeRange.rangeStart &&
    badgeNumber <= authorization.activeBadgeRange.rangeEnd
  )
}
