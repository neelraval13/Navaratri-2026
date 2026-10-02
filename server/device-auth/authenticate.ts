import { and, eq, isNull } from 'drizzle-orm'

import type { DeviceAttribute } from '../../src/shared/device-attributes.js'
import { getDatabase } from '../db/client.js'
import {
  badgeAssignments,
  deviceAttributes,
  devices,
  events,
} from '../db/schema.js'
import { validateDevicePassword, verifyDevicePassword } from './password.js'

/**
 * Central device authentication: the database side of the device realm.
 *
 * No HTTP concerns live here, and no cookie or token handling — those are
 * `cookies.ts` and `session.ts`. This module answers two questions:
 *
 *   "do these credentials identify a device that may sign in?"  (login)
 *   "is this session still valid, and what is this device NOW?" (session)
 *
 * The second is re-asked on every authenticated request, because a token
 * proves only that this server issued it. Whether the device may still act,
 * and what it may do, lives in Postgres.
 */

export interface AuthenticatedDeviceContext {
  device: {
    id: string
    eventId: string
    name: string
    loginName: string
    attributes: DeviceAttribute[]
    lastSeenAt: string | null
  }
  event: {
    id: string
    slug: string
    name: string
    timezone: string
  }
  activeBadgeRange: {
    rangeStart: number
    rangeEnd: number
    assignedAt: string
  } | null
}

/**
 * A FIXED, valid scrypt record used only to equalise timing.
 *
 * Without it, an unknown login name or an unprovisioned device would return
 * before any key derivation while a known login with a wrong password paid
 * for a full scrypt — a difference an attacker can measure to enumerate which
 * login names exist.
 *
 * It is a hash of a throwaway constant, produced with the parameters in
 * `password.ts`. It is NOT a credential and grants nothing: no device row
 * references it, and `verifyDevicePassword` against it can only ever return
 * false for a real submitted password.
 *
 * Fixed rather than generated per request: generating one would cost a second
 * derivation and make the unknown path SLOWER than the known one, swapping
 * one signal for another.
 */
const TIMING_EQUALIZER_HASH =
  'scrypt$v1$32768$8$1$ISRg929yv_s1jPJShyl58w$J7TnMbQf8j-IkjXqXPmhp5rqQHhXve5tn3IFvgHQHLs'

const toIso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString()

/** The CURRENT attribute set, never a claim carried in a token. */
const readAttributes = async (deviceId: string): Promise<DeviceAttribute[]> => {
  const rows = await getDatabase()
    .select({ attribute: deviceAttributes.attribute })
    .from(deviceAttributes)
    .where(eq(deviceAttributes.deviceId, deviceId))

  return rows.map((row) => row.attribute as DeviceAttribute).sort()
}

/** The CURRENT active assignment, never a claim carried in a token. */
const readActiveBadgeRange = async (
  deviceId: string,
): Promise<AuthenticatedDeviceContext['activeBadgeRange']> => {
  const rows = await getDatabase()
    .select()
    .from(badgeAssignments)
    .where(
      and(eq(badgeAssignments.deviceId, deviceId), isNull(badgeAssignments.releasedAt)),
    )

  const [row] = rows

  return row === undefined
    ? null
    : {
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
        assignedAt: row.assignedAt.toISOString(),
      }
}

interface DeviceRow {
  id: string
  eventId: string
  name: string
  loginName: string | null
  passwordHash: string | null
  sessionVersion: number
  enabled: boolean
  lastSeenAt: Date | null
}

interface EventRow {
  id: string
  slug: string
  name: string
  timezone: string
  active: boolean
  endsAt: Date | null
}

/**
 * An EXPLICIT projection, never a spread of a Drizzle row.
 *
 * `passwordHash` and `sessionVersion` sit one field away on the same object;
 * spreading would publish both. Listing every field means a column added
 * later cannot leak by accident.
 */
const toContext = async (
  device: DeviceRow,
  event: EventRow,
  lastSeenAt: Date | null,
): Promise<AuthenticatedDeviceContext> => {
  const [attributes, activeBadgeRange] = await Promise.all([
    readAttributes(device.id),
    readActiveBadgeRange(device.id),
  ])

  return {
    device: {
      id: device.id,
      eventId: device.eventId,
      name: device.name,
      // Only reachable once a login name has been proven present.
      loginName: device.loginName ?? '',
      attributes,
      lastSeenAt: toIso(lastSeenAt),
    },
    event: {
      id: event.id,
      slug: event.slug,
      name: event.name,
      timezone: event.timezone,
    },
    activeBadgeRange,
  }
}

const readEventBySlug = async (slug: string): Promise<EventRow | null> => {
  const [row] = await getDatabase().select().from(events).where(eq(events.slug, slug))

  return row ?? null
}

/**
 * Login names are unique PER EVENT, so this is always scoped by `eventId`.
 * A bare `WHERE login_name = ?` would let `desk-a` in one event authenticate
 * as `desk-a` in another.
 */
const readDeviceByLogin = async (
  eventId: string,
  loginName: string,
): Promise<DeviceRow | null> => {
  const [row] = await getDatabase()
    .select()
    .from(devices)
    .where(and(eq(devices.eventId, eventId), eq(devices.loginName, loginName)))

  return row ?? null
}

