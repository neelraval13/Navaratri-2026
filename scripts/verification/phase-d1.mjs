/**
 * Phase D1 verification — central / local device identity convergence.
 *
 * Run with:  pnpm verify:d1
 *
 * It NEVER connects to Neon, Google or any network. The REAL convergence
 * domain, the REAL badge-safety checks it borrows from C3B, and the REAL
 * registration writer all run against the stand-in Dexie, so identity
 * provenance is observed rather than asserted from source.
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

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const convergence = await jiti.import(`${root}/src/db/device-identity-convergence.ts`)
const authz = await jiti.import(`${root}/src/device-auth/event-authorization.ts`)
const issuance = await jiti.import(`${root}/src/db/registrations.ts`)
const { state } = await import('./fake-db.mjs')

const CENTRAL_B = '0810abd4-c627-4476-a7f8-fb5a10cfd90e'
const CENTRAL_OTHER = '99999999-c627-4476-a7f8-fb5a10cfd90e'
const EVENT_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const LOCAL_A = 'cb160e13-bd39-46e2-abf5-f833ff565094'
const ASSIGNED_AT = '2026-10-01T00:30:00.000Z'
const RANGE = { rangeStart: 501, rangeEnd: 600, assignedAt: ASSIGNED_AT }

const context = (over = {}) => ({
  device: {
    id: CENTRAL_B, eventId: EVENT_ID, name: 'Claim Test Desk 2',
    loginName: 'claim-test-2', attributes: ['registration'], lastSeenAt: null,
    ...(over.device ?? {}),
  },
  event: {
    id: EVENT_ID, slug: 'navaratri-2026', name: 'Navaratri 2026',
    timezone: 'Asia/Kolkata', ...(over.event ?? {}),
  },
  activeBadgeRange: over.activeBadgeRange === undefined ? RANGE : over.activeBadgeRange,
})

const ENROLLMENT = {
  deviceId: CENTRAL_B, eventId: EVENT_ID, eventSlug: 'navaratri-2026',
  deviceName: 'Claim Test Desk 2', loginName: 'claim-test-2',
  attributes: ['registration'], verifiedAt: '2026-10-02T09:00:00.000Z',
}
const BINDING = {
  deviceId: CENTRAL_B, eventId: EVENT_ID, rangeStart: 501, rangeEnd: 600,
  assignedAt: ASSIGNED_AT, adoptedAt: '2026-10-01T01:00:00.000Z',
}
const LEASE = { token: 'eyJwYXlsb2FkIjoxfQ.c2ln', receivedAt: '2026-10-02T09:00:01.000Z' }

/** The proven C3B fixture: legacy local identity, converged badge state. */
const LEGACY = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata',
  deviceId: LOCAL_A, deviceName: 'claim-test-local-c3b',
  deviceConfiguredAt: '2026-09-28T00:00:00.000Z',
  badgeStart: 501, badgeEnd: 600, nextBadge: 502,
  badgeConfiguredAt: '2026-10-01T01:00:00.000Z',
  centralDeviceEnrollment: ENROLLMENT,
  centralDeviceOfflineAuthorization: LEASE,
  centralBadgeRangeBinding: BINDING,
  upiId: 'organizer@upi', payeeName: 'Organizer', updatedAt: '2026-10-02T09:00:01.000Z',
}
/** A browser that has signed in centrally but never been set up locally. */
const FRESH = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1,
  centralDeviceEnrollment: ENROLLMENT, centralDeviceOfflineAuthorization: LEASE,
  upiId: 'organizer@upi', payeeName: 'Organizer', updatedAt: 'T',
}

const PRESERVED = [
  'badgeStart', 'badgeEnd', 'nextBadge', 'badgeConfiguredAt',
  'centralBadgeRangeBinding', 'centralDeviceEnrollment',
  'centralDeviceOfflineAuthorization', 'eventName', 'currency', 'amount',
  'timezone', 'upiId', 'payeeName',
]
const preserved = (config) =>
  Object.fromEntries(PRESERVED.map((field) => [field, config?.[field]]))

