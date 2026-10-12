/**
 * Phase A1 verification — the read-only attendee directory.
 *
 * Run with:  pnpm verify:a1
 *
 * It NEVER connects to Neon, Google or any network. The REAL endpoint, the
 * REAL Badge Register reader, the REAL route policy, the REAL shared filters,
 * the REAL browser client and the REAL cards and filter controls all run;
 * only Postgres, the Sheets API and HTTP are stood in for.
 *
 * TWO PROPERTIES CARRY THIS PHASE, and most of what follows is one of them:
 *
 *   1. IT CHANGES NOTHING. Not through the API, not through the page, not
 *      through a card. A read-only viewer handed to a volunteer stops being
 *      one the moment anything here can write.
 *   2. IT IS SEPARATELY GRANTED. `prizes` must not open it and
 *      `registration` must not either, because browsing the whole register is
 *      a different thing to be trusted with than identifying the badge in
 *      somebody's hand.
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

/**
 * A missing file FAILS its assertion rather than aborting the suite: a crash
 * here hides every assertion below it, which a Phase P1.1 canary proved the
 * hard way.
 */
const read = (p) => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : ''
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const DEVICE_ID = '33333333-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '44444444-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const ORIGIN = 'https://viewer.example.test'
const REGISTERED_AT = '2026-10-10T12:30:00.000Z'

/* ------------------------------------------------ the server, end to end */

const serverJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../../server/db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    '../sync/google-sheets.js': `${HERE}/fake-sheets.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})

const SECRET = 'a'.repeat(48)
process.env.EVENT_DEVICE_SESSION_SECRET = SECRET
process.env.SYNC_ALLOWED_ORIGIN = ORIGIN
/**
 * The real release interlock, satisfied the way Development satisfies it.
 * These are placeholders, not credentials: the Sheets client is a fake and
 * never authenticates anything.
 */
process.env.SYNC_WRITE_ENABLED = 'true'
process.env.SYNC_ALLOWED_VERCEL_ENV = 'development'
process.env.VERCEL_ENV = 'development'
process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'fake-spreadsheet'
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'fake@example.test'
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'fake-key'

const deviceSession = await serverJiti.import(`${root}/server/device-auth/session.ts`)
const adminSession = await serverJiti.import(`${root}/server/admin-auth/session.ts`)
const endpoint = await serverJiti.import(`${root}/api/attendees.ts`)
const prizeEndpoint = await serverJiti.import(`${root}/api/prizes.ts`)
const sheetContract = await serverJiti.import(`${root}/server/sync/sheet-contract.ts`)
const password = await serverJiti.import(`${root}/server/device-auth/password.ts`)
const fakeDb = await import('./fake-admin-db.mjs')
const fakeSheets = await import('./fake-sheets.mjs')

const storedHash = await password.hashDevicePassword('viewer-passphrase')

/* --------------------------------------------------------------- fixtures */

/**
 * Built through the REAL Badge Register row builder, so a column that moved
 * would break this suite instead of silently shifting what the reader reads.
 */
const ATTENDEES = [
  { badge: 9001, name: 'Prize Test 01', age: 7, gender: 'female' },
  { badge: 9002, name: 'Prize Test 02', age: 15, gender: 'male' },
  { badge: 9003, name: 'Prize Test 03', age: 15, gender: 'female' },
  { badge: 9004, name: 'Prize Test 04', age: 34, gender: 'male' },
  { badge: 9005, name: 'Meera', age: 11, gender: 'female' },
]

const PHONE_OF = (badge) => String(9000000000 + badge - 9000)

const sheetRow = (attendee) =>
  sheetContract
    .buildBadgeRegisterRow({
      id: `a1-fixture-${String(attendee.badge)}`,
      status: 'completed',
      paymentStatus: 'confirmed',
      paymentMethod: 'upi',
      badgeNumber: attendee.badge,
      name: attendee.name,
      phone: PHONE_OF(attendee.badge),
      age: attendee.age,
      gender: attendee.gender,
      amount: 20,
      createdAt: REGISTERED_AT,
      completedAt: REGISTERED_AT,
      updatedAt: REGISTERED_AT,
    })
    .map((cell) => cell.value)

/** Deliberately UNSORTED, so "badge-ascending" is the reader's doing. */
const seedSheet = (attendees = [...ATTENDEES].reverse()) => {
  fakeSheets.reset()
  fakeSheets.state.values = [
    [...sheetContract.BADGE_REGISTER_HEADERS],
    ...attendees.map(sheetRow),
  ]
}

const seedCentral = ({ attributes = ['attendees'], device = {}, event = {} } = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata',
    active: true, endsAt: null, ...event,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Attendee Viewer Test',
    loginName: 'attendee-viewer-test', passwordHash: storedHash, sessionVersion: 2,
    enabled: true, lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...device,
  })
  fakeDb.state.devices.set(OTHER_DEVICE_ID, {
    id: OTHER_DEVICE_ID, eventId: EVENT_ID, name: 'Prize Desk',
    loginName: 'prize-desk', passwordHash: storedHash, sessionVersion: 1,
    enabled: true, lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  fakeDb.state.attributes.push({ deviceId: OTHER_DEVICE_ID, attribute: 'prizes' })
  fakeDb.state.applied = []
}

const deviceCookie = (sessionVersion = 2) =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion,
  })}`

const request = (method, cookie = deviceCookie()) =>
  new Request(`${ORIGIN}/api/attendees`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
  })

const get = (cookie = deviceCookie()) => endpoint.GET(request('GET', cookie))
const directory = async (cookie) => (await get(cookie)).json()
const badgesIn = (list) => list.map((entry) => entry.badgeNumber)

/* ========================= 1-7, 13-14. THE PERMISSION MODEL ============= */

console.log('=== 1-7, 13-14. THREE INDEPENDENT ATTRIBUTES ===')

const domainJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const authz = await domainJiti.import(`${root}/src/device-auth/event-authorization.ts`)
const attributes = await domainJiti.import(`${root}/src/shared/device-attributes.ts`)
const filters = await domainJiti.import(`${root}/src/attendees/attendee-filters.ts`)
const client = await domainJiti.import(`${root}/src/attendees/attendee-api.ts`)

// RE-SCOPED BY PHASE D3, which added `dandiya` as a fourth independent
// capability. A1's concern is that `attendees` is one of them and is its own.
check('1. `attendees` is a valid device attribute',
  [[...attributes.DEVICE_ATTRIBUTES],
   attributes.isDeviceAttribute('attendees'),
   attributes.parseAttributeSet(['attendees']).attributes,
   attributes.ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE],
  [['registration', 'prizes', 'attendees', 'dandiya'], true, ['attendees'], 'attendees'])
check('  it is labelled and described for the Admin form',
  [attributes.DEVICE_ATTRIBUTE_LABELS.attendees,
   attributes.DEVICE_ATTRIBUTE_DESCRIPTIONS.attendees.length > 0],
  ['Attendees', true])
check('  and free text is still refused',
  [attributes.parseAttributeSet(['viewer']).ok,
   attributes.parseAttributeSet(['attendee']).ok,
   attributes.parseAttributeSet(['Attendees']).ok],
  [false, false, false])

/** A converged browser with NO badge state at all: the viewer shape. */
const VIEWER_CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1,
  deviceId: DEVICE_ID, deviceName: 'Attendee Viewer Test',
  deviceConfiguredAt: '2026-10-01T01:00:00.000Z', updatedAt: 'T',
}
const ENROLLMENT = {
  deviceId: DEVICE_ID, eventId: EVENT_ID, eventSlug: 'navaratri-2026',
  deviceName: 'Attendee Viewer Test', loginName: 'attendee-viewer-test',
  attributes: ['attendees'], verifiedAt: 'T',
}
const grant = (over = {}) => ({
  source: 'device-online', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['attendees'],
  activeBadgeRange: null, ...over,
})
const authorize = (module, over = {}) => authz.authorizeEventModule(module, {
  grant: 'grant' in over ? over.grant : grant(),
  config: 'config' in over ? over.config : VIEWER_CONFIG,
  enrollment: 'enrollment' in over ? over.enrollment : ENROLLMENT,
})
const outcomeFor = (attributeSet) => ({
  attendees: authorize('attendees', { grant: grant({ attributes: attributeSet }) }).outcome,
  registration: authorize('registration', { grant: grant({ attributes: attributeSet }) }).outcome,
  prizes: authorize('prizes', { grant: grant({ attributes: attributeSet }) }).outcome,
})

check('2. an attendees-only device opens /attendees',
  authorize('attendees'), { outcome: 'authorized', source: 'device-online' })
check('3. and may NOT open /badge-registration',
  outcomeFor(['attendees']).registration, 'unavailable')
