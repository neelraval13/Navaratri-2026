/**
 * Phase 7B verification — Device Readiness, read-only guarantees, browser
 * capability states, login 429 handling, and the firewall documentation.
 *
 * Run with:  pnpm verify:7b
 *
 * Framework-free on purpose: it loads the real TypeScript modules through jiti
 * with the database aliased to an in-memory stub. Requires `pnpm build` first,
 * because a few assertions inspect the built service worker and index.html.
 */
import { createJiti } from 'jiti'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')
const FAKE = `${HERE}/fake-db.mjs`

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': FAKE, '@': `${root}/src` }, interopDefault: true,
})

const distIndex = join(root, 'dist/index.html')
if (!existsSync(distIndex)) {
  console.error('This suite inspects the production build. Run `pnpm build` first.')
  process.exit(1)
}

let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { fails++; console.log(`FAIL ${label}\n     got  ${String(JSON.stringify(actual))}\n     want ${String(JSON.stringify(expected))}`) }
  else console.log(`ok   ${label.padEnd(58)} ${String(JSON.stringify(actual)).slice(0, 38)}`)
}

const setGlobals = (over = {}) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true, ...over.navigator }, configurable: true, writable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: { matchMedia: () => ({ matches: false }), ...over.window }, configurable: true, writable: true,
  })
}
setGlobals()

const { state } = await jiti.import(FAKE)
const readiness = await jiti.import(`${root}/src/db/readiness.ts`)
const environment = await jiti.import(`${root}/src/lib/device-environment.ts`)
const summary = await jiti.import(`${root}/src/lib/device-readiness-summary.ts`)
const device = await jiti.import(`${root}/src/db/device.ts`)

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const CONFIGURED = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, badgeEnd: 250, nextBadge: 1,
  deviceId: DEVICE_ID, deviceName: 'Registration Desk A',
  deviceConfiguredAt: '2026-09-27T06:00:00.000Z', updatedAt: 'T1',
  upiId: 'organizer@upi', payeeName: 'Organizer',
}
const BOOTSTRAP = { ...CONFIGURED, deviceId: undefined, deviceName: undefined, badgeEnd: undefined, deviceConfiguredAt: undefined }

const reset = (config = CONFIGURED) => {
  state.registrations.clear(); state.outbox.clear()
  state.config = config === null ? null : { ...config }
}
const addRegistration = (id, over) => {
  state.registrations.set(id, {
    id, name: 'Aarav Sharma', normalizedName: 'aarav sharma', phone: '9876543210',
    age: 25, gender: 'male', amount: 20, createdAt: 'x', updatedAt: 'x', ...over,
  })
}

console.log('=== 1-12. READINESS DATA IS FRESH AND CORRECT ===')
reset()
let r = await readiness.readLocalReadiness()
check('configured device identity read', [r.ok, r.device.deviceName, r.device.deviceId], [true, 'Registration Desk A', DEVICE_ID])
check('  configuredAt read', r.device.deviceConfiguredAt, '2026-09-27T06:00:00.000Z')
check('  readAt stamped', typeof r.readAt === 'string' && r.readAt.endsWith('Z'), true)
check('badge range formatting', device.formatBadgeRange(r.badgeDistribution.badgeStart, r.badgeDistribution.badgeEnd), '#001–#250')
check('  1000 not truncated', device.formatBadgeRange(1, 1000), '#001–#1000')
check('range available at start', [r.badgeDistribution.status, r.badgeDistribution.remaining], ['available', 250])

// nextBadge advances in the DB only; the read must follow it.
state.config = { ...CONFIGURED, nextBadge: 137 }
r = await readiness.readLocalReadiness()
check('nextBadge read FRESH from IndexedDB', r.badgeDistribution.nextBadge, 137)
check('  remaining recomputed', r.badgeDistribution.remaining, 114)
state.config = { ...CONFIGURED, nextBadge: 250 }
check('last badge still available', (await readiness.readLocalReadiness()).badgeDistribution.status, 'available')
state.config = { ...CONFIGURED, nextBadge: 251 }
r = await readiness.readLocalReadiness()
check('exhausted range reports 0 remaining', [r.badgeDistribution.status, r.badgeDistribution.remaining], ['exhausted', 0])