const registration = (id, badgeNumber, deviceId, deviceName, status = 'completed') => ({
  id, status, badgeNumber, deviceId, deviceName,
  name: `Attendee ${id}`, normalizedName: `attendee ${id}`, phone: '9000000001',
  age: 20, gender: 'Male', amount: 20,
  paymentStatus: status === 'completed' ? 'confirmed' : 'pending',
  ...(status === 'completed' ? { paymentMethod: 'cash', completedAt: 'T' } : { heldAt: 'T' }),
  createdAt: 'T', updatedAt: 'T',
})

const seed = (config, { registrations = [], outbox = [] } = {}) => {
  state.config = config === null ? null : structuredClone(config)
  state.registrations = new Map(registrations.map((row) => [row.id, structuredClone(row)]))
  state.outbox = new Map(outbox.map((row) => [row.id, structuredClone(row)]))
}

const plan = async (config, { over = {}, registrations = [], outbox = [] } = {}) => {
  seed(config, { registrations, outbox })
  return (await convergence.readDeviceIdentityConvergencePlan(context(over))).plan
}

console.log('=== 1-3, 42. THE CONVERGENCE PLAN ===')
check('6. a legacy identity with no badge state is ready',
  await plan({ ...FRESH, deviceId: LOCAL_A, deviceName: 'legacy-d1-test',
    deviceConfiguredAt: 'T' }),
  { outcome: 'ready',
    from: { deviceId: LOCAL_A, deviceName: 'legacy-d1-test' },
    to: { deviceId: CENTRAL_B, deviceName: 'Claim Test Desk 2' } })
check('7-8. a legacy identity with matching range and progress is ready',
  (await plan(LEGACY)).outcome, 'ready')
check('1. a fresh browser with a live central device is ready to set up',
  await plan(FRESH), { outcome: 'fresh-setup',
    to: { deviceId: CENTRAL_B, deviceName: 'Claim Test Desk 2' } })
check('15. a central range with no local range is SAFE for identity',
  (await plan({ ...FRESH, deviceId: LOCAL_A, deviceName: 'legacy', deviceConfiguredAt: 'T' },
    { over: { activeBadgeRange: RANGE } })).outcome, 'ready')
check('17. an already-converged browser reports exactly that',
  await plan({ ...LEGACY, deviceId: CENTRAL_B, deviceName: 'Claim Test Desk 2' }),
  { outcome: 'already-converged',
    identity: { deviceId: CENTRAL_B, deviceName: 'Claim Test Desk 2' },
    nameRefreshAvailable: false })
check('18. the same id with a changed central name offers a name refresh',
  (await plan({ ...LEGACY, deviceId: CENTRAL_B, deviceName: 'Old Name' }))
    .nameRefreshAvailable, true)

console.log('\n=== 3, 15, 21, 42. UNAVAILABLE AND BLOCKED ===')
check('3. no central enrollment makes convergence unavailable',
  await plan({ ...FRESH, centralDeviceEnrollment: undefined }),
  { outcome: 'unavailable', gap: 'no-enrollment' })
check('  and no config row at all',
  await plan(null), { outcome: 'unavailable', gap: 'missing-config' })
check('19. an enrollment for ANOTHER central device is blocked by C1 logic',
  await plan({ ...FRESH, centralDeviceEnrollment: { ...ENROLLMENT, deviceId: CENTRAL_OTHER } }),
  { outcome: 'blocked', conflict: 'enrollment-device-mismatch' })
check('  and one for another event',
  (await plan({ ...FRESH,
    centralDeviceEnrollment: { ...ENROLLMENT, eventSlug: 'other-event' } })).conflict,
  'enrollment-event-mismatch')
check('4. a fresh browser holding registrations is blocked',
  await plan(FRESH, { registrations: [registration('r1', 501, LOCAL_A, 'Old')] }),
  { outcome: 'blocked', conflict: 'local-data-without-identity' })
check('5. and one holding a queued outbox row',
  (await plan(FRESH, { outbox: [{ id: 'registration:r1', registrationId: 'r1' }] })).conflict,
  'local-data-without-identity')

