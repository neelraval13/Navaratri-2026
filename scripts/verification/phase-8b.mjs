/**
 * Phase 8B verification — device identity is separate from badge distribution.
 *
 * Run with:  pnpm verify:8b
 *
 * The correction this proves: a registered physical device does NOT
 * necessarily hand out badges. A prize or dandiya desk is a real registered
 * device that owns no range, and nothing may infer badge ownership from a
 * device identity or from bootstrap defaults.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { renderRoute } from './route-render.mjs'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')
const FAKE = `${HERE}/fake-db.mjs`

if (!existsSync(join(root, 'dist/index.html'))) {
  console.error('This suite inspects the production build. Run `pnpm build` first.')
  process.exit(1)
}

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': FAKE, '@': `${root}/src` }, interopDefault: true,
})
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true })

let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { fails++; console.log(`FAIL ${label}\n     got  ${String(JSON.stringify(actual))}\n     want ${String(JSON.stringify(expected))}`) }
  else console.log(`ok   ${label.padEnd(58)} ${String(JSON.stringify(actual)).slice(0, 38)}`)
}

const { state } = await jiti.import(FAKE)
const device = await jiti.import(`${root}/src/db/device.ts`)
const eventConfig = await jiti.import(`${root}/src/db/event-config.ts`)
const reg = await jiti.import(`${root}/src/db/registrations.ts`)
const readiness = await jiti.import(`${root}/src/db/readiness.ts`)

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const BOOTSTRAP = { id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1, upiId: 'organizer@upi',
  payeeName: 'Organizer', updatedAt: 'T0' }
/** A real Phase 7 production device: identity AND range, no badgeConfiguredAt. */
const LEGACY = { ...BOOTSTRAP, deviceId: DEVICE_ID, deviceName: 'Registration Desk A',
  badgeStart: 1, badgeEnd: 250, nextBadge: 137, deviceConfiguredAt: 'T1' }
const reset = (config) => { state.registrations.clear(); state.outbox.clear(); state.config = { ...config } }
const attendee = (phone, name) => ({ registrationId: null, phone, name, age: 25, gender: 'male' })

console.log('=== 1-4. THE DOMAIN SPLIT ===')
reset(BOOTSTRAP)
let r = await device.registerDevice({ deviceName: 'Prize Desk' })
check('generic registration succeeds with NO badgeEnd', r.outcome, 'registered')
check('  it assigns no range at all',
  [r.config.badgeEnd, r.config.badgeConfiguredAt], [undefined, undefined])
check('  a UUID identity is minted', /^[0-9a-f-]{36}$/.test(r.config.deviceId), true)
check('  deviceConfiguredAt stamped', typeof r.config.deviceConfiguredAt, 'string')
const generic = { ...state.config }
check('generic device IS registered', device.isDeviceRegistered(generic), true)
check('generic device is NOT badge-configured', device.isBadgeDistributionConfigured(generic), false)
check('  bootstrap badgeStart/nextBadge grant nothing',
  [generic.badgeStart, generic.nextBadge, device.isBadgeDistributionConfigured(generic)], [1, 1, false])

check('legacy Phase-7 device is registered', device.isDeviceRegistered(LEGACY), true)
check('  AND badge-configured', device.isBadgeDistributionConfigured(LEGACY), true)
check('  a missing badgeConfiguredAt does not invalidate it',
  [LEGACY.badgeConfiguredAt, device.isBadgeDistributionConfigured(LEGACY)], [undefined, true])
check('  a missing deviceConfiguredAt does not invalidate identity',
  device.isDeviceRegistered({ ...LEGACY, deviceConfiguredAt: undefined }), true)
check('unregistered bootstrap is neither',
  [device.isDeviceRegistered(BOOTSTRAP), device.isBadgeDistributionConfigured(BOOTSTRAP)], [false, false])
