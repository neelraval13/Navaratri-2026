/**
 * Phase D2.1 verification — contiguous badge refill / range extension.
 *
 * Run with:  pnpm verify:d21
 *
 * It NEVER connects to Neon, Google or any network. The REAL endpoint, the
 * REAL central extender, the REAL local transaction, the REAL refill flow and
 * the REAL offline-lease signer all run; only Postgres, IndexedDB and HTTP are
 * stood in for.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { generateKeyPairSync } from 'node:crypto'
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

/** A disposable pair. Generated here, never printed, never written to disk. */
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PRIVATE_B64 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const PUBLIC_B64 = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

process.env.VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64 = PUBLIC_B64
process.env.EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64 = PRIVATE_B64

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '22222222-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const ASSIGNED_AT = '2026-10-01T00:00:00.000Z'
const ORIGIN = 'https://desk.example.test'

/* ------------------------------------------- the central half, end to end */

const serverJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../../server/db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})

const SECRET = 'd'.repeat(48)
process.env.EVENT_DEVICE_SESSION_SECRET = SECRET
process.env.SYNC_ALLOWED_ORIGIN = ORIGIN

const deviceSession = await serverJiti.import(`${root}/server/device-auth/session.ts`)
const reserve = await serverJiti.import(`${root}/server/badge-assignments/reserve.ts`)
const endpoint = await serverJiti.import(`${root}/api/device-badge-claim.ts`)
const sharedLease = await serverJiti.import(`${root}/src/shared/device-offline-authorization.ts`)
const fakeDb = await import('./fake-admin-db.mjs')
const password = await serverJiti.import(`${root}/server/device-auth/password.ts`)
const storedHash = await password.hashDevicePassword('desk-passphrase')