for (const [label, config, over, conflict] of [
  ['9. the binding names another device',
   { ...LEGACY, centralBadgeRangeBinding: { ...BINDING, deviceId: CENTRAL_OTHER } }, {},
   'binding-device-mismatch'],
  ['10. the binding names another event',
   { ...LEGACY, centralBadgeRangeBinding: { ...BINDING, eventId: CENTRAL_OTHER } }, {},
   'binding-event-mismatch'],
  ['11. the binding records a different range',
   { ...LEGACY, centralBadgeRangeBinding: { ...BINDING, rangeEnd: 700 } }, {},
   'binding-range-mismatch'],
  ['12. the assignment was reissued since adoption',
   { ...LEGACY, centralBadgeRangeBinding: { ...BINDING, assignedAt: '2020-01-01T00:00:00.000Z' } },
   {}, 'binding-assigned-at-mismatch'],
  ['13. the local range is not the central range',
   { ...LEGACY, badgeStart: 401, badgeEnd: 500, nextBadge: 401 }, {}, 'local-range-mismatch'],
  ['14. a binding exists but central owns no range',
   LEGACY, { activeBadgeRange: null }, 'central-range-missing'],
  ['16. the local badge counter is incoherent',
   { ...LEGACY, nextBadge: 900 }, {}, 'local-range-incoherent'],
  ['  the central range exists but the local one does not',
   { ...LEGACY, badgeEnd: undefined }, {}, 'local-range-missing'],
]) {
  check(`BLOCKED: ${label}`, await plan(config, { over }), { outcome: 'blocked', conflict })
}

/**
 * Stricter than C3B on purpose. C3B tolerates a legacy hand-typed range with
 * no binding, because such a desk simply has no device authority. Pointing
 * its allocator at a central device that owns NO range is a different act.
 */
check('19. a badge-distributing desk cannot adopt a device with no range',
  await plan({ ...LEGACY, centralBadgeRangeBinding: undefined },
    { over: { activeBadgeRange: null } }),
  { outcome: 'blocked', conflict: 'local-range-without-central-range' })

console.log('\n=== 5, 11-14, 20-26, 43. THE MIGRATION ITSELF ===')
seed(LEGACY, {
  registrations: [
    registration('r501', 501, LOCAL_A, 'Old Local Desk'),
    registration('held-1', undefined, LOCAL_A, 'Old Local Desk', 'held'),
  ],
  outbox: [{
    id: 'registration:r501', registrationId: 'r501', operation: 'upsert',
    payload: registration('r501', 501, LOCAL_A, 'Old Local Desk'),
    createdAt: 'T', attemptCount: 0,
  }],
})
const before = structuredClone(state.config)
const beforeRegistrations = JSON.stringify([...state.registrations.values()])
const beforeOutbox = JSON.stringify([...state.outbox.values()])

const converged = await convergence.convergeDeviceIdentity({ context: context() })
check('a legacy browser converges', converged.outcome, 'converged')
check('  deviceId becomes the CENTRAL uuid', state.config.deviceId, CENTRAL_B)
check('  deviceName becomes the central name',
  state.config.deviceName, 'Claim Test Desk 2')
check('  deviceConfiguredAt is re-stamped',
  state.config.deviceConfiguredAt !== before.deviceConfiguredAt, true)
check('11-12. the badge range and nextBadge are untouched',
  [state.config.badgeStart, state.config.badgeEnd, state.config.nextBadge,
   state.config.badgeConfiguredAt],
  [501, 600, 502, '2026-10-01T01:00:00.000Z'])
check('13. the central binding is byte-identical',
  state.config.centralBadgeRangeBinding, BINDING)
check('14. the enrollment is byte-identical', state.config.centralDeviceEnrollment, ENROLLMENT)
check('  and still exactly its seven C1 fields',
  Object.keys(state.config.centralDeviceEnrollment).sort(),
  ['attributes', 'deviceId', 'deviceName', 'eventId', 'eventSlug', 'loginName', 'verifiedAt'])
check('15. the signed lease is byte-identical',
  state.config.centralDeviceOfflineAuthorization, LEASE)
check('26. event and UPI configuration survive', preserved(state.config), preserved(before))
check('  ONLY the identity fields changed',
  Object.keys(state.config)
    .filter((key) => JSON.stringify(state.config[key]) !== JSON.stringify(before[key]))
    .sort(),
  ['deviceConfiguredAt', 'deviceId', 'deviceName', 'updatedAt'])