check('identity without a name is not registered',
  device.isDeviceRegistered({ ...LEGACY, deviceName: '  ' }), false)

console.log('\n=== 5-10. ROUTE STATES ===')
const UNREGISTERED = { ...BOOTSTRAP }
const GENERIC = { ...BOOTSTRAP, deviceId: DEVICE_ID, deviceName: 'Prize Desk', deviceConfiguredAt: 'T1' }
const FORM = '__REGISTRATION_FORM__'

const deviceUnreg = renderRoute('/device-registration', UNREGISTERED)
check('`/device-registration` unregistered asks only for a device name',
  [deviceUnreg.html.includes('Device name'), deviceUnreg.html.includes('Register Device')], [true, true])
check('  no badge From / To fields', /device-badge-start|device-badge-end/.test(deviceUnreg.html), false)
check('  no physical-stack checkbox', /physical badges/i.test(deviceUnreg.html), false)
const deviceReg = renderRoute('/device-registration', GENERIC)
check('`/device-registration` registered shows identity + readiness',
  [deviceReg.html.includes('This device is registered'), deviceReg.html.includes('Prize Desk'),
   deviceReg.html.includes('Open Device Readiness')], [true, true, true])
check('  and offers no badge setup', deviceReg.html.includes('Configure Badge Distribution'), false)

const badgeUnreg = renderRoute('/badge-registration', UNREGISTERED)
check('STATE A — unregistered shows Register This Device',
  [badgeUnreg.html.includes('This device is not registered'),
   badgeUnreg.html.includes('Register this physical device before configuring event modules'),
   badgeUnreg.html.includes('Register This Device')], [true, true, true])
check('  and NOT the workflow', badgeUnreg.html.includes(FORM), false)
const badgeGeneric = renderRoute('/badge-registration', GENERIC)
check('STATE B — registered without badges shows Badge Distribution Setup',
  [badgeGeneric.html.includes('Badge Distribution Setup'),
   badgeGeneric.html.includes('it has not been assigned a badge range')], [true, true])
check('  it names the device', badgeGeneric.html.includes('Prize Desk'), true)
check('  it asks for the range and the physical stack',
  [badgeGeneric.html.includes('device-badge-start'), badgeGeneric.html.includes('device-badge-end'),
   badgeGeneric.html.includes('physical badges')], [true, true, true])
check('  and NOT the workflow', badgeGeneric.html.includes(FORM), false)
check('  and never re-asks for a device name', badgeGeneric.html.includes('Register Device'), false)
const badgeConfigured = renderRoute('/badge-registration', LEGACY)
check('STATE C — badge-configured renders the workflow', badgeConfigured.html.includes(FORM), true)
check('  with the device label and readiness',
  [badgeConfigured.html.includes('Registration Desk A'), badgeConfigured.html.includes('Device readiness')], [true, true])

console.log('\n=== 11-15. BADGE CONFIGURATION TRANSACTION ===')
reset(GENERIC)
r = await device.configureBadgeDistribution({ badgeStart: 251, badgeEnd: 500, physicalStackConfirmed: true })
check('configures start/end/next atomically',
  [r.outcome, r.config.badgeStart, r.config.badgeEnd, r.config.nextBadge], ['configured', 251, 500, 251])
check('  stamps badgeConfiguredAt', typeof r.config.badgeConfiguredAt, 'string')
check('  preserves device identity',
  [r.config.deviceId, r.config.deviceName, r.config.deviceConfiguredAt], [DEVICE_ID, 'Prize Desk', 'T1'])
check('  preserves unrelated EventConfig',
  [r.config.eventName, r.config.currency, r.config.amount, r.config.timezone, r.config.upiId, r.config.payeeName],
  ['Navaratri 2026', 'INR', 20, 'Asia/Kolkata', 'organizer@upi', 'Organizer'])
