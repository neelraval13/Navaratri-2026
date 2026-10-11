// Stand-ins for the drizzle-orm operators and the pg table definitions, so
// the real registry's queries become inspectable descriptors instead of SQL.

const column = (table, name) => ({ __column: true, table, column: name })

const tableOf = (name, columns) => {
  const built = { __table: name }

  for (const columnName of columns) {
    built[columnName] = column(name, columnName)
  }

  return built
}

export const events = tableOf('events', [
  'id', 'slug', 'name', 'timezone', 'startsAt', 'endsAt', 'active', 'createdAt', 'updatedAt',
])

export const devices = tableOf('devices', [
  'id', 'eventId', 'name', 'loginName', 'passwordHash', 'sessionVersion',
  'enabled', 'lastSeenAt', 'createdAt', 'updatedAt',
])

export const deviceAttributes = tableOf('device_attributes', ['deviceId', 'attribute'])

export const badgeAssignments = tableOf('badge_assignments', [
  'id', 'eventId', 'deviceId', 'rangeStart', 'rangeEnd', 'assignedAt', 'releasedAt',
])

export const prizeAwards = tableOf('prize_awards', [
  'id', 'eventId', 'badgeNumber', 'prizeName', 'awardedByDeviceId', 'awardedAt',
])

/**
 * `left` is always a column. `value` may be a LITERAL or, in a join
 * condition, another column — `eq(devices.id, prizeAwards.awardedByDeviceId)`
 * — so both the table and the column of each side are carried and the
 * evaluator decides which it is looking at.
 */
export const eq = (left, value) => ({
  op: 'eq', table: left.table, column: left.column, value,
})
export const isNull = (left) => ({ op: 'isNull', table: left.table, column: left.column })
export const and = (...parts) => ({ op: 'and', parts: parts.filter(Boolean) })
export const asc = (left) => ({ op: 'asc', column: left.column })

/** A tagged template captured as a descriptor, never as real SQL. */
export const sql = (strings, ...values) => ({ op: 'sql', strings: [...strings], values })
