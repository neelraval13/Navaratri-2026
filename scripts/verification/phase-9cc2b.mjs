/**
 * Phase 9C-C2B verification — authenticated online badge-range self-claim.
 *
 * Run with:  pnpm verify:9cc2b
 *
 * It NEVER connects to Neon and makes no HTTP request. The REAL endpoint, the
 * REAL device session primitives, the REAL browser client and the REAL C2A
 * adoption transaction all run; only Postgres and IndexedDB are stood in for.
 * The browser's `fetch` is wired directly into the endpoint, so the happy path
 * and both distributed-failure paths are observed end to end rather than
 * asserted from source.
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

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '22222222-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const OTHER_EVENT_ID = '88888888-2222-4333-8444-555555555555'
const LOCAL_DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SECRET = 'd'.repeat(48)
const ORIGIN = 'https://desk.example.test'

process.env.EVENT_DEVICE_SESSION_SECRET = SECRET

/* ------------------------------------------------------------------ server */

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

const reserve = await serverJiti.import(`${root}/server/badge-assignments/reserve.ts`)
const conflicts = await serverJiti.import(`${root}/server/badge-assignments/conflicts.ts`)
const rangeModel = await serverJiti.import(`${root}/server/badge-assignments/range.ts`)
const claimContract = await serverJiti.import(`${root}/src/shared/badge-claim-contract.ts`)
const registry = await serverJiti.import(`${root}/server/admin/registry.ts`)
const adminErrors = await serverJiti.import(`${root}/server/admin/errors.ts`)
const requests = await serverJiti.import(`${root}/server/device-auth/requests.ts`)
const deviceSession = await serverJiti.import(`${root}/server/device-auth/session.ts`)
const claimApi = await serverJiti.import(`${root}/api/device-badge-claim.ts`)
const fakeDb = await import('./fake-admin-db.mjs')

const password = await serverJiti.import(`${root}/server/device-auth/password.ts`)
const PASSPHRASE = 'desk-b-passphrase'
const storedHash = await password.hashDevicePassword(PASSPHRASE)