reset(GENERIC)
r = await device.configureBadgeDistribution({ badgeStart: 1, badgeEnd: 10, physicalStackConfirmed: false })
check('physical-stack confirmation is REQUIRED', r.outcome, 'stack-not-confirmed')
check('  and nothing was written', state.config.badgeEnd, undefined)
reset(LEGACY)
r = await device.configureBadgeDistribution({ badgeStart: 900, badgeEnd: 999, physicalStackConfirmed: true })
check('a second badge setup is refused', r.outcome, 'already-configured')
check('  the original range is untouched',
  [state.config.badgeStart, state.config.badgeEnd, state.config.nextBadge], [1, 250, 137])
reset(BOOTSTRAP)
check('badge setup on unregistered hardware is refused',
  (await device.configureBadgeDistribution({ badgeStart: 1, badgeEnd: 10, physicalStackConfirmed: true })).outcome,
  'device-not-registered')
for (const [label, input] of [
  ['start 0', { badgeStart: 0, badgeEnd: 10 }], ['end 0', { badgeStart: 1, badgeEnd: 0 }],
  ['start > end', { badgeStart: 50, badgeEnd: 10 }], ['fractional', { badgeStart: 1.5, badgeEnd: 10 }],
]) {
  reset(GENERIC)
  check(`  range rejected: ${label}`,
    (await device.configureBadgeDistribution({ ...input, physicalStackConfirmed: true })).outcome, 'invalid-range')
}

console.log('\n=== 16-19. HOLD / ISSUE ENFORCEMENT ===')
reset(GENERIC)
check('hold fails on a registered device with no badge setup',
  (await reg.holdRegistration({ ...attendee('9000080001', 'X'), paymentMethod: null })).outcome,
  'badge-distribution-not-configured')
check('issue fails on a registered device with no badge setup',
  (await reg.issueBadge({ ...attendee('9000080001', 'X'), paymentMethod: 'cash' })).outcome,
  'badge-distribution-not-configured')
check('  NO registration or outbox mutation', [state.registrations.size, state.outbox.size], [0, 0])
check('  nextBadge untouched', state.config.nextBadge, 1)
check('hasBadgeAvailable false on a generic registered device',
  eventConfig.hasBadgeAvailable(GENERIC), false)
check('  true on a badge-configured device', eventConfig.hasBadgeAvailable(LEGACY), true)
check('  false once exhausted', eventConfig.hasBadgeAvailable({ ...LEGACY, nextBadge: 251 }), false)
reset(LEGACY)
check('a badge-configured device still issues normally',
  (await reg.issueBadge({ ...attendee('9000080002', 'Y'), paymentMethod: 'cash' })).outcome, 'issued')
check('  and advances nextBadge exactly once', state.config.nextBadge, 138)

console.log('\n=== 20-22. READINESS ON A GENERIC DEVICE ===')
reset(GENERIC)
let snapshot = await readiness.readLocalReadiness()
check('readiness works on a generic registered device', snapshot.ok, true)
check('  identity is reported', [snapshot.device.deviceName, snapshot.device.deviceId], ['Prize Desk', DEVICE_ID])
check('  badge distribution says Not configured', snapshot.badgeDistribution, { configured: false })
check('  it invents no range, next badge or remaining',
  JSON.stringify(snapshot.badgeDistribution).includes('badge'), false)
reset(LEGACY)
snapshot = await readiness.readLocalReadiness()
check('configured readiness shows range / next / remaining',
  [snapshot.badgeDistribution.configured, snapshot.badgeDistribution.badgeStart,
   snapshot.badgeDistribution.badgeEnd, snapshot.badgeDistribution.nextBadge,
   snapshot.badgeDistribution.remaining, snapshot.badgeDistribution.status],
  [true, 1, 250, 137, 114, 'available'])
reset(BOOTSTRAP)
check('unregistered readiness fails closed', (await readiness.readLocalReadiness()).reason, 'not-registered')
reset(LEGACY)
const serialised = JSON.stringify(await readiness.readLocalReadiness())
check('  no UPI, attendee or secret in the snapshot',
  /organizer@upi|Organizer|accessCode|EVENT_SESSION_SECRET/.test(serialised), false)

