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
 */
const CONSTRAINT_CONFLICTS: Record<string, AdminConflict> = {
  devices_event_id_login_name_key: 'login-name-taken',
  badge_assignments_active_ranges_no_overlap: 'badge-range-overlap',
  badge_assignments_one_active_per_device: 'badge-range-already-assigned',
  badge_assignments_device_event_fk: 'device-event-mismatch',
  events_slug_key: 'event-slug-taken',
}

const readConstraintName = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const candidate = error as {
    constraint?: unknown
    sourceError?: { constraint?: unknown }
    message?: unknown
  }

  const direct = candidate.constraint ?? candidate.sourceError?.constraint

  if (typeof direct === 'string') {
    return direct
  }

  /**
   * The HTTP driver does not always surface `constraint` as a field, so the
   * message is the fallback. Only known names are matched — an unrecognised
   * error is never guessed at.
   */
  const message = typeof candidate.message === 'string' ? candidate.message : ''

  return (
    Object.keys(CONSTRAINT_CONFLICTS).find((name) => message.includes(name)) ??
    null
  )
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
  const constraint = readConstraintName(error)

  return constraint === null ? null : (CONSTRAINT_CONFLICTS[constraint] ?? null)
}
