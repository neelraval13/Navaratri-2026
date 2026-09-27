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
  'id', 'eventId', 'name', 'loginName', 'enabled', 'lastSeenAt', 'createdAt', 'updatedAt',
])

export const deviceAttributes = tableOf('device_attributes', ['deviceId', 'attribute'])

export const badgeAssignments = tableOf('badge_assignments', [
  'id', 'eventId', 'deviceId', 'rangeStart', 'rangeEnd', 'assignedAt', 'releasedAt',
])

export const eq = (left, value) => ({ op: 'eq', column: left.column, value })
export const isNull = (left) => ({ op: 'isNull', column: left.column })
export const and = (...parts) => ({ op: 'and', parts: parts.filter(Boolean) })
export const asc = (left) => ({ op: 'asc', column: left.column })