reset()
addRegistration('c1', { status: 'completed', badgeNumber: 1, paymentStatus: 'confirmed', paymentMethod: 'cash', completedAt: 'x' })
addRegistration('c2', { status: 'completed', badgeNumber: 2, paymentStatus: 'confirmed', paymentMethod: 'upi', completedAt: 'x' })
addRegistration('h1', { status: 'held', paymentStatus: 'pending', heldAt: 'x' })
state.outbox.set('registration:h1', { id: 'registration:h1', registrationId: 'h1', payload: {}, attemptCount: 0 })
r = await readiness.readLocalReadiness()
check('completed count', r.counts.completed, 2)
check('held count', r.counts.held, 1)
check('outbox count', r.counts.pendingSync, 1)

// A second read after the queue drains must show the new value.
state.outbox.clear()
check('re-read picks up the drained queue', (await readiness.readLocalReadiness()).counts.pendingSync, 0)
addRegistration('c3', { status: 'completed', badgeNumber: 3, paymentStatus: 'confirmed', paymentMethod: 'cash', completedAt: 'x' })
check('re-read picks up a new registration', (await readiness.readLocalReadiness()).counts.completed, 3)

reset(BOOTSTRAP)
r = await readiness.readLocalReadiness()
check('unregistered device fails closed', [r.ok, r.reason], [false, 'not-registered'])
check('  counts still reported', r.counts, { completed: 0, held: 0, pendingSync: 0 })
reset(null)
check('missing config fails closed', (await readiness.readLocalReadiness()).reason, 'missing-config')
/**
 * A registered device with no badge range is HEALTHY, not broken: readiness
 * must work for a prize or dandiya desk. It simply reports the badge module
 * as unconfigured, and invents no range.
 */
reset({ ...CONFIGURED, badgeEnd: undefined, badgeStart: 1, nextBadge: 1 })
r = await readiness.readLocalReadiness()
check('registered device with NO badge range still reads ok', r.ok, true)
check('  badge distribution reported unconfigured', r.badgeDistribution, { configured: false })
check('  open-ended range is never inferred',
  ['badgeStart', 'badgeEnd', 'nextBadge', 'remaining'].some((k) => k in r.badgeDistribution), false)

reset()
addRegistration('c1', { status: 'completed', badgeNumber: 1, paymentStatus: 'confirmed', paymentMethod: 'cash', completedAt: 'x' })
const serialised = JSON.stringify(await readiness.readLocalReadiness())
check('no attendee name in the readiness data', /Aarav|Sharma/.test(serialised), false)
check('no phone number in the readiness data', /9876543210/.test(serialised), false)
check('no UPI details in the readiness data', /organizer@upi|Organizer/.test(serialised), false)
check('  snapshot device projection is identity ONLY',
  Object.keys(JSON.parse(serialised).device).sort(),
  ['deviceConfiguredAt', 'deviceId', 'deviceName'])

console.log('\n=== 13-24. BROWSER CAPABILITIES ===')
let persistCalls = 0
const withEnv = async (nav, win) => {
  setGlobals({ navigator: nav, window: win })
  return await environment.readDeviceEnvironment()
}
check('online rendered', (await withEnv({ onLine: true })).network, 'online')
check('offline rendered safely', (await withEnv({ onLine: false })).network, 'offline')
check('service worker controlling -> active',
  (await withEnv({ onLine: true, serviceWorker: { controller: {} } })).serviceWorker, 'active')
check('  no controller -> not-controlling',
  (await withEnv({ onLine: true, serviceWorker: { controller: null } })).serviceWorker, 'not-controlling')
check('  unsupported handled', (await withEnv({ onLine: true })).serviceWorker, 'unsupported')
check('standalone display mode detected',
  (await withEnv({ onLine: true }, { matchMedia: () => ({ matches: true }) })).displayMode, 'standalone')
check('  browser mode detected',
  (await withEnv({ onLine: true }, { matchMedia: () => ({ matches: false }) })).displayMode, 'browser')
check('  iOS navigator.standalone fallback',
  (await withEnv({ onLine: true, standalone: true }, { matchMedia: () => ({ matches: false }) })).displayMode, 'standalone')
check('  no matchMedia at all handled', (await withEnv({ onLine: true }, {})).displayMode, 'browser')