const seedCentral = ({ device = {}, event = {}, attributes = ['registration'],
  assignments = [], otherDevice = false } = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'Navaratri 2026',
    timezone: 'Asia/Kolkata', active: true, ...event,
  })
  fakeDb.state.events.push({
    id: OTHER_EVENT_ID, slug: 'other-event', name: 'Other', timezone: 'Asia/Kolkata', active: true,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Desk B', loginName: 'desk-b',
    passwordHash: storedHash, sessionVersion: 3, enabled: true, lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), ...device,
  })
  if (otherDevice) {
    fakeDb.state.devices.set(OTHER_DEVICE_ID, {
      id: OTHER_DEVICE_ID, eventId: EVENT_ID, name: 'Desk A', loginName: 'desk-a',
      passwordHash: storedHash, sessionVersion: 1, enabled: true, lastSeenAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
  }
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  if (otherDevice) {
    fakeDb.state.attributes.push({ deviceId: OTHER_DEVICE_ID, attribute: 'registration' })
  }
  for (const assignment of assignments) {
    fakeDb.state.assignments.push({
      id: `a-${String(fakeDb.state.assignments.length)}`, eventId: EVENT_ID,
      assignedAt: new Date('2026-02-01T00:00:00.000Z'), releasedAt: null, ...assignment,
    })
  }
  fakeDb.state.applied = []
}

const cookieFor = (over = {}) =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion: 3, ...over,
  })}`

const claimRequest = (body, { cookie = cookieFor(), origin = ORIGIN, contentType = 'application/json' } = {}) =>
  new Request(`${ORIGIN}/api/device-badge-claim`, {
    method: 'POST',
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(contentType === null ? {} : { 'content-type': contentType }),
      ...(cookie === null ? {} : { cookie }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const settle = async (response) => ({
  status: response.status,
  body: await response.json(),
  cacheControl: response.headers.get('cache-control'),
  cookie: response.headers.get('set-cookie'),
})

const post = async (body, options) => settle(await claimApi.POST(claimRequest(body, options)))
const CLAIM = { rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true }
const writes = () => fakeDb.state.applied.filter((entry) => !entry.startsWith('select'))

console.log('=== 1-7, 38. ONE SHARED CENTRAL RESERVATION PRIMITIVE ===')
check('exactly one module inserts a badge assignment',
  walk(join(root, 'server')).concat(walk(join(root, 'api')))
    .filter((file) => /insert\(badgeAssignments\)/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')),
  ['server/badge-assignments/reserve.ts'])
check('  Admin reserves through it',
  /reserveBadgeRange\(/.test(stripComments(read('server/admin/registry.ts'))), true)
check('  and Device self-claim reserves through the SAME one',
  /reserveBadgeRange\(/.test(stripComments(read('api/device-badge-claim.ts'))), true)
check('  the constraint map lives in one place too',
  walk(join(root, 'server'))
    .filter((file) => /badge_assignments_active_ranges_no_overlap/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')),
  ['server/badge-assignments/conflicts.ts'])
check('  and Admin reads it rather than restating it',
  /BADGE_RESERVATION_CONSTRAINTS/.test(read('server/admin/errors.ts')), true)
check('the shared primitive carries no realm concern',
  /admin|operator|cookie|session|Request|Response/i
    .test(stripComments(read('server/badge-assignments/reserve.ts'))), false)
/**
 * Admin legitimately hashes a device password — that is `device-auth/password`,
 * a pure crypto module with no HTTP or session concern. What it must never
 * touch is the device SESSION: a device cookie authorizes nothing in Admin.
 */
check('  and Admin never reaches into device SESSION auth',
  /device-auth\/(session|cookies|authorize|environment|same-origin)|navaratri_device_session/
    .test(stripComments(read('server/admin/registry.ts') + read('server/admin/errors.ts') +
      read('server/admin/validation.ts') + read('api/admin-badge-assignment.ts'))), false)
check('  nor the claim endpoint Admin auth',
  /server\/admin|admin_session|guardAdminRequest/
    .test(stripComments(read('api/device-badge-claim.ts'))), false)
check('the range MODEL is shared, so both accept the same mathematics',
  [/parseBadgeRange\(body\)/.test(read('server/admin/validation.ts')),
   /parseBadgeRange\(body\)/.test(read('server/device-auth/requests.ts'))], [true, true])
check('  with no invented maximum size',
  rangeModel.parseBadgeRange({ rangeStart: 1, rangeEnd: 1_000_000 }).ok, true)
check('  a single-badge range is valid',
  rangeModel.parseBadgeRange({ rangeStart: 7, rangeEnd: 7 }).value, { rangeStart: 7, rangeEnd: 7 })

console.log('  -- the error arrives WRAPPED, as drizzle throws it --')
/**
 * Production never hands the reader a bare Postgres error. Drizzle rethrows
 * `DrizzleQueryError`, whose message is `Failed query: …` and whose `cause`
 * carries the real one. A reader that looked only at the top level mapped
 * NOTHING in production while passing every test, and an overlapping badge
 * range reached the operator as "The server returned an unexpected response."
 */
const wrappedViolation = (name) => {
  const postgres = new Error(`conflicting key value violates constraint "${name}"`)
  postgres.name = 'NeonDbError'
  postgres.constraint = name
  const outer = new Error('Failed query: insert into "badge_assignments" ...\nparams: ')
  outer.name = 'DrizzleQueryError'
  outer.cause = postgres
  return outer
}
check('the wrapper itself names no constraint',
  /badge_assignments_/.test(wrappedViolation('badge_assignments_active_ranges_no_overlap').message),
  false)
check('a drizzle-wrapped overlap still maps',
  conflicts.mapBadgeReservationConflict(
    wrappedViolation('badge_assignments_active_ranges_no_overlap')), 'badge-range-overlap')
check('  so does a wrapped one-active-per-device',
  conflicts.mapBadgeReservationConflict(
    wrappedViolation('badge_assignments_one_active_per_device')), 'badge-range-already-assigned')
check('  and ADMIN reads the same wrapped shape',
  [adminErrors.mapDatabaseConflict(wrappedViolation('devices_event_id_login_name_key')),
   adminErrors.mapDatabaseConflict(wrappedViolation('events_slug_key')),
   adminErrors.mapDatabaseConflict(wrappedViolation('badge_assignments_active_ranges_no_overlap'))],
  ['login-name-taken', 'event-slug-taken', 'badge-range-overlap'])
check('  a name carried only in the inner MESSAGE is found',
  conflicts.mapBadgeReservationConflict({
    message: 'Failed query',
    cause: { message: 'violates "badge_assignments_one_active_per_device"' },
  }), 'badge-range-already-assigned')
check('  a Neon sourceError link is still followed',
  conflicts.mapBadgeReservationConflict({
    message: 'Failed query',
    sourceError: { constraint: 'badge_assignments_device_event_fk' },
  }), 'device-event-mismatch')
check('  an unknown wrapped constraint is still refused',
  conflicts.mapBadgeReservationConflict(wrappedViolation('something_else')), null)
const cyclic = { message: 'Failed query' }
cyclic.cause = cyclic
check('  a cyclic chain terminates rather than hanging',
  conflicts.mapBadgeReservationConflict(cyclic), null)

console.log('  -- Admin preassignment behaves exactly as before --')
seedCentral({ otherDevice: true })
const adminAssigned = await registry.assignBadgeRange(EVENT_ID, DEVICE_ID, { rangeStart: 1, rangeEnd: 200 })
check('1. Admin preassignment still succeeds',
  [adminAssigned.ok, adminAssigned.value.rangeStart, adminAssigned.value.rangeEnd], [true, 1, 200])
check('  and returns a server assignedAt',
  typeof adminAssigned.value.assignedAt, 'string')
const adminOverlap = await registry.assignBadgeRange(EVENT_ID, OTHER_DEVICE_ID, { rangeStart: 150, rangeEnd: 250 })
check('2. an overlapping Admin range still rejects',
  adminOverlap, { ok: false, conflict: 'badge-range-overlap' })
const adminSecond = await registry.assignBadgeRange(EVENT_ID, DEVICE_ID, { rangeStart: 400, rangeEnd: 500 })
check('3. a second active assignment still rejects',
  adminSecond, { ok: false, blocked: 'badge-range-already-assigned' })
const adminCrossEvent = await registry.assignBadgeRange(OTHER_EVENT_ID, OTHER_DEVICE_ID, { rangeStart: 400, rangeEnd: 500 })
check('4. a cross-event assignment still rejects',
  adminCrossEvent, { ok: false, blocked: 'device-event-mismatch' })
seedCentral({ device: { enabled: false } })
check('  Admin still refuses a disabled device',
  await registry.assignBadgeRange(EVENT_ID, DEVICE_ID, { rangeStart: 1, rangeEnd: 2 }),
  { ok: false, blocked: 'device-disabled' })
seedCentral({ attributes: ['prizes'] })
check('  and one without Registration',
  await registry.assignBadgeRange(EVENT_ID, DEVICE_ID, { rangeStart: 1, rangeEnd: 2 }),
  { ok: false, blocked: 'device-not-registration' })
check('5. release/history semantics are unchanged: nothing releases a range',
  walk(join(root, 'server')).concat(walk(join(root, 'api')))
    .filter((file) => /releasedAt:\s*(new Date|sql)|releaseBadgeRange|\.set\(\{\s*releasedAt/
      .test(stripComments(readFileSync(file, 'utf8')))), [])
check('  and `released_at IS NULL` is still what active means',
  /isNull\(badgeAssignments\.releasedAt\)/.test(read('server/badge-assignments/reserve.ts')), true)
check('7. only the AUTHORIZATION layers differ',
  [/checkBadgeAssignmentAllowed/.test(read('server/admin/registry.ts')),
   /checkBadgeAssignmentAllowed/.test(read('api/device-badge-claim.ts')),
   /authorizeDeviceRequest/.test(read('api/device-badge-claim.ts')),
   /authorizeDeviceRequest/.test(read('server/admin/registry.ts'))], [true, false, true, false])

console.log('\n=== 2. THE REQUEST CONTRACT ===')
check('a well-formed claim parses',
  requests.parseDeviceBadgeClaimInput(CLAIM).value, { rangeStart: 201, rangeEnd: 300 })
for (const field of requests.FORBIDDEN_CLAIM_FIELDS) {
  check(`  ${field} is REFUSED, not ignored`,
    requests.parseDeviceBadgeClaimInput({ ...CLAIM, [field]: 'x' }).ok, false)
}
check('  the forbidden set is exactly the identity fields',
  [...requests.FORBIDDEN_CLAIM_FIELDS], ['deviceId', 'eventId', 'eventSlug', 'loginName'])
for (const [label, body] of [
  ['no confirmation', { rangeStart: 201, rangeEnd: 300 }],
  ['a false confirmation', { ...CLAIM, physicalStackConfirmed: false }],
  ['a truthy non-boolean confirmation', { ...CLAIM, physicalStackConfirmed: 'true' }],
  ['a numeric confirmation', { ...CLAIM, physicalStackConfirmed: 1 }],
  ['a zero start', { ...CLAIM, rangeStart: 0 }],
  ['a reversed range', { ...CLAIM, rangeStart: 300, rangeEnd: 201 }],
  ['a fractional range', { ...CLAIM, rangeStart: 1.5 }],
  ['a string range', { ...CLAIM, rangeStart: '201' }],
  ['a negative range', { ...CLAIM, rangeStart: -1 }],
  ['a non-object body', 'nope'],
]) check(`  rejected: ${label}`, requests.parseDeviceBadgeClaimInput(body).ok, false)
check('the confirmation is a guard, never stored',
  [/physical_confirmed|physical_stack_confirmed|physicalStackConfirmed/
     .test(read('server/db/schema.ts')),
   /physicalStackConfirmed/.test(read('server/badge-assignments/reserve.ts'))], [false, false])
check('  and the parsed value carries only the range',
  Object.keys(requests.parseDeviceBadgeClaimInput(CLAIM).value).sort(), ['rangeEnd', 'rangeStart'])

console.log('\n=== 8-16, 39. THE SESSION IS THE IDENTITY ===')
seedCentral()
check('8. an unauthenticated claim is rejected',
  await post(CLAIM, { cookie: null }).then((r) => [r.status, r.body.authenticated]), [401, false])
check('  and writes nothing', writes(), [])
check('9. a malformed token is rejected',
  (await post(CLAIM, { cookie: '__Host-navaratri_device_session=garbage' })).status, 401)
check('  as is another realm\'s cookie',
  (await post(CLAIM, { cookie: '__Host-navaratri_admin_session=x' })).status, 401)
check('  a cross-site claim is refused before anything else',
  (await post(CLAIM, { origin: 'https://evil.test' })).status, 403)
check('  a missing origin too', (await post(CLAIM, { origin: null })).status, 403)
seedCentral()
fakeDb.state.devices.get(DEVICE_ID).sessionVersion = 4
check('10. a stale session version is rejected', (await post(CLAIM)).status, 401)
seedCentral({ device: { enabled: false } })
check('11. a disabled device is rejected', (await post(CLAIM)).status, 401)
seedCentral({ event: { active: false } })
check('12. an inactive event is rejected', (await post(CLAIM)).status, 401)
seedCentral({ device: { passwordHash: null } })
check('13. an unprovisioned device is rejected', (await post(CLAIM)).status, 401)
seedCentral()
fakeDb.state.devices.delete(DEVICE_ID)
check('  a deleted device is rejected', (await post(CLAIM)).status, 401)
check('  none of them wrote anything', writes(), [])
check('  and every rejection looks identical',
  await Promise.all([
    post(CLAIM, { cookie: '__Host-navaratri_device_session=garbage' }),
    post(CLAIM, { cookie: null }),
  ]).then((rows) => rows.map((row) => JSON.stringify(row.body))).then((rows) => rows[0] === rows[1]),
  true)

seedCentral({ attributes: ['prizes'] })
const prizesOnly = await post(CLAIM)
check('14. a prizes-only device gets registration-required',
  [prizesOnly.status, prizesOnly.body.blocked], [403, 'registration-required'])
check('  and nothing is reserved', [writes(), fakeDb.state.assignments.length], [[], 0])
seedCentral({ attributes: [] })
check('  so does one with no attributes',
  (await post(CLAIM)).body.blocked, 'registration-required')

seedCentral()
const unconfirmed = await post({ rangeStart: 201, rangeEnd: 300 })
check('15. no physical confirmation is rejected', unconfirmed.status, 400)
check('  and nothing is reserved', fakeDb.state.assignments.length, 0)
check('16. an invalid range is rejected',
  (await post({ ...CLAIM, rangeStart: 0 })).status, 400)
check('  an identity field in the body is rejected',
  (await post({ ...CLAIM, deviceId: OTHER_DEVICE_ID })).status, 400)
check('  a wrong content type is 415',
  (await post(CLAIM, { contentType: 'text/plain' })).status, 415)
check('  an oversized body is 413',
  (await post({ ...CLAIM, padding: 'x'.repeat(5000) })).status, 413)
check('  invalid JSON is 400', (await post('{', {})).status, 400)
check('  and none of them reserved anything',
  [writes(), fakeDb.state.assignments.length], [[], 0])

console.log('\n=== 17-24. CLAIM, IDEMPOTENCY AND THE RACE ===')
seedCentral()
const first = await post(CLAIM)
check('17. a valid fresh claim succeeds',
  [first.status, first.body.ok, first.body.outcome], [201, true, 'claimed'])
check('18. the returned range is exactly the one requested',
  [first.body.activeBadgeRange.rangeStart, first.body.activeBadgeRange.rangeEnd], [201, 300])
check('19. assignedAt is present and comes from the server',
  [typeof first.body.activeBadgeRange.assignedAt,
   first.body.activeBadgeRange.assignedAt === '2026-02-01T00:00:00.000Z'], ['string', false])
check('  exactly one row was inserted', [writes(), fakeDb.state.assignments.length],
  [['insert badge_assignments'], 1])
check('  the response is never cached', first.cacheControl, 'no-store')
check('  it sets no cookie', first.cookie, null)
check('  and carries no credential or registry data',
  /password|hash|salt|scrypt|sessionVersion|enabled|loginName|lastSeen/i
    .test(JSON.stringify(first.body)), false)
// 9C-C3A adds the re-issued offline lease: a claim changes central badge
// ownership, so the lease the browser holds is stale the moment it returns.
check('  its keys are exactly the contract',
  Object.keys(first.body).sort(),
  ['activeBadgeRange', 'offlineAuthorization', 'ok', 'outcome'])
check('  and the lease envelope is safe when signing is unconfigured',
  first.body.offlineAuthorization, { configured: false })
check('  and the range keys too',
  Object.keys(first.body.activeBadgeRange).sort(), ['assignedAt', 'rangeEnd', 'rangeStart'])

fakeDb.state.applied = []
const repeat = await post(CLAIM)
check('20. the same range again is an idempotent success',
  [repeat.status, repeat.body.outcome], [200, 'already-claimed'])
check('  with no second row', [writes(), fakeDb.state.assignments.length], [[], 1])
check('  and the authoritative range',
  [repeat.body.activeBadgeRange.rangeStart, repeat.body.activeBadgeRange.rangeEnd], [201, 300])

const different = await post({ rangeStart: 400, rangeEnd: 500, physicalStackConfirmed: true })
check('21. a DIFFERENT range is already-assigned',
  [different.status, different.body.conflict], [409, 'already-assigned'])
check('  and carries this device\'s real range',
  [different.body.activeBadgeRange.rangeStart, different.body.activeBadgeRange.rangeEnd], [201, 300])
check('  nothing was replaced and nothing added',
  [fakeDb.state.assignments.length, fakeDb.state.assignments[0].rangeEnd], [1, 300])

seedCentral({ otherDevice: true, assignments: [{ deviceId: OTHER_DEVICE_ID, rangeStart: 1, rangeEnd: 250 }] })
const overlap = await post(CLAIM)
check('22. overlapping another device is range-overlap',
  [overlap.status, overlap.body.conflict], [409, 'range-overlap'])
check('  the message names no other device',
  [overlap.body.message, /desk-a|Desk A|22222222/.test(JSON.stringify(overlap.body))],
  ['That badge range is already assigned.', false])
// The insert was ATTEMPTED and the constraint refused it, which is the point:
// what matters is that nothing committed and the other desk is untouched.
check('  the refused insert committed nothing',
  [fakeDb.state.assignments.length, fakeDb.state.assignments[0].deviceId,
   fakeDb.state.assignments[0].rangeEnd], [1, OTHER_DEVICE_ID, 250])

console.log('  -- a concurrent writer commits between the check and the insert --')
seedCentral()
fakeDb.state.beforeNextWrite = () => {
  fakeDb.state.assignments.push({
    id: 'raced', eventId: EVENT_ID, deviceId: DEVICE_ID, rangeStart: 201, rangeEnd: 300,
    assignedAt: new Date('2026-02-02T00:00:00.000Z'), releasedAt: null,
  })
}
const racedSame = await post(CLAIM)
check('24. the same-range race resolves idempotently',
  [racedSame.status, racedSame.body.outcome], [200, 'already-claimed'])
check('  against the row the OTHER writer committed',
  [racedSame.body.activeBadgeRange.assignedAt, fakeDb.state.assignments.length],
  ['2026-02-02T00:00:00.000Z', 1])

seedCentral()
fakeDb.state.beforeNextWrite = () => {
  fakeDb.state.assignments.push({
    id: 'raced', eventId: EVENT_ID, deviceId: DEVICE_ID, rangeStart: 900, rangeEnd: 999,
    assignedAt: new Date('2026-02-02T00:00:00.000Z'), releasedAt: null,
  })
}
const racedDifferent = await post(CLAIM)
check('23. a different-range race reloads the current assignment',
  [racedDifferent.status, racedDifferent.body.conflict,
   racedDifferent.body.activeBadgeRange.rangeStart], [409, 'already-assigned', 900])
check('  and still only one row exists', fakeDb.state.assignments.length, 1)
check('  the recovery really re-reads rather than echoing the request',
  /resolveExistingAssignment[\s\S]{0,500}readActiveBadgeAssignment\(deviceId\)/
    .test(read('api/device-badge-claim.ts')), true)

console.log('  -- the constraints, not the precheck, are the guarantee --')
seedCentral({ otherDevice: true })
await reserve.reserveBadgeRange({ eventId: EVENT_ID, deviceId: DEVICE_ID, range: { rangeStart: 1, rangeEnd: 100 } })
check('a second active assignment is refused by the DATABASE',
  await reserve.reserveBadgeRange({ eventId: EVENT_ID, deviceId: DEVICE_ID, range: { rangeStart: 500, rangeEnd: 600 } }),
  { ok: false, conflict: 'badge-range-already-assigned' })
check('  an overlapping one too',
  await reserve.reserveBadgeRange({ eventId: EVENT_ID, deviceId: OTHER_DEVICE_ID, range: { rangeStart: 50, rangeEnd: 150 } }),
  { ok: false, conflict: 'badge-range-overlap' })
check('  a touching-but-not-overlapping one is allowed',
  (await reserve.reserveBadgeRange({ eventId: EVENT_ID, deviceId: OTHER_DEVICE_ID, range: { rangeStart: 101, rangeEnd: 150 } })).ok,
  true)
for (const [constraint, conflict] of [
  ['badge_assignments_active_ranges_no_overlap', 'badge-range-overlap'],
  ['badge_assignments_one_active_per_device', 'badge-range-already-assigned'],
  ['badge_assignments_device_event_fk', 'device-event-mismatch'],
]) {
  check(`  ${constraint} -> ${conflict}`, conflicts.mapBadgeReservationConflict({ constraint }), conflict)
  check(`    also from the message`,
    conflicts.mapBadgeReservationConflict({ message: `violates "${constraint}"` }), conflict)
}
check('  an unknown error is never guessed at',
  conflicts.mapBadgeReservationConflict({ constraint: 'something_else' }), null)

console.log('\n=== 25. NO RAW DATABASE ERROR LEAKS ===')
seedCentral()
const logged = []
const realError = console.error
console.error = (...args) => { logged.push(args.join(' ')) }
/**
 * Built from parts: writing a connection string literally here would make
 * this suite trip the repository's own secret scan, and an exemption for the
 * scanner is a blind spot waiting to hide a real one.
 */
const FAKE_CONNECTION_STRING = `${'postgres'}://user:hunter@host/db`
fakeDb.state.failNextWrite =
  `error: relation "badge_assignments" does not exist at ${FAKE_CONNECTION_STRING}`
