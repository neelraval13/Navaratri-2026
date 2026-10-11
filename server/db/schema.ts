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
     * The future device username, per event. Still nullable: devices created
     * before Phase 9C-A have none, and one is never generated silently.
     */
    loginName: text('login_name'),
    /**
     * The scrypt-encoded device password — NEVER a password, a plaintext
     * copy, a reversible ciphertext or a temporary secret.
     *
     * NULL means CREDENTIALS HAVE NOT BEEN PROVISIONED. It must never be read
     * as "this device may sign in without a password": the Phase 9C-B login
     * will reject a null hash outright, before any comparison.
     *
     * Nullable because central devices already exist and the migration must
     * preserve them exactly as they are.
     */
    passwordHash: text('password_hash'),
    /**
     * Groundwork for session revocation, unused in Phase 9C-A.
     *
     * Every deliberate password set or reset increments it. A future device
     * session will carry the value it was issued under, so changing a
     * password invalidates every session that device already holds. There is
     * no session store to purge — the counter is the revocation.
     */
    sessionVersion: integer('session_version').notNull().default(1),
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
    check(
      'devices_password_hash_not_empty',
      sql`${table.passwordHash} is null or length(btrim(${table.passwordHash})) > 0`,
    ),
    /**
     * A version below the initial 1 could only come from a bug, and would let
     * a future session claim to predate every revocation.
     */
    check('devices_session_version_positive', sql`${table.sessionVersion} >= 1`),
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

/**
 * THE PRIZE LEDGER. Which badge received which prize, from which device, when.
 *
 * ATTENDEE PII IS STILL NEVER STORED CENTRALLY. There is deliberately no
 * name, phone, age, gender, WhatsApp link or payment column here: the person
 * behind a badge number lives in the Google Sheet, and the prize screen joins
 * the two per request. Copying a name in to make history easier to read would
 * create a second, unsynchronised copy of personal data in a database that
 * has managed without any.
 *
 * REPEAT PRIZES ARE LEGAL, since Phase P1.1. One attendee may win Best Dance
 * and Best Dress, or the same prize twice, so there is NO
 * `UNIQUE(event_id, badge_number)` — `0004_repeat_prize_awards.sql` dropped
 * the one P1 created — and no per-attendee uniqueness constraint of any kind
 * may replace it. Not on `(event_id, badge_number, prize_name)`, not by
 * category, and not as a unique index: every one of those would refuse a
 * second legitimate award, and the event rule is that the volunteer decides.
 *
 * Previous awards are INFORMATION. The prize desk warns about them and still
 * lets another through, so three identical rows for one badge are three
 * legitimate facts rather than a race to be arbitrated.
 *
 * APPEND-ONLY from the product. There is no undo, no delete and no edit in
 * this phase, so the row needs no `updated_at` and gets no `set_updated_at`
 * trigger — `awarded_at` is the only time that means anything.
 */
export const prizeAwards = pgTable(
  'prize_awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    badgeNumber: integer('badge_number').notNull(),
    prizeName: text('prize_name').notNull(),
    awardedByDeviceId: uuid('awarded_by_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'restrict' }),
    awardedAt: timestamp('awarded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * The same cross-event integrity the badge assignments use: a prize
     * cannot be recorded for one event by a device belonging to another.
     */
    foreignKey({
      name: 'prize_awards_device_event_fk',
      columns: [table.awardedByDeviceId, table.eventId],
      foreignColumns: [devices.id, devices.eventId],
    }).onDelete('restrict'),
    index('prize_awards_event_id_idx').on(table.eventId),
    index('prize_awards_awarded_by_device_id_idx').on(table.awardedByDeviceId),
    check('prize_awards_badge_number_positive', sql`${table.badgeNumber} > 0`),
    /**
     * The application trims and length-checks the name at its boundary; these
     * are the database's own floor, so a future writer cannot store a blank
     * or unbounded prize name whatever it believes it validated.
     */
    check(
      'prize_awards_prize_name_not_empty',
      sql`length(btrim(${table.prizeName})) > 0`,
    ),
    check(
      'prize_awards_prize_name_max_length',
      sql`length(${table.prizeName}) <= 80`,
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
export type PrizeAward = typeof prizeAwards.$inferSelect
export type NewPrizeAward = typeof prizeAwards.$inferInsert