const seedCentral = ({
  device = {},
  event = {},
  attributes = ['registration'],
  range = { rangeStart: 1, rangeEnd: 2 },
  others = [],
} = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata',
    active: true, endsAt: null, ...event,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Claim Test Desk 2', loginName: 'claim-test-2',
    passwordHash: storedHash, sessionVersion: 3, enabled: true, lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), ...device,
  })
  fakeDb.state.devices.set(OTHER_DEVICE_ID, {
    id: OTHER_DEVICE_ID, eventId: EVENT_ID, name: 'Other Desk', loginName: 'other-desk',
    passwordHash: storedHash, sessionVersion: 1, enabled: true, lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  if (range !== null) {
    fakeDb.state.assignments.push({
      id: 'assignment-under-test', eventId: EVENT_ID, deviceId: DEVICE_ID,
      rangeStart: range.rangeStart, rangeEnd: range.rangeEnd,
      assignedAt: new Date(ASSIGNED_AT), releasedAt: null,
    })
  }
  for (const [index, other] of others.entries()) {
    fakeDb.state.assignments.push({
      id: `other-${String(index)}`, eventId: EVENT_ID, deviceId: OTHER_DEVICE_ID,
      rangeStart: other.rangeStart, rangeEnd: other.rangeEnd,
      assignedAt: new Date(ASSIGNED_AT), releasedAt: null,
    })
  }
  fakeDb.state.applied = []
}

const deviceCookie = (sessionVersion = 3) =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion,
  })}`

const patch = (body, cookie = deviceCookie()) =>
  endpoint.PATCH(new Request(`${ORIGIN}/api/device-badge-claim`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  }))

const refill = (over = {}, cookie = deviceCookie()) =>
  patch({ expectedRangeEnd: 2, newRangeEnd: 50, physicalStackConfirmed: true, ...over }, cookie)

const assignmentUnderTest = () =>
  fakeDb.state.assignments.find((row) => row.deviceId === DEVICE_ID)

console.log('=== 1-3. #001-#002 EXTENDS THROUGH #050 ===')
seedCentral()
let response = await refill()
let body = await response.json()
check('1. the extension succeeds',
  [response.status, body.ok, body.outcome], [200, true, 'extended'])
check('  and returns the COMPLETE range, not the delta',
  body.activeBadgeRange, { rangeStart: 1, rangeEnd: 50, assignedAt: ASSIGNED_AT })
check('2. the database row becomes #001-#050',
  [assignmentUnderTest().rangeStart, assignmentUnderTest().rangeEnd], [1, 50])
check('  on the SAME assignment row, never a second one',
  [assignmentUnderTest().id, fakeDb.state.assignments.length], ['assignment-under-test', 1])
check('  and nothing was inserted or released',
  [fakeDb.state.applied.filter((entry) => entry.startsWith('insert')).length,
   assignmentUnderTest().releasedAt], [0, null])
check('3. assignedAt is unchanged',
  assignmentUnderTest().assignedAt.toISOString(), ASSIGNED_AT)
check('  as are the device and event',
  [assignmentUnderTest().deviceId, assignmentUnderTest().eventId], [DEVICE_ID, EVENT_ID])

console.log('\n=== 7-10. THE REFUSALS ===')
seedCentral({ others: [{ rangeStart: 51, rangeEnd: 100 }] })
response = await refill({ newRangeEnd: 60 })
body = await response.json()
check('7. overlapping another device fails closed',
  [response.status, body.ok, body.conflict], [409, false, 'range-overlap'])
check('  and nothing was written',
  [assignmentUnderTest().rangeStart, assignmentUnderTest().rangeEnd], [1, 2])
check('  the other device is never named',
  JSON.stringify(body).includes(OTHER_DEVICE_ID), false)
check('  nor is a constraint name or SQLSTATE',
  /badge_assignments_|23P01|23505/.test(JSON.stringify(body)), false)

seedCentral()
/**
 * 8. A GAP CANNOT BE REPRESENTED. There is no `rangeStart` on the wire — the
 * new batch begins one past the current end, derived by the server — so
 * "add #060-#100 to #001-#002" has no expressible form. Trying to smuggle a
 * start in is refused outright rather than ignored.
 */
response = await patch({
  expectedRangeEnd: 2, newRangeEnd: 100, rangeStart: 60, physicalStackConfirmed: true,
})
check('8. a gap cannot be requested: rangeStart is refused', response.status, 400)
check('  and nothing was written', assignmentUnderTest().rangeEnd, 2)
check('  nor can a counter be smuggled in',
  (await patch({ expectedRangeEnd: 2, newRangeEnd: 100, nextBadge: 1, physicalStackConfirmed: true })).status,
  400)
check('  the derived start is contiguous by construction',
  /refillStart = /.test(stripComments(read('src/db/central-badge-range.ts'))) ||
  /central\.rangeEnd \+ 1/.test(stripComments(read('src/db/central-badge-range.ts'))), true)

seedCentral()
await refill()
response = await refill()
body = await response.json()
check('9. the same PATCH repeated is idempotent',
  [response.status, body.ok, body.outcome], [200, true, 'already-extended'])
check('  with the same complete range',
  body.activeBadgeRange, { rangeStart: 1, rangeEnd: 50, assignedAt: ASSIGNED_AT })
check('  and still exactly one assignment row', fakeDb.state.assignments.length, 1)

seedCentral({ range: { rangeStart: 1, rangeEnd: 20 } })
response = await refill({ expectedRangeEnd: 2, newRangeEnd: 50 })
body = await response.json()
check('10. a stale expectedRangeEnd fails closed',
  [response.status, body.ok, body.conflict], [409, false, 'stale-range'])
check('  the authoritative range travels back',
  body.activeBadgeRange, { rangeStart: 1, rangeEnd: 20, assignedAt: ASSIGNED_AT })
check('  and nothing was written', assignmentUnderTest().rangeEnd, 20)

seedCentral({ range: null })
response = await refill()
body = await response.json()
check('  no active assignment is its own answer',
  [response.status, body.conflict], [409, 'no-active-range'])

seedCentral()
check('  an end that is not an increase is refused',
  (await refill({ newRangeEnd: 2 })).status, 400)
check('    as is a lower one', (await refill({ newRangeEnd: 1 })).status, 400)
check('    and an unconfirmed stack',
  (await refill({ physicalStackConfirmed: false })).status, 400)
check('  none of those wrote anything', assignmentUnderTest().rangeEnd, 2)

console.log('\n=== 11-14. ONLY A LIVE, PERMITTED DEVICE MAY EXTEND ===')
seedCentral({ device: { enabled: false } })
check('11. a disabled device cannot extend', (await refill()).status, 401)
check('  and nothing was written', assignmentUnderTest().rangeEnd, 2)
seedCentral({ event: { active: false } })
check('  nor can one whose event is inactive', (await refill()).status, 401)
seedCentral()
check('  nor a stale session_version', (await refill({}, deviceCookie(2))).status, 401)
seedCentral({ device: { passwordHash: null } })
check('  nor an unprovisioned device', (await refill()).status, 401)

seedCentral({ attributes: ['prizes'] })
response = await refill()
body = await response.json()
check('12. a device without Registration cannot extend',
  [response.status, body.blocked], [403, 'registration-required'])
check('  and nothing was written', assignmentUnderTest().rangeEnd, 2)

seedCentral()
check('13. an Admin cookie alone cannot extend',
  (await refill({}, '__Host-navaratri_admin_session=anything-at-all')).status, 401)
check('  nor can an anonymous caller', (await refill({}, null)).status, 401)
check('  nor the retired operator cookie',
  (await refill({}, '__Host-navaratri_operator_session=anything')).status, 401)
check('  and nothing was written', assignmentUnderTest().rangeEnd, 2)

/**
 * 14. THE OFFLINE LEASE IS NEVER A CENTRAL CREDENTIAL. It is readable by
 * JavaScript because the browser verifies it offline; its power is LOCAL
 * authorization until `exp`. The endpoint reads only the device cookie.
 */
seedCentral()
const leaseEndpoint = stripComments(read('api/device-badge-claim.ts'))
check('14. the endpoint never reads a lease or a bearer token',
  /verifyOfflineAuthorization|offline-lease|centralDeviceOfflineAuthorization|\bBearer\b/
    .test(leaseEndpoint), false)
check('  and a lease presented as a cookie authorizes nothing',
  (await refill({}, '__Host-navaratri_device_offline=signed.token')).status, 401)

console.log('\n=== 18. THE RE-ISSUED LEASE CARRIES THE EXTENDED RANGE ===')
seedCentral()
response = await refill()
body = await response.json()
/**
 * Decoded from the TOKEN, exactly as the browser does: split it, base64url
 * the payload, parse it with the shared validator. Nothing trusts a field
 * the endpoint might have put beside the token.
 */
const split = sharedLease.splitOfflineAuthorizationToken(body.offlineAuthorization.token)
const claims = split === null
  ? null
  : sharedLease.parseDeviceOfflineClaims(
      JSON.parse(Buffer.from(split.encodedPayload, 'base64url').toString('utf8')),
    )
check('18. a fresh lease is issued', body.offlineAuthorization.configured, true)
check('  and its claims name the EXTENDED range',
  claims === null ? null : claims.activeBadgeRange,
  { rangeStart: 1, rangeEnd: 50, assignedAt: ASSIGNED_AT })
check('  for this device and event',
  claims === null ? null : [claims.deviceId, claims.eventId], [DEVICE_ID, EVENT_ID])
check('  and it carries no counter and no credential',
  claims === null ? null : ['nextBadge', 'password', 'sessionVersion', 'token']
    .filter((field) => field in claims), [])
seedCentral({ range: { rangeStart: 1, rangeEnd: 20 } })
const refused = await (await refill({ expectedRangeEnd: 2 })).json()
check('  a REFUSED extension issues none',
  'offlineAuthorization' in refused, false)

/* --------------------------------------------- the local half, end to end */

console.log('\n=== 4-6, 15-17. THE LOCAL EXTENSION ===')
const localJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const { state: local } = await import('./fake-db.mjs')
const domain = await localJiti.import(`${root}/src/db/central-badge-range.ts`)

const BINDING = {
  deviceId: DEVICE_ID, eventId: EVENT_ID, rangeStart: 1, rangeEnd: 2,
  assignedAt: ASSIGNED_AT, adoptedAt: '2026-10-01T01:00:00.000Z',
}
/** The exhausted desk from the phase brief: owns #001-#002, nextBadge #003. */
const EXHAUSTED = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, badgeEnd: 2, nextBadge: 3,
  badgeConfiguredAt: '2026-10-01T01:00:00.000Z',
  deviceId: DEVICE_ID, deviceName: 'Claim Test Desk 2',
  deviceConfiguredAt: '2026-09-01T00:00:00.000Z',
  centralBadgeRangeBinding: BINDING,
  upiId: 'organizer@upi', payeeName: 'Organizer', updatedAt: 'T0',
}
const context = (rangeEnd, over = {}) => ({
  device: {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Claim Test Desk 2',
    loginName: 'claim-test-2', attributes: ['registration'], lastSeenAt: null,
    ...(over.device ?? {}),
  },
  event: {
    id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata',
    ...(over.event ?? {}),
  },
  activeBadgeRange:
    rangeEnd === null
      ? null
      : { rangeStart: 1, rangeEnd, assignedAt: ASSIGNED_AT, ...(over.range ?? {}) },
})

const seedLocal = (config = EXHAUSTED) => {
  local.config = structuredClone(config)
  local.registrations = new Map()
  local.outbox = new Map()
  // One issued badge and one queued snapshot, so "untouched" means something.
  local.registrations.set('r1', {
    id: 'r1', status: 'completed', badgeNumber: 1, name: 'Attendee',
    normalizedName: 'attendee', phone: '9000000001', age: 20, gender: 'Male',
    amount: 20, paymentStatus: 'confirmed', paymentMethod: 'cash',
    createdAt: 'T', updatedAt: 'T', completedAt: 'T',
    deviceId: DEVICE_ID, deviceName: 'Claim Test Desk 2',
  })
  local.outbox.set('registration:r1', {
    id: 'registration:r1', registrationId: 'r1', createdAt: 'T',
    payload: { status: 'completed', badgeNumber: 1, updatedAt: 'T' },
  })
}

seedLocal()
const before = structuredClone(local.config)
const registrationsBefore = structuredClone([...local.registrations.values()])
const outboxBefore = structuredClone([...local.outbox.values()])
let extension = await domain.extendLocalBadgeRange({ context: context(50) })
check('the local range is extended', extension.outcome, 'extended')
check('  from #002 to #050', [extension.from, extension.to], [2, 50])
check('4. nextBadge 3 REMAINS 3', local.config.nextBadge, 3)
check('5. badgeStart stays 1', local.config.badgeStart, 1)
check('  badgeEnd becomes 50', local.config.badgeEnd, 50)
check('  the binding end follows it', local.config.centralBadgeRangeBinding.rangeEnd, 50)
check('  and the binding keeps everything else',
  [local.config.centralBadgeRangeBinding.rangeStart,
   local.config.centralBadgeRangeBinding.assignedAt,
   local.config.centralBadgeRangeBinding.adoptedAt,
   local.config.centralBadgeRangeBinding.deviceId,
   local.config.centralBadgeRangeBinding.eventId],
  [1, ASSIGNED_AT, BINDING.adoptedAt, DEVICE_ID, EVENT_ID])
check('  badgeConfiguredAt is not re-stamped',
  local.config.badgeConfiguredAt, before.badgeConfiguredAt)
check('  the device identity is untouched',
  [local.config.deviceId, local.config.deviceName, local.config.deviceConfiguredAt],
  [before.deviceId, before.deviceName, before.deviceConfiguredAt])
check('  and every unrelated field survives',
  ['eventName', 'currency', 'amount', 'timezone', 'upiId', 'payeeName']
    .map((field) => local.config[field]),
  ['eventName', 'currency', 'amount', 'timezone', 'upiId', 'payeeName']
    .map((field) => before[field]))
check('6. no registration is touched',
  [...local.registrations.values()], registrationsBefore)
check('  and no outbox row is touched', [...local.outbox.values()], outboxBefore)
check('  exactly three config fields changed',
  Object.keys(local.config).filter((key) =>
    JSON.stringify(local.config[key]) !== JSON.stringify(before[key])).sort(),
  ['badgeEnd', 'centralBadgeRangeBinding', 'updatedAt'])

/**
 * A desk PART-WAY through its range. The exhausted fixture above cannot
 * prove `nextBadge` is left alone on its own: at #003 with an old end of
 * #002, a reset to "one past the old end" lands on the same number, so a
 * writer that recomputed the counter would pass. This one is at #001, where
 * every plausible recomputation differs.
 */
seedLocal({ ...EXHAUSTED, nextBadge: 1 })
extension = await domain.extendLocalBadgeRange({ context: context(50) })
check('4. a desk mid-range keeps its place exactly',
  [extension.outcome, local.config.nextBadge, local.config.badgeEnd], ['extended', 1, 50])
check('  not the new batch start, the old end or the range start',
  [local.config.nextBadge === 3, local.config.nextBadge === 50,
   local.config.nextBadge === 2], [false, false, false])
check('  and the writer never names the counter at all',
  /nextBadge/.test(stripComments(read('src/db/central-badge-range.ts'))
    .slice(stripComments(read('src/db/central-badge-range.ts'))
      .indexOf('export const extendLocalBadgeRange'))), false)

/** 9/16/17. Idempotent, and never a decrease. */
const counterBeforeRepeat = local.config.nextBadge
const rowBeforeRepeat = structuredClone(local.config)
extension = await domain.extendLocalBadgeRange({ context: context(50) })
check('16. a repeat is idempotent and writes nothing', extension.outcome, 'already-extended')
check('  the whole row is byte-identical', local.config, rowBeforeRepeat)
check('17. and the counter is untouched by it',
  local.config.nextBadge, counterBeforeRepeat)
seedLocal({ ...EXHAUSTED, badgeEnd: 50, centralBadgeRangeBinding: { ...BINDING, rangeEnd: 50 } })
extension = await domain.extendLocalBadgeRange({ context: context(20) })
check('  a SMALLER central range is refused, never applied',
  [extension.outcome, extension.reason], ['refused', 'not-an-extension'])
check('    and the local range is unchanged', local.config.badgeEnd, 50)

console.log('  -- the safe-superset rule, clause by clause --')
seedLocal()
for (const [label, over, reason] of [
  ['another central device', { device: { id: OTHER_DEVICE_ID } }, 'binding-device-mismatch'],
  ['another central event', { event: { id: 'cccccccc-1111-4111-8111-cccccccccccc' } }, 'binding-event-mismatch'],
  ['a different range start', { range: { rangeStart: 11 } }, 'range-start-mismatch'],
  ['a reissued grant', { range: { assignedAt: '2026-10-02T00:00:00.000Z' } }, 'assigned-at-mismatch'],
]) {
  seedLocal()
  const result = await domain.extendLocalBadgeRange({ context: context(50, over) })
  check(`  refused: ${label}`, [result.outcome, result.reason], ['refused', reason])
  check('    and nothing was written', local.config.badgeEnd, 2)
}
seedLocal({ ...EXHAUSTED, centralBadgeRangeBinding: undefined })
check('  refused: no local provenance',
  (await domain.extendLocalBadgeRange({ context: context(50) })).reason, 'no-binding')
seedLocal({ ...EXHAUSTED, badgeEnd: undefined })
check('  refused: no local range',
  (await domain.extendLocalBadgeRange({ context: context(50) })).reason, 'no-local-range')
seedLocal({ ...EXHAUSTED, badgeEnd: 10 })
check('  refused: local and its binding disagree',
  (await domain.extendLocalBadgeRange({ context: context(50) })).reason, 'local-binding-disagree')
seedLocal()
check('  refused: no central assignment',
  (await domain.extendLocalBadgeRange({ context: context(null) })).reason,
  'no-central-assignment')
check('    and nothing was written', local.config.badgeEnd, 2)

console.log('  -- 15. the recovery the distributed failure leaves behind --')
seedLocal()
const pending = domain.planCentralBadgeRangeRefill({
  config: local.config, context: context(50),
})
check('15. central ahead of local is reported as recoverable',
  [pending.outcome, pending.central.rangeEnd, pending.local.rangeEnd, pending.nextBadge],
  ['extension-pending', 50, 2, 3])
const aligned = domain.planCentralBadgeRangeRefill({
  config: { ...local.config, badgeEnd: 50,
    centralBadgeRangeBinding: { ...BINDING, rangeEnd: 50 } },
  context: context(50),
})
check('  an aligned desk is offered a refill instead',
  [aligned.outcome, aligned.current.rangeEnd, aligned.refillStart, aligned.nextBadge],
  ['refillable', 50, 51, 3])
check('  the refill start is DERIVED, one past the current end',
  aligned.refillStart - aligned.current.rangeEnd, 1)
const mismatched = domain.planCentralBadgeRangeRefill({
  config: { ...local.config, badgeStart: 401, badgeEnd: 500,
    centralBadgeRangeBinding: { ...BINDING, rangeStart: 401, rangeEnd: 500 } },
  context: context(600, { range: { rangeStart: 501 } }),
})
check('  an unrelated central range is NEVER read as an extension',
  [mismatched.outcome, mismatched.conflict], ['blocked', 'binding-range-mismatch'])
for (const [label, over, reason] of [
  ['no central assignment', { range: null }, 'no-central-assignment'],
  ['no Registration', { attributes: ['prizes'] }, 'registration-not-permitted'],
]) {
  const plan = domain.planCentralBadgeRangeRefill({
    config: local.config,
    context: over.range === null
      ? context(null)
      : { ...context(50), device: { ...context(50).device, attributes: over.attributes } },
  })
  check(`  unavailable: ${label}`, [plan.outcome, plan.reason], ['unavailable', reason])
}

console.log('\n=== 19-23. NOTHING ELSE MOVED ===')
const claimEndpoint = stripComments(read('api/device-badge-claim.ts'))
const postHandler = claimEndpoint.slice(
  claimEndpoint.indexOf('export async function POST'),
  claimEndpoint.indexOf('const extended = ('),
)
check('19. the initial self-claim still reserves through the shared primitive',
  [/reserveBadgeRange\(/.test(postHandler), /extendActiveBadgeRange\(/.test(postHandler)],
  [true, false])
seedCentral({ range: null })
const claimed = await endpoint.POST(new Request(`${ORIGIN}/api/device-badge-claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: deviceCookie() },
  body: JSON.stringify({ rangeStart: 1, rangeEnd: 2, physicalStackConfirmed: true }),
}))
const claimedBody = await claimed.json()
check('  and a first claim behaves exactly as before',
  [claimed.status, claimedBody.outcome, claimedBody.activeBadgeRange.rangeEnd],
  [201, 'claimed', 2])