const storage = (persisted) => ({
  persisted: async () => { if (typeof persisted === 'function') return persisted(); return persisted },
  persist: async () => { persistCalls++; return true },
})
check('persisted() true -> granted',
  (await withEnv({ onLine: true, storage: storage(true) })).persistentStorage, 'granted')
check('  false -> not-granted (a warning, not a reset)',
  (await withEnv({ onLine: true, storage: storage(false) })).persistentStorage, 'not-granted')
check('  missing API -> unsupported', (await withEnv({ onLine: true })).persistentStorage, 'unsupported')
check('  throwing persisted() -> unsupported, no throw',
  (await withEnv({ onLine: true, storage: storage(() => { throw new Error('nope') }) })).persistentStorage, 'unsupported')
check('readiness NEVER calls navigator.storage.persist()', persistCalls, 0)

const envSource = readFileSync(join(root, 'src/lib/device-environment.ts'), 'utf8')
const panelSource = readFileSync(join(root, 'src/components/device/device-readiness.tsx'), 'utf8')
const readinessSource = readFileSync(join(root, 'src/db/readiness.ts'), 'utf8')
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const allReadiness = stripComments(`${envSource}\n${panelSource}\n${readinessSource}`)
check('  never registers or replaces a service worker',
  /serviceWorker\.register|skipWaiting|\.update\(\)|unregister\(/.test(allReadiness), false)
check('  never calls persist()', /storage\.persist\(|\.persist\(\)/.test(allReadiness), false)
setGlobals()

console.log('\n=== 25-33. READ-ONLY GUARANTEE ===')
reset()
addRegistration('c1', { status: 'completed', badgeNumber: 7, paymentStatus: 'confirmed', paymentMethod: 'cash', completedAt: 'x' })
state.outbox.set('registration:c1', { id: 'registration:c1', registrationId: 'c1', payload: {}, attemptCount: 2 })
const before = JSON.stringify({
  config: state.config,
  registrations: [...state.registrations.entries()],
  outbox: [...state.outbox.entries()],
})
await readiness.readLocalReadiness()
await readiness.readLocalReadiness()
const after = JSON.stringify({
  config: state.config,
  registrations: [...state.registrations.entries()],
  outbox: [...state.outbox.entries()],
})
check('readiness performs NO config write', JSON.parse(after).config, JSON.parse(before).config)
check('  NO registration write', JSON.parse(after).registrations, JSON.parse(before).registrations)
check('  NO outbox write', JSON.parse(after).outbox, JSON.parse(before).outbox)
check('  whole local state byte-identical', after, before)
check('  read layer contains no write call',
  /\.put\(|\.add\(|\.delete\(|\.clear\(|bulkPut|bulkDelete|deleteDatabase/.test(stripComments(readinessSource)), false)
check('  read layer uses a read-only transaction path', /db\.transaction\(\s*'rw'/.test(readinessSource), false)

for (const [label, pattern] of [
  ['range edit', /editRange|setBadgeRange|changeRange|updateRange/],
  ['nextBadge reset', /resetNextBadge|setNextBadge/],
  ['device ID reset', /regenerateDevice|changeDeviceId|resetDeviceId/],
  ['clear storage', /clearRegistrations|clearOutbox|clearStorage|deleteDatabase|\.clear\(\)/],
  ['logout side effect', /lockOperatorDevice|clearTrustedDevice/],
]) check(`  no ${label} control in the panel`, pattern.test(stripComments(panelSource)), false)

const summarySnapshot = {
  local: {
    ok: true, readAt: 'x',
    device: { deviceId: DEVICE_ID, deviceName: 'Registration Desk A',
      deviceConfiguredAt: '2026-09-27T06:00:00.000Z' },
    badgeDistribution: { configured: true, badgeStart: 1, badgeEnd: 250, nextBadge: 1, remaining: 250, status: 'available' },
    counts: { completed: 0, held: 0, pendingSync: 0 },
  },
  environment: { network: 'online', serviceWorker: 'active', displayMode: 'standalone', persistentStorage: 'granted' },
}
const text = summary.buildDeviceSummary(summarySnapshot)
check('summary names device and range', [text.includes('Registration Desk A'), text.includes('#001–#250')], [true, true])
check('  includes the Device ID', text.includes(DEVICE_ID), true)
check('  excludes attendee data', /Aarav|Sharma|9876543210/.test(text), false)
check('  excludes UPI + secrets', /organizer@upi|EVENT_SESSION_SECRET|accessCode|cookie|__Host-/i.test(text), false)
check('  reports capabilities', [text.includes('PWA: Installed / standalone'), text.includes('Service Worker: Active')], [true, true])
check('unregistered summary says so, without inventing a range',
  summary.buildDeviceSummary({ ...summarySnapshot, local: { ok: false, readAt: 'x', reason: 'not-registered', counts: { completed: 0, held: 0, pendingSync: 0 } } })
    .includes('Device: NOT REGISTERED'), true)
const noBadgeSummary = summary.buildDeviceSummary({ ...summarySnapshot,
  local: { ...summarySnapshot.local, badgeDistribution: { configured: false } } })
check('registered-without-badges summary is honest',
  [noBadgeSummary.includes('Badge Distribution: Not configured'),
   /Badge Range|Next Badge|Remaining/.test(noBadgeSummary)], [true, false])

console.log('\n=== 41. LOGIN 429 HANDLING ===')
const loginStatus = (status) => {
  const r = spawnSync('node', [`${HERE}/login-status.mjs`, String(status)], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) { console.log(r.stderr.split('\n').slice(0, 3).join('\n')) }
  return JSON.parse(r.stdout.trim().split('\n').pop())
}
let l = loginStatus(429)
check('429 -> generic wait message', l.message, 'Too many unlock attempts. Wait a moment and try again.')
check('  does not claim the code was wrong', /incorrect/i.test(l.message), false)
check('  no crash', l.ok, false)
check('  device NOT marked trusted', l.trusted, null)
check('401 still says incorrect', loginStatus(401).message, 'Access code is incorrect.')
check('503 still says not configured', loginStatus(503).message, 'Operator access is not configured.')
check('500 -> generic unavailable', loginStatus(500).message, 'Unable to unlock. Try again.')
const authSource = readFileSync(join(root, 'src/auth/operator-access.ts'), 'utf8')
check('  no server response text ever rendered', /response\.text\(\)|body\.message|await response\.json\(\).*message/.test(authSource), false)
check('  no IP or counter exposed', /remaining|retryAfter|Retry-After|ipAddress/i.test(authSource), false)

console.log('\n=== FIREWALL DOC + NO IN-PROCESS LIMITER ===')
const firewallDoc = readFileSync(join(root, 'docs/VERCEL_FIREWALL.md'), 'utf8')
check('documents the login path + method', [/\/api\/operator-login/.test(firewallDoc), /POST/.test(firewallDoc)], [true, true])
check('  10 requests / 60 seconds / IP / fixed window',
  [/\b10\b/.test(firewallDoc), /60 seconds/.test(firewallDoc), /\bIP\b/.test(firewallDoc), /Fixed Window/i.test(firewallDoc)], [true, true, true, true])
check('  states it is NOT created by application code', /NOT created by application code/i.test(firewallDoc), true)
check('  excludes the other endpoints',
  [/Do not rate-limit/i.test(firewallDoc), /operator-session/.test(firewallDoc), /sync-registration/.test(firewallDoc)], [true, true, true])
const serverSources = spawnSync('grep', ['-rlE', 'rateLimit|rate_limit|@vercel/firewall|ratelimit', join(root, 'api'), join(root, 'server')], { encoding: 'utf8' })
check('no in-process rate limiter in api/ or server/', serverSources.stdout.trim(), '')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('  no firewall/redis/kv dependency added',
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /firewall|redis|kv|upstash|ratelimit/i.test(d)), [])

console.log('\n=== MOUNT ORDER: NO DEXIE BEFORE DatabaseGate ===')
const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const headerSource = appSource.slice(appSource.indexOf('<header'), appSource.indexOf('</header>'))
const badgePageSource = readFileSync(join(root, 'src/pages/badge-registration-page.tsx'), 'utf8')
const devicePageSource = readFileSync(join(root, 'src/pages/device-registration-page.tsx'), 'utf8')
check('readiness trigger is NOT in the global header', /<DeviceReadiness/.test(headerSource), false)
/**
 * Phase 8A moved the router under DatabaseGate, so every page — and therefore
 * every readiness trigger — mounts only after bootstrap has succeeded.
 */
check('  the router mounts inside DatabaseGate', appSource.indexOf('<DatabaseGate>') < appSource.indexOf('<AppRouter />'), true)
check('  badge page gates readiness behind DeviceRequiredGate',
  badgePageSource.indexOf('<DeviceRequiredGate>') < badgePageSource.indexOf('<DeviceReadiness'), true)
/**
 * Phase D1 added a CONVERGED branch above the registered one, so a single
 * "the guard appears before the render" position test no longer describes the
 * page. The invariant it was protecting is unchanged and is now stated
 * directly: every readiness render sits inside a branch that has already
 * established a device identity, and the unregistered fall-through renders
 * none at all.
 */
const devicePageBody = devicePageSource.slice(devicePageSource.indexOf('const DeviceRegistrationPage'))
const convergedGuardAt = devicePageBody.indexOf('if (isConverged) {')
const registeredGuardAt = devicePageBody.indexOf('if (isDeviceRegistered(config)) {')
const readinessAt = [...devicePageBody.matchAll(/<DeviceReadiness/g)].map((match) => match.index)
const unregisteredReturn = devicePageBody.slice(devicePageBody.lastIndexOf('\n  return ('))
check('  device page shows it only for a device that has an identity', [
  convergedGuardAt > -1,
  registeredGuardAt > convergedGuardAt,
  readinessAt.length === 2,
  readinessAt.every((at) => at > convergedGuardAt),
  readinessAt[1] > registeredGuardAt,
  unregisteredReturn.includes('<DeviceRegistrationForm'),
  unregisteredReturn.includes('<DeviceReadiness'),
], [true, true, true, true, true, true, false])
const convergedDefinition = devicePageBody.slice(
  devicePageBody.indexOf('const isConverged ='), convergedGuardAt)
check('    converged is an identity match, never a stored flag',
  /config\.deviceId === config\.centralDeviceEnrollment\.deviceId/.test(convergedDefinition), true)
check('readiness reads no config hook to decide visibility',
  /useEventConfig/.test(panelSource), false)

/**
 * Every component the header renders, checked against the database layer. A
 * header component runs BEFORE bootstrap, so none may touch Dexie.
 */
const HEADER_COMPONENTS = [
  'src/components/connectivity-status.tsx',
  'src/components/sync-status.tsx',
  'src/components/theme-toggle.tsx',
  'src/components/operator/lock-device-button.tsx',
]
const dbTouching = HEADER_COMPONENTS.filter((file) =>
  /useEventConfig|@\/db\/(database|event-config|readiness|device|registrations|outbox)/.test(
    readFileSync(join(root, file), 'utf8')))
check('no header component reads the database', dbTouching, [])
check('  every useEventConfig consumer is inside DatabaseGate',
  spawnSync('grep', ['-rl', 'useEventConfig', join(root, 'src/components'), join(root, 'src/pages')], { encoding: 'utf8' })
    .stdout.trim().split('\n').map((f) => f.replace(`${root}/src/`, '')).sort(),
  ['components/device/badge-distribution-gate.tsx', 'components/device/device-label.tsx',
   'components/device/device-registered-gate.tsx', 'components/registration/registration-form.tsx',
   'pages/device-registration-page.tsx', 'pages/home-page.tsx'].sort())

console.log('\n=== DIALOG PRIMITIVE AUDIT ===')
const dialogSource = readFileSync(join(root, 'src/components/ui/dialog.tsx'), 'utf8')
const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('`cn` is a DECLARED dependency, not transitive', typeof pkgJson.dependencies.cn, 'string')
check('  dialog matches every other ui primitive', /import \{ cn \} from "cn"/.test(dialogSource), true)
check('React types are imported explicitly', /import \* as React from "react"/.test(dialogSource), true)
check('Title and Description are rendered for a11y',
  [/DialogPrimitive\.Title/.test(dialogSource), /DialogPrimitive\.Description/.test(dialogSource)], [true, true])
check('  the panel actually uses them',
  [/<DialogTitle>/.test(panelSource), /<DialogDescription>/.test(panelSource)], [true, true])
check('a Close is rendered INSIDE the Popup (Base UI modal requirement)',
  dialogSource.indexOf('DialogPrimitive.Popup') < dialogSource.indexOf('DialogPrimitive.Close\n') ||
  /<DialogPrimitive\.Close[\s\S]*<\/DialogPrimitive\.Popup>/.test(dialogSource), true)
check('  it has an accessible name', /<span className="sr-only">\s*Close/.test(dialogSource), true)
check('dismissal is left at Base UI defaults (Esc + outside press)',
  /dismissible|modal=/.test(dialogSource), false)
check('no new dependency for the dialog',
  Object.keys(pkgJson.dependencies).filter((d) => /dialog|modal|radix|headless/i.test(d)), [])

console.log('\n=== DURABLE VERIFICATION ===')
for (const f of ['scripts/verification/phase-7b.mjs', 'scripts/verification/prior-phases.mjs',
                 'scripts/verification/fake-db.mjs', 'scripts/verification/component-render.mjs',
                 'scripts/verification/login-status.mjs', 'scripts/verification/fake-event-config.mjs'])
  check(`${f.replace('scripts/verification/', '')} is in the repository`, existsSync(join(root, f)), true)
check('package scripts expose them',
  [pkgJson.scripts['verify:7b'], pkgJson.scripts['verify:prior']],
  ['node scripts/verification/phase-7b.mjs', 'node scripts/verification/prior-phases.mjs'])
check('jiti is a DECLARED devDependency', typeof pkgJson.devDependencies.jiti, 'string')
const runners = ['phase-7b.mjs', 'prior-phases.mjs', 'component-render.mjs', 'login-status.mjs']
  .map((f) => readFileSync(join(root, 'scripts/verification', f), 'utf8')).join('\n')
check('  no hashed pnpm store path is baked in', /node_modules\/\.pnpm/.test(runners), false)
// Needle built from parts so this assertion does not match its own source.
const SCRATCH_NEEDLE = new RegExp(['claude-' + '502', 'scratch' + 'pad'].join('|'))
check('  no session scratch path is baked in', SCRATCH_NEEDLE.test(runners), false)
check('  runners resolve the repo from their own location', /resolve\(HERE, '\.\.\/\.\.'\)/.test(runners), true)
check('no test framework was added',
  Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies })
    .filter((d) => /^(vitest|jest|mocha|ava|jasmine|@testing-library)/.test(d)), [])

console.log('\n=== DOCS + NO SCHEMA CHANGE ===')
for (const doc of ['docs/DEVICE_RANGE_PLAN.md', 'docs/DEVICE_PROVISIONING.md', 'docs/VERCEL_FIREWALL.md'])
  check(`${doc} exists`, readFileSync(join(root, doc), 'utf8').length > 500, true)
const planDoc = readFileSync(join(root, 'docs/DEVICE_RANGE_PLAN.md'), 'utf8')
check('range plan states Badge Count formula', /Range End . Range Start \+ 1/.test(planDoc), true)
check('  states ranges must not overlap', /must not overlap/i.test(planDoc), true)
check('  documents the reserve range', /[Rr]eserve/.test(planDoc), true)
check('  states the app does not own it', /never reads it, never\s+writes it and does not own it/i.test(planDoc), true)
check('  warns against clearing site data', /never clear browser or site data/i.test(planDoc), true)
const provisioningDoc = readFileSync(join(root, 'docs/DEVICE_PROVISIONING.md'), 'utf8')
check('provisioning warns about real badge smoke tests', /Do not smoke-test issuance with real event badge numbers/i.test(provisioningDoc), true)
check('  documents the offline test', /offline provisioning test/i.test(provisioningDoc), true)
check('  says not to issue a badge to prove offline', /Do not issue a real production badge/i.test(provisioningDoc), true)

const dbSource = readFileSync(join(root, 'src/db/database.ts'), 'utf8')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION\s*=\s*1\b/.test(dbSource), true)
const storesBlock = /\.stores\(\{([\s\S]*?)\}\)/.exec(dbSource)?.[1] ?? ''
check('  exactly three stores', (storesBlock.match(/^\s*(\w+):/gm) ?? []).map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
const sheetSource = readFileSync(join(root, 'server/sync/sheet-contract.ts'), 'utf8')
check('Sheet ranges unchanged (A1:N / A1:M)',
  [/A1:N/.test(sheetSource), /A1:M/.test(sheetSource)], [true, true])
check('  no new Sheet column added', /Device ID', 'Device Name'/.test(sheetSource), true)

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