console.log('  -- 8, 24, 25, 31. history is NOT rewritten --')
check('24. every existing registration keeps its original identity',
  JSON.stringify([...state.registrations.values()]), beforeRegistrations)
check('  including the HELD one',
  [state.registrations.get('held-1').deviceId,
   state.registrations.get('held-1').deviceName], [LOCAL_A, 'Old Local Desk'])
check('25. the pending outbox snapshot is byte-identical',
  JSON.stringify([...state.outbox.values()]), beforeOutbox)
check('  and still carries the pre-convergence identity',
  state.outbox.get('registration:r501').payload.deviceId, LOCAL_A)
check('the writer never opens registrations or the outbox to WRITE',
  /db\.(registrations|outbox)\.(put|add|update|delete|clear)/
    .test(stripComments(read('src/db/device-identity-convergence.ts'))), false)
check('43. and its transaction names ONLY the config table',
  [...stripComments(read('src/db/device-identity-convergence.ts'))
    .matchAll(/db\.transaction\('rw',\s*([^,]+),/g)].map((match) => match[1].trim()),
  ['db.config', 'db.config'])

console.log('  -- 24, 44. idempotency and concurrency --')
const stamped = structuredClone(state.config)
const again = await convergence.convergeDeviceIdentity({ context: context() })
check('a second convergence is already-converged', again.outcome, 'already-converged')
check('  and churns nothing at all', state.config, stamped)
seed(LEGACY)
const [raceA, raceB] = await Promise.all([
  convergence.convergeDeviceIdentity({ context: context() }),
  convergence.convergeDeviceIdentity({ context: context() }),
])
check('44. two concurrent convergences settle safely',
  [raceA.outcome, raceB.outcome].sort(), ['already-converged', 'converged'])
check('  with one final identity and no field loss',
  [state.config.deviceId, state.config.nextBadge, state.config.badgeEnd],
  [CENTRAL_B, 502, 600])

console.log('  -- a refused plan writes NOTHING --')
seed({ ...LEGACY, centralBadgeRangeBinding: { ...BINDING, rangeEnd: 700 } })
const refusedBefore = JSON.stringify(state.config)
const refused = await convergence.convergeDeviceIdentity({ context: context() })
check('a blocked plan refuses',
  [refused.outcome, refused.conflict], ['blocked', 'binding-range-mismatch'])
check('  and the row is untouched', JSON.stringify(state.config), refusedBefore)

console.log('\n=== 20. FRESH CENTRAL SETUP ===')
seed(FRESH)
const fresh = await convergence.convergeDeviceIdentity({ context: context() })
check('a fresh browser adopts the central identity', fresh.outcome, 'converged')
check('  using the CENTRAL uuid, not a generated one',
  [state.config.deviceId, state.config.deviceName],
  [CENTRAL_B, 'Claim Test Desk 2'])
check('  no random uuid is ever minted here',
  /randomUUID/.test(stripComments(read('src/db/device-identity-convergence.ts'))), false)
check('24. and NO central badge range is adopted',
  [state.config.badgeEnd, state.config.centralBadgeRangeBinding], [undefined, undefined])
check('  convergence never calls the adoption writer',
  /adoptCentralBadgeRange|configureBadgeDistribution/
    .test(stripComments(read('src/db/device-identity-convergence.ts'))), false)

console.log('\n=== 7, 47. CENTRAL NAME REFRESH ===')
seed({ ...LEGACY, deviceId: CENTRAL_B, deviceName: 'Old Name' })
const renamedBefore = structuredClone(state.config)
const renamed = await convergence.refreshConvergedDeviceName({ context: context() })
check('a converged browser follows the central rename',
  [renamed.outcome, state.config.deviceName], ['refreshed', 'Claim Test Desk 2'])
check('  deviceId is unchanged', state.config.deviceId, CENTRAL_B)
check('  deviceConfiguredAt is NOT re-stamped: a rename is not a new identity',
  state.config.deviceConfiguredAt, renamedBefore.deviceConfiguredAt)
check('  and every other field survives', preserved(state.config), preserved(renamedBefore))
check('an identical name writes nothing',
  (await convergence.refreshConvergedDeviceName({ context: context() })).outcome, 'unchanged')
seed(LEGACY)
const notConverged = structuredClone(state.config)
check('an UNCONVERGED browser is never renamed',
  (await convergence.refreshConvergedDeviceName({ context: context() })).outcome,
  'not-converged')
check('  and its local name is untouched', state.config, notConverged)

console.log('\n=== 29-31. NEW REGISTRATIONS CARRY THE CENTRAL IDENTITY ===')
seed(LEGACY, {
  registrations: [registration('r501', 501, LOCAL_A, 'Old Local Desk')],
  outbox: [{
    id: 'registration:r501', registrationId: 'r501', operation: 'upsert',
    payload: registration('r501', 501, LOCAL_A, 'Old Local Desk'),
    createdAt: 'T', attemptCount: 0,
  }],
})
await convergence.convergeDeviceIdentity({ context: context() })
const issued = await issuance.issueBadge({
  registrationId: null, phone: '9000000002', name: 'After Convergence',
  age: 22, gender: 'Female', paymentMethod: 'cash',
})
check('30. the NEW registration is stamped with the central identity',
  [issued.outcome, issued.registration.deviceId, issued.registration.deviceName],
  ['issued', CENTRAL_B, 'Claim Test Desk 2'])
check('  it took the next badge, #502', issued.registration.badgeNumber, 502)
check('31. the OLD registration still carries the local identity',
  [state.registrations.get('r501').deviceId, state.registrations.get('r501').deviceName],
  [LOCAL_A, 'Old Local Desk'])
check('  and the pre-convergence outbox row does too',
  state.outbox.get('registration:r501').payload.deviceId, LOCAL_A)
check('  the new row carries the central one',
  state.outbox.get(`registration:${issued.registration.id}`).payload.deviceId, CENTRAL_B)
check('29. registration needed no identity branching to do it',
  /centralDeviceEnrollment|convergence|isConverged|central/i
    .test(stripComments(read('src/db/registrations.ts'))), false)

console.log('\n=== 32. SYNC STAYS BACKWARD COMPATIBLE ===')
/**
 * A pre-convergence row carries the OLD local device id. Requiring it to
 * equal the current central device would strand exactly the rows this
 * migration creates.
 */
const syncDeviceAuth = stripComments(read('server/sync/device-authorization.ts'))
const syncEndpoint = stripComments(read('api/sync-registration.ts'))
check('the server never compares payload.deviceId to the central device',
  /payload\.deviceId|deviceId ===|deviceName ===/.test(syncDeviceAuth + syncEndpoint), false)
check('  device sync still authorizes on the LIVE session alone',
  [/loadDeviceSessionContext/.test(syncDeviceAuth),
   /BADGE_RANGE_REQUIRED_ATTRIBUTE/.test(syncDeviceAuth),
   /activeBadgeRange === null/.test(syncDeviceAuth)], [true, true, true])
check('  and only the completed BADGE NUMBER is range-checked',
  /isBadgeWithinDeviceRange\(authorization, badgeNumber\)/.test(syncDeviceAuth) ||
  /isBadgeWithinDeviceRange/.test(syncEndpoint), true)

console.log('\n=== 34-35. C3B COMPATIBILITY AND EQUALITY-IS-NOT-AUTHORITY ===')
const authorize = (config, grant) => authz.authorizeEventModule('registration', {
  grant, config, enrollment: config.centralDeviceEnrollment,
})
const liveGrant = authz.grantFromDeviceSession(context())
/**
 * PHASE D2 RE-SCOPE. D1 was deliberately backward compatible: a legacy
 * unconverged browser still authorized. D2 made convergence MANDATORY, so
 * the same two cases now have opposite answers — and that difference is
 * exactly what D1's migration exists to close.
 */
check('34. a LEGACY unconverged browser is now refused, and told to converge',
  authorize(LEGACY, liveGrant),
  { outcome: 'unavailable', gap: 'identity-convergence-required' })
check('  and a CONVERGED one authorizes',
  authorize({ ...LEGACY, deviceId: CENTRAL_B, deviceName: 'Claim Test Desk 2' }, liveGrant),
  { outcome: 'authorized', source: 'device-online' })
check('35. identity equality ALONE grants nothing without a live grant',
  authorize({ ...LEGACY, deviceId: CENTRAL_B, deviceName: 'Claim Test Desk 2' }, null),
  { outcome: 'unavailable', gap: 'no-grant' })
/**
 * The comparison exists now, but it is a REQUIREMENT, never a credential:
 * one function, which cannot be called without a grant and can only ever
 * return a gap.
 */
const authDomain = stripComments(read('src/device-auth/event-authorization.ts'))
check('  identity is compared in exactly one place',
  (authDomain.match(/config\.deviceId === /g) ?? []).length, 1)
check('    and that place can only ever return a gap',
  [/checkConvergedDeviceIdentity = \(\s*grant: DeviceOperationalGrant,/.test(authDomain),
   /IdentityConsistencyGap \| null/.test(authDomain),
   /isConverged/.test(authDomain)], [true, true, false])
check('  it still also requires a VALID local identity',
  /isDeviceRegistered\(config\)/.test(read('src/device-auth/event-authorization.ts')), true)

console.log('\n=== 2, 45. ONLINE ONLY, AGAINST A FRESH CONTEXT ===')
const flow = stripComments(read('src/device-auth/identity-convergence.ts'))
check('45. the migration re-checks the session immediately before writing',
  [/getDeviceSession\(\)/.test(flow),
   flow.indexOf('getDeviceSession()') < flow.indexOf('convergeDeviceIdentity(')], [true, true])
check('  an unauthenticated recheck writes nothing',
  /status === 'unauthenticated'[\s\S]{0,120}session-invalid/.test(flow), true)
check('  an unreachable server writes nothing',
  /status !== 'authenticated'[\s\S]{0,300}unreachable/.test(flow), true)
check('  a different live device writes nothing',
  /device\.id !== input\.expected\.device\.id[\s\S]{0,160}device-changed/.test(flow), true)
check('  and the write uses the FRESH context, never the one on screen',
  /convergeDeviceIdentity\(\{ context: session\.context \}\)/.test(flow), true)
check('2. a cached lease can never trigger convergence',
  /offline-lease|verifyOfflineAuthorization|centralDeviceOfflineAuthorization/
    .test(flow + stripComments(read('src/db/device-identity-convergence.ts'))), false)
check('  nor Operator Access',
  /operator/i.test(flow + stripComments(read('src/db/device-identity-convergence.ts'))), false)
check('46. no new Function was added for the recheck',
  readdirSync(join(root, 'api')).filter((file) => /converge|identity/i.test(file)), [])

console.log('\n=== 5, 49. ONE WRITER, AND NO OTHERS ===')
/**
 * Scanned at the CONFIG-LITERAL level: plenty of modules mention a
 * `deviceId` — in a binding, an enrollment, a registration — but only an
 * identity writer assigns one on the row it stores.
 */
const identityWriters = walk(join(root, 'src'))
  .filter((file) => {
    const code = stripComments(readFileSync(file, 'utf8'))
    const literals = [
      ...code.matchAll(/:\s*\w*Config\s*=\s*\{([\s\S]*?)\n\s*\}/g),
      ...code.matchAll(/db\.config\.put\(\{([\s\S]*?)\n\s*\}\)/g),
    ]
    return literals.some((match) => /^\s{4,}deviceId:/m.test(match[1]))
  })
  .map((file) => file.replace(`${root}/src/`, '')).sort()
// Phase D2 deleted `registerDevice`, leaving convergence as the only writer.
check('exactly one module writes a device identity',
  identityWriters, ['db/device-identity-convergence.ts'])
check('  and nothing mints a device id locally any more',
  [/deviceId:\s*crypto\.randomUUID\(\)/.test(read('src/db/device.ts')),
   /registerDevice/.test(stripComments(read('src/db/device.ts')))], [false, false])
check('  and no React component writes an identity',
  walk(join(root, 'src/components')).concat(walk(join(root, 'src/pages')))
    .filter((file) => /db\.config\.(put|add)/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])

console.log('\n=== 26-28, 36-40. NOTHING ELSE MOVED ===')
const identityUi = read('src/components/device-auth/device-identity-section.tsx')
check('26. /device-login has its own Identity section',
  [/Device Identity/.test(identityUi),
   /<DeviceIdentitySection/.test(read('src/components/device-auth/device-enrollment-panel.tsx'))],
  [true, true])
check('  with the required states',
  ['Set Up This Device', 'Converge Device Identity', 'Identity conflict',
   'Unified with central device', 'unavailable while offline']
    .filter((needle) => !identityUi.includes(needle)), [])
check('22. the migration needs an explicit acknowledgement',
  [/I understand this changes the device identity/.test(identityUi),
   /disabled=\{!understood \|\| isBusy\}/.test(identityUi)], [true, true])
check('  and says history keeps its original identity',
  /keep their\s*\n?\s*original historical identity/.test(identityUi), true)
check('  a conflict offers no override',
  /Continue anyway|Override|Force|Operator Access/i
    .test(stripComments(identityUi).replace(/cannot be unlocked with an operator code/i, '')),
  false)
/**
 * D1 kept `/device-registration` as an Operator-only legacy page. D2 retired
 * it: convergence became the only setup path, so the page that offered a
 * second one had to go rather than sit there contradicting it.
 */
check('27, 37. /device-registration is a redirect, with no page behind it',
  [/ROUTES\.deviceRegistration\}> <Redirect to=\{ROUTES\.deviceLogin\} \/>/
     .test(stripComments(read('src/components/app-router.tsx')).replace(/\s+/g, ' ')),
   existsSync(join(root, 'src/pages/device-registration-page.tsx'))], [true, false])
check('  the convergence action is the only setup path offered',
  [/Set Up This Device/.test(identityUi), /Converge Device Identity/.test(identityUi)],
  [true, true])
check('36. Operator Access is gone',
  ['operator-login', 'operator-logout', 'operator-session']
    .some((name) => existsSync(join(root, 'api', `${name}.ts`))), false)
check('6, 38. no new EventConfig identity field was added',
  /centralDeviceId|effectiveDeviceId|canonicalDeviceId|legacyDeviceId/
    .test(read('src/db/types.ts')), false)
check('  IndexedDB version unchanged (1)',
  /DATABASE_VERSION = 1/.test(read('src/db/database.ts')), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(read('src/db/database.ts'))?.[1] ?? '')
    .match(/^\s*(\w+):/gm) ?? []).map((entry) => entry.trim().replace(':', '')),
  ['registrations', 'config', 'outbox'])
