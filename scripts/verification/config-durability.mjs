/**
 * EventConfig durability — the local row must survive every startup,
 * remount, realm transition and concurrent initialisation.
 *
 * Run with:  pnpm verify:config
 *
 * It exists because a Development browser lost its local device identity,
 * badge range and central badge binding, leaving a row identical to the
 * bootstrap defaults. That is DATA LOSS: `nextBadge` is the offline badge
 * allocator and nothing can reconstruct it safely.
 *
 * The REAL bootstrap and the REAL enrollment, lease and badge writers run
 * against a stand-in Dexie that now behaves like Dexie on the two points
 * that matter: `add` REFUSES an existing key, and read-write transactions
 * are serialised.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')

if (!existsSync(join(root, 'dist/index.html'))) {
  console.error('This suite inspects the production build. Run `pnpm build` first.')
  process.exit(1)
}

let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { fails++; console.log(`FAIL ${label}\n     got  ${String(JSON.stringify(actual))}\n     want ${String(JSON.stringify(expected))}`) }
  else console.log(`ok   ${label.padEnd(58)} ${String(JSON.stringify(actual)).slice(0, 38)}`)
}

const read = (p) => readFileSync(join(root, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const alias = { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` }
const jiti = createJiti(import.meta.url, { alias, interopDefault: true })
const { state, db: standIn } = await import('./fake-db.mjs')

/**
 * A FRESH page load: a new module registry, so `bootstrapDatabase`'s memo
 * starts empty exactly as it does on a real reload. Re-using one instance
 * would only ever prove the memo works.
 */
const freshPageLoad = async () => {
  const module = await createJiti(import.meta.url,
    { alias, interopDefault: true, moduleCache: false })
    .import(`${root}/src/db/bootstrap.ts`)

  /**
   * A REJECTED bootstrap is reported, never thrown. An unconditional `add`
   * raises Dexie's ConstraintError, and a suite that merely crashed on it
   * would fail without ever saying which invariant broke.
   */
  return {
    bootstrapDatabase: async () => {
      try {
        await module.bootstrapDatabase()
      } catch (error) {
        fails += 1
        console.log(`FAIL bootstrap rejected: ${String(error?.name ?? error)}`)
      }
    },
  }
}

const enrollment = await jiti.import(`${root}/src/db/central-enrollment.ts`)
const offlineStore = await jiti.import(`${root}/src/db/central-offline-authorization.ts`)
const adoption = await jiti.import(`${root}/src/db/central-badge-range.ts`)
const issuance = await jiti.import(`${root}/src/db/registrations.ts`)

const CENTRAL_DEVICE = 'dddddddd-1111-4111-8111-dddddddddddd'
const CENTRAL_EVENT = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const LOCAL_DEVICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

/** The EXACT shape the Development browser held before the loss. */
const CONFIGURED = {
  id: 'event',
  eventName: 'Navaratri 2026',
  currency: 'INR',
  amount: 20,
  timezone: 'Asia/Kolkata',
  deviceId: LOCAL_DEVICE,
  deviceName: 'claim-test-local-2.1',
  deviceConfiguredAt: '2026-10-01T00:00:00.000Z',
  badgeStart: 501,
  badgeEnd: 600,
  nextBadge: 502,
  badgeConfiguredAt: '2026-10-01T01:00:00.000Z',
  centralDeviceEnrollment: {
    deviceId: CENTRAL_DEVICE, eventId: CENTRAL_EVENT, eventSlug: 'navaratri-2026',
    deviceName: 'Claim Test Desk 2', loginName: 'claim-test-2',
    attributes: ['registration'], verifiedAt: '2026-10-02T09:00:00.000Z',
  },
  centralDeviceOfflineAuthorization: {
    token: 'eyJwYXlsb2FkIjoxfQ.c2lnbmF0dXJl', receivedAt: '2026-10-02T09:00:01.000Z',
  },
  centralBadgeRangeBinding: {
    deviceId: CENTRAL_DEVICE, eventId: CENTRAL_EVENT, rangeStart: 501, rangeEnd: 600,
    assignedAt: '2026-10-01T00:30:00.000Z', adoptedAt: '2026-10-01T01:00:00.000Z',
  },
  upiId: 'organizer@upi',
  payeeName: 'Organizer',
  updatedAt: '2026-10-02T09:00:01.000Z',
}

