import { randomUUID } from 'node:crypto'

import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import type { DeviceAttribute } from '../../src/shared/device-attributes.js'
import { getDatabase } from '../db/client.js'
import {
  badgeAssignments,
  deviceAttributes,
  devices,
  events,
} from '../db/schema.js'
import { hashDevicePassword } from '../device-auth/password.js'
import { mapDatabaseConflict, type AdminConflict } from './errors.js'
import {
  checkAttributeRemovalAllowed,
  checkBadgeAssignmentAllowed,
  type BadgeAssignmentBlock,
  type BadgeRangeInput,
  type CreateDeviceInput,
  type CreateEventInput,
  type CredentialBlock,
  type DeviceConfigurationInput,
} from './validation.js'

/**
 * The central registry. API handlers stay thin and never build queries
 * themselves, so the rules live in one place.
 *
 * This layer holds NO attendee data and NO live badge counter. It owns which
 * devices exist and which RANGE each one has been given.
 */

export type RegistryResult<T> =
  | { ok: true; value: T }
  | { ok: false; conflict: AdminConflict }
  | {
      ok: false
      blocked:
        | BadgeAssignmentBlock
        | 'registration-required-by-badge-range'
        | CredentialBlock
    }

export interface AdminEvent {
  id: string
  slug: string
  name: string
  timezone: string
  startsAt: string | null
  endsAt: string | null
  active: boolean
}

export interface AdminBadgeRange {
  rangeStart: number
  rangeEnd: number
  assignedAt: string
}

/**
 * What Admin is allowed to see about a device.
 *
 * An EXPLICIT projection, never a serialized Drizzle row: `passwordHash` and
 * `sessionVersion` live one field away in the table and must never reach a
 * browser. Whether credentials exist is the only credential fact Admin needs,
 * and it is reduced to a boolean here rather than derived client-side from
 * anything sensitive.
 */
export interface AdminDevice {
  id: string
  eventId: string
  name: string
  loginName: string | null
  enabled: boolean
  lastSeenAt: string | null
  createdAt: string
  attributes: DeviceAttribute[]
  activeBadgeRange: AdminBadgeRange | null
  /**
   * `password_hash IS NOT NULL`. It means PROVISIONED, nothing more — it does
   * not say the device may sign in, because no device login exists yet.
   */
  credentialsConfigured: boolean
}

const toIso = (value: Date | null): string | null => {
  return value === null ? null : value.toISOString()
}

export const listEvents = async (): Promise<AdminEvent[]> => {
  const rows = await getDatabase()
    .select()
    .from(events)
    .orderBy(asc(events.createdAt))

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    startsAt: toIso(row.startsAt),
    endsAt: toIso(row.endsAt),
    active: row.active,
  }))
}

export const createEvent = async (
  input: CreateEventInput,
): Promise<RegistryResult<AdminEvent>> => {
  try {
    const [row] = await getDatabase()
      .insert(events)
      .values({
        name: input.name,
        slug: input.slug,
        timezone: input.timezone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      })
      .returning()

    return {
      ok: true,
      value: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        timezone: row.timezone,
        startsAt: toIso(row.startsAt),
        endsAt: toIso(row.endsAt),
        active: row.active,
      },
    }
  } catch (error: unknown) {
    const conflict = mapDatabaseConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, conflict }
  }
}

/**
 * Every device in one event, with its attributes and its ACTIVE badge range.
 *
 * Three narrow reads rather than one join: the joined shape would need
 * de-duplicating in JavaScript anyway, and these stay readable.
 */
export const listDevices = async (eventId: string): Promise<AdminDevice[]> => {
  const db = getDatabase()

  const [deviceRows, attributeRows, assignmentRows] = await Promise.all([
    db.select().from(devices).where(eq(devices.eventId, eventId)).orderBy(asc(devices.createdAt)),
    db
      .select({ deviceId: deviceAttributes.deviceId, attribute: deviceAttributes.attribute })
      .from(deviceAttributes)
      .innerJoin(devices, eq(devices.id, deviceAttributes.deviceId))
      .where(eq(devices.eventId, eventId)),
    db
      .select()
      .from(badgeAssignments)
      .where(
        and(eq(badgeAssignments.eventId, eventId), isNull(badgeAssignments.releasedAt)),
      ),
  ])

  const attributesByDevice = new Map<string, DeviceAttribute[]>()

  for (const row of attributeRows) {
    const existing = attributesByDevice.get(row.deviceId) ?? []

    existing.push(row.attribute as DeviceAttribute)
    attributesByDevice.set(row.deviceId, existing)
  }

  const rangeByDevice = new Map<string, AdminBadgeRange>(
    assignmentRows.map((row) => [
      row.deviceId,
      {
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
        assignedAt: row.assignedAt.toISOString(),
      },
    ]),
  )

  return deviceRows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    loginName: row.loginName,
    enabled: row.enabled,
    lastSeenAt: toIso(row.lastSeenAt),
    createdAt: row.createdAt.toISOString(),
    attributes: (attributesByDevice.get(row.id) ?? []).sort(),
    activeBadgeRange: rangeByDevice.get(row.id) ?? null,
    credentialsConfigured: row.passwordHash !== null,
  }))
}

