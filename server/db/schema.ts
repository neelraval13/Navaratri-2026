import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * CENTRAL OPERATIONAL METADATA ONLY.
 *
 * This database answers "which devices exist, and which badge range does each
 * one own". It deliberately holds NO attendee data: no name, phone, age,
 * gender, payment, held registration or completed registration. Those stay in
 * IndexedDB (the offline workflow) and Google Sheets (the human ledger).
 *
 * It also holds NO live badge counter. Postgres owns which RANGE belongs to a
 * device; `nextBadge` stays local so a disconnected desk keeps issuing. A
 * central counter would make issuance require the network, which is exactly
 * what this application is built to avoid.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Maintained by the `set_updated_at` trigger installed in the migrations, so
   * no writer has to remember it. See docs/DATABASE.md.
   */
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('events_slug_key').on(table.slug),
    index('events_slug_idx').on(table.slug),
    check('events_slug_not_empty', sql`length(btrim(${table.slug})) > 0`),
    check('events_name_not_empty', sql`length(btrim(${table.name})) > 0`),
    check('events_timezone_not_empty', sql`length(btrim(${table.timezone})) > 0`),
    check(
      'events_dates_ordered',
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.endsAt} >= ${table.startsAt}`,
    ),
  ],
)

/**
 * Devices are EVENT-SCOPED for now.
 *
 * Reusing one piece of hardware across events is a real future need, but
 * inventing that abstraction before anything requires it would be premature.
 * The composite key below keeps the later migration straightforward.
 *
 * There is deliberately no `deviceType`: a device may serve several modules,
 * so what it does is recorded in `device_attributes`, one row per capability.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * Reserved for Phase 9C device authentication. It belongs to the registry
     * and has a clear uniqueness rule, so it exists now — but there is no
     * password, hash or session column, and authentication is unchanged.
     */
    loginName: text('login_name'),
    enabled: boolean('enabled').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    /**
     * Not redundant with the primary key: it is the target a composite foreign
     * key needs, so a badge assignment cannot pair an event with a device
     * belonging to a different event.
     */
    unique('devices_id_event_id_key').on(table.id, table.eventId),
    /**
     * Postgres treats NULLs as distinct here, so many devices may have no
     * login name at all. That is intended until authentication exists.
     */
    uniqueIndex('devices_event_id_login_name_key').on(
      table.eventId,
      table.loginName,
    ),
    index('devices_event_id_idx').on(table.eventId),
    check('devices_name_not_empty', sql`length(btrim(${table.name})) > 0`),
    check(
      'devices_login_name_not_empty',
      sql`${table.loginName} is null or length(btrim(${table.loginName})) > 0`,
    ),
  ],
)

/**
 * What a device is for, one row per capability.
 *
 * Deliberately TEXT rather than a Postgres enum: adding `prizes`, `dandiya` or
 * `checkin` later must not require altering a database type. The application
 * will own the allow-list when it needs one.
 */
export const deviceAttributes = pgTable(
  'device_attributes',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    attribute: text('attribute').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.attribute] }),
    index('device_attributes_device_id_idx').on(table.deviceId),
    check(
      'device_attributes_attribute_not_empty',
      sql`length(btrim(${table.attribute})) > 0`,
    ),
  ],
)

/**
 * Which physical badge range belongs to which device.
 *
 * `released_at IS NULL` means ACTIVE. A released row is kept as history rather
 * than deleted. There is no `next_badge` column here on purpose — see the
 * module comment.
 *
 * Two guarantees are enforced by the database itself, in the migrations,
 * because application validation alone cannot stop a concurrent writer:
 *
 * - active ranges within one event may not overlap (GiST exclusion constraint)
 * - a device may hold at most one active assignment (partial unique index)
 */
export const badgeAssignments = pgTable(
  'badge_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'restrict' }),
    rangeStart: integer('range_start').notNull(),
    rangeEnd: integer('range_end').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Cross-event corruption is impossible rather than merely discouraged.
    foreignKey({
      name: 'badge_assignments_device_event_fk',
      columns: [table.deviceId, table.eventId],
      foreignColumns: [devices.id, devices.eventId],
    }).onDelete('restrict'),
    index('badge_assignments_event_id_idx').on(table.eventId),
    index('badge_assignments_device_id_idx').on(table.deviceId),
    uniqueIndex('badge_assignments_one_active_per_device')
      .on(table.deviceId)
      .where(sql`${table.releasedAt} is null`),
    check('badge_assignments_range_start_positive', sql`${table.rangeStart} > 0`),
    check('badge_assignments_range_end_positive', sql`${table.rangeEnd} > 0`),
    check(
      'badge_assignments_range_ordered',
      sql`${table.rangeStart} <= ${table.rangeEnd}`,
    ),
  ],
)

export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
export type Device = typeof devices.$inferSelect
export type NewDevice = typeof devices.$inferInsert
export type DeviceAttribute = typeof deviceAttributes.$inferSelect
export type NewDeviceAttribute = typeof deviceAttributes.$inferInsert
export type BadgeAssignment = typeof badgeAssignments.$inferSelect
export type NewBadgeAssignment = typeof badgeAssignments.$inferInsert
