import { resolve } from 'node:path'
// Drives unlockOperatorAccess against one HTTP status, in a fresh process.
import { createJiti } from 'jiti'
const HERE = import.meta.dirname
const root = resolve(HERE, '../..')
const status = Number(process.argv[2])
const TRUSTED_KEY = 'navaratri-2026.operator-device-unlocked.v1'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true })
globalThis.fetch = async () => ({
  ok: status >= 200 && status < 300,
  status,
  // Deliberately hostile: if the client ever rendered server text, it would show.
  async json() { return { ok: false, message: 'RAW SERVER INTERNAL DETAIL 10.0.0.1' } },
  async text() { return 'RAW SERVER INTERNAL DETAIL 10.0.0.1' },
})

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` }, interopDefault: true,
})
const access = await jiti.import(`${root}/src/auth/operator-access.ts`)
const result = await access.unlockOperatorAccess('a-strong-event-passphrase')
console.log(JSON.stringify({ ...result, trusted: store.get(TRUSTED_KEY) ?? null }))
