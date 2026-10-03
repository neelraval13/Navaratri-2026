// Stand-in for src/db/database.ts so the real write/read layers run without
// a browser IndexedDB.
export const state = { outbox: new Map(), registrations: new Map(), config: null }

const clone = (v) => (v === undefined ? undefined : structuredClone(v))
const regs = () => [...state.registrations.values()]

const outboxTable = {
  __name: 'outbox',
  async toArray() { return [...state.outbox.values()].map(clone) },
  async get(id) { return clone(state.outbox.get(id)) },
  async put(item) { state.outbox.set(item.id, clone(item)) },
  async delete(id) { state.outbox.delete(id) },
  async count() { return state.outbox.size },
}

const registrationsTable = {
  __name: 'registrations',
  async get(id) { return clone(state.registrations.get(id)) },
  async put(record) { state.registrations.set(record.id, clone(record)) },
  async count() { return state.registrations.size },
  where(index) {
    return {
      equals(key) {
        const all = () => {
          if (index === '[phone+normalizedName]') {
            const [phone, normalizedName] = key
            return regs().filter((r) => r.phone === phone && r.normalizedName === normalizedName)
          }
          if (index === 'badgeNumber') return regs().filter((r) => r.badgeNumber === key)
          if (index === 'status') return regs().filter((r) => r.status === key)
          if (index === 'phone') return regs().filter((r) => r.phone === key)
          throw new Error(`unexpected index ${index}`)
        }
        return {
          async toArray() { return all() },
          async first() { return all()[0] },
          async count() { return all().length },
        }
      },
    }
  },
}

/**
 * Dexie's `add` REFUSES an existing primary key; it does not overwrite.
 *
 * The stand-in used to overwrite, which made a destructive bootstrap
 * indistinguishable from a safe one: `add(defaults)` over a configured row
 * would silently succeed here and wipe the row in production. Faithfulness
 * on this one call is the difference between a test that can see data loss
 * and one that cannot.
 */
const constraintError = () => {
  const error = new Error(
    "Key already exists in the object store. ConstraintError: the config row is already present.",
  )

  error.name = 'ConstraintError'

  return error
}

/**
 * Dexie serialises read-write transactions over the same table, so two
 * concurrent bootstraps cannot interleave their read and their write. The
 * queue reproduces that: without it, a racy create-if-missing would look
 * safe here and double-write in a browser.
 */
let transactionQueue = Promise.resolve()

export const db = {
  outbox: outboxTable,
  registrations: registrationsTable,
  config: {
    __name: 'config',
    async get() { return state.config === null ? undefined : clone(state.config) },
    async put(c) { state.config = clone(c) },
    async add(c) {
      if (state.config !== null && state.config !== undefined) {
        throw constraintError()
      }

      state.config = clone(c)
    },
  },
  async open() {},
  async transaction(mode, ...rest) {
    const cb = rest.pop()
    const run = transactionQueue.then(() => cb(), () => cb())

    transactionQueue = run.then(() => undefined, () => undefined)

    return await run
  },
}
