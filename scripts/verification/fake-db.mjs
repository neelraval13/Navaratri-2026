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

export const db = {
  outbox: outboxTable,
  registrations: registrationsTable,
  config: {
    __name: 'config',
    async get() { return state.config === null ? undefined : clone(state.config) },
    async put(c) { state.config = clone(c) },
    async add(c) { state.config = clone(c) },
  },
  async open() {},
  async transaction(mode, ...rest) { const cb = rest.pop(); return await cb() },
}