const readDevice = async (deviceId: string) => {
  const [row] = await getDatabase().select().from(devices).where(eq(devices.id, deviceId))

  return row ?? null
}

const readAttributes = async (deviceId: string): Promise<string[]> => {
  const rows = await getDatabase()
    .select({ attribute: deviceAttributes.attribute })
    .from(deviceAttributes)
    .where(eq(deviceAttributes.deviceId, deviceId))

  return rows.map((row) => row.attribute)
}

const readActiveAssignment = async (
  deviceId: string,
): Promise<AdminBadgeRange | null> => {
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

const hasActiveAssignment = async (deviceId: string): Promise<boolean> => {
  return (await readActiveAssignment(deviceId)) !== null
}

/**
 * Creates a device, its initial attributes and — when supplied — its
 * credentials, ATOMICALLY.
 *
 * The id is generated here so every statement can be built up front and sent
 * as one Neon batch, which runs in a single transaction. The HTTP driver has
 * no interactive transactions, and a half-created device with no attributes
 * or with a login name but no password would be worse than a failed create.
 *
 * Credentials are part of the create, never a follow-up call to a password
 * endpoint: a second independently committed write is how a partial device
 * would appear. `session_version` starts at the column default of 1.
 */
export const createDevice = async (
  eventId: string,
  input: CreateDeviceInput,
): Promise<RegistryResult<AdminDevice>> => {
  const db = getDatabase()
  const deviceId = randomUUID()

  /**
   * Hashed BEFORE the batch is built, so a hashing failure means no device is
   * created at all rather than one created without the credentials the Admin
   * asked for. The plaintext never leaves this call.
   */
  const passwordHash =
    input.password === null ? null : await hashDevicePassword(input.password)

  const statements = [
    db.insert(devices).values({
      id: deviceId,
      eventId,
      name: input.name,
      loginName: input.loginName,
      enabled: input.enabled,
      passwordHash,
    }),
    ...input.attributes.map((attribute) =>
      db.insert(deviceAttributes).values({ deviceId, attribute }),
    ),
  ] as const

  try {
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0])
  } catch (error: unknown) {
    const conflict = mapDatabaseConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, conflict }
  }

  const created = await readDevice(deviceId)

  if (created === null) {
    throw new Error('The device could not be read back after creation.')
  }

  return {
    ok: true,
    value: {
      id: created.id,
      eventId: created.eventId,
      name: created.name,
      loginName: created.loginName,
      enabled: created.enabled,
      lastSeenAt: toIso(created.lastSeenAt),
      createdAt: created.createdAt.toISOString(),
      attributes: [...input.attributes].sort(),
      activeBadgeRange: null,
      credentialsConfigured: input.password !== null,
    },
  }
}

/**
 * The COMPLETE Edit Device operation: device fields and the exact attribute
 * set, validated together and committed as ONE atomic batch.
 *
 * This deliberately replaces the earlier pair of independently committed
 * mutations. Sending a rename and an attribute change as two requests meant a
 * refused attribute change left the rename already persisted — a partial edit
 * of what the operator performed as a single Save.
 *
 * Every precondition is evaluated BEFORE the first write statement is sent,
 * so a refusal writes nothing at all.
 */
