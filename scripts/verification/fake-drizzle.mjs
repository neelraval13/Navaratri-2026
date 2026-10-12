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

export const dandiyaLoans = tableOf('dandiya_loans', [
  'id', 'eventId', 'pairCode', 'issuedByDeviceId', 'issuedAt',
  'closedAt', 'closedByDeviceId', 'outcome', 'pairReleasedAt',
  'contactPhone', 'accountabilityBadgeNumber',
])

export const dandiyaLoanHolders = tableOf('dandiya_loan_holders', [
  'id', 'loanId', 'eventId', 'badgeNumber', 'slot',
  'resolution', 'resolvedAt', 'resolvedByDeviceId',
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
export const or = (...parts) => ({ op: 'or', parts: parts.filter(Boolean) })
/**
 * HALF-OPEN RANGE COMPARISONS, which the day-scoped history read needs.
 *
 * `gte`/`lt` rather than a `between`, because the day window is
 * `[start, end)` — an inclusive upper bound would either lose a millisecond
 * or claim one twice.
 */
export const gte = (left, value) => ({
  op: 'gte', table: left.table, column: left.column, value,
})
export const lt = (left, value) => ({
  op: 'lt', table: left.table, column: left.column, value,
})
export const inArray = (left, values) => ({
  op: 'inArray', table: left.table, column: left.column, values: [...values],
})
export const asc = (left) => ({ op: 'asc', column: left.column })

/**
 * A tagged template captured as a descriptor, never as real SQL.
 *
 * `.as(alias)` exists because an INSERT ... SELECT names every selected
 * expression, and the issuance writer builds its guarded insert that way. The
 * alias is carried but never used to decide anything: the stand-in reads the
 * FIELD KEY, exactly as Drizzle builds the column list from the table.
 */
export const sql = (strings, ...values) => {
  const expression = { op: 'sql', strings: [...strings], values }

  expression.as = (alias) => ({ ...expression, alias, as: expression.as })

  return expression
}