console.log('\n=== 19. MIGRATION SAFETY ===')
reset(LEGACY)
const before = JSON.stringify(state.config)
await readiness.readLocalReadiness()
renderRoute('/device-registration', LEGACY)
renderRoute('/badge-registration', LEGACY)
renderRoute('/', LEGACY)
check('a legacy production device is never rewritten', JSON.stringify(state.config), before)
check('  it classifies as registered AND badge-configured',
  [device.isDeviceRegistered(state.config), device.isBadgeDistributionConfigured(state.config)], [true, true])
check('  so no setup screen appears on either route',
  [renderRoute('/badge-registration', LEGACY).html.includes('Badge Distribution Setup'),
   renderRoute('/device-registration', LEGACY).html.includes('Register Device')], [false, false])
check('  identity, range and nextBadge all survive',
  [state.config.deviceId, state.config.deviceName, state.config.badgeStart,
   state.config.badgeEnd, state.config.nextBadge],
  [DEVICE_ID, 'Registration Desk A', 1, 250, 137])

console.log('\n=== 23-24. SCHEMA + HOME ===')
const dbSource = readFileSync(join(root, 'src/db/database.ts'), 'utf8')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION\s*=\s*1\b/.test(dbSource), true)
const storesBlock = /\.stores\(\{([\s\S]*?)\}\)/.exec(dbSource)?.[1] ?? ''
check('  exactly three stores', (storesBlock.match(/^\s*(\w+):/gm) ?? []).map((m) => m.trim().replace(':', '')),
  ['registrations', 'config', 'outbox'])
check('  no new index for the split', /badgeConfiguredAt|deviceConfiguredAt/.test(storesBlock), false)
check('badgeConfiguredAt is an optional EventConfig field',
  /badgeConfiguredAt\?: string/.test(readFileSync(join(root, 'src/db/types.ts'), 'utf8')), true)
const homeGeneric = renderRoute('/', GENERIC)
check('Home shows generic identity, not badge status',
  [homeGeneric.html.includes('Prize Desk'), homeGeneric.html.includes('Registered')], [true, true])
check('  it never implies badge distribution',
  /Badges #|badge range|Next badge|Remaining/i.test(homeGeneric.html), false)
check('Home on unregistered hardware says so',
  renderRoute('/', UNREGISTERED).html.includes('Device not registered'), true)
const routerSource = readFileSync(join(root, 'src/app/routes.ts'), 'utf8')
check('the route table is unchanged',
  [/badgeRegistration: '\/badge-registration'/.test(routerSource),
   /deviceRegistration: '\/device-registration'/.test(routerSource),
   /badge-setup|device\/badge/.test(routerSource)], [true, true, false])

console.log('\n=== NO deviceType MODELLING ===')
/**
 * These guards must scan CODE. A comment explaining why `deviceType` would be
 * the wrong model is the opposite of a breach, and must not trip the check.
 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const walkSource = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSource(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}
const codeFiles = walkSource(join(root, 'src'))
  .map((f) => ({ file: f.replace(`${root}/src/`, ''), code: stripComments(readFileSync(f, 'utf8')) }))
const hits = (pattern) => codeFiles.filter(({ code }) => pattern.test(code)).map(({ file }) => file)

check('no single deviceType field exists', hits(/deviceType|DeviceType|deviceKind/), [])
check('no capability registry was invented', hits(/capabilit(y|ies)|moduleRegistry/), [])
check('the two questions are asked by two different helpers',
  [hits(/isDeviceRegistered/).length > 0, hits(/isBadgeDistributionConfigured/).length > 0], [true, true])
check('the old conflated helper is gone', hits(/isDeviceConfigured|configureDevice\b/), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