export const updateDeviceConfiguration = async (
  deviceId: string,
  input: DeviceConfigurationInput,
): Promise<RegistryResult<AdminDevice>> => {
  const [device, currentAttributes, activeBadgeRange] = await Promise.all([
    readDevice(deviceId),
    readAttributes(deviceId),
    readActiveAssignment(deviceId),
  ])

  if (device === null) {
    return { ok: false, blocked: 'device-not-found' }
  }

  if (input.eventId !== null && device.eventId !== input.eventId) {
    return { ok: false, blocked: 'device-event-mismatch' }
  }

  if (input.attributes !== null) {
    const blocked = checkAttributeRemovalAllowed({
      requested: input.attributes,
      hasActiveAssignment: activeBadgeRange !== null,
    })

    if (blocked !== null) {
      return { ok: false, blocked }
    }
  }

  const db = getDatabase()

  /**
   * One batch, which the Neon HTTP driver runs as a single transaction. The
   * driver has no interactive transactions, so every statement is built up
   * front and sent together: either the fields and the attribute set both
   * land, or neither does.
   */
  const statements = [
    ...(Object.keys(input.fields).length === 0
      ? []
      : [
          db
            .update(devices)
            .set({ ...input.fields, updatedAt: new Date() })
            .where(eq(devices.id, deviceId)),
        ]),
    ...(input.attributes === null
      ? []
      : [
          db.delete(deviceAttributes).where(eq(deviceAttributes.deviceId, deviceId)),
          ...input.attributes.map((attribute) =>
            db.insert(deviceAttributes).values({ deviceId, attribute }),
          ),
        ]),
  ] as const

  try {
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0])
  } catch (error: unknown) {
    const conflict = mapDatabaseConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, conflict }
  }

  return {
    ok: true,
    value: {
      id: device.id,
      eventId: device.eventId,
      name: input.fields.name ?? device.name,
      loginName:
        input.fields.loginName === undefined ? device.loginName : input.fields.loginName,
      enabled: input.fields.enabled ?? device.enabled,
      lastSeenAt: toIso(device.lastSeenAt),
      createdAt: device.createdAt.toISOString(),
      attributes: [
        ...(input.attributes ?? (currentAttributes as DeviceAttribute[])),
      ].sort(),
      activeBadgeRange,
      credentialsConfigured: device.passwordHash !== null,
    },
  }
}

/**
 * Sets or resets a device's password.
 *
 * Deliberately NOT part of Save Device. A blank field in an ordinary edit
 * would be ambiguous — keep the password, clear it, or set an empty one — so
 * credentials are their own explicit action with its own confirmation.
 *
 * Every precondition is checked before the password is hashed, so a refusal
 * costs no work and writes nothing. There is no way to clear a password: once
 * a device is provisioned the choices are reset it or disable the device.
 *
 * A disabled device may still be provisioned. Preparing a desk before opening
 * it is normal, and `enabled` is enforced at login, not here.
 */
export const setDevicePassword = async (
  eventId: string,
  deviceId: string,
  password: string,
): Promise<RegistryResult<{ deviceId: string; credentialsConfigured: true }>> => {
  const device = await readDevice(deviceId)

  if (device === null) {
    return { ok: false, blocked: 'device-not-found' }
  }

  if (device.eventId !== eventId) {
    return { ok: false, blocked: 'device-event-mismatch' }
  }

  if (device.loginName === null) {
    return { ok: false, blocked: 'device-has-no-login-name' }
  }

  const passwordHash = await hashDevicePassword(password)

  try {
    /**
     * The hash and the version move together. `session_version` is
     * incremented from its stored value on EVERY deliberate reset, without
     * comparing the new password to the old one — the operator asked for a
     * credential change, so every session issued under the previous one is
     * considered revoked when Phase 9C-B begins checking.
     */
    await getDatabase()
      .update(devices)
      .set({
        passwordHash,
        sessionVersion: sql`${devices.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(devices.id, deviceId))
  } catch (error: unknown) {
    const conflict = mapDatabaseConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, conflict }
  }

  // Never the hash, never the session version, never the password.
  return { ok: true, value: { deviceId, credentialsConfigured: true } }
}

/**
 * Assigns a device its FIRST badge range.
 *
 * There is deliberately no edit, replace, release, transfer or extend here.
 * Changing a range while devices operate offline is how two attendees end up
 * with the same badge, and doing it safely is a reconciliation problem for a
 * later phase.
 */
export const assignBadgeRange = async (
  eventId: string,
  deviceId: string,
  range: BadgeRangeInput,
): Promise<RegistryResult<AdminBadgeRange>> => {
  const [device, attributes, active] = await Promise.all([
    readDevice(deviceId),
    readAttributes(deviceId),
    hasActiveAssignment(deviceId),
  ])

  const blocked = checkBadgeAssignmentAllowed({
    device: device === null ? null : { eventId: device.eventId, enabled: device.enabled },
    eventId,
    attributes,
    hasActiveAssignment: active,
  })

  if (blocked !== null) {
    return { ok: false, blocked }
  }

  try {
    // Postgres remains authoritative: overlap, one-active-per-device and
    // event consistency are all enforced by constraints, not by the checks
    // above, because two Admins can race.
    const [row] = await getDatabase()
      .insert(badgeAssignments)
      .values({
        eventId,
        deviceId,
        rangeStart: range.rangeStart,
        rangeEnd: range.rangeEnd,
      })
      .returning()

    return {
      ok: true,
      value: {
        rangeStart: row.rangeStart,
        rangeEnd: row.rangeEnd,
        assignedAt: row.assignedAt.toISOString(),
      },
    }
  } catch (error: unknown) {
    const conflict = mapDatabaseConflict(error)

    if (conflict === null) {
      throw error
    }

    return { ok: false, conflict }
  }
}
