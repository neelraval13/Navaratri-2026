import { BADGE_RESERVATION_CONSTRAINTS } from '../badge-assignments/conflicts.js'
import { readConstraintName } from '../db/constraints.js'

/**
 * Every conflict Admin can report. Typed, safe, and free of SQL.
 */
export type AdminConflict =
  | 'login-name-taken'
  | 'badge-range-overlap'
  | 'badge-range-already-assigned'
  | 'device-event-mismatch'
  | 'event-slug-taken'

export const ADMIN_CONFLICT_MESSAGES: Record<AdminConflict, string> = {
  'login-name-taken':
    'That login name is already assigned to another device in this event.',
  'badge-range-overlap':
    'That badge range overlaps a range already assigned to another device in this event.',
  'badge-range-already-assigned':
    'This device already has an active badge range.',
  'device-event-mismatch': 'That device does not belong to the selected event.',
  'event-slug-taken': 'An event with that slug already exists.',
}

/**
 * The database is the authority on these conflicts — two concurrent Admins can
 * each pass an application check and still both commit — so its constraint
 * violations are translated rather than pre-empted.
 *
 * The badge-assignment names come from the shared reservation primitive, which
 * Admin and Device self-claim both write through. Restating them here would be
 * a second place to forget one.
 */
const CONSTRAINT_CONFLICTS: Record<string, AdminConflict> = {
  devices_event_id_login_name_key: 'login-name-taken',
  events_slug_key: 'event-slug-taken',
  ...BADGE_RESERVATION_CONSTRAINTS,
}

/**
 * Maps a database error to a typed conflict, or null when it is not one this
 * application understands.
 *
 * A null result must be treated as an unexpected failure: reported generically
 * to the operator and logged server-side WITHOUT the connection string, the
 * driver object or the full stack.
 */
export const mapDatabaseConflict = (error: unknown): AdminConflict | null => {
  const constraint = readConstraintName(error, Object.keys(CONSTRAINT_CONFLICTS))

  return constraint === null ? null : (CONSTRAINT_CONFLICTS[constraint] ?? null)
}
