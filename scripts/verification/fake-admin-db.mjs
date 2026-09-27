// Stand-in for server/db/client.ts so the REAL registry code runs without
// Postgres. It never opens a socket and never reads DATABASE_URL.
//
// Statements are lazy descriptors. A batch applies them against a snapshot
// and restores that snapshot if any of them throws, which is how the Neon
// HTTP driver's single-transaction batch behaves — that is precisely the
// property the no-partial-write tests need to observe.

export const state = {
  devices: new Map(),
  attributes: [], // { deviceId, attribute }
  assignments: [], // { id, eventId, deviceId, rangeStart, rangeEnd, assignedAt, releasedAt }
  events: [],
  /** Statements actually applied, in order. Reset between scenarios. */
  applied: [],
  /** Set to a message to make the NEXT applied write throw. */
  failNextWrite: null,
}

export const reset = () => {
  state.devices = new Map()
  state.attributes = []
  state.assignments = []
  state.events = []
  state.applied = []
  state.failNextWrite = null
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

const snapshot = () => ({
  devices: new Map([...state.devices].map(([k, v]) => [k, clone(v)])),
  attributes: clone(state.attributes),
  assignments: clone(state.assignments),
  events: clone(state.events),
})

const restore = (taken) => {
  state.devices = taken.devices
  state.attributes = taken.attributes
  state.assignments = taken.assignments
  state.events = taken.events
}

const rowsOf = (table) => {
  if (table === 'devices') return [...state.devices.values()]
  if (table === 'device_attributes') return state.attributes
  if (table === 'badge_assignments') return state.assignments
  if (table === 'events') return state.events
  throw new Error(`unexpected table ${table}`)
}

/** Evaluates a descriptor produced by the fake drizzle-orm operators. */
const matches = (row, condition) => {
  if (condition === undefined || condition === null) return true
  if (condition.op === 'and') return condition.parts.every((p) => matches(row, p))
  if (condition.op === 'eq') return row[condition.column] === condition.value
  if (condition.op === 'isNull') return row[condition.column] === null || row[condition.column] === undefined
  throw new Error(`unexpected condition ${String(condition.op)}`)
}

const project = (row, columns) => {
  if (columns === undefined) return clone(row)

  const picked = {}

  for (const [alias, descriptor] of Object.entries(columns)) {
    picked[alias] = clone(row[descriptor.column])
  }

  return picked
}

const guardFailure = () => {
  if (state.failNextWrite !== null) {
    const message = state.failNextWrite

    state.failNextWrite = null
    throw new Error(message)
  }
}

/**
 * A thenable statement. Awaiting it applies it immediately; handing it to
 * batch() applies it inside the batch instead.
 */
const statement = (describe, apply) => {
  const built = {
    describe,
    apply,
    then(resolve, reject) {
      try {
        resolve(built.__run())
      } catch (error) {
        reject(error)
      }

      return undefined
    },
    __run() {
      state.applied.push(describe())

      return apply()
    },
  }

  return built
}

const selectBuilder = (columns) => {
  const query = { columns, table: null, condition: undefined }

  const builder = {
    from(table) {
      query.table = table.__table

      return builder
    },
    innerJoin() {
      // The registry's only join narrows attributes to one event; the fake
      // keeps every attribute row scoped by device, so the join is a no-op.
      return builder
    },
    where(condition) {
      query.condition = condition

      return builder
    },
    orderBy() {
      return builder
    },
    then(resolve, reject) {
      try {
        state.applied.push(`select ${String(query.table)}`)
        resolve(
          rowsOf(query.table)
            .filter((row) => matches(row, query.condition))
            .map((row) => project(row, columns)),
        )
      } catch (error) {
        reject(error)
      }

      return undefined
    },
  }

  return builder
}

let nextId = 1

const insertBuilder = (table) => {
  const target = table.__table

  return {
    values(payload) {
      let returned = null

      const built = statement(
        () => `insert ${target}`,
        () => {
          guardFailure()

          const row = { ...payload }

          if (target === 'devices') {
            row.loginName ??= null
            row.enabled ??= true
            row.lastSeenAt ??= null
            row.createdAt ??= new Date('2026-01-01T00:00:00.000Z')
            state.devices.set(row.id, row)
          } else if (target === 'device_attributes') {
            state.attributes.push(row)
          } else if (target === 'badge_assignments') {
            row.id ??= `assignment-${String(nextId++)}`
            row.assignedAt ??= new Date('2026-01-01T00:00:00.000Z')
            row.releasedAt ??= null
            state.assignments.push(row)
          } else if (target === 'events') {
            row.id ??= `event-${String(nextId++)}`
            row.active ??= true
            row.startsAt ??= null
            row.endsAt ??= null
            row.createdAt ??= new Date('2026-01-01T00:00:00.000Z')
            state.events.push(row)
          }

          returned = clone(row)

          return [returned]
        },
      )

      built.returning = () => ({
        then(resolve, reject) {
          try {
            resolve(built.__run())
          } catch (error) {
            reject(error)
          }

          return undefined
        },
      })

      return built
    },
  }
}

const updateBuilder = (table) => {
  const target = table.__table

  return {
    set(patch) {
      let condition

      const built = statement(
        () => `update ${target}`,
        () => {
          guardFailure()

          const changed = []

          for (const row of rowsOf(target)) {
            if (matches(row, condition)) {
              Object.assign(row, patch)
              changed.push(clone(row))
            }
          }

          return changed
        },
      )

      const chain = {
        where(value) {
          condition = value

          return chain
        },
        returning() {
          return {
            then(resolve, reject) {
              try {
                resolve(built.__run())
              } catch (error) {
                reject(error)
              }

              return undefined
            },
          }
        },
        then(resolve, reject) {
          return built.then(resolve, reject)
        },
        describe: built.describe,
        __run: () => built.__run(),
      }

      return chain
    },
  }
}

const deleteBuilder = (table) => {
  const target = table.__table

  return {
    where(condition) {
      return statement(
        () => `delete ${target}`,
        () => {
          guardFailure()

          if (target === 'device_attributes') {
            state.attributes = state.attributes.filter((row) => !matches(row, condition))

            return []
          }

          throw new Error(`unexpected delete on ${target}`)
        },
      )
    },
  }
}

const database = {
  select: (columns) => selectBuilder(columns),
  insert: (table) => insertBuilder(table),
  update: (table) => updateBuilder(table),
  delete: (table) => deleteBuilder(table),
  /** All statements, or none: the Neon HTTP batch is one transaction. */
  async batch(statements) {
    const taken = snapshot()

    try {
      return statements.map((entry) => entry.__run())
    } catch (error) {
      restore(taken)
      throw error
    }
  },
}

export const getDatabase = () => database
export const isDatabaseConfigured = () => true

export class DatabaseNotConfiguredError extends Error {}

export const schema = {}