export type DeviceLoginResult =
  | {
      ok: true
      context: AuthenticatedDeviceContext
      deviceId: string
      eventId: string
      sessionVersion: number
      /**
       * SERVER-ONLY, deliberately outside the safe context: it caps how long
       * an offline authorization lease may live. It is never returned to a
       * browser as part of the device context.
       */
      eventEndsAt: Date | null
    }
  /** Every credential failure, indistinguishable from the others. */
  | { ok: false; reason: 'invalid-credentials' }
  /** Only reachable once the password has been proven correct. */
  | { ok: false; blocked: 'device-disabled' | 'event-inactive' }

/**
 * Authenticates `eventSlug` + `loginName` + `password`.
 *
 * ORDER MATTERS:
 *
 * 1. resolve the event, then the device WITHIN that event
 * 2. derive a key and compare — always, even when nothing was found
 * 3. only with a correct password, check `enabled` and `event.active`
 * 4. only then touch `last_seen_at`
 *
 * An unknown event, an unknown login name, an unprovisioned device and a
 * wrong password all return the SAME `invalid-credentials`, after comparable
 * work. `enabled` and `active` produce typed answers precisely because the
 * caller has already proven it knows the password, so naming them enumerates
 * nothing.
 *
 * `password_hash IS NULL` means credentials were never provisioned. It is
 * rejected here before any comparison, and never means passwordless access.
 */
export const authenticateDevice = async (credentials: {
  eventSlug: string
  loginName: string
  password: string
}): Promise<DeviceLoginResult> => {
  /**
   * A password outside the 8-128 policy cannot match any stored hash, since
   * every stored hash was produced from a compliant one. It is rejected here
   * as `invalid-credentials` rather than as a distinct validation error, so
   * the policy cannot be probed — and the equalizer still runs, so it costs
   * what a wrong password costs.
   */
  if (!validateDevicePassword(credentials.password).ok) {
    await verifyDevicePassword(credentials.password, TIMING_EQUALIZER_HASH)

    return { ok: false, reason: 'invalid-credentials' }
  }

  const event = await readEventBySlug(credentials.eventSlug)
  const device =
    event === null ? null : await readDeviceByLogin(event.id, credentials.loginName)

  /**
   * The derivation runs on every path, so an unknown login costs what a wrong
   * password costs.
   */
  const storedHash = device?.passwordHash ?? TIMING_EQUALIZER_HASH
  const passwordMatches = await verifyDevicePassword(credentials.password, storedHash)

  if (event === null || device === null || device.passwordHash === null || !passwordMatches) {
    return { ok: false, reason: 'invalid-credentials' }
  }

  // A device without a login name cannot have been found by one, but the
  // context type depends on it, so this is proven rather than assumed.
  if (device.loginName === null) {
    return { ok: false, reason: 'invalid-credentials' }
  }

  if (!device.enabled) {
    return { ok: false, blocked: 'device-disabled' }
  }

  if (!event.active) {
    return { ok: false, blocked: 'event-inactive' }
  }

  /**
   * The first trustworthy sighting: a device has just proven its identity.
   * Only a SUCCESSFUL login writes this — a failed attempt says nothing about
   * where the real device is, and there is no heartbeat.
   */
  const lastSeenAt = new Date()

  await getDatabase()
    .update(devices)
    .set({ lastSeenAt, updatedAt: new Date() })
    .where(eq(devices.id, device.id))

  return {
    ok: true,
    context: await toContext(device, event, lastSeenAt),
    deviceId: device.id,
    eventId: device.eventId,
    sessionVersion: device.sessionVersion,
    eventEndsAt: event.endsAt,
  }
}

/**
 * Re-authorizes an already-signed token against CURRENT central state.
 *
 * A valid signature is not enough. Every one of these must still hold, and
 * the caller is told only that the session is not authenticated — never
 * which one failed:
 *
 * - the device still exists
 * - it still belongs to the event the token names
 * - `session_version` still matches, so no password reset has revoked it
 * - it is still enabled
 * - its event is still active
 * - its credentials are still provisioned
 *
 * Attributes and the badge range are read fresh, so an Admin change is
 * reflected on the next check without a new cookie. `last_seen_at` is NOT
 * touched: checking a session is not evidence of device activity.
 *
 * It returns the safe context PLUS the event's end, which is server-only: an
 * offline authorization lease may never outlive the event, and the safe
 * context must not grow a field to carry that.
 */
export interface DeviceSessionState {
  context: AuthenticatedDeviceContext
  eventEndsAt: Date | null
}

export const loadDeviceSessionContext = async (claims: {
  deviceId: string
  eventId: string
  sessionVersion: number
}): Promise<DeviceSessionState | null> => {
  const [device] = await getDatabase()
    .select()
    .from(devices)
    .where(eq(devices.id, claims.deviceId))

  if (device === undefined || device === null) {
    return null
  }

  if (
    device.eventId !== claims.eventId ||
    device.sessionVersion !== claims.sessionVersion ||
    !device.enabled ||
    device.passwordHash === null ||
    device.loginName === null
  ) {
    return null
  }

  const [event] = await getDatabase().select().from(events).where(eq(events.id, device.eventId))

  if (event === undefined || event === null || !event.active) {
    return null
  }

  return {
    context: await toContext(device, event, device.lastSeenAt),
    eventEndsAt: event.endsAt,
  }
}