check('4. and may NOT open /prizes',
  authorize('prizes', { grant: grant({ attributes: ['attendees'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('5. a registration-only device may NOT open /attendees',
  authorize('attendees', { grant: grant({ attributes: ['registration'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('6. a prizes-only device may NOT open /attendees',
  authorize('attendees', { grant: grant({ attributes: ['prizes'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
/**
 * 7. THE WHOLE MATRIX, as one table. `prizes` does not imply `attendees` and
 * `registration` does not either: the prize desk lists attendees as part of
 * awarding a prize, while browsing the whole register is separately granted.
 *
 * `registration` additionally needs badge ownership, which this viewer
 * browser has none of — so it is `unavailable` wherever it appears here, and
 * that is the Registration rule rather than an attribute problem.
 */
check('7. mixed permissions are INDEPENDENT',
  [outcomeFor([]), outcomeFor(['attendees']), outcomeFor(['prizes']),
   outcomeFor(['prizes', 'attendees']), outcomeFor(['registration', 'attendees']),
   outcomeFor(['registration', 'prizes', 'attendees'])],
  [{ attendees: 'unavailable', registration: 'unavailable', prizes: 'unavailable' },
   { attendees: 'authorized', registration: 'unavailable', prizes: 'unavailable' },
   { attendees: 'unavailable', registration: 'unavailable', prizes: 'authorized' },
   { attendees: 'authorized', registration: 'unavailable', prizes: 'authorized' },
   { attendees: 'authorized', registration: 'unavailable', prizes: 'unavailable' },
   { attendees: 'authorized', registration: 'unavailable', prizes: 'authorized' }])
/**
 * 13-14 ARE THE DECISIVE ONES. A viewer owns no badge range, holds no central
 * binding and has no local range. If the directory consulted badge ownership
 * it would block on `binding-missing` for a range it was never meant to have.
 */
check('13-14. a viewer needs no badge range, binding or local range',
  [authorize('attendees'),
   authorize('attendees', { config: { ...VIEWER_CONFIG, badgeEnd: undefined } }),
   authorize('attendees', { grant: grant({ activeBadgeRange: null }) })],
  [{ outcome: 'authorized', source: 'device-online' },
   { outcome: 'authorized', source: 'device-online' },
   { outcome: 'authorized', source: 'device-online' }])
check('  but it still needs a grant, the right event and a converged identity',
  [authorize('attendees', { grant: null }).gap,
   authorize('attendees', { grant: grant({ eventSlug: 'other-event' }) }).gap,
   authorize('attendees', { config: { ...VIEWER_CONFIG, deviceId: OTHER_DEVICE_ID } }).gap,
   authorize('attendees', { enrollment: undefined }).gap],
  ['no-grant', 'event-mismatch', 'identity-convergence-required', 'no-enrollment'])
check('  and an enrollment naming another device still BLOCKS',
  authorize('attendees', { enrollment: { ...ENROLLMENT, deviceId: OTHER_DEVICE_ID } }).outcome,
  'blocked')
check('  an offline lease authorizes it too, like every other module',
  authorize('attendees', { grant: grant({ source: 'device-offline' }) }),
  { outcome: 'authorized', source: 'device-offline' })

/* ================================ 8-12. ENDPOINT AUTHORIZATION ========== */

console.log('\n=== 8-12. GET /api/attendees REFUSES EVERYTHING IT SHOULD ===')
seedCentral()
seedSheet()

check('8. an anonymous caller is refused, and learns nothing',
  await (async () => {
    const response = await get(null)
    const body = await response.json()
    return [response.status, body.authenticated ?? null, 'attendees' in body]
  })(), [401, false, false])
/**
 * 9. The realms are CRYPTOGRAPHICALLY separate: an Admin token signed with
 * the SAME secret is still rejected, because each realm signs a different
 * domain-separated message.
 */
process.env.EVENT_ADMIN_SESSION_SECRET = SECRET
check('9. an Admin cookie authorizes nothing here',
  await (async () => {
    const adminToken = adminSession.createAdminSessionToken(SECRET)
    const asDevice = await get(`__Host-navaratri_device_session=${adminToken}`)
    const asAdmin = await get(`__Host-navaratri_admin_session=${adminToken}`)
    return [asDevice.status, asAdmin.status,
      /admin-auth|adminSession|readAdminSessionCookie|__Host-navaratri_admin_session/
        .test(stripComments(read('api/attendees.ts')))]
  })(), [401, 401, false])

seedCentral({ device: { enabled: false } })
check('10. a DISABLED device is refused', (await get()).status, 401)

seedCentral({ event: { active: false } })
check('11. an INACTIVE event is refused', (await get()).status, 401)

seedCentral()
check('12. a stale session_version is refused', (await get(deviceCookie(1))).status, 401)
check('  an unprovisioned device is refused',
  await (async () => {
    seedCentral({ device: { passwordHash: null } })
    return (await get()).status
  })(), 401)

seedCentral({ attributes: ['registration', 'prizes'] })
check('  a device with registration AND prizes but not attendees is refused',
  await (async () => {
    const response = await get()
    const body = await response.json()
    return [response.status, body.blocked, 'attendees' in body]
  })(), [403, 'attendees-required', false])
check('  and the attribute comes from CURRENT Postgres, never the token',
  /device\.attributes\.includes\(ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE\)/
    .test(stripComments(read('api/attendees.ts'))), true)

/* ============================= 15-20. THE ROSTER AND THE BOUNDARY ======= */

console.log('\n=== 15-20. WHAT THE DIRECTORY RETURNS, AND WHAT IT NEVER DOES ===')
seedCentral()
seedSheet()
let response = await get()
const rawBody = await response.text()
let body = JSON.parse(rawBody)

check('15. GET returns the Badge Register roster',
  [response.status, body.ok, body.attendees.length], [200, true, 5])
check('16. badge-ascending, from an unsorted Sheet',
  badgesIn(body.attendees), [9001, 9002, 9003, 9004, 9005])
check('  read from the application-owned range only, and mutating nothing',
  [fakeSheets.state.reads, fakeSheets.state.mutations],
  [[sheetContract.BADGE_REGISTER_RANGE], []])
check('17. no phone number is ever returned',
  ATTENDEES.some((attendee) => rawBody.includes(PHONE_OF(attendee.badge))), false)
check('18. no WhatsApp link is ever returned',
  /wa\.me|whatsapp|HYPERLINK/i.test(rawBody), false)
check('19-20. no payment method and no amount',
  [/upi|cash/i.test(rawBody), /"amount"|₹|\bINR\b/i.test(rawBody)], [false, false])
check('  an entry carries EXACTLY the four allowed fields',
  [...new Set(body.attendees.flatMap((entry) => Object.keys(entry)))].sort(),
  ['age', 'badgeNumber', 'gender', 'name'])
check('  no registration id, device id or timestamp rides along either',
  [/a1-fixture/.test(rawBody), /registrationId|deviceId|updatedAt|completedAt/.test(rawBody)],
  [false, false])
check('  gender is the NORMALISED value, not the Sheet label',
  [...new Set(body.attendees.map((entry) => entry.gender))].sort(), ['female', 'male'])
check('  and the response carries the list and nothing else',
  Object.keys(body).sort(), ['attendees', 'ok'])
check('  a row with no Registration ID is not an attendee',
  await (async () => {
    seedSheet()
    fakeSheets.state.values.push(['', '', '', '', '', '', '', '', '', '', '', '', '', ''])
    fakeSheets.state.values.push([9099, 'No Id', '9000000099', '', 20, 'Male', 'UPI', 20, 'd', 't', '', '', '', ''])
    return badgesIn((await directory()).attendees)
  })(), [9001, 9002, 9003, 9004, 9005])

/* ====================================== 21-30. FILTERS, CLIENT-SIDE ===== */

console.log('\n=== 21-30. SEARCH, AGE AND GENDER ===')
seedSheet()
const ROSTER = (await directory()).attendees
const filtered = (over) =>
  badgesIn(filters.filterAttendees(ROSTER, { ...filters.EMPTY_ATTENDEE_FILTERS, ...over }))

check('21. search by badge number works, padded or not',
  [filtered({ search: '9005' }), filtered({ search: '#9005' }), filtered({ search: '900' })],
  [[9005], [9005], [9001, 9002, 9003, 9004, 9005]])
check('22. search by name works, case-insensitively',
  [filtered({ search: 'Meera' }), filtered({ search: 'meera' }), filtered({ search: 'Test 02' })],
  [[9005], [9005], [9002]])
check('23. a minimum age works', filtered({ minAge: '15' }), [9002, 9003, 9004])
check('24. a maximum age works', filtered({ maxAge: '14' }), [9001, 9005])
check('25. minimum and maximum compose',
  [filtered({ minAge: '11', maxAge: '15' }), filtered({ minAge: '8', maxAge: '10' })],
  [[9002, 9003, 9005], []])
check('  an empty bound is NOT zero',
  [filtered({ minAge: '' }), filtered({ maxAge: '' })],
  [[9001, 9002, 9003, 9004, 9005], [9001, 9002, 9003, 9004, 9005]])
check('26. the gender filter works',
  [filtered({ gender: 'female' }), filtered({ gender: 'male' }), filtered({ gender: 'all' })],
  [[9001, 9003, 9005], [9002, 9004], [9001, 9002, 9003, 9004, 9005]])
check('27. age and gender compose',
  filtered({ gender: 'female', minAge: '10', maxAge: '20' }), [9003, 9005])
check('28. search, age and gender all compose',
  [filtered({ search: 'Prize', gender: 'female', minAge: '10' }),
   filtered({ search: 'meera', gender: 'male' }),
   filtered({ search: '9005', minAge: '10', maxAge: '16', gender: 'female' })],
  [[9003], [], [9005]])
check('29. Clear filters restores the full roster',
  [filters.hasActiveAttendeeFilters({ ...filters.EMPTY_ATTENDEE_FILTERS, search: 'x' }),
   filters.hasActiveAttendeeFilters({ ...filters.EMPTY_ATTENDEE_FILTERS, gender: 'male' }),
   filters.hasActiveAttendeeFilters(filters.EMPTY_ATTENDEE_FILTERS),
   filtered({})],
  [true, true, false, [9001, 9002, 9003, 9004, 9005]])
/**
 * 30. AN INVALID RANGE IS REPORTED, NOT ANSWERED WITH AN EMPTY LIST. Quietly
 * returning nothing for `min 20, max 10` would read as "nobody is
 * registered", which is the one answer that must never be guessed at.
 */
check('30. an invalid age range is reported and filters NOTHING',
  [filters.parseAgeBounds({ minAge: '20', maxAge: '10' }).ok,
   filters.parseAgeBounds({ minAge: '20', maxAge: '10' }).message.length > 0,
   filtered({ minAge: '20', maxAge: '10' })],
  [false, true, [9001, 9002, 9003, 9004, 9005]])
check('  non-numeric and out-of-range entries are refused the same way',
  [filters.parseAgeBounds({ minAge: 'x', maxAge: '' }).ok,
   filters.parseAgeBounds({ minAge: '', maxAge: '121' }).ok,
   filters.parseAgeBounds({ minAge: '0', maxAge: '120' }).ok,
   filters.parseAgeBounds({ minAge: '', maxAge: '' })],
  [false, false, true, { ok: true, min: null, max: null }])
check('  and the filter control renders the message rather than an empty grid',
  (() => {
    const control = read('src/components/attendees/attendee-filters.tsx')
    return [/ageError === null \? null :/.test(control),
      /aria-invalid=\{ageError !== null\}/.test(control)]
  })(), [true, true])

/* ============================ 31-32. EMPTY IS NOT UNREADABLE =========== */

console.log('\n=== 31-32. AN EMPTY REGISTER AND AN UNREADABLE ONE ===')
seedCentral()
fakeSheets.reset()
// A real, initialised, EMPTY Badge Register: the header row and nothing else.
fakeSheets.state.values = [[...sheetContract.BADGE_REGISTER_HEADERS]]
check('31. a genuinely empty register is a 200 with no attendees',
  await (async () => {
    const empty = await get()
    const emptyBody = await empty.json()
    return [empty.status, emptyBody.ok, emptyBody.attendees]
  })(), [200, true, []])
check('  and the page renders the empty state for it, not an error',
  (() => {
    const source = read('src/components/attendees/attendee-directory.tsx')
    const branch = source.slice(source.indexOf('directory.attendees.length === 0'))
    return [branch.slice(0, 400).includes('No attendees have been registered yet.'),
      source.includes('`Attendees (${String(directory.attendees.length)})`')]
  })(), [true, true])

seedSheet()
fakeSheets.state.failNextRead = true
check('32. an UNREADABLE register is a 503, never an empty roster',
  await (async () => {
    const refused = await get()
    const refusedBody = await refused.json()
    return [refused.status, refusedBody.reason, 'attendees' in refusedBody]
  })(), [503, 'register-unavailable', false])
check('  a CONFLICTING Sheet layout fails closed too',
  await (async () => {
    fakeSheets.reset()
    fakeSheets.state.values = [['Something', 'Else'], ['x', 'y']]
    const refused = await get()
    return [refused.status, (await refused.json()).reason]
  })(), [503, 'register-unavailable'])
check('  a Sheet that is wholly blank fails closed as well',
  await (async () => {
    fakeSheets.reset()
    fakeSheets.state.values = []
    const refused = await get()
    return [refused.status, (await refused.json()).reason]
  })(), [503, 'register-unavailable'])
check('  and an unconfigured release interlock does the same',
  await (async () => {
    seedSheet()
    process.env.SYNC_WRITE_ENABLED = 'false'
    const refused = await get()
    process.env.SYNC_WRITE_ENABLED = 'true'
    return [refused.status, (await refused.json()).reason]
  })(), [503, 'register-unavailable'])
/**
 * AND THE BROWSER KEEPS THEM APART TOO. The whole point is that a volunteer
 * reading "No attendees have been registered yet" can believe it, so the
 * client maps a 503 to its own state rather than to an empty list.
 */
check('  the client distinguishes them, by status',
  await (async () => {
    const original = globalThis.fetch
    const reply = (status, payload) => {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), {
        status, headers: { 'content-type': 'application/json' },
      })
    }

    reply(200, { ok: true, attendees: [] })
    const empty = await client.fetchAttendeeDirectory()

    reply(503, { ok: false, reason: 'register-unavailable' })
    const unreadable = await client.fetchAttendeeDirectory()

    reply(200, { ok: true, attendees: [{ badgeNumber: 1, name: 'A', age: 9, gender: 'x' }] })
    const malformed = await client.fetchAttendeeDirectory()

    globalThis.fetch = original

    return [empty.status, empty.attendees, unreadable.status, malformed.status]
  })(), ['loaded', [], 'register-unavailable', 'unexpected'])

/* ============================ 33-35. THERE IS NO MUTATION ============== */

console.log('\n=== 33-35. READ-ONLY, AND STRUCTURALLY SO ===')
seedCentral()
seedSheet()

/**
 * AWAITED, and read defensively.
 *
 * A canary that turned `POST` into a real async handler made these CRASH
 * rather than fail — `refused.headers` was undefined on a Promise — and a
 * crash aborts the suite and hides every assertion below it. `await` accepts
 * either shape, and a missing header reads as `null` and fails its assertion.
 */
const refuse = async (method) => {
  const response = await endpoint[method](request(method))

  return [response?.status ?? null, response?.headers?.get('allow') ?? null]
}

check('33. POST returns 405 with Allow: GET',
  await (async () => {
    const response = await endpoint.POST(request('POST'))
    return [...(await refuse('POST')), (await response.json()).ok]
  })(), [405, 'GET', false])
check('34. PUT, PATCH and DELETE return 405 with Allow: GET',
  await (async () => {
    const outcomes = {}
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      outcomes[method] = await refuse(method)
    }
    return outcomes
  })(), { PUT: [405, 'GET'], PATCH: [405, 'GET'], DELETE: [405, 'GET'] })
check('  a refusal is never cached',
  (await endpoint.POST(request('POST')))?.headers?.get('cache-control') ?? null, 'no-store')
/**
 * And every refusal is the SAME handler, so one cannot be quietly turned into
 * a writer while the others still answer 405.
 */
check('  all four refusals go through the one helper',
  ['POST', 'PUT', 'PATCH', 'DELETE'].filter((method) => {
    const source = stripComments(read('api/attendees.ts'))
    const start = source.indexOf(`export function ${method}(): Response {`)
    return start === -1 ||
      !source.slice(start, source.indexOf('}', start)).includes('methodNotAllowed()')
  }), [])
check('  and only GET is a real handler',
  [...stripComments(read('api/attendees.ts')).matchAll(/export (?:async )?function ([A-Z]+)\(/g)]
    .map((match) => match[1]), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
/**
 * 35. NO MUTATION CODE EXISTS. Not "is not called" — is not PRESENT. The
 * endpoint opens no database client, imports no writer, reads no body and
 * issues no Sheet mutation, so there is nothing for a later edit to reach
 * for.
 */
check('35. the endpoint cannot write, because it holds nothing that could',
  ['getDatabase', 'readDeviceBody', 'batchUpdate', 'prizeAwards', 'recordPrizeAward',
   'drizzle', '.insert(', '.update(', '.delete(', 'values.update']
    .filter((capability) => stripComments(read('api/attendees.ts')).includes(capability)), [])
check('  the shared reader is strictly read-only on the Sheet',
  (() => {
    const reader = stripComments(read('server/attendees/register.ts'))
    return [/\.values\.get\(/.test(reader),
      /batchUpdate|addSheet|appendCells|deleteDimension|updateCells/.test(reader)]
  })(), [true, false])
check('  the browser module sends only GET, with no body',
  await (async () => {
    const original = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', hasBody: 'body' in (init ?? {}) })
      return new Response(JSON.stringify({ ok: true, attendees: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    await client.fetchAttendeeDirectory()
    globalThis.fetch = original
    return calls
  })(), [{ url: '/api/attendees', method: 'GET', hasBody: false }])
check('  and no attendee module in the browser can ask for a mutation',
  (() => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        const code = stripComments(read(next))
        if (/method: '(POST|PUT|PATCH|DELETE)'|onSubmit|<form/.test(code)) found.push(next)
      }
    }
    walk('src/attendees')
    walk('src/components/attendees')
    return found
  })(), [])
check('  and the read-only card takes ONE prop and offers no control',
  (() => {
    const card = stripComments(read('src/components/attendees/attendee-card.tsx'))
    return [/interface AttendeeCardProps \{\s*attendee: EventAttendee\s*\}/.test(card),
      /onClick|onSubmit|Button|disabled|<form/.test(card)]
  })(), [true, false])

/* ============================== 36. OFFLINE SHOWS NO ROSTER ============ */

console.log('\n=== 36. OFFLINE, THE DIRECTORY SHOWS NOTHING ===')
const { renderRoute, setDeviceGrant, clearDeviceGrant, setNetworkStatus } =
  await import('./route-render.mjs')
const DEVICE_STATE = {
  config: VIEWER_CONFIG, enrollment: ENROLLMENT, deviceName: 'Attendee Viewer Test',
}

setDeviceGrant(grant(), DEVICE_STATE)
setNetworkStatus('offline')
let page = renderRoute('/attendees', VIEWER_CONFIG)
check('36. offline it says so, and exposes no attendee at all',
  [page.html.includes('Attendees requires an internet connection.'),
   ATTENDEES.some((attendee) => page.html.includes(attendee.name)),
   page.html.includes('Attendees (') , page.html.includes('Refresh'),
   page.html.includes('Search')],
  [true, false, false, false, false])
check('  and nothing was ever stored to show',
  (() => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (/@\/db\/database|from 'dexie'|localStorage|sessionStorage|caches\.|indexedDB/
          .test(stripComments(read(next)))) found.push(next)
      }
    }
    walk('src/attendees')
    walk('src/components/attendees')
    return [...found, ...(/@\/db\/database|localStorage/.test(read('src/pages/attendees-page.tsx'))
      ? ['src/pages/attendees-page.tsx'] : [])]
  })(), [])
check('  and it never polls or retries on a timer',
  (() => {
    const api = stripComments(read('src/attendees/attendee-api.ts'))
    const page_ = stripComments(read('src/components/attendees/attendee-directory.tsx'))
    return [/setInterval/.test(api + page_),
      [...api.matchAll(/setTimeout\(/g)].length,
      [...page_.matchAll(/setTimeout\(/g)].length,
      /controller\.abort\(\)/.test(api)]
  })(), [false, 1, 0, true])
setNetworkStatus('online')

/* ============================== THE ROUTE AND THE PAGE ================= */

console.log('\n=== THE ROUTE, RENDERED FOR REAL ===')
clearDeviceGrant()
check('an unauthorized browser never reaches the directory',
  (() => {
    const refused = renderRoute('/attendees', VIEWER_CONFIG)
    return [refused.html.includes('Device access required'), refused.html.includes('ATTENDEES')]
  })(), [true, false])

for (const [label, attributeSet] of [['a registration-only', ['registration']],
  ['a prizes-only', ['prizes']]]) {
  setDeviceGrant(grant({ attributes: attributeSet }), DEVICE_STATE)
  check(`${label} device is refused at the route`,
    [renderRoute('/attendees', VIEWER_CONFIG).html.includes('Not available on this device'),
     renderRoute('/attendees', VIEWER_CONFIG).html.includes('Read-only event attendee directory.')],
    [true, false])
}

setDeviceGrant(grant(), DEVICE_STATE)
page = renderRoute('/attendees', VIEWER_CONFIG)
check('an attendees device opens the directory',
  [page.error ?? null, page.html.includes('Attendees'),
   page.html.includes('Read-only event attendee directory.'),
   page.html.includes('Attendee Viewer Test')],
  [null, true, true, true])
check('  and it reports no badge state, which a viewer does not own',
  /Badges #|badgeStart|Next badge|Give Prize/.test(page.html), false)
check('  a viewer cannot open the other two modules',
  [renderRoute('/badge-registration', VIEWER_CONFIG).html.includes('__REGISTRATION_FORM__'),
   renderRoute('/prizes', VIEWER_CONFIG).html.includes('Give Prize')],
  [false, false])

/**
 * HOME IS ATTRIBUTE-AWARE, and it is NOT the security boundary. The order is
 * the one the phase asked for, and an ungranted module is inert rather than
 * absent: a volunteer who cannot open Prizes should see why.
 */
const homeFor = (attributeSet) => {
  setDeviceGrant(grant({ attributes: attributeSet }), DEVICE_STATE)

  return renderRoute('/', VIEWER_CONFIG).html
}
const moduleLinks = (html) =>
  [...html.matchAll(/href="(\/[a-z-]*)"[^>]*class="[^"]*group\/module/g)]
    .map((match) => match[1])
const cardOrder = (html) =>
  [...html.matchAll(/<h2 class="[^"]*">([^<]+)<\/h2>/g)].map((match) => match[1].trim())

// RE-SCOPED BY PHASE D3: Dandiya is a real module now, so a viewer sees three
// ungranted cards and no `Coming soon` at all.
check('Home offers Attendees to a viewer, and nothing else',
  [moduleLinks(homeFor(['attendees'])),
   (homeFor(['attendees']).match(/Not on this device/g) ?? []).length,
   (homeFor(['attendees']).match(/Coming soon/g) ?? []).length],
  [['/attendees'], 3, 0])
check('  the card order is Badge Registration, Attendees, Prizes, Dandiya',
  cardOrder(homeFor(['attendees'])),
  ['Badge Registration', 'Attendees', 'Prizes', 'Dandiya'])
check('  each attribute offers only its own module',
  [moduleLinks(homeFor(['registration'])), moduleLinks(homeFor(['prizes'])),
   moduleLinks(homeFor(['prizes', 'attendees'])),
   moduleLinks(homeFor(['registration', 'prizes', 'attendees']))],
  [['/badge-registration'], ['/prizes'], ['/attendees', '/prizes'],
   ['/badge-registration', '/attendees', '/prizes']])
check('  and the card is NOT the boundary: the route refuses anyway',
  (() => {
    setDeviceGrant(grant({ attributes: ['prizes'] }), DEVICE_STATE)
    const refused = renderRoute('/attendees', VIEWER_CONFIG).html
    return [refused.includes('Read-only event attendee directory.'),
      refused.includes('Not available on this device')]
  })(), [false, true])
setDeviceGrant(grant(), DEVICE_STATE)

console.log('\n=== THE CARDS AND CONTROLS, RENDERED ===')
const uiJiti = createJiti(import.meta.url, {
  alias: { '@': `${root}/src` },
  interopDefault: true,
  jsx: { runtime: 'automatic' },
})
const React = await uiJiti.import('react')
const { renderToStaticMarkup } = await uiJiti.import('react-dom/server')
const renderUi = async (modulePath, props) => {
  const imported = await uiJiti.import(`${root}/${modulePath}`)
  const Component = imported.default ?? imported

  return renderToStaticMarkup(React.createElement(Component, props))
}
const noop = () => undefined

const card = await renderUi('src/components/attendees/attendee-card.tsx', {
  attendee: { badgeNumber: 9005, name: 'Meera', age: 11, gender: 'female' },
})
check('a card shows the badge, the name and the age and gender',
  [card.includes('#9005'), card.includes('Meera'), card.includes('Age 11 · Female')],
  [true, true, true])
check('  and NOTHING else: no action, no contact detail, no prize state',
  ['Give Prize', 'Award', 'Edit', 'Delete', 'Remove', '<button', 'wa.me', '9000000005',
   'UPI', 'Cash', 'prize', 'a1-fixture']
    .filter((needle) => card.toLowerCase().includes(needle.toLowerCase())), [])

const controls = await renderUi('src/components/attendees/attendee-filters.tsx', {
  state: filters.EMPTY_ATTENDEE_FILTERS, resultCount: 45, totalCount: 45,
  onChange: noop, onClear: noop,
})
check('the filter controls are search, an age window and gender',
  [controls.includes('Badge number or name'), controls.includes('Min'),
   controls.includes('Max'), ['All', 'Male', 'Female']
     .every((label) => controls.includes(label)), controls.includes('45 attendees')],
  [true, true, true, true, true])
check('  Clear filters appears only when something is active',
  await (async () => {
    const active = await renderUi('src/components/attendees/attendee-filters.tsx', {
      state: { ...filters.EMPTY_ATTENDEE_FILTERS, search: '9005' },
      resultCount: 1, totalCount: 45, onChange: noop, onClear: noop,
    })
    return [controls.includes('Clear filters'), active.includes('Clear filters'),
      active.includes('1 of 45 attendees')]
  })(), [false, true, true])
check('  and an invalid age window renders its message',
  await (async () => {
    const invalid = await renderUi('src/components/attendees/attendee-filters.tsx', {
      state: { ...filters.EMPTY_ATTENDEE_FILTERS, minAge: '20', maxAge: '10' },
      resultCount: 45, totalCount: 45, onChange: noop, onClear: noop,
    })
    return [invalid.includes('The minimum age must not be above the maximum.'),
      invalid.includes('aria-invalid="true"')]
  })(), [true, true])

/* ======================= SHARED REUSE, NOT DUPLICATION ================= */

console.log('\n=== ONE READER, ONE SET OF FILTERS ===')
/**
 * The phase asked for reuse rather than a second implementation, and the way
 * to keep that true is to pin the COUNT of implementations rather than to
 * read the new one and hope.
 */
const registerReaders = (() => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) { walk(next); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (/BADGE_REGISTER_COLUMNS/.test(stripComments(read(next)))) found.push(next)
    }
  }
  for (const directory of ['api', 'server', 'src']) walk(directory)
  return found.sort()
})()

check('there is ONE Badge Register parser outside the sync module',
  registerReaders.filter((path) => !path.startsWith('server/sync/')),
  ['server/attendees/register.ts'])
check('  and both Functions go through it',
  ['api/attendees.ts', 'api/prizes.ts']
    .filter((path) => !/readAttendeeRegister/.test(read(path))), [])
check('  the old prize-only reader is gone, not left as a duplicate',
  existsSync(join(root, 'server/prizes/roster.ts')), false)
check('there is ONE attendee filter implementation',
  (() => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.ts$/.test(entry.name)) continue
        if (/export const filterAttendees|export const parseAgeBounds/
          .test(read(next))) found.push(next)
      }
    }
    walk('src')
    return found
  })(), ['src/attendees/attendee-filters.ts'])
check('  and the prize desk uses it rather than its own',
  [/@\/attendees\/attendee-filters/.test(read('src/components/prizes/prize-desk.tsx')),
   /filterAttendees|parseAgeBounds/.test(read('src/prizes/prize-filters.ts'))],
  [true, false])
check('there is ONE attendee shape and ONE parser for it',
  (() => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        const code = stripComments(read(next))
        if (/badgeNumber: number[\s\S]{0,80}name: string[\s\S]{0,80}age: number/.test(code)) {
          found.push(next)
        }
      }
    }
    for (const directory of ['api', 'server', 'src']) walk(directory)
    return found
  })(), ['src/shared/attendee-contract.ts'])
check('  the prize contract ALIASES it rather than redeclaring it',
  [/export type PrizeAttendee = EventAttendee/.test(read('src/shared/prize-contract.ts')),
   /export type PrizeGender = AttendeeGender/.test(read('src/shared/prize-contract.ts'))],
  [true, true])
check('  and the shared contract declares no contact or payment field',
  ['phone', 'whatsapp', 'wa.me', 'payment', 'amount', 'upi', 'registrationId']
    .filter((field) => stripComments(read('src/shared/attendee-contract.ts'))
      .toLowerCase().includes(field.toLowerCase())), [])

/* ============== 37-43. NOTHING ELSE MOVED, AND THE BUDGET ============== */

console.log('\n=== 37-43. NOTHING ELSE MOVED ===')
const dexie = read('src/db/database.ts')
check('37. IndexedDB version unchanged (1)', /DATABASE_VERSION = 1\b/.test(dexie), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((entry) => entry.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
/**
 * 38. A1 NEEDED NO MIGRATION, and still does not.
 *
 * RE-SCOPED BY PHASE D3, which legitimately took the next migration number.
 * Counting files cannot express A1's concern any more, so the concern is
 * stated directly: the attribute column is already text, and no migration
 * anywhere creates an attendee table or an attendee column.
 */
const everyMigration = readdirSync(join(root, 'drizzle'))
  .filter((file) => file.endsWith('.sql'))
  .map((file) => read(`drizzle/${file}`))
  .join('\n')

check('38. no migration was needed: the attribute column is already text',
  [/attribute: text\('attribute'\)/.test(read('server/db/schema.ts')),
   /pgEnum/.test(read('server/db/schema.ts'))], [true, false])
check('  and nothing anywhere created an attendee table or column',
  [/CREATE TABLE "attendee/i.test(everyMigration),
   ['attendee_name', 'attendee_phone', 'whatsapp']
     .filter((column) => everyMigration.includes(column)),
   /attendees = pgTable/.test(read('server/db/schema.ts'))],
  [false, [], false])

console.log('  -- 39-40. the prize module is untouched --')
seedCentral({ attributes: ['prizes', 'attendees'] })
seedSheet()
check('39. GET /api/prizes still works',
  await (async () => {
    const prizes = await prizeEndpoint.GET(new Request(`${ORIGIN}/api/prizes`, {
      method: 'GET', headers: { cookie: deviceCookie() },
    }))
    const prizeBody = await prizes.json()
    return [prizes.status, prizeBody.attendees.length, Array.isArray(prizeBody.awards)]
  })(), [200, 5, true])
check('40. a repeat award still succeeds, twice, with the same prize',
  await (async () => {
    const award = async (prizeName) => {
      const response = await prizeEndpoint.POST(new Request(`${ORIGIN}/api/prizes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: deviceCookie() },
        body: JSON.stringify({ badgeNumber: 9005, prizeName }),
      }))
      return response.status
    }
    const first = await award('Best Dance - Girl')
    const second = await award('Best Dress - Girl')
    const third = await award('Best Dance - Girl')
    return [first, second, third, fakeDb.state.prizeAwards.length]
  })(), [201, 201, 201, 3])
check('  and the awarded attendee is still in the prize attendee list',
  await (async () => {
    const prizes = await prizeEndpoint.GET(new Request(`${ORIGIN}/api/prizes`, {
      method: 'GET', headers: { cookie: deviceCookie() },
    }))
    const prizeBody = await prizes.json()
    return [prizeBody.attendees.length,
      badgesIn(prizeBody.attendees).includes(9005), prizeBody.awards.length]
  })(), [5, true, 3])
check('  the prize ledger row still holds no attendee data',
  Object.keys(fakeDb.state.prizeAwards[0] ?? {}).sort(),
  ['awardedAt', 'awardedByDeviceId', 'badgeNumber', 'eventId', 'id', 'prizeName'])
check('  and the eight-prize catalog is unchanged',
  (() => {
    const contract = read('src/shared/prize-contract.ts')
    return [...contract.matchAll(/label: '([^']+)'/g)].map((match) => match[1])
  })(),
  ['Best Dance - Boy', 'Best Dance - Girl', 'Best Dance - Male', 'Best Dance - Female',
   'Best Dress - Boy', 'Best Dress - Girl', 'Best Dress - Male', 'Best Dress - Female'])

check('41. the D2, D2.1 and P1 suites still exist and still run in `verify`',
  (() => {
    const pkg = JSON.parse(read('package.json'))
    return [['phase-d2', 'phase-d21', 'phase-p1', 'phase-a1']
      .filter((suite) => !existsSync(join(root, `scripts/verification/${suite}.mjs`))),
    ['verify:d2 ', 'verify:d21', 'verify:p1', 'verify:a1']
      .filter((script) => !pkg.scripts.verify.includes(script)),
    pkg.scripts['verify:a1']]
  })(), [[], [], 'node scripts/verification/phase-a1.mjs'])
check('  and A1 touched no registration, badge or sync module',
  ['src/db/registrations.ts', 'src/db/device.ts', 'src/db/central-badge-range.ts',
   'src/db/device-identity-convergence.ts', 'api/sync-registration.ts',
   'api/device-badge-claim.ts', 'server/badge-assignments/reserve.ts']
    .filter((path) => /attendee-api|attendees\/|ATTENDEE_DIRECTORY/.test(read(path))), [])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
console.log(`  Vercel Functions: ${String(budget.actual.length)} / ${String(functionChecker.HOBBY_FUNCTION_LIMIT)}` +
  `   Headroom: ${String(functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length)}`)
check('42. the Function inventory is exactly eleven', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'attendees', 'dandiya', 'device-auth', 'device-badge-claim',
  'prizes', 'sync-registration',
])
check('  with one slot of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 1)
check('  the directory is ONE Function, and no helper joined it',
  [readdirSync(join(root, 'api')).filter((file) => /attendee/.test(file)),
   readdirSync(join(root, 'api'))
     .filter((file) => /search|filter|count|roster|directory/.test(file))],
  [['attendees.ts'], []])
check('  and nothing unexpected', budget.problems, [])
/**
 * 43. AUTHENTICATED DEVICE TRAFFIC GETS NO FIREWALL RULE. A rule would
 * throttle a viewer's ordinary reads while protecting nothing: there is no
 * credential to guess at an endpoint that refuses everything without a device
 * session cookie.
 */
const firewall = read('docs/VERCEL_FIREWALL.md')
check('43. /api/attendees has no firewall rule',
  [/\*\*Condition — Path\*\* \| `\/api\/attendees`/.test(firewall),
   /`\/api\/attendees`/.test(firewall)], [false, true])
check('  and the live rule is still the one combined login rule',
  [firewall.includes('/api/admin-auth'), firewall.includes('/api/device-auth'),
   firewall.includes('10')], [true, true, true])

console.log('\n=== DOCUMENTATION ===')
for (const [doc, needles] of [
  ['docs/ATTENDEES.md', ['/attendees', 'attendees', 'read-only', '405',
    'register-unavailable', 'Attendee Viewer Test']],
  ['AGENTS.md', ['Attendee Directory', 'attendees']],
  ['README.md', ['/attendees']],
  ['docs/PRODUCTION_RELEASE_CHECKLIST.md', ['/api/attendees']],
  ['docs/ADMIN.md', ['Attendees']],
  ['docs/VERCEL_FIREWALL.md', ['/api/attendees']],
]) {
  check(`${doc} documents this phase`,
    needles.filter((needle) => !read(doc).includes(needle)), [])
}
check('release:check guards the directory',
  ['attendee-directory', "'attendees.ts'", 'ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE',
   'parses the Badge Register itself']
    .filter((needle) => !read('scripts/release-check.mjs').includes(needle)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${String(fails)} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