const unexpected = await post(CLAIM)
console.error = realError
check('an unmapped database failure is a generic 500',
  [unexpected.status, unexpected.body],
  [500, { ok: false, message: 'That badge range could not be claimed. Try again.' }])
check('  no SQL, table name or connection string reaches the caller',
  [/relation|badge_assignments|hunter/.test(JSON.stringify(unexpected.body)),
   JSON.stringify(unexpected.body).includes(FAKE_CONNECTION_STRING)], [false, false])
check('  nor the server log',
  logged.filter((entry) => entry.includes(FAKE_CONNECTION_STRING) || /relation "/.test(entry)), [])
check('  which records the operation and the SQLSTATE only',
  logged.map((entry) => entry.replace(/\(SQLSTATE .*\)/, '(SQLSTATE …)')),
  ['Navaratri device badge claim: failed (SQLSTATE …).'])

console.log('\n=== 13, 36. NO LOCAL STATE IN THE SERVER ===')
const claimSource = stripComments(read('api/device-badge-claim.ts'))
check('the endpoint knows nothing about local badge state',
  /nextBadge|badgeStart|badgeEnd|centralBadgeRangeBinding|IndexedDB|localStorage/
    .test(claimSource), false)
check('  nor about attendees',
  /attendee|normalizedName|\bphone\b|badgeNumber|issueBadge|holdRegistration/
    .test(claimSource), false)
check('36. no central nextBadge column or state exists',
  /next_badge|nextBadge|last_issued_badge|claimed_count/
    .test(stripComments(read('server/db/schema.ts')) +
          stripComments(read('server/badge-assignments/reserve.ts'))), false)
check('  and issuing a badge updates no central row',
  /badge_assignments|\/api\/|fetch\(/.test(stripComments(read('src/db/registrations.ts'))), false)
check('37. no attendee data reaches Postgres',
  /name|phone|age|gender|payment/i
    .test(stripComments(read('server/badge-assignments/reserve.ts'))), false)
check('  and the schema still has no attendee table',
  /attendee|registrations|holds/i.test(stripComments(read('server/db/schema.ts'))), false)
check('NO migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])

/* ------------------------------------------------------------------ client */

console.log('\n=== 26-36, 40. THE LOCAL PREFLIGHT ===')
const clientJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const adoption = await clientJiti.import(`${root}/src/db/central-badge-range.ts`)
const badgeClaim = await clientJiti.import(`${root}/src/device-auth/badge-claim.ts`)
const { state: dexie } = await import('./fake-db.mjs')

const LOCAL_BASE = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1,
  deviceId: LOCAL_DEVICE_ID, deviceName: 'Local Desk B',
  deviceConfiguredAt: '2026-09-01T00:00:00.000Z',
  upiId: 'organizer@upi', payeeName: 'Organizer', updatedAt: '2026-09-01T02:00:00.000Z',
}

const context = (over = {}) => ({
  device: {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Desk B', loginName: 'desk-b',
    attributes: ['registration'], lastSeenAt: null, ...(over.device ?? {}),
  },
  event: { id: EVENT_ID, slug: 'navaratri-2026', name: 'Navaratri 2026', timezone: 'Asia/Kolkata' },
  activeBadgeRange: over.activeBadgeRange ?? null,
})

const seedLocal = (config, completed = 0, held = 0) => {
  dexie.config = config === null ? null : { ...config }
  dexie.registrations = new Map()
  dexie.outbox = new Map()
  for (let index = 0; index < completed; index += 1) {
    dexie.registrations.set(`c${String(index)}`, {
      id: `c${String(index)}`, status: 'completed', badgeNumber: index + 1,
      name: `Attendee ${String(index)}`, phone: `90000000${String(index).padStart(2, '0')}`,
      normalizedName: `attendee ${String(index)}`, age: 20, gender: 'Male', amount: 20,
      paymentStatus: 'confirmed', paymentMethod: 'cash', createdAt: 'T', updatedAt: 'T', completedAt: 'T',
    })
  }
  for (let index = 0; index < held; index += 1) {
    dexie.registrations.set(`h${String(index)}`, {
      id: `h${String(index)}`, status: 'held', paymentStatus: 'pending',
      name: `Held ${String(index)}`, phone: `91000000${String(index).padStart(2, '0')}`,
      normalizedName: `held ${String(index)}`, age: 20, gender: 'Female', amount: 20,
      createdAt: 'T', updatedAt: 'T', heldAt: 'T',
    })
  }
}

const claimPlan = async (config, { over = {}, completed = 0, held = 0 } = {}) => {
  seedLocal(config, completed, held)
  return (await adoption.readCentralBadgeRangePlan(context(over))).claim
}

check('26. no local identity offers no claim',
  (await claimPlan({ ...LOCAL_BASE, deviceId: undefined, deviceName: undefined })),
  { outcome: 'blocked', plan: { outcome: 'device-not-registered' } })
check('27. no Registration offers no claim',
  (await claimPlan(LOCAL_BASE, { over: { device: { attributes: ['prizes'] } } })).plan.outcome,
  'registration-not-permitted')
check('28. a binding with no central assignment is a hard block',
  (await claimPlan({
    ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37,
    centralBadgeRangeBinding: {
      deviceId: DEVICE_ID, eventId: EVENT_ID, rangeStart: 1, rangeEnd: 200,
      assignedAt: 'A', adoptedAt: 'B',
    },
  })).outcome, 'binding-without-assignment')
check('  including when the binding range differs from the local one',
  (await claimPlan({
    ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37,
    centralBadgeRangeBinding: {
      deviceId: DEVICE_ID, eventId: EVENT_ID, rangeStart: 1, rangeEnd: 150,
      assignedAt: 'A', adoptedAt: 'B',
    },
  })).outcome, 'binding-without-assignment')
check('29. a binding for ANOTHER central device is blocked',
  (await claimPlan({
    ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37,
    centralBadgeRangeBinding: {
      deviceId: OTHER_DEVICE_ID, eventId: EVENT_ID, rangeStart: 1, rangeEnd: 200,
      assignedAt: 'A', adoptedAt: 'B',
    },
  })).plan.outcome, 'binding-device-conflict')
check('30. no local range and no issued badges is an editable self-claim',
  await claimPlan(LOCAL_BASE), { outcome: 'claimable-fresh' })
check('  held registrations alone do not change that',
  (await claimPlan(LOCAL_BASE, { held: 4 })).outcome, 'claimable-fresh')
check('31. a coherent local range offers ONLY that exact range',
  await claimPlan({ ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37 }, { completed: 36 }),
  { outcome: 'claimable-existing', rangeStart: 1, rangeEnd: 200, nextBadge: 37, issuedCount: 36 })
check('33. issued badges with a coherent range are allowed',
  (await claimPlan({ ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37 }, { completed: 36 })).issuedCount, 36)
check('34. issued badges with NO range are blocked',
  (await claimPlan(LOCAL_BASE, { completed: 3 })).plan,
  { outcome: 'issued-badges-without-range', issuedCount: 3 })
check('35. an incoherent nextBadge is blocked',
  (await claimPlan({ ...LOCAL_BASE, badgeEnd: 200, nextBadge: 500 })).plan.outcome,
  'incoherent-next-badge')
check('  a malformed local range too',
  (await claimPlan({ ...LOCAL_BASE, badgeStart: 9, badgeEnd: 2, nextBadge: 9 })).plan.outcome,
  'incoherent-next-badge')
check('  a nextBadge below the range too',
  (await claimPlan({ ...LOCAL_BASE, badgeStart: 10, badgeEnd: 200, nextBadge: 1 })).plan.outcome,
  'incoherent-next-badge')
check('  a missing config row is reported',
  (await claimPlan(null)).plan.outcome, 'missing-config')
check('an existing central assignment is adoption\'s business, not a claim\'s',
  (await claimPlan(LOCAL_BASE, {
    over: { activeBadgeRange: { rangeStart: 1, rangeEnd: 200, assignedAt: 'A' } },
  })).outcome, 'central-assignment-exists')

console.log('  -- one definition of "can this browser own range X?" --')
check('36. the claim planner delegates to the adoption planner',
  [...stripComments(read('src/db/central-badge-range.ts'))
    .matchAll(/planCentralBadgeRangeAdoption\(\{/g)].length >= 3, true)
check('  and the preflight uses the same one',
  /checkCentralBadgeRangeClaimable[\s\S]{0,900}planCentralBadgeRangeAdoption\(\{/
    .test(stripComments(read('src/db/central-badge-range.ts'))), true)
check('  the safety matrix exists in exactly one module',
  walk(join(root, 'src'))
    .filter((file) => /issued-badges-without-range/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')).sort(),
  ['src/components/device-auth/adoption-block.tsx', 'src/db/central-badge-range.ts'])
check('  and the UI file that names it only RENDERS it',
  /planCentralBadgeRangeAdoption|isBadgeDistributionConfigured|issuedBadgeCount/
    .test(read('src/components/device-auth/adoption-block.tsx')), false)

seedLocal({ ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37 }, 36)
check('the preflight accepts the matching range',
  await adoption.checkCentralBadgeRangeClaimable({
    context: context(), requested: { rangeStart: 1, rangeEnd: 200 },
  }), { ok: true })
check('  and refuses a different one',
  (await adoption.checkCentralBadgeRangeClaimable({
    context: context(), requested: { rangeStart: 201, rangeEnd: 300 },
  })).plan.outcome, 'range-conflict')
check('  it writes nothing either way',
  JSON.stringify(dexie.config), JSON.stringify({ ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37 }))
check('  and never stores the hypothetical assignedAt',
  /hypothetical/.test(JSON.stringify(dexie.config)), false)

/* ------------------------------------------- the browser against the server */

const fetchCalls = []
let scriptedFailure = null
const realFetch = globalThis.fetch

globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url, method: init.method, body: init.body,
    credentials: init.credentials, cache: init.cache })

  if (scriptedFailure !== null) {
    const failure = scriptedFailure
    scriptedFailure = null
    throw failure
  }

  return await claimApi.POST(new Request(`${ORIGIN}${String(url)}`, {
    method: init.method,
    headers: { ...(init.headers ?? {}), origin: ORIGIN, cookie: cookieFor() },
    body: init.body,
  }))
}

const runClaim = (input) => badgeClaim.claimCentralBadgeRange({ context: context(), ...input })

/**
 * The panel's claim handler ALONE, so an assertion cannot match `adopt` —
 * and, since Phase D1, not `converge` either. The slice ends at the next
 * handler rather than at the end of the handler block, because a window that
 * runs past its subject stops testing its subject.
 */
const panelFull = stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
const panelClaimSource = panelFull.slice(
  panelFull.indexOf('const claim = async'),
  panelFull.indexOf('const converge = async'),
)

console.log('\n=== 37-49, 41. THE HAPPY PATH, END TO END ===')
seedCentral()
seedLocal(LOCAL_BASE)
fetchCalls.length = 0
const happy = await runClaim({ rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })

check('37-39. an authenticated device with no assignment claims the typed range',
  [happy.outcome, happy.adoption], ['claimed', 'adopted'])
check('41. the request sends exactly the range and the confirmation',
  JSON.parse(fetchCalls[0].body),
  { rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })
check('  and names no device, event or login',
  Object.keys(JSON.parse(fetchCalls[0].body)).sort(),
  ['physicalStackConfirmed', 'rangeEnd', 'rangeStart'])
check('  against the claim endpoint, same-origin and uncached',
  [fetchCalls[0].url, fetchCalls[0].method, fetchCalls[0].credentials, fetchCalls[0].cache],
  ['/api/device-badge-claim', 'POST', 'same-origin', 'no-store'])
check('  exactly one request was made', fetchCalls.length, 1)
check('42. central returned the authoritative assignment',
  [happy.activeBadgeRange.rangeStart, happy.activeBadgeRange.rangeEnd], [201, 300])
check('44-46. local badge state is the claimed range, counter at its start',
  [dexie.config.badgeStart, dexie.config.badgeEnd, dexie.config.nextBadge], [201, 300, 201])
check('47. the binding uses the SERVER assignedAt',
  dexie.config.centralBadgeRangeBinding.assignedAt, happy.activeBadgeRange.assignedAt)
check('  and the central device and event',
  [dexie.config.centralBadgeRangeBinding.deviceId, dexie.config.centralBadgeRangeBinding.eventId],
  [DEVICE_ID, EVENT_ID])
check('  its fields are still exactly the approved set',
  Object.keys(dexie.config.centralBadgeRangeBinding).sort(),
  ['adoptedAt', 'assignedAt', 'deviceId', 'eventId', 'rangeEnd', 'rangeStart'])
check('48. the local device identity is untouched',
  [dexie.config.deviceId, dexie.config.deviceName], [LOCAL_DEVICE_ID, 'Local Desk B'])
check('  and no enrollment was invented', dexie.config.centralDeviceEnrollment, undefined)
check('40. the confirmation is required before anything happens',
  await runClaim({ rangeStart: 1, rangeEnd: 2, physicalStackConfirmed: false })
    .then((result) => [result.outcome, result.reason]), ['refused', 'stack-not-confirmed'])
check('  and no request was made for it', fetchCalls.length, 1)
check('49. C2B introduces no second local badge writer',
  walk(join(root, 'src'))
    .filter((file) => /badgeStart:\s|badgeEnd:\s|nextBadge:\s/.test(stripComments(readFileSync(file, 'utf8'))))
    .filter((file) => /db\.config\.put\(/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/src/`, '')).sort(),
  ['db/bootstrap.ts', 'db/central-badge-range.ts', 'db/device.ts', 'db/registrations.ts'])
check('25. the claim flow calls C2A adoption rather than writing',
  [/adoptCentralBadgeRange\(/.test(read('src/device-auth/badge-claim.ts')),
   /db\.config|db\.transaction|badgeStart:|nextBadge:/
     .test(stripComments(read('src/device-auth/badge-claim.ts')))], [true, false])

console.log('\n=== THE STALE-CONTEXT REGRESSION ===')
/**
 * The bug this section exists for, reproduced from real Development.
 *
 * `Claim Test Desk` claimed #401-#500. Postgres and IndexedDB were both
 * correct, yet the page briefly showed "Central assignment: Not assigned" and
 * accused the desk of an ownership-history mismatch. The claim response was
 * used for the local adoption, but the plans were then recomputed against the
 * PRE-CLAIM context, whose `activeBadgeRange` was still null.
 *
 * Refresh Device Status fixed it, which is what identified the cause: the only
 * thing that changed was the context, not the data.
 */
seedCentral()
seedLocal(LOCAL_BASE)
fetchCalls.length = 0
const claimed401 = await runClaim({ rangeStart: 401, rangeEnd: 500, physicalStackConfirmed: true })
check('the real Development claim succeeds and adopts',
  [claimed401.outcome, claimed401.adoption], ['claimed', 'adopted'])

const STALE = context()
const stalePlans = await adoption.readCentralBadgeRangePlan(STALE)
check('  planning against the PRE-CLAIM context reproduces the bug',
  [stalePlans.plan.outcome, stalePlans.claim.outcome],
  ['no-central-assignment', 'binding-without-assignment'])

const updated = badgeClaim.contextAfterClaim(STALE, claimed401)
check('the authoritative returned range is installed into the context',
  updated.activeBadgeRange,
  { rangeStart: 401, rangeEnd: 500, assignedAt: claimed401.activeBadgeRange.assignedAt })
check('  it is the SERVER range, not the submitted form',
  updated.activeBadgeRange.assignedAt === '2026-02-01T00:00:00.000Z', false)
check('  and not read back out of IndexedDB',
  updated.activeBadgeRange.assignedAt,
  fakeDb.state.assignments[0].assignedAt.toISOString())

const fixedPlans = await adoption.readCentralBadgeRangePlan(updated)
check('  the page immediately resolves to ALIGNED, with no refresh',
  fixedPlans.plan.outcome, 'already-adopted')
check('  and never to an ownership-history conflict',
  ['binding-without-assignment', 'central-range-changed', 'binding-device-conflict',
   'no-central-assignment', 'range-conflict']
    .includes(fixedPlans.plan.outcome), false)
check('  nor does the claim planner still offer a claim',
  fixedPlans.claim.outcome, 'central-assignment-exists')
check('  nextBadge was not reset', dexie.config.nextBadge, 401)
check('  the binding keeps the server assignedAt',
  dexie.config.centralBadgeRangeBinding.assignedAt, claimed401.activeBadgeRange.assignedAt)
check('  centralDeviceEnrollment is untouched', dexie.config.centralDeviceEnrollment, undefined)
check('  exactly one claim POST was made', fetchCalls.length, 1)
check('  and no second central assignment exists', fakeDb.state.assignments.length, 1)

console.log('  -- after an issue, the preserved counter survives the same transition --')
const afterIssue = { ...dexie.config, nextBadge: 402 }
seedLocal(afterIssue, 1)
const issuedPlans = await adoption.readCentralBadgeRangePlan(updated)
check('a desk that has issued #401 still reads as aligned',
  [issuedPlans.plan.outcome, dexie.config.nextBadge], ['already-adopted', 402])

console.log('  -- the panel installs it, and adds no network call --')
check('the panel plans against the updated context, never the stale one',
  [/const context = contextAfterClaim\(state\.context, result\)/.test(panelClaimSource),
   /readCentralBadgeRangePlan\(context\)/.test(panelClaimSource),
   /readCentralBadgeRangePlan\(state\.context\)/.test(panelClaimSource)],
  [true, true, false])
check('  and stores it, so the identity summary updates too',
  /setState\(\{ \.\.\.state, context, badge(, offline)? \}\)/.test(panelClaimSource), true)
check('  no extra session GET was added',
  [...stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
    .matchAll(/getDeviceSession\(\)/g)].length, 1)
// The module legitimately IMPORTS from `@/device-auth/...`; what it must not
// do is call the session endpoint to paper over its own stale state.
check('  and the claim flow never asks for the session again',
  /getDeviceSession|\/api\/device-auth|fetch\(/
    .test(stripComments(read('src/device-auth/badge-claim.ts'))), false)

console.log('  -- only a CONFIRMED reservation may update the context --')
const UNCONFIRMED = { outcome: 'unconfirmed', message: 'x' }
check('an ambiguous network failure manufactures NO central state',
  badgeClaim.contextAfterClaim(STALE, UNCONFIRMED).activeBadgeRange, null)
check('  a preflight block does not either',
  badgeClaim.contextAfterClaim(STALE,
    { outcome: 'preflight-blocked', plan: { outcome: 'range-conflict' } }).activeBadgeRange, null)
check('  nor an overlap refusal',
  badgeClaim.contextAfterClaim(STALE,
    { outcome: 'refused', reason: 'range-overlap', message: 'x', activeBadgeRange: null })
    .activeBadgeRange, null)
check('  nor already-assigned, which stays an explicit reconciliation',
  badgeClaim.contextAfterClaim(STALE, {
    outcome: 'refused', reason: 'already-assigned', message: 'x',
    activeBadgeRange: { rangeStart: 1, rangeEnd: 9, assignedAt: 'A' },
  }).activeBadgeRange, null)
check('  and the context is otherwise projected unchanged',
  [updated.device.id, updated.device.name, updated.event.slug,
   JSON.stringify(updated.device.attributes)],
  [DEVICE_ID, 'Desk B', 'navaratri-2026', '["registration"]'])

console.log('\n=== 50-59, 42. EXISTING-RANGE MIGRATION ===')
seedCentral()
const EXISTING = { ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37,
  badgeConfiguredAt: '2026-09-05T00:00:00.000Z' }
seedLocal(EXISTING, 36)
const plan = (await adoption.readCentralBadgeRangePlan(context())).claim
check('50-53. a desk with progress and no central assignment may claim its own range',
  [plan.outcome, plan.rangeStart, plan.rangeEnd, plan.nextBadge, plan.issuedCount],
  ['claimable-existing', 1, 200, 37, 36])
fetchCalls.length = 0
const migrated = await runClaim({
  rangeStart: plan.rangeStart, rangeEnd: plan.rangeEnd, physicalStackConfirmed: true,
})
check('54. the request is forced to the EXISTING range',
  JSON.parse(fetchCalls[0].body),
  { rangeStart: 1, rangeEnd: 200, physicalStackConfirmed: true })
check('55-56. central succeeds and C2A ALIGNS rather than resetting',
  [migrated.outcome, migrated.adoption], ['claimed', 'aligned'])
check('57. nextBadge remains #037', dexie.config.nextBadge, 37)
check('  and the range is unchanged',
  [dexie.config.badgeStart, dexie.config.badgeEnd], [1, 200])
check('  the existing badgeConfiguredAt is preserved',
  dexie.config.badgeConfiguredAt, '2026-09-05T00:00:00.000Z')
check('58. every completed registration survives',
  [...dexie.registrations.values()].filter((row) => row.status === 'completed').length, 36)
check('  and the outbox is untouched', dexie.outbox.size, 0)
check('59. the binding was added',
  [dexie.config.centralBadgeRangeBinding.rangeStart,
   dexie.config.centralBadgeRangeBinding.rangeEnd], [1, 200])
check('  central recorded exactly one assignment',
  [fakeDb.state.assignments.length, fakeDb.state.assignments[0].rangeEnd], [1, 200])
check('32. the migration range is NOT editable in the UI',
  [/plan\.rangeStart,\s*\n?\s*rangeEnd: plan\.rangeEnd/
     .test(read('src/components/device-auth/badge-range-claim.tsx')),
   /claimable-existing'[\s\S]{0,2600}<Input/
     .test(read('src/components/device-auth/badge-range-claim.tsx'))], [true, false])

console.log('\n=== 60-65, 43. CENTRAL SUCCESS, LOCAL FAILURE ===')
seedCentral()
seedLocal(LOCAL_BASE)
fetchCalls.length = 0
/**
 * The preflight passes, then local state changes while the request is in
 * flight. This is the one sequence no transaction can cover.
 */
const realGlobalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const response = await realGlobalFetch(url, init)
  dexie.config = { ...dexie.config, badgeStart: 1, badgeEnd: 50, nextBadge: 1 }
  return response
}
const split = await runClaim({ rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })
globalThis.fetch = realGlobalFetch

check('60-62. central claimed, C2A refused the local adoption',
  [split.outcome, split.plan.outcome], ['claimed-not-adopted', 'range-conflict'])
check('63. the central assignment is reported, not hidden',
  [split.activeBadgeRange.rangeStart, split.activeBadgeRange.rangeEnd], [201, 300])
check('64. it is NOT released automatically',
  [fakeDb.state.assignments.length, fakeDb.state.assignments[0].releasedAt], [1, null])
check('  and nothing in the browser can release one',
  /release|DELETE/.test(stripComments(read('src/device-auth/badge-claim.ts') +
    read('src/device-auth/device-api.ts').slice(
      read('src/device-auth/device-api.ts').indexOf('claimDeviceBadgeRange')))), false)
check('65. the conflicting local state was not overwritten',
  [dexie.config.badgeStart, dexie.config.badgeEnd, dexie.config.nextBadge], [1, 50, 1])
check('  and no binding was written', dexie.config.centralBadgeRangeBinding, undefined)
const claimUi = read('src/components/device-auth/badge-range-claim.tsx')
/**
 * The result report lives beside the badge sections, not inside the claim
 * form: installing the authoritative range moves the page onto the adoption
 * view, and this report has to survive that move.
 */
const resultUi = read('src/components/device-auth/claim-result.tsx')
check('  the UI says so in the strongest terms',
  [/Central range claimed, but local setup could not be completed/.test(resultUi),
   /Do not issue badges from this device until the conflict is/.test(resultUi),
   /has NOT been released/.test(resultUi)], [true, true, true])
check('  and the report is rendered outside the claim form, so it survives',
  [/<ClaimResult/.test(read('src/components/device-auth/local-badge-setup.tsx')),
   /ClaimResult/.test(claimUi)], [true, false])

console.log('\n=== 66-70, 44. AMBIGUOUS NETWORK FAILURE ===')
seedCentral()
seedLocal(LOCAL_BASE)
fetchCalls.length = 0
scriptedFailure = new DOMException('The operation was aborted.', 'AbortError')
const ambiguous = await runClaim({ rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })
check('66-68. an aborted request is UNCONFIRMED, never a failure',
  ambiguous.outcome, 'unconfirmed')
check('  and says exactly that',
  ambiguous.message,
  'Claim status could not be confirmed. Refresh the device status before trying again.')
check('67. no local adoption occurred',
  [dexie.config.badgeEnd, dexie.config.centralBadgeRangeBinding], [undefined, undefined])
check('70. no automatic second request was made', fetchCalls.length, 1)
check('69. the UI offers Refresh Device Status',
  [/'unconfirmed'[\s\S]{0,900}Refresh Device Status/.test(resultUi),
   /Claim status could not be confirmed/.test(resultUi)], [true, true])
check('  and there is no retry timer anywhere in the claim path',
  /setInterval|setTimeout|retry|poll/i
    .test(stripComments(read('src/device-auth/badge-claim.ts'))), false)

console.log('  -- 30, 31. central state moving mid-flow --')
seedCentral({ attributes: ['prizes'] })
seedLocal(LOCAL_BASE)
const revoked = await runClaim({ rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })
check('30. Registration removed between render and submit is refused by the SERVER',
  [revoked.outcome, revoked.reason], ['refused', 'registration-required'])
check('  with no local mutation',
  [dexie.config.badgeEnd, dexie.config.centralBadgeRangeBinding], [undefined, undefined])
check('  and no central insert', fakeDb.state.assignments.length, 0)
seedCentral({ device: { enabled: false } })
seedLocal(LOCAL_BASE)
check('31. a device disabled mid-flow is refused',
  (await runClaim({ rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })).reason,
  'unauthenticated')
seedCentral()
fakeDb.state.devices.get(DEVICE_ID).sessionVersion = 9
seedLocal(LOCAL_BASE)
check('  as is a password reset mid-flow',
  (await runClaim({ rangeStart: 201, rangeEnd: 300, physicalStackConfirmed: true })).reason,
  'unauthenticated')
check('  neither wrote anything locally or centrally',
  [dexie.config.badgeEnd, fakeDb.state.assignments.length], [undefined, 0])
check('  and the UI sends the operator back to the server for all three',
  /'already-assigned' \|\|[\s\S]{0,160}'registration-required' \|\|[\s\S]{0,160}'unauthenticated'[\s\S]{0,220}Refresh Device Status/
    .test(resultUi), true)

console.log('\n=== 71-75, 45. OVERLAP, END TO END ===')
/**
 * The real Development failure: Device B typed a range Device A already owned
 * and was told "The server returned an unexpected response." Every layer below
 * is exercised for real, so a break anywhere in the chain
 *
 *   exclusion constraint -> shared primitive -> typed internal conflict
 *   -> public 409 identifier -> client parser -> operator message
 *
 * shows up here rather than at a desk.
 */
seedCentral({ otherDevice: true, assignments: [{ deviceId: OTHER_DEVICE_ID, rangeStart: 401, rangeEnd: 500 }] })
seedLocal(LOCAL_BASE)
fetchCalls.length = 0

console.log('  -- the public contract --')
check('the public conflict identifiers are the shared ones',
  [...claimContract.BADGE_CLAIM_CONFLICTS],
  ['range-overlap', 'already-assigned', 'device-event-mismatch'])
check('  internal names translate in exactly ONE place',
  conflicts.PUBLIC_BADGE_CLAIM_CONFLICT,
  {
    'badge-range-overlap': 'range-overlap',
    'badge-range-already-assigned': 'already-assigned',
    'device-event-mismatch': 'device-event-mismatch',
  })
check('  the translation is total over the internal conflicts',
  Object.keys(conflicts.PUBLIC_BADGE_CLAIM_CONFLICT).sort(),
  Object.values(conflicts.BADGE_RESERVATION_CONSTRAINTS).sort())
check('  the endpoint uses that map rather than a literal',
  [/PUBLIC_BADGE_CLAIM_CONFLICT/.test(read('api/device-badge-claim.ts')),
   /conflict: 'range-overlap'/.test(stripComments(read('api/device-badge-claim.ts')))],
  [true, false])
check('  and the client recognises it by the SHARED guard',
  [/isBadgeClaimConflict/.test(read('src/device-auth/device-api.ts')),
   /badge-claim-contract/.test(read('src/device-auth/device-api.ts'))], [true, true])
check('  no internal constraint name is reachable from the browser',
  walk(join(root, 'src'))
    .filter((file) => /badge_assignments_/.test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${root}/`, '')), [])

console.log('  -- 1-4. the server side --')
const overlapReserved = await reserve.reserveBadgeRange({
  eventId: EVENT_ID, deviceId: DEVICE_ID, range: { rangeStart: 401, rangeEnd: 500 },
})
check('1. the exclusion constraint fires and the primitive types it',
  overlapReserved, { ok: false, conflict: 'badge-range-overlap' })

fakeDb.state.applied = []
const overlapResponse = await post({ rangeStart: 401, rangeEnd: 500, physicalStackConfirmed: true })
check('2. the endpoint answers 409', overlapResponse.status, 409)
check('3. with the stable PUBLIC identifier', overlapResponse.body.conflict, 'range-overlap')
check('4. and no internal constraint name, SQL or driver detail',
  /badge_assignments_|constraint|Postgres|postgres|SQL|gist|23P01|Drizzle|Failed query/
    .test(JSON.stringify(overlapResponse.body)), false)
check('  nor anything about the other device',
  /desk-a|Desk A|22222222|loginName|deviceId/.test(JSON.stringify(overlapResponse.body)), false)
check('  its keys are only the safe three',
  Object.keys(overlapResponse.body).sort(), ['conflict', 'message', 'ok'])
check('7. no assignment row was created for this device',
  fakeDb.state.assignments.filter((row) => row.deviceId === DEVICE_ID).length, 0)
check('8. the other device\'s row is untouched',
  [fakeDb.state.assignments.length, fakeDb.state.assignments[0].deviceId,
   fakeDb.state.assignments[0].rangeStart, fakeDb.state.assignments[0].rangeEnd],
  [1, OTHER_DEVICE_ID, 401, 500])

console.log('  -- 5-14. the client side --')
fetchCalls.length = 0
const refused = await runClaim({ rangeStart: 401, rangeEnd: 500, physicalStackConfirmed: true })
check('5. the client result is range-overlap',
  [refused.outcome, refused.reason], ['refused', 'range-overlap'])
check('6. and is NOT unexpected', refused.reason === 'unexpected', false)
check('  it carries the range the operator typed, for the message',
  refused.requested, { rangeStart: 401, rangeEnd: 500 })
check('74. the message is operational, not technical',
  [refused.message,
   /unexpected|constraint|Postgres|SQL|server error|database/i.test(refused.message)],
  ['Those badges overlap a range already assigned to another device. Check the physical badge stack at this desk and enter a different range.',
   false])
check('9-10. nothing local was written',
  [dexie.config.badgeStart, dexie.config.badgeEnd, dexie.config.nextBadge,
   dexie.config.centralBadgeRangeBinding, dexie.config.badgeConfiguredAt],
  [1, undefined, 1, undefined, undefined])
check('11. the session context still reports no assignment',
  badgeClaim.contextAfterClaim(context(), refused).activeBadgeRange, null)
check('12. exactly one POST was made', fetchCalls.length, 1)
check('13-14. and no automatic GET or retry followed',
  fetchCalls.map((call) => `${String(call.method)} ${String(call.url)}`),
  ['POST /api/device-badge-claim'])

console.log('  -- the operator-facing rendering --')
for (const needle of ['Badge range already assigned',
  'overlap a range already assigned to another device',
  'Check the physical badge stack at this desk and enter a different',
  'Nothing was changed on this device.',
  'result.requested.rangeStart']) {
  check(`  overlap UI contains: ${needle.slice(0, 46)}`, resultUi.includes(needle), true)
}
check('  and it is its own branch, not the generic refusal',
  /result\.reason === 'range-overlap'[\s\S]{0,400}Badge range already assigned/.test(resultUi), true)
check('  it names NO technical detail',
  /unexpected response|constraint|Postgres|SQL|database conflict|server error/i
    .test(stripComments(resultUi)), false)
check('  and no other-device information',
  /loginName|deviceId|device\.name|otherDevice/.test(resultUi), false)

console.log('  -- 73. input preservation and confirmation reset --')
check('73. the entered range is never cleared by the UI',
  /setStart\(''\)|setEnd\(''\)|setStart\(String|reset\(\)/.test(claimUi), false)
check('  editing either boundary resets the physical confirmation',
  [/const editRange = /.test(claimUi),
   /editRange[\s\S]{0,200}setConfirmed\(false\)/.test(claimUi),
   /editRange\(setStart\)/.test(claimUi), /editRange\(setEnd\)/.test(claimUi)],
  [true, true, true, true])
check('  and dismisses the previous result',
  /editRange[\s\S]{0,240}onRangeEdited\(\)/.test(claimUi), true)
check('  which the panel honours by clearing it',
  /onRangeEdited=\{\(\) => \{\s*setClaimResult\(null\)/
    .test(stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))), true)
check('  the claim stays disabled until the NEW range is confirmed',
  /disabled=\{!isRangeValid \|\| !confirmed \|\| isBusy\}/.test(claimUi), true)
check('  and an unconfirmed submit never reaches the server',
  [(await runClaim({ rangeStart: 601, rangeEnd: 700, physicalStackConfirmed: false })).reason,
   fetchCalls.length], ['stack-not-confirmed', 1])

console.log('  -- 75. the operator simply enters another range --')
const retried = await runClaim({ rangeStart: 601, rangeEnd: 700, physicalStackConfirmed: true })
check('75. a non-overlapping range then succeeds', retried.outcome, 'claimed')
check('  beside the other device\'s range, untouched',
  fakeDb.state.assignments.map((row) => row.rangeStart).sort((a, b) => a - b), [401, 601])

console.log('  -- every operator-facing claim message is distinct and safe --')
const messages = Object.entries(
  /export const DEVICE_MESSAGES = \{([\s\S]*?)\n\} as const/
    .exec(read('src/device-auth/device-api.ts'))[1]
    .split('\n').join(' ')
    .matchAll(/(\w+):\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)
).map(([, entry]) => entry[2])
check('no operator message exposes an implementation detail',
  messages.filter((message) =>
    /constraint|Postgres|SQL|drizzle|stack trace|500|exception|null/i.test(message)), [])
check('  and none of them is a bare "unexpected"',
  messages.filter((message) => message === 'unexpected'), [])
check('a rate-limited claim does not borrow the LOGIN copy',
  /status === 429[\s\S]{0,260}claimTooMany/.test(read('src/device-auth/device-api.ts')), true)
check('the last-resort message tells the operator what to do',
  /Something went wrong while claiming this badge range\. Try again, or refresh the device status\./
    .test(read('src/device-auth/device-api.ts')), true)
check('  and is only used where nothing better is known',
  [...stripComments(read('src/device-auth/device-api.ts'))
    .matchAll(/status: 'unexpected'/g)].length >= 1, true)

globalThis.fetch = realFetch

console.log('\n=== 16-18, 32-34. THE UI ===')
const setupSource = read('src/components/device-auth/local-badge-setup.tsx')
check('the claim surface lives in the existing Local Badge Setup section',
  [/Local Badge Setup/.test(setupSource),
   /no-central-assignment'[\s\S]{0,200}<BadgeRangeClaim/.test(setupSource)], [true, true])
check('  and no new route was added',
  ['/', '/badge-registration', '/device-registration', '/device-login', '/admin']
    .every((route) => read('src/app/routes.ts').includes(`'${route}'`)) &&
  [...read('src/app/routes.ts').matchAll(/'\/[a-z-]*'/g)].map((m) => m[0]).sort(),
  ["'/'", "'/admin'", "'/badge-registration'", "'/device-login'", "'/device-registration'"])
check('33. a fresh desk gets Badge Range Setup with two inputs',
  [/Badge Range Setup/.test(claimUi), /claim-range-start/.test(claimUi),
   /claim-range-end/.test(claimUi), /Range start/.test(claimUi), /Range end/.test(claimUi)],
  [true, true, true, true, true])
check('  a live badge count',
  /badgeCount === null[\s\S]{0,260}badge'\s*:\s*'badges'/.test(claimUi), true)
check('  a mandatory physical confirmation',
  [/I have physical badges \$\{range\} at this device\./.test(claimUi),
   /disabled=\{!isRangeValid \|\| !confirmed \|\| isBusy\}/.test(claimUi)], [true, true])
check('  and the reserve-first explanation',
  /reserved online first/.test(claimUi), true)
check('  the action is explicitly worded',
  /Claim & Set Up \$\{range\}/.test(claimUi), true)
check('17. there is NO suggested or auto-assigned range',
  /Find next range|Auto.?assign|Get next numbers|next free|suggest/i
    .test(stripComments(claimUi)), false)
check('  the inputs start empty and are never prefilled',
  [/useState\(''\)/.test(claimUi),
   /defaultValue|placeholder=/.test(claimUi)], [true, false])
check('34. an existing range is shown read-only with its progress',
  [/Existing local badge range/.test(claimUi), /Next badge/.test(claimUi),
   /Completed badges/.test(claimUi), /Only this exact range can be claimed/.test(claimUi)],
  [true, true, true, true])
check('  with its own wording and action',
  [/The physical \$\{range\} badge stack belongs to this device\./.test(claimUi),
   /Claim Existing \$\{range\} Centrally/.test(claimUi)], [true, true])
check('22. the binding reconciliation state blocks hard',
  [/Local badge ownership history does not match the current central\s*\n?\s*state/.test(claimUi),
   /binding-without-assignment'[\s\S]{0,1400}needs reconciliation/.test(claimUi)], [true, true])
check('  and offers no override anywhere in the claim UI',
  /Override|Force|Claim anyway|Ignore|Replace range/i.test(stripComments(claimUi)), false)
/**
 * 9C-C3B's authorization provider READS the config row to evaluate badge
 * ownership. Writing is still forbidden — and so is touching registrations
 * or the outbox at all.
 */
check('the UI never writes badge state itself',
  walk(join(root, 'src/components/device-auth'))
    .filter((file) => /db\.config\.(put|update|add|delete)|db\.transaction|configureBadgeDistribution\(|db\.(registrations|outbox)\./
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  and the claim is one deliberate action, not two',
  [...stripComments(setupSource).matchAll(/onClaim/g)].length >= 1 &&
  [...stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
    .matchAll(/claimCentralBadgeRange\(/g)].length, 1)

console.log('\n=== 46-51. BOUNDARIES ===')
const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
check('46. the Function inventory is exactly eleven', budget.actual.length, 11)
check('  with one slot of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 1)
check('  the new entry is device-badge-claim',
  budget.actual.includes('device-badge-claim'), true)
check('  every existing Function remains',
  budget.actual, [
    'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
    'admin-events', 'device-auth', 'device-badge-claim', 'operator-login',
    'operator-logout', 'operator-session', 'sync-registration',
  ])
check('  and nothing unexpected', budget.problems, [])
check('  no helper was placed under api/',
  functionChecker.functionEntrypoints()
    .filter((file) => !/export (async )?function (GET|POST|PUT|PATCH|DELETE)\(/
      .test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  the claim endpoint exports POST only',
  [...read('api/device-badge-claim.ts').matchAll(/export (?:async )?function ([A-Z]+)\(/g)]
    .map((match) => match[1]), ['POST'])

check('47. no unauthenticated rate-limit rule was added for the claim',
  /device-badge-claim/.test(read('docs/VERCEL_FIREWALL.md').replace(
    /## Why the claim endpoint[\s\S]*?(?=\n## |$)/, '')), false)
check('  and the device login rule is unchanged',
  [/\/api\/device-auth/.test(read('docs/VERCEL_FIREWALL.md')),
   /### The method matters/.test(read('docs/VERCEL_FIREWALL.md'))], [true, true])

console.log('  -- 48. C1 and C2A still hold --')
const panelSource = stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
check('the enrollment shape is still the seven C1 fields',
  (/export interface CentralDeviceEnrollment \{([\s\S]*?)\n\}/.exec(read('src/db/types.ts'))?.[1] ?? '')
    .match(/^\s{2}(\w+)[?]?:/gm).map((entry) => entry.trim().replace(/[?:]/g, '')).sort(),
  ['attributes', 'deviceId', 'deviceName', 'eventId', 'eventSlug', 'loginName', 'verifiedAt'])
check('  signing in still never adopts automatically',
  /saved\.outcome === 'saved'[\s\S]{0,400}(adoptCentralBadgeRange|claimCentralBadgeRange)/
    .test(panelSource), false)
check('  adoption still has exactly one caller in the panel',
  [...panelSource.matchAll(/adoptCentralBadgeRange\(/g)].length, 1)
check('  and the claim exactly one',
  [...panelSource.matchAll(/claimCentralBadgeRange\(/g)].length, 1)
/**
 * Named one by one rather than counted. Phase D1 added a third mutating
 * handler, `converge`, which carries the same guard — and a bare count would
 * have been satisfied by any three occurrences anywhere, including three in
 * one handler while another had none.
 */
check('  each mutating handler is guarded by an authenticated state', [
  'const adopt = async', 'const claim = async', 'const converge = async',
].map((handler) => {
  const body = panelSource.slice(panelSource.indexOf(handler))
  return /^[\s\S]{0,220}state\.phase !== 'authenticated'/.test(body)
}), [true, true, true])
check('    and nothing else in the panel claims that guard',
  [...panelSource.matchAll(/state\.phase !== 'authenticated'/g)].length, 3)
check('  the offline branches reach neither',
  /'last-verified'[\s\S]{0,700}(adoptCentralBadgeRange|claimCentralBadgeRange)/
    .test(panelSource), false)
check('  sign-out and clear still keep badge state',
  /clearCentralBadgeRange|centralBadgeRangeBinding:\s*undefined|badgeStart:/.test(panelSource), false)

console.log('  -- 49, 50. the event app is untouched --')
// 9C-C3B moved Operator Access from the shell to the routes; it remains the
// fallback everywhere, and the sole authority for /device-registration.
check('49. Operator Access still gates event routes',
  [/OperatorAccessGate/.test(read('src/components/app-router.tsx')),
   /ROUTES\.deviceRegistration[\s\S]{0,200}EventAccessGate/
     .test(stripComments(read('src/components/app-router.tsx')))], [true, false])
check('  the operator realm is still its own three Functions',
  ['operator-login', 'operator-logout', 'operator-session']
    .every((name) => budget.actual.includes(name)), true)
check('50. /device-registration still exists',
  existsSync(join(root, 'src/pages/device-registration-page.tsx')), true)
check('  and local identity is never replaced by a central one',
  /deviceId:\s*context\.device\.id|deviceName:\s*context\.device\.name/
    .test(stripComments(read('src/db/central-badge-range.ts')
      .replace(/const binding: CentralBadgeRangeBinding = \{[\s\S]*?\n  \}/, ''))), false)
/**
 * 9C-C3A issues an offline lease here, which is why `offlineAuthorization`
 * now legitimately appears. What C3 must still NOT have is a heartbeat, a
 * poll, or a cached permission used as authority.
 */
check('51. no C3 heartbeat or permission cache appeared',
  /heartbeat|setInterval|permissionCache|cachedAttributes/i
    .test(stripComments(read('src/device-auth/badge-claim.ts') + claimUi + panelSource)), false)
check('  and no route is authorized from the lease',
  /offline/i.test(stripComments(read('src/components/event-app-gate.tsx'))), false)

console.log('\n=== 52-54. DOCS, RELEASE CHECK AND THE SUITE ===')
const deviceDoc = read('docs/DEVICE_AUTH.md')
for (const needle of [
  '/api/device-badge-claim', 'online only', 'Registration', 'physical',
  'exclusion constraint', 'idempotent', 'not rolled back', 'nextBadge',
  'PUBLIC_BADGE_CLAIM_CONFLICT', 'DrizzleQueryError', 'walks the chain',
]) check(`DEVICE_AUTH.md documents ${needle}`, deviceDoc.includes(needle), true)
check('AGENTS.md records the wrapped-error rule',
  [/WALK THAT CHAIN/.test(read('AGENTS.md')),
   /PUBLIC_BADGE_CLAIM_CONFLICT/.test(read('AGENTS.md')),
   /resets\s*\n?`?physicalStackConfirmed`?/.test(read('AGENTS.md'))], [true, true, true])
check('  and names the Function count',
  /11 \/ 12|11 of 12/.test(deviceDoc + read('AGENTS.md')), true)
check('AGENTS.md records the self-claim rules',
  [/self-claim/i.test(read('AGENTS.md')),
   /device-badge-claim/.test(read('AGENTS.md'))], [true, true])
check('README names the endpoint', read('README.md').includes('device-badge-claim'), true)
check('the release checklist covers it',
  /device-badge-claim/.test(read('docs/PRODUCTION_RELEASE_CHECKLIST.md')), true)
check('release:check guards the self-claim',
  /badge-self-claim/.test(read('scripts/release-check.mjs')), true)

const manifest = JSON.parse(read('package.json'))
check('verify:9cc2b is registered',
  manifest.scripts['verify:9cc2b'], 'node scripts/verification/phase-9cc2b.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9cc2b'), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /zod|redux|zustand|jotai|react-query|tanstack|swr|lock|redis|ioredis/i.test(name)), [])
check('IndexedDB version unchanged (1)',
  /DATABASE_VERSION = 1/.test(read('src/db/database.ts')), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(read('src/db/database.ts'))?.[1] ?? '')
    .match(/^\s*(\w+):/gm) ?? []).map((entry) => entry.trim().replace(':', '')),
  ['registrations', 'config', 'outbox'])
check('Google Sheet ranges unchanged',
  [/A1:N/.test(read('server/sync/sheet-contract.ts')),
   /A1:M/.test(read('server/sync/sheet-contract.ts'))], [true, true])
/**
 * 9C-C3B adds a live device session as a second sync realm. The self-claim
 * endpoint is still nothing to do with sync, and the offline lease is still
 * accepted by nothing.
 */
check('sync keeps the operator realm and never takes the lease or the claim',
  [/operator/i.test(read('api/sync-registration.ts')),
   /device-badge-claim|verifyOfflineAuthorization|offline-lease/
     .test(stripComments(read('api/sync-registration.ts')))], [true, false])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