check('38. NO central migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('  and no server file knows about convergence',
  /device-identity-convergence|converge/i
    .test(walk(join(root, 'server')).map((file) => readFileSync(file, 'utf8')).join('\n')), false)
check('39. the Sheet schema is unchanged',
  [/A1:N/.test(read('server/sync/sheet-contract.ts')),
   /A1:M/.test(read('server/sync/sheet-contract.ts'))], [true, true])
check('40. nextBadge is still local only',
  /next_badge|nextBadge/.test(stripComments(read('server/db/schema.ts'))), false)

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
// D1 added no Function; Phase D2 removed the three Operator ones.
check('46. the Function inventory is eight', budget.actual.length, 8)
check('  with four slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 4)
check('  and nothing unexpected', budget.problems, [])

console.log('\n=== 52. DOCUMENTATION ===')
const deviceDoc = read('docs/DEVICE_AUTH.md')
for (const needle of ['convergence', 'explicit', 'historical', '/device-registration', 'D2'])
  check(`DEVICE_AUTH.md documents ${needle}`, deviceDoc.includes(needle), true)
check('AGENTS.md records the D1 rules',
  [/identity convergence/i.test(read('AGENTS.md')),
   /historical/i.test(read('AGENTS.md'))], [true, true])
check('README describes convergence',
  /converge/i.test(read('README.md')), true)
check('the release checklist covers it',
  /converge/i.test(read('docs/PRODUCTION_RELEASE_CHECKLIST.md')), true)
check('release:check guards convergence',
  /device-identity-convergence/.test(read('scripts/release-check.mjs')), true)

const manifest = JSON.parse(read('package.json'))
check('verify:d1 is registered',
  manifest.scripts['verify:d1'], 'node scripts/verification/phase-d1.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:d1'), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /uuid|nanoid|redux|zustand/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