/** Everything whose loss would be unrecoverable or operationally wrong. */
const DURABLE_FIELDS = [
  'deviceId', 'deviceName', 'deviceConfiguredAt',
  'badgeStart', 'badgeEnd', 'nextBadge', 'badgeConfiguredAt',
  'centralBadgeRangeBinding', 'eventName', 'currency', 'amount', 'timezone',
  'upiId', 'payeeName',
]
const durable = (config) =>
  Object.fromEntries(DURABLE_FIELDS.map((field) => [field, config?.[field]]))

const seed = (config, { completed = [] } = {}) => {
  state.config = config === null ? null : structuredClone(config)
  state.registrations = new Map()
  state.outbox = new Map()

  for (const badgeNumber of completed) {
    state.registrations.set(`r${String(badgeNumber)}`, {
      id: `r${String(badgeNumber)}`, status: 'completed', badgeNumber,
      name: 'Attendee', normalizedName: 'attendee', phone: '9000000001',
      age: 20, gender: 'Male', amount: 20, paymentStatus: 'confirmed',
      paymentMethod: 'cash', createdAt: 'T', updatedAt: 'T', completedAt: 'T',
    })
  }
}

console.log('=== 1. THE WRITER INVENTORY ===')
const configWriters = walk(join(root, 'src'))
  .filter((file) => /db\.config\.(put|add|update|delete)\(/.test(stripComments(readFileSync(file, 'utf8'))))
  .map((file) => file.replace(`${root}/src/`, '')).sort()
check('every module that writes the config row is accounted for', configWriters, [
  // create-if-missing, plus the UPI merge
  'db/bootstrap.ts',
  // adopts a central range: range + provenance together
  'db/central-badge-range.ts',
  // the central identity snapshot
  'db/central-enrollment.ts',
  // the signed offline lease
  'db/central-offline-authorization.ts',
  // Phase 7 identity and the one-time local range
  'db/device.ts',
  // the nextBadge increment
  'db/registrations.ts',
])

/**
 * The decisive static rule. A write that does not carry the existing row
 * forward replaces it, and a replaced config row is exactly the loss this
 * suite exists for.
 */
const literalWrites = []
for (const file of walk(join(root, 'src'))) {
  const code = stripComments(readFileSync(file, 'utf8'))

  for (const match of code.matchAll(/db\.config\.(?:put|add)\(\s*\{([\s\S]{0,120})/g)) {
    if (!match[1].includes('...')) {
      literalWrites.push(file.replace(`${root}/src/`, ''))
    }
  }

  for (const match of code.matchAll(/:\s*(?:Event|Registered|BadgeDistribution)\w*Config\s*=\s*\{\s*([\s\S]{0,40})/g)) {
    if (!match[1].includes('...')) {
      literalWrites.push(file.replace(`${root}/src/`, ''))
    }
  }
}
check('  no config write builds a row without carrying the existing one forward',
  [...new Set(literalWrites)], [])
check('  and nothing anywhere clears or deletes local data',
  walk(join(root, 'src'))
    .filter((file) => /\.clear\(\)|db\.delete\(\)|deleteDatabase|config\.delete\(/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/src/`, '')), [])

console.log('\n=== 2, 4. BOOTSTRAP PRESERVES A CONFIGURED ROW ===')
seed(CONFIGURED, { completed: [501] })
const original = JSON.stringify(state.config)

const first = await freshPageLoad()
await first.bootstrapDatabase()
check('a first page load changes NOTHING', JSON.stringify(state.config), original)
await first.bootstrapDatabase()
check('  calling it again within the same load changes nothing',
  JSON.stringify(state.config), original)

for (const load of [2, 3, 4]) {
  const reloaded = await freshPageLoad()
  await reloaded.bootstrapDatabase()
  check(`  page load ${String(load)} still changes nothing`,
    JSON.stringify(state.config), original)
}
check('  every durable field survived', durable(state.config), durable(CONFIGURED))
check('  including the ones that were lost in Development',
  ['deviceId', 'deviceName', 'deviceConfiguredAt', 'badgeEnd', 'badgeConfiguredAt',
   'centralBadgeRangeBinding'].filter((field) => state.config[field] === undefined), [])
check('  the issued registration survived too',
  [...state.registrations.values()].map((row) => row.badgeNumber), [501])

console.log('  -- 3. a DatabaseGate remount must be harmless --')
/**
 * `/device-login` sits OUTSIDE the event shell and mounts its own
 * DatabaseGate, so moving between realms genuinely mounts another one.
 * Bootstrap must be idempotent on its own, not merely mounted once.
 */
const remounts = await freshPageLoad()
for (let mount = 0; mount < 6; mount += 1) {
  await remounts.bootstrapDatabase()
}
check('six DatabaseGate mounts change nothing', JSON.stringify(state.config), original)

console.log('  -- 7. concurrent initialisation --')
const concurrent = await freshPageLoad()
await Promise.all([
  concurrent.bootstrapDatabase(),
  concurrent.bootstrapDatabase(),
  concurrent.bootstrapDatabase(),
])
check('three concurrent bootstraps change nothing',
  JSON.stringify(state.config), original)
const racingLoads = await Promise.all([freshPageLoad(), freshPageLoad(), freshPageLoad()])
await Promise.all(racingLoads.map((module) => module.bootstrapDatabase()))
check('  nor do three independent loads racing each other',
  JSON.stringify(state.config), original)

console.log('\n=== 5. AN EMPTY DATABASE IS SEEDED EXACTLY ONCE ===')
seed(null)
const empty = await freshPageLoad()
await empty.bootstrapDatabase()
check('bootstrap creates the default row',
  [state.config.id, state.config.badgeStart, state.config.nextBadge], ['event', 1, 1])
check('  with no badge range and no device identity',
  [state.config.badgeEnd, state.config.deviceId, state.config.deviceName,
   state.config.centralBadgeRangeBinding], [undefined, undefined, undefined, undefined])
check('  which grants nothing on its own',
  [state.config.badgeEnd === undefined, state.config.centralDeviceEnrollment], [true, undefined])
const seeded = JSON.stringify(state.config)
await (await freshPageLoad()).bootstrapDatabase()
check('  and a second load is a no-op', JSON.stringify(state.config), seeded)

seed(null)
const racingEmpty = await Promise.all([freshPageLoad(), freshPageLoad()])
await Promise.all(racingEmpty.map((module) => module.bootstrapDatabase()))
check('two loads racing on an EMPTY database still produce one coherent row',
  [state.config.id, state.config.badgeStart, state.config.nextBadge], ['event', 1, 1])

console.log('\n=== 6. ENROLLMENT AND LEASE PRESERVE EVERYTHING ELSE ===')
seed(CONFIGURED, { completed: [501] })
const baseline = durable(state.config)
const context = {
  device: {
    id: CENTRAL_DEVICE, eventId: CENTRAL_EVENT, name: 'Claim Test Desk 2',
    loginName: 'claim-test-2', attributes: ['registration'], lastSeenAt: null,
  },
  event: {
    id: CENTRAL_EVENT, slug: 'navaratri-2026', name: 'Navaratri 2026',
    timezone: 'Asia/Kolkata',
  },
  activeBadgeRange: { rangeStart: 501, rangeEnd: 600, assignedAt: '2026-10-01T00:30:00.000Z' },
}

await enrollment.saveCentralDeviceEnrollment(context)
check('saving the central enrollment preserves every local field',
  durable(state.config), baseline)
await offlineStore.saveCentralDeviceOfflineAuthorization('fresh.token')
check('  storing an offline lease preserves them too', durable(state.config), baseline)
await enrollment.saveCentralDeviceEnrollment(context)
await offlineStore.saveCentralDeviceOfflineAuthorization('replacement.token')
check('  refreshing the enrollment and replacing the lease preserve them',
  durable(state.config), baseline)
check('  the lease really was replaced',
  state.config.centralDeviceOfflineAuthorization.token, 'replacement.token')
check('  and exactly one lease is stored',
  Object.keys(state.config).filter((key) => /[Oo]ffline/.test(key)).length, 1)
await adoption.readCentralBadgeRangePlan(context)
check('  reading the badge plan writes nothing at all',
  durable(state.config), baseline)

console.log('  -- 8. a realm transition, mounts and all --')
seed(CONFIGURED, { completed: [501] })
const before = structuredClone(state.config)
const journey = await freshPageLoad()
// /device-login (its own DatabaseGate) -> / -> /badge-registration
// -> /device-registration -> /device-login
for (const step of [1, 2, 3, 4, 5]) {
  await journey.bootstrapDatabase()

  if (step === 1 || step === 5) {
    await enrollment.saveCentralDeviceEnrollment(context)
    await offlineStore.saveCentralDeviceOfflineAuthorization(`token-${String(step)}`)
  }
}
check('the whole journey preserves every durable field',
  durable(state.config), durable(before))
const changed = Object.keys(state.config)
  .filter((key) => JSON.stringify(state.config[key]) !== JSON.stringify(before[key]))
  .sort()
check('  and ONLY the intentionally refreshed fields changed',
  changed, ['centralDeviceEnrollment', 'centralDeviceOfflineAuthorization', 'updatedAt'])
check('  the enrollment change is the verification timestamp, not identity',
  [state.config.centralDeviceEnrollment.deviceId,
   state.config.centralDeviceEnrollment.loginName],
  [before.centralDeviceEnrollment.deviceId, before.centralDeviceEnrollment.loginName])

console.log('\n=== 9. ISSUED BADGES ARE NEVER RESET ===')
seed(CONFIGURED, { completed: [501] })
const issuedBaseline = durable(state.config)
for (const step of [1, 2, 3]) {
  const module = await freshPageLoad()
  await module.bootstrapDatabase()
  await enrollment.saveCentralDeviceEnrollment(context)
  await offlineStore.saveCentralDeviceOfflineAuthorization(`t${String(step)}`)
  await adoption.readCentralBadgeRangePlan(context)
}
check('nextBadge is untouched by every initialisation path', state.config.nextBadge, 502)
check('  the range and the binding too',
  [state.config.badgeStart, state.config.badgeEnd,
   state.config.centralBadgeRangeBinding.rangeEnd], [501, 600, 600])
check('  the issued registration survives', [...state.registrations.keys()], ['r501'])
check('  and every durable field is unchanged', durable(state.config), issuedBaseline)

console.log('  -- issuance still advances the counter, from the real domain --')
const issued = await issuance.issueBadge({
  registrationId: null, phone: '9000000002', name: 'Second',
  age: 22, gender: 'Female', paymentMethod: 'cash',
})
check('the next badge issued is #502',
  [issued.outcome, issued.registration.badgeNumber], ['issued', 502])
check('  and nextBadge advanced by exactly one', state.config.nextBadge, 503)
check('  without disturbing the device identity or the binding',
  [state.config.deviceId, state.config.centralBadgeRangeBinding.rangeStart],
  [LOCAL_DEVICE, 501])
await (await freshPageLoad()).bootstrapDatabase()
check('  and a reload after issuance does not rewind it', state.config.nextBadge, 503)

console.log('\n=== 10. BOOTSTRAP CANNOT REPLACE AN EXISTING ROW ===')
/**
 * Enforced by the stand-in, which now refuses `add` on an existing key just
 * as Dexie does. A bootstrap that reached for `add` unconditionally would
 * throw here rather than silently overwriting — which is what made the
 * earlier stand-in unable to see this class of bug at all.
 */
seed(CONFIGURED)
let addRejected = false
try {
  await standIn.config.add({ id: 'event' })
} catch (error) {
  addRejected = error.name === 'ConstraintError'
}
check('the stand-in refuses `add` over an existing row, exactly as Dexie does',
  addRejected, true)
check('  and the row was not touched by the attempt',
  durable(state.config), durable(CONFIGURED))

const bootstrapSource = stripComments(read('src/db/bootstrap.ts'))
check('bootstrap reads INSIDE the transaction before deciding',
  /db\.transaction\([\s\S]{0,200}db\.config\.get\(EVENT_CONFIG_ID\)/.test(bootstrapSource), true)
check('  it only ever ADDS when the row is absent',
  /existingConfig === undefined[\s\S]{0,200}db\.config\.add\(/.test(bootstrapSource), true)
check('  its only `put` carries the existing row forward',
  /applyUpiEnvironment\(existingConfig/.test(bootstrapSource), true)
check('  and skips the write entirely when nothing changed',
  /patchedConfig === existingConfig[\s\S]{0,60}return/.test(bootstrapSource), true)
check('  the UPI merge spreads rather than rebuilds',
  /return \{\s*\.\.\.config,/.test(stripComments(read('src/db/event-config.ts'))), true)

console.log('\n=== 7. OPERATOR LOCK TOUCHES NO LOCAL DATA ===')
const operatorSource = stripComments(read('src/auth/operator-access.ts'))
check('the operator realm never opens the database',
  /db\.config|db\.registrations|db\.outbox|@\/db\/database|bootstrapDatabase/
    .test(operatorSource), false)
check('  lock clears only the server cookie and the trusted marker',
  (() => {
    const lock = operatorSource.slice(operatorSource.indexOf('export const lockOperatorDevice'))
    return [/LOGOUT_ENDPOINT/.test(lock), /clearTrustedDevice\(\)/.test(lock),
            /db\.|config|nextBadge|Enrollment|offline/i.test(lock)]
  })(), [true, true, false])
check('  the trusted marker is localStorage only, never IndexedDB',
  /db\.|indexedDB/.test(stripComments(read('src/auth/trusted-device.ts'))), false)
check('  and no auth module writes the config row',
  walk(join(root, 'src/auth'))
    .filter((file) => /db\.config/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/src/`, '')), [])

console.log('\n=== 12. NO RECOVERY MAGIC WAS ADDED ===')
/**
 * A browser that lost its range must be reconfigured deliberately. Inferring
 * `nextBadge` from issued registrations could skip a badge already taken out
 * of the stack, and copying the central range is C2A's explicit, physically
 * confirmed act.
 */
check('nothing reconstructs nextBadge from registrations',
  walk(join(root, 'src'))
    .filter((file) => /nextBadge\s*[:=][^\n]*(max|Math\.max|length|count)/i
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/src/`, '')), [])
check('  and no startup path adopts a central range',
  /adoptCentralBadgeRange|configureBadgeDistribution/
    .test(bootstrapSource + stripComments(read('src/components/database-gate.tsx'))), false)
check('  IndexedDB version unchanged (1)',
  /DATABASE_VERSION = 1/.test(read('src/db/database.ts')), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(read('src/db/database.ts'))?.[1] ?? '')
    .match(/^\s*(\w+):/gm) ?? []).map((entry) => entry.trim().replace(':', '')),
  ['registrations', 'config', 'outbox'])

const manifest = JSON.parse(read('package.json'))
check('verify:config is registered',
  manifest.scripts['verify:config'], 'node scripts/verification/config-durability.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:config'), true)
check('release:check guards config durability',
  /config-durability/.test(read('scripts/release-check.mjs')), true)

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