check('  the claim flow is untouched by the refill',
  /refillDeviceBadgeRange|extendLocalBadgeRange|expectedRangeEnd/
    .test(stripComments(read('src/device-auth/badge-claim.ts'))), false)

const router = stripComments(read('src/components/app-router.tsx'))
check('20. D2 route policy is unchanged',
  [/OperatorAccessGate/.test(router), /<EventAccessGate module="/.test(router),
   /ROUTES\.deviceRegistration\}> <Redirect to=\{ROUTES\.deviceLogin\} \/>/
     .test(router.replace(/\s+/g, ' '))], [false, true, true])
check('  sync is still device-only',
  /operator/i.test(stripComments(read('api/sync-registration.ts'))
    .slice(stripComments(read('api/sync-registration.ts')).indexOf('export async function POST'))),
  false)
check('  convergence is still mandatory for event modules',
  /checkConvergedDeviceIdentity\(grant, config\)/
    .test(stripComments(read('src/device-auth/event-authorization.ts'))), true)

const dexie = read('src/db/database.ts')
check('21. IndexedDB version unchanged (1)', /DATABASE_VERSION = 1\b/.test(dexie), true)
check('  stores and indexes unchanged',
  (/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
  (/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').replace(/\s+/g, ' ').trim())
check('  exactly three stores',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((entry) => entry.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and no new EventConfig field was added',
  /refillAt|refilledAt|extendedAt|pendingRangeEnd|badgeRefill/
    .test(read('src/db/types.ts')), false)

const sheet = read('server/sync/sheet-contract.ts')
check('22. the Sheet contract is unchanged',
  [/A1:N/.test(sheet), /A1:M/.test(sheet), /Device ID', 'Device Name'/.test(sheet)],
  [true, true, true])
check('  no Postgres migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql',
   '0002_device_credentials.sql'])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
check('23. the Function inventory is exactly eight', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'device-auth', 'device-badge-claim', 'sync-registration',
])
check('  with four slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 4)
check('  and the refill added no Function of its own',
  [budget.problems,
   readdirSync(join(root, 'api')).filter((file) => /refill|extend|badge-range/.test(file))],
  [[], []])

console.log('\n=== DOCUMENTATION + HARNESS ===')
for (const [doc, needles] of [
  ['AGENTS.md', ['Contiguous Badge Refill', 'upward and contiguously']],
  ['README.md', ['badge refill', 'stays exactly where it is']],
  ['docs/DEVICE_AUTH.md', ['Phase D2.1', 'contiguous']],
  ['docs/EVENT_DAY_RUNBOOK.md', ['Add More Badges']],
  ['docs/DEVICE_RANGE_PLAN.md', ['refill']],
]) {
  const flat = read(doc).replace(/\s+/g, ' ')
  for (const needle of needles) {
    check(`${doc} documents "${needle.slice(0, 34)}"`, flat.includes(needle), true)
  }
}
const pkg = JSON.parse(read('package.json'))
check('verify:d21 is registered', pkg.scripts['verify:d21'], 'node scripts/verification/phase-d21.mjs')
check('  and included in verify', pkg.scripts.verify.includes('verify:d21'), true)
check('release:check guards the refill', /'badge-refill'/.test(read('scripts/release-check.mjs')), true)
check('no dependency was added',
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => /refill|range|interval/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
