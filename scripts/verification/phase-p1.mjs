/**
 * Phase P1 / P1.1 verification — prize distribution with repeat prizes.
 *
 * Run with:  pnpm verify:p1
 *
 * It NEVER connects to Neon, Google or any network. The REAL endpoint, the
 * REAL ledger writer, the REAL roster reader, the REAL composer, the REAL
 * filters, the REAL catalog, the REAL route policy and the REAL prize chooser
 * and warning all run; only Postgres, the Sheets API, HTTP and the dialog's
 * portal are stood in for.
 *
 * P1.1 INVERTED THE CENTRAL PRODUCT RULE. P1 proved that a second prize for
 * one badge was REFUSED; the event rule is now that it is allowed, so those
 * assertions are rewritten rather than deleted — the same situations, with
 * the opposite expected outcome, which is the only honest way to record a
 * deliberate reversal.
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

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '22222222-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const ORIGIN = 'https://desk.example.test'
const AWARDED_AT = '2026-10-10T12:30:00.000Z'

/** The eight canonical prizes, written out so a changed label fails here. */
const CATALOG = [
  'Best Dance - Boy', 'Best Dance - Girl', 'Best Dance - Male', 'Best Dance - Female',
  'Best Dress - Boy', 'Best Dress - Girl', 'Best Dress - Male', 'Best Dress - Female',
]

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

const SECRET = 'p'.repeat(48)
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
const endpoint = await serverJiti.import(`${root}/api/prizes.ts`)
const eligibility = await serverJiti.import(`${root}/server/prizes/eligibility.ts`)
const sheetContract = await serverJiti.import(`${root}/server/sync/sheet-contract.ts`)
const password = await serverJiti.import(`${root}/server/device-auth/password.ts`)
const contract = await serverJiti.import(`${root}/src/shared/prize-contract.ts`)
const fakeDb = await import('./fake-admin-db.mjs')
const fakeSheets = await import('./fake-sheets.mjs')

const storedHash = await password.hashDevicePassword('prize-passphrase')

/* --------------------------------------------------------------- fixtures */

/**
 * A fixture attendee, built through the REAL Badge Register row builder, so a
 * column that moved would break this suite instead of silently shifting what
 * the roster reads.
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
      id: `prize-test-fixture-${String(attendee.badge)}`,
      status: 'completed',
      paymentStatus: 'confirmed',
      paymentMethod: 'upi',
      badgeNumber: attendee.badge,
      name: attendee.name,
      phone: PHONE_OF(attendee.badge),
      age: attendee.age,
      gender: attendee.gender,
      amount: 20,
      createdAt: AWARDED_AT,
      completedAt: AWARDED_AT,
      updatedAt: AWARDED_AT,
    })
    .map((cell) => cell.value)

const seedSheet = (attendees = ATTENDEES) => {
  fakeSheets.reset()
  fakeSheets.state.values = [
    [...sheetContract.BADGE_REGISTER_HEADERS],
    ...attendees.map(sheetRow),
  ]
}

let seeded = 0

const seedCentral = ({
  attributes = ['prizes'],
  device = {},
  event = {},
  awards = [],
} = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata',
    active: true, endsAt: null, ...event,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Prize Test Desk', loginName: 'prize-test',
    passwordHash: storedHash, sessionVersion: 2, enabled: true, lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), ...device,
  })
  fakeDb.state.devices.set(OTHER_DEVICE_ID, {
    id: OTHER_DEVICE_ID, eventId: EVENT_ID, name: 'Prize Test Desk B',
    loginName: 'prize-test-b', passwordHash: storedHash, sessionVersion: 1,
    enabled: true, lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  fakeDb.state.attributes.push({ deviceId: OTHER_DEVICE_ID, attribute: 'prizes' })
  /**
   * Ids are generated rather than derived from the badge: ONE BADGE MAY NOW
   * HOLD SEVERAL AWARDS, and keying a fixture by badge number would have made
   * the repeat cases impossible to express.
   */
  for (const award of awards) {
    seeded += 1
    fakeDb.state.prizeAwards.push({
      id: `aaaaaaaa-0000-4000-8000-${String(seeded).padStart(12, '0')}`,
      eventId: EVENT_ID,
      badgeNumber: award.badgeNumber,
      prizeName: award.prizeName,
      awardedByDeviceId: award.deviceId ?? DEVICE_ID,
      awardedAt: new Date(award.awardedAt ?? AWARDED_AT),
    })
  }
  fakeDb.state.applied = []
}

const deviceCookie = (sessionVersion = 2) =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion,
  })}`

const get = (cookie = deviceCookie()) =>
  endpoint.GET(new Request(`${ORIGIN}/api/prizes`, {
    method: 'GET',
    headers: { ...(cookie === null ? {} : { cookie }) },
  }))

const post = (body, cookie = deviceCookie()) =>
  endpoint.POST(new Request(`${ORIGIN}/api/prizes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  }))

const badgesIn = (list) => list.map((entry) => entry.badgeNumber)
const roster = async (cookie) => (await get(cookie)).json()

/**
 * Reads a field from a row that MIGHT NOT EXIST.
 *
 * A broken endpoint writes no row, and `prizeAwards[0].prizeName` then throws
 * — which aborts the whole suite and hides every assertion below it. A
 * canary proved that: one regression reported one failure and silently
 * skipped the twenty checks that would also have caught it. A missing row
 * must read as `null` and FAIL its assertion.
 */
const fieldOf = (row, key) => (row === undefined || row === null ? null : row[key] ?? null)
const ledgerField = (index, key) => fieldOf(fakeDb.state.prizeAwards[index], key)

/* ============================= 25-27. POLICY: WHO MAY RUN A PRIZE DESK === */

console.log('=== 25-27. AUTHORIZATION IS UNCHANGED BY P1.1 ===')

const domainJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const authz = await domainJiti.import(`${root}/src/device-auth/event-authorization.ts`)
const filters = await domainJiti.import(`${root}/src/prizes/prize-filters.ts`)

/** A converged browser with NO badge state at all: the prize-desk shape. */
const PRIZE_CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1,
  deviceId: DEVICE_ID, deviceName: 'Prize Test Desk',
  deviceConfiguredAt: '2026-10-01T01:00:00.000Z', updatedAt: 'T',
}
const ENROLLMENT = {
  deviceId: DEVICE_ID, eventId: EVENT_ID, eventSlug: 'navaratri-2026',
  deviceName: 'Prize Test Desk', loginName: 'prize-test',
  attributes: ['prizes'], verifiedAt: 'T',
}
const grant = (over = {}) => ({
  source: 'device-online', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['prizes'],
  activeBadgeRange: null, ...over,
})
const authorize = (module, over = {}) => authz.authorizeEventModule(module, {
  grant: 'grant' in over ? over.grant : grant(),
  config: 'config' in over ? over.config : PRIZE_CONFIG,
  enrollment: 'enrollment' in over ? over.enrollment : ENROLLMENT,
})

check('a prizes device opens /prizes',
  authorize('prizes'), { outcome: 'authorized', source: 'device-online' })
check('26. a REGISTRATION-only device is still refused',
  authorize('prizes', { grant: grant({ attributes: ['registration'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('  and a prizes-only device may not open badge registration',
  authorize('registration').outcome, 'unavailable')
check('  a device with BOTH opens both',
  [authorize('prizes', { grant: grant({ attributes: ['registration', 'prizes'] }) }).outcome,
   authorize('home', { grant: grant({ attributes: ['registration', 'prizes'] }) }).outcome],
  ['authorized', 'authorized'])
/**
 * 27 IS THE DECISIVE ONE. A prize desk owns no badge range, holds no central
 * binding and has no local range. If prizes consulted badge ownership it
 * would block on `binding-missing` for a range it was never meant to have.
 */
check('27. a prizes device still needs no badge range, binding or local range',
  [authorize('prizes'),
   authorize('prizes', { config: { ...PRIZE_CONFIG, badgeEnd: undefined } }),
   authorize('prizes', { grant: grant({ activeBadgeRange: null }) })],
  [{ outcome: 'authorized', source: 'device-online' },
   { outcome: 'authorized', source: 'device-online' },
   { outcome: 'authorized', source: 'device-online' }])
check('  but it still needs a grant, the right event and a converged identity',
  [authorize('prizes', { grant: null }).gap,
   authorize('prizes', { grant: grant({ eventSlug: 'other-event' }) }).gap,
   authorize('prizes', { config: { ...PRIZE_CONFIG, deviceId: OTHER_DEVICE_ID } }).gap,
   authorize('prizes', { enrollment: undefined }).gap],
  ['no-grant', 'event-mismatch', 'identity-convergence-required', 'no-enrollment'])
check('  and an enrollment naming another device still BLOCKS',
  authorize('prizes', { enrollment: { ...ENROLLMENT, deviceId: OTHER_DEVICE_ID } }),
  { outcome: 'blocked', conflict: 'enrollment-device-mismatch', central: null, local: null })

seedCentral()
seedSheet()

check('25. an anonymous caller still cannot read prize data',
  await (async () => {
    const response = await get(null)
    const body = await response.json()
    return [response.status, body.authenticated ?? null, 'attendees' in body, 'awards' in body]
  })(), [401, false, false, false])
check('  nor award',
  await (async () => {
    const response = await post({ badgeNumber: 9001, prizeName: CATALOG[1] }, null)
    return [response.status, fakeDb.state.prizeAwards.length]
  })(), [401, 0])
/**
 * The realms are CRYPTOGRAPHICALLY separate: an Admin token signed with the
 * SAME secret is still rejected, because each realm signs a different
 * domain-separated message.
 */
process.env.EVENT_ADMIN_SESSION_SECRET = SECRET
check('  an Admin cookie authorizes nothing here',
  await (async () => {
    const adminToken = adminSession.createAdminSessionToken(SECRET)
    const asDeviceCookie = await get(`__Host-navaratri_device_session=${adminToken}`)
    const asAdminCookie = await get(`__Host-navaratri_admin_session=${adminToken}`)
    return [asDeviceCookie.status, asAdminCookie.status,
      /admin-auth|adminSession|readAdminSessionCookie|__Host-navaratri_admin_session/
        .test(stripComments(read('api/prizes.ts')))]
  })(), [401, 401, false])

seedCentral({ device: { enabled: false } })
check('  a DISABLED device cannot award, and nothing is written',
  await (async () => {
    const response = await post({ badgeNumber: 9001, prizeName: CATALOG[1] })
    return [response.status, (await get()).status, fakeDb.state.prizeAwards.length]
  })(), [401, 401, 0])

seedCentral({ event: { active: false } })
check('  an INACTIVE event cannot award',
  await (async () => {
    const response = await post({ badgeNumber: 9001, prizeName: CATALOG[1] })
    return [response.status, fakeDb.state.prizeAwards.length]
  })(), [401, 0])

seedCentral({ attributes: ['registration'] })
check('  a device without `prizes` is refused both ways',
  await (async () => {
    const refusedPost = await post({ badgeNumber: 9001, prizeName: CATALOG[1] })
    const postBody = await refusedPost.json()
    const refusedGet = await get()
    const getBody = await refusedGet.json()
    return [refusedPost.status, postBody.blocked, refusedGet.status, getBody.blocked,
      'attendees' in getBody, fakeDb.state.prizeAwards.length]
  })(), [403, 'prizes-required', 403, 'prizes-required', false, 0])
check('  and the attribute comes from CURRENT Postgres, never the token',
  /device\.attributes\.includes\(PRIZE_REQUIRED_ATTRIBUTE\)/
    .test(stripComments(read('api/prizes.ts'))), true)
check('  a stale session_version is refused too',
  await (async () => {
    seedCentral()
    return (await get(deviceCookie(1))).status
  })(), 401)

/* ========================== 1-4. EVERY REGISTERED ATTENDEE IS LISTED ==== */

console.log('\n=== 1-4. THE ATTENDEE LIST NEVER SHRINKS ===')

/**
 * THE CENTRAL REVERSAL OF P1.1, asserted against the live endpoint.
 *
 * One attendee with no prize, one with a single prize, one with three. Under
 * P1 the last two would have been subtracted from the list; the event rule is
 * now that a previous prize disqualifies nobody, so all five stay.
 */
seedCentral({
  awards: [
    { badgeNumber: 9002, prizeName: 'Best Dress - Boy' },
    { badgeNumber: 9005, prizeName: 'Best Dance - Girl', awardedAt: '2026-10-10T12:10:00.000Z' },
    { badgeNumber: 9005, prizeName: 'Best Dress - Girl', awardedAt: '2026-10-10T12:20:00.000Z' },
    { badgeNumber: 9005, prizeName: 'Best Dance - Girl', awardedAt: '2026-10-10T12:30:00.000Z' },
  ],
})
seedSheet()
let body = await roster()

check('1. every registered attendee appears, badge-ascending',
  [body.attendees.length, badgesIn(body.attendees)],
  [5, [9001, 9002, 9003, 9004, 9005]])
check('2. an attendee with ZERO awards appears',
  badgesIn(body.attendees).includes(9001), true)
check('3. an attendee with ONE award still appears',
  badgesIn(body.attendees).includes(9002), true)
check('4. an attendee with THREE awards still appears',
  [badgesIn(body.attendees).includes(9005),
   body.awards.filter((award) => award.badgeNumber === 9005).length], [true, 3])
check('  the response field is `attendees`, and `eligible` is gone',
  ['attendees' in body, 'eligible' in body], [true, false])
check('  the composer returns the roster UNCHANGED, whatever the history says',
  (() => {
    const attendees = ATTENDEES.map((a) =>
      ({ badgeNumber: a.badge, name: a.name, age: a.age, gender: a.gender }))
    const composed = eligibility.composePrizeRoster({
      attendees,
      awards: attendees.map((a, index) => ({
        id: `x${String(index)}`, badgeNumber: a.badgeNumber, prizeName: CATALOG[0],
        awardedAt: AWARDED_AT, awardedBy: { id: DEVICE_ID, name: 'D' },
      })),
    })
    return [composed.attendees.length, badgesIn(composed.attendees)]
  })(), [5, [9001, 9002, 9003, 9004, 9005]])
check('  read from the application-owned range only, and mutating nothing',
  [fakeSheets.state.reads, fakeSheets.state.mutations],
  [[sheetContract.BADGE_REGISTER_RANGE], []])
check('  a row with no Registration ID is still not an attendee',
  await (async () => {
    seedSheet()
    fakeSheets.state.values.push(['', '', '', '', '', '', '', '', '', '', '', '', '', ''])
    fakeSheets.state.values.push([9099, 'No Id', '9000000099', '', 20, 'Male', 'UPI', 20, 'd', 't', '', '', '', ''])
    return badgesIn((await roster()).attendees)
  })(), [9001, 9002, 9003, 9004, 9005])

/* ================================== 5-7. FILTERS INCLUDE PAST WINNERS === */

console.log('\n=== 5-7. SEARCH AND FILTERS FIND A PAST WINNER ===')
seedSheet()
body = await roster()
const ROSTER = body.attendees
const filtered = (over) =>
  badgesIn(filters.filterAttendees(ROSTER, { ...filters.EMPTY_PRIZE_FILTERS, ...over }))

/** #9005 holds three prizes and #9002 one, in the seeded ledger above. */
check('5. searching `9005` finds the attendee who has already won three',
  [filtered({ search: '9005' }), filtered({ search: '#9005' }), filtered({ search: 'Meera' })],
  [[9005], [9005], [9005]])
check('6. the age filter includes already-awarded attendees',
  [filtered({ minAge: '11', maxAge: '11' }), filtered({ minAge: '12' }), filtered({ maxAge: '12' })],
  [[9005], [9002, 9003, 9004], [9001, 9005]])
check('7. the gender filter includes already-awarded attendees',
  [filtered({ gender: 'female' }), filtered({ gender: 'male' })],
  [[9001, 9003, 9005], [9002, 9004]])
check('  and the filters still compose',
  [filtered({ gender: 'female', minAge: '10', maxAge: '20' }),
   filtered({ search: 'Prize', gender: 'female', minAge: '10' }),
   filtered({ search: 'meera', gender: 'male' })],
  [[9003, 9005], [9003], []])
check('  an empty bound is NOT zero, and min above max filters nothing',
  [filtered({ maxAge: '' }), filtered({ minAge: '20', maxAge: '5' }),
   filters.parseAgeBounds({ minAge: '20', maxAge: '5' }).ok],
  [[9001, 9002, 9003, 9004, 9005], [9001, 9002, 9003, 9004, 9005], false])
check('  and Clear filters restores everything',
  [filters.hasActivePrizeFilters({ ...filters.EMPTY_PRIZE_FILTERS, search: 'x' }),
   filters.hasActivePrizeFilters(filters.EMPTY_PRIZE_FILTERS), filtered({})],
  [true, false, [9001, 9002, 9003, 9004, 9005]])
/**
 * NOT VACUOUS. The filter is never handed the award history, so there is no
 * value it could filter on — which is a stronger statement than any single
 * case above, and the one that keeps being true when a filter is added.
 */
check('  the filter is never even given the award history',
  /export const filterAttendees = \(\s*attendees: readonly PrizeAttendee\[\],\s*state: PrizeFilterState,\s*\)/
    .test(read('src/prizes/prize-filters.ts')), true)

/* ============================= 8-13. AWARDING, AGAIN AND AGAIN ========== */

console.log('\n=== 8-13. REPEAT AWARDS SUCCEED ===')
seedCentral()
seedSheet()

let response = await post({ badgeNumber: 9005, prizeName: '  Best Dance - Girl  ' })
body = await response.json()

check('8. the FIRST award succeeds',
  [response.status, body.ok, fieldOf(body.award, 'badgeNumber'), fieldOf(body.award, 'prizeName'),
   fakeDb.state.prizeAwards.length],
  [201, true, 9005, 'Best Dance - Girl', 1])
check('  the prize name is trimmed to the canonical label',
  ledgerField(0, 'prizeName'), 'Best Dance - Girl')

response = await post({ badgeNumber: 9005, prizeName: 'Best Dress - Girl' })
body = await response.json()
check('9. a SECOND, DIFFERENT prize for the same badge succeeds',
  [response.status, body.ok, fieldOf(body.award, 'prizeName'), fakeDb.state.prizeAwards.length],
  [201, true, 'Best Dress - Girl', 2])

response = await post({ badgeNumber: 9005, prizeName: 'Best Dance - Girl' })
body = await response.json()
check('10. a second IDENTICAL prize for the same badge ALSO succeeds',
  [response.status, body.ok, fieldOf(body.award, 'prizeName'), fakeDb.state.prizeAwards.length],
  [201, true, 'Best Dance - Girl', 3])
check('11. three award rows exist for one badge, each with its own id',
  [fakeDb.state.prizeAwards.filter((row) => row.badgeNumber === 9005).length,
   new Set(fakeDb.state.prizeAwards.map((row) => row.id)).size],
  [3, 3])
check('  and no conflict was ever reported',
  [response.status, 'conflict' in body, 'blocked' in body], [201, false, false])

body = await roster()
check('12. the Awards count counts ROWS, not unique badges',
  [body.awards.length, new Set(badgesIn(body.awards)).size], [3, 1])
check('  while the attendee count is unmoved by three awards',
  body.attendees.length, 5)
check('  and the awarded badge is STILL in the attendee list',
  badgesIn(body.attendees).includes(9005), true)
check('13. history shows the repeated badge independently, newest first',
  body.awards.map((award) => [award.badgeNumber, award.prizeName]),
  [[9005, 'Best Dance - Girl'], [9005, 'Best Dress - Girl'], [9005, 'Best Dance - Girl']])
check('  each row carries its own identity and the joined attendee',
  [new Set(body.awards.map((award) => award.id)).size,
   body.awards.every((award) => award.attendee?.name === 'Meera')], [3, true])
check('  the awarding device is joined by name, so a rename is reflected',
  await (async () => {
    fakeDb.state.devices.get(DEVICE_ID).name = 'Prize Desk Renamed'
    const fresh = await roster()
    fakeDb.state.devices.get(DEVICE_ID).name = 'Prize Test Desk'
    return [...new Set(fresh.awards.map((award) => award.awardedBy.name))]
  })(), ['Prize Desk Renamed'])
check('  history survives the Sheet row disappearing',
  await (async () => {
    seedSheet(ATTENDEES.filter((attendee) => attendee.badge !== 9005))
    const fresh = await roster()
    return [fresh.awards.length, fresh.awards.every((award) => award.attendee === null)]
  })(), [3, true])
seedSheet()
check('  the timestamp is the SERVER\'s, not the caller\'s',
  [new Set(fakeDb.state.prizeAwards.map((row) => row.awardedAt.toISOString())),
   (await post({ badgeNumber: 9001, prizeName: CATALOG[0], awardedAt: '1999-01-01T00:00:00.000Z' })).status],
  [{}, 400])
/**
 * CONCURRENCY CHANGED DELIBERATELY. Device B's insert lands between Device A's
 * roster read and A's own insert. Under P1 exactly one row survived; now BOTH
 * are legitimate, so two rows exist and neither caller is refused.
 */
seedCentral()
seedSheet()
fakeDb.state.beforeNextWrite = () => {
  fakeDb.state.prizeAwards.push({
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    eventId: EVENT_ID,
    badgeNumber: 9003,
    prizeName: 'Best Dance - Girl',
    awardedByDeviceId: OTHER_DEVICE_ID,
    awardedAt: new Date(AWARDED_AT),
  })
}
response = await post({ badgeNumber: 9003, prizeName: 'Best Dance - Girl' })
body = await response.json()
check('  two desks awarding the same badge at once BOTH succeed',
  [response.status, body.ok, fakeDb.state.prizeAwards.length,
   fakeDb.state.prizeAwards.filter((row) => row.badgeNumber === 9003).length],
  [201, true, 2, 2])
check('  and the ledger is not consulted before inserting',
  stripComments(read('api/prizes.ts'))
    .slice(stripComments(read('api/prizes.ts')).indexOf('export async function POST('))
    .includes('readPrizeAwards('), false)

/* ======================== 20-23. THE FIXED CATALOG AND THE SUGGESTION === */

console.log('\n=== 20-23. EIGHT PRIZES, AND A SUGGESTION THAT IS NOT A RULE ===')

check('20. the catalog is exactly the agreed eight labels',
  contract.PRIZE_CATALOG.map((entry) => entry.label), CATALOG)
check('  two categories of four divisions, with stable codes',
  [contract.PRIZE_CATEGORIES,
   [...new Set(contract.PRIZE_CATALOG.map((entry) => entry.division))],
   contract.PRIZE_CATALOG.map((entry) => entry.code)],
  [['best-dance', 'best-dress'], ['boy', 'girl', 'male', 'female'],
   ['best-dance-boy', 'best-dance-girl', 'best-dance-male', 'best-dance-female',
    'best-dress-boy', 'best-dress-girl', 'best-dress-male', 'best-dress-female']])
check('  every label fits the column the database will store it in',
  contract.PRIZE_CATALOG.filter((entry) => entry.label.length > contract.PRIZE_NAME_MAX_LENGTH), [])
check('  and the catalog has no table, only shared code',
  [/prize_catalog|prizeCatalog = pgTable|CREATE TABLE "prize/i.test(read('server/db/schema.ts')),
   readdirSync(join(root, 'drizzle')).filter((file) => /catalog/.test(file))],
  [false, []])

seedCentral()
seedSheet()
check('21. an arbitrary prize string is REFUSED by the API',
  await (async () => {
    const outcomes = {}
    for (const prizeName of ['Best Dressed', 'best dance - girl', 'Best Dance – Girl',
      'Best Dance - Girl!', 'Best Dance', '', '   ', 'a'.repeat(81)]) {
      outcomes[prizeName.slice(0, 22)] = (await post({ badgeNumber: 9001, prizeName })).status
    }
    return [outcomes, fakeDb.state.prizeAwards.length]
  })(), [{
    'Best Dressed': 400, 'best dance - girl': 400, 'Best Dance – Girl': 400,
    'Best Dance - Girl!': 400, 'Best Dance': 400, '': 400, '   ': 400,
    'aaaaaaaaaaaaaaaaaaaaaa': 400,
  }, 0])
check('  a non-string too, and every one of the eight is accepted',
  await (async () => {
    const nonString = (await post({ badgeNumber: 9001, prizeName: 42 })).status
    const accepted = []
    for (const prizeName of CATALOG) {
      accepted.push((await post({ badgeNumber: 9001, prizeName })).status)
    }
    return [nonString, [...new Set(accepted)], fakeDb.state.prizeAwards.length]
  })(), [400, [201], 8])
check('  the SAME policy module decides for the browser and the server',
  [/parsePrizeName/.test(read('server/prizes/requests.ts')),
   /parsePrizeName/.test(read('src/components/prizes/award-prize-dialog.tsx')),
   /PRIZE_NAMES\.includes\(/.test(read('src/shared/prize-contract.ts'))],
  [true, true, true])

check('22. the demographic suggestion follows age and gender',
  [contract.suggestedPrizeDivision({ age: 7, gender: 'male' }),
   contract.suggestedPrizeDivision({ age: 7, gender: 'female' }),
   contract.suggestedPrizeDivision({ age: 34, gender: 'male' }),
   contract.suggestedPrizeDivision({ age: 34, gender: 'female' })],
  ['boy', 'girl', 'male', 'female'])
check('  18 is the boundary, and it is adult',
  [contract.PRIZE_ADULT_AGE,
   contract.suggestedPrizeDivision({ age: 17, gender: 'female' }),
   contract.suggestedPrizeDivision({ age: 18, gender: 'female' })],
  [18, 'girl', 'female'])
check('23. and the suggestion is NOT enforcement: a contradicting prize is accepted',
  await (async () => {
    seedCentral()
    seedSheet()
    // #9005 is an 11-year-old girl; `Best Dance - Male` is deliberately wrong
    // for her, and the server has no opinion about that.
    const accepted = await post({ badgeNumber: 9005, prizeName: 'Best Dance - Male' })
    return [accepted.status, ledgerField(0, 'prizeName')]
  })(), [201, 'Best Dance - Male'])
check('  the server never consults the suggestion at all',
  ['api', 'server'].flatMap((directory) => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.ts$/.test(entry.name)) continue
        if (/suggestedPrizeDivision|PRIZE_ADULT_AGE/.test(read(next))) found.push(next)
      }
    }
    walk(directory)
    return found
  }), [])

/* ============================= 28-29. WHAT STILL CANNOT BE AWARDED ===== */

console.log('\n=== 28-29. THE REFUSALS THAT REMAIN ===')
seedCentral()
seedSheet()
check('28. a badge that is not in the register still cannot be awarded',
  await (async () => {
    const refused = await post({ badgeNumber: 4242, prizeName: CATALOG[0] })
    const refusedBody = await refused.json()
    return [refused.status, refusedBody.blocked, fakeDb.state.prizeAwards.length]
  })(), [404, 'badge-not-registered', 0])
check('  and the register is read BEFORE anything is written',
  (() => {
    const source = stripComments(read('api/prizes.ts'))
    const postSource = source.slice(source.indexOf('export async function POST('))
    return [postSource.indexOf('readPrizeRoster(') < postSource.indexOf('recordPrizeAward('),
      postSource.includes("blocked: 'badge-not-registered'")]
  })(), [true, true])
/**
 * 29. FAIL CLOSED. The Badge Register is the only thing that can confirm the
 * badge exists, so a Sheet that cannot be read must write nothing at all.
 */
fakeSheets.state.failNextRead = true
check('29. a Sheet read failure causes NO database write',
  await (async () => {
    const refused = await post({ badgeNumber: 9001, prizeName: CATALOG[0] })
    const refusedBody = await refused.json()
    return [refused.status, refusedBody.reason, fakeDb.state.prizeAwards.length,
      fakeDb.state.applied.filter((entry) => entry.includes('prize')).length]
  })(), [503, 'roster-unavailable', 0, 0])
check('  and the read fails closed rather than reporting an empty event',
  await (async () => {
    fakeSheets.state.failNextRead = true
    const refused = await get()
    const refusedBody = await refused.json()
    return [refused.status, refusedBody.reason, 'attendees' in refusedBody]
  })(), [503, 'roster-unavailable', false])
check('  a CONFLICTING Sheet layout fails closed too',
  await (async () => {
    fakeSheets.reset()
    fakeSheets.state.values = [['Something', 'Else'], ['x', 'y']]
    const refused = await get()
    return [refused.status, (await refused.json()).reason]
  })(), [503, 'roster-unavailable'])
check('  and an unconfigured release interlock does the same',
  await (async () => {
    seedSheet()
    process.env.SYNC_WRITE_ENABLED = 'false'
    const refusedGet = await get()
    const refusedPost = await post({ badgeNumber: 9001, prizeName: CATALOG[0] })
    process.env.SYNC_WRITE_ENABLED = 'true'
    return [refusedGet.status, refusedPost.status, fakeDb.state.prizeAwards.length]
  })(), [503, 503, 0])

/* ===================== LEGACY HISTORY FROM BEFORE THE CATALOG ========== */

console.log('\n=== LEGACY HISTORY IS DISPLAYED, NOT HIDDEN ===')
/**
 * Development holds one real P1 award — #9005 `Best Dressed` — written when
 * prize names were free text. It is HISTORY: the prize was given, so the
 * ledger must keep showing it even though that name is no longer one a NEW
 * award may use.
 */
seedCentral({ awards: [{ badgeNumber: 9005, prizeName: 'Best Dressed' }] })
seedSheet()
body = await roster()
check('a free-text P1 award is still returned by the API',
  [body.awards.length, fieldOf(body.awards[0], 'prizeName'),
   fieldOf(fieldOf(body.awards[0], 'attendee'), 'name')],
  [1, 'Best Dressed', 'Meera'])
check('  its attendee is still in the attendee list',
  badgesIn(body.attendees).includes(9005), true)
check('  and a NEW award with that name is refused while the old row is untouched',
  await (async () => {
    const refused = await post({ badgeNumber: 9005, prizeName: 'Best Dressed' })
    return [refused.status, fakeDb.state.prizeAwards.length,
      ledgerField(0, 'prizeName')]
  })(), [400, 1, 'Best Dressed'])
check('  the client parser accepts a legacy name rather than rejecting the row',
  await (async () => {
    const parsers = await domainJiti.import(`${root}/src/prizes/prize-contract-parsers.ts`)
    const legacy = parsers.parsePrizeAward({
      id: 'cccccccc-0000-4000-8000-000000000001', badgeNumber: 9005,
      prizeName: 'Best Dressed', awardedAt: AWARDED_AT,
      awardedBy: { id: DEVICE_ID, name: 'Prize Test Desk' }, attendee: null,
    })
    return legacy?.prizeName ?? null
  })(), 'Best Dressed')

/* ========================== 14-19, 24. THE DIALOG, RENDERED FOR REAL === */

console.log('\n=== 14-19, 24. THE WARNING AND THE CHOOSER, ON SCREEN ===')

/**
 * The REAL dialog, with ONLY the Base UI portal stood in for: it renders
 * through `DialogPrimitive.Portal`, which produces nothing at all under
 * `renderToStaticMarkup`, so the dialog's own markup would otherwise be
 * untestable. Everything inside it is the component's own code.
 */
const uiJiti = createJiti(import.meta.url, {
  alias: { '@/components/ui/dialog': `${HERE}/fake-dialog.mjs`, '@': `${root}/src` },
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

const PREVIOUS = [
  {
    id: 'dddddddd-0000-4000-8000-000000000002', badgeNumber: 9005,
    prizeName: 'Best Dress - Girl', awardedAt: '2026-10-11T07:45:00.000Z',
    awardedBy: { id: DEVICE_ID, name: 'Prize Test Desk' }, attendee: null,
  },
  {
    id: 'dddddddd-0000-4000-8000-000000000001', badgeNumber: 9005,
    prizeName: 'Best Dance - Girl', awardedAt: '2026-10-11T07:15:00.000Z',
    awardedBy: { id: OTHER_DEVICE_ID, name: 'Prize Test Desk B' }, attendee: null,
  },
]

const MEERA = { badgeNumber: 9005, name: 'Meera', age: 11, gender: 'female' }
const noop = () => undefined

const dialog = (over = {}) => renderUi('src/components/prizes/award-prize-dialog.tsx', {
  attendee: MEERA, previousAwards: [], isSubmitting: false,
  onCancel: noop, onAward: noop, ...over,
})

const withPrevious = await dialog({ previousAwards: PREVIOUS })
const withOne = await dialog({ previousAwards: [PREVIOUS[0]] })
const withNone = await dialog()

check('14. the warning appears when this badge has history',
  [withPrevious.includes('Previous prizes'), withOne.includes('Previous prizes')],
  [true, true])
check('15. it names every previous prize, newest first',
  [...withPrevious.matchAll(/Best (?:Dance|Dress) - Girl/g)].map((match) => match[0]).slice(0, 2),
  ['Best Dress - Girl', 'Best Dance - Girl'])
/**
 * 07:45 and 07:15 UTC are 1:15 pm and 12:45 pm in Asia/Kolkata. The EVENT
 * timezone is the point: a volunteer's tablet set to another zone must not
 * make "when did they already win" read differently.
 *
 * `Intl` separates the time from am/pm with a NARROW NO-BREAK SPACE, and
 * React escapes a non-breaking space in the markup, so both are normalised to
 * an ordinary space before matching.
 */
check('16. with the date and time, in the EVENT timezone',
  (() => {
    const text = withPrevious.replace(/&nbsp;|\u202f|\u00a0/g, ' ')

    return [/11 Oct[^<]*1:15\s*pm/i.test(text), /11 Oct[^<]*12:45\s*pm/i.test(text)]
  })(), [true, true])
check('17. and the awarding device, by name',
  [withPrevious.includes('Awarded by Prize Test Desk'),
   withPrevious.includes('Awarded by Prize Test Desk B')], [true, true])
check('  it says how many, and that another is still allowed',
  [withOne.includes('This attendee has already received 1 prize.'),
   withPrevious.includes('This attendee has already received 2 prizes.'),
   withOne.includes('You can still award another.')], [true, true, true])
check('19. a never-awarded attendee gets NO warning at all',
  [withNone.includes('Previous prizes'), withNone.includes('already received')],
  [false, false])
check('  and the button copy says which case it is',
  [withNone.includes('Award Prize'), withNone.includes('Award Another Prize'),
   withPrevious.includes('Award Another Prize')], [true, false, true])

const submitOf = (html) => /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? 'absent'
const enabledChoices = (html) =>
  [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)]
    .filter((match) => !/\sdisabled=""/.test(match[0])).length

/**
 * 18 IS THE WHOLE POINT OF THE WARNING, and it needs more than a comparison
 * of the two renders.
 *
 * `renderToStaticMarkup` runs no effects and dispatches no clicks, so no
 * prize is ever selected in a server render and the submit button is
 * correctly disabled in BOTH — which made the obvious "the markup is
 * identical either way" assertion pass with the award button additionally
 * gated on `previousAwards.length > 0`. A canary found that.
 *
 * So the CONDITION is pinned instead, exactly as written, together with every
 * place the component is allowed to look at `previousAwards` at all: a
 * warning may change what is displayed and the button's wording, and nothing
 * else. Adding a fifth use fails this whether or not it is reachable in a
 * server render.
 */
const dialogSource = read('src/components/prizes/award-prize-dialog.tsx')

check('18. whether an award is allowed depends on the request and the chosen prize',
  [/disabled=\{isSubmitting \|\| !chosen\.ok\}/.test(dialogSource),
   /if \(chosen\.ok && !isSubmitting\) \{/.test(dialogSource)], [true, true])
check('  and previous awards are read in exactly four places, none of them a gate',
  dialogSource.split('\n')
    .filter((line) => line.includes('previousAwards'))
    .map((line) => line.trim()),
  ['previousAwards: readonly PrizeAward[]',
   'previousAwards,',
   "const action = previousAwards.length === 0 ? 'Award Prize' : 'Award Another Prize'",
   '<PreviousAwardsWarning awards={previousAwards} />'])
check('  the eight prize buttons stay enabled whatever the history says',
  [enabledChoices(withPrevious), enabledChoices(withNone),
   submitOf(withPrevious) === submitOf(withNone)],
  [8, 8, true])
check('  and the warning itself offers no override, approval or disabled control',
  await (async () => {
    const warning = await renderUi(
      'src/components/prizes/previous-awards-warning.tsx', { awards: PREVIOUS })
    return [/\sdisabled=""/.test(warning), /override|approval|admin/i.test(warning),
      warning.includes('Previous prizes')]
  })(), [false, false, true])
check('20. all eight prizes are rendered, in their two groups',
  [CATALOG.filter((label) => !withNone.includes(label)),
   withNone.includes('Best Dance') && withNone.includes('Best Dress'),
   enabledChoices(withNone)], [[], true, 8])
check('  the demographic suggestion is marked, once per group',
  await (async () => {
    const chooser = await renderUi('src/components/prizes/prize-chooser.tsx', {
      value: null, suggestedDivision: contract.suggestedPrizeDivision(MEERA),
      disabled: false, onChange: noop,
    })
    const marked = [...chooser.matchAll(/aria-label="([^"]+)"[\s\S]*?(Suggested)?<\/button>/g)]
    return [(chooser.match(/Suggested/g) ?? []).length,
      // The two Girl buttons, one in each group, are the marked ones.
      marked.length, chooser.includes('Best Dance - Girl')]
  })(), [2, 8, true])
check('23. and nothing is preselected, so nothing is auto-submitted',
  [/aria-checked="true"/.test(withNone), /disabled=""/.test(submitOf(withNone))],
  [false, true])
check('24. a request in flight disables every control, so a double tap cannot award twice',
  await (async () => {
    const busy = await dialog({ previousAwards: PREVIOUS, isSubmitting: true })
    return [/disabled=""/.test(submitOf(busy)), enabledChoices(busy),
      busy.includes('Awarding…')]
  })(), [true, 0, true])
check('  and the desk refuses a second submission even before the button redraws',
  (() => {
    const desk = stripComments(read('src/components/prizes/prize-desk.tsx'))
    return [/if \(selected === null \|\| isSubmitting\) \{\s*return/.test(desk),
      /sequence\.current/.test(desk)]
  })(), [true, true])

console.log('\n=== THE TWO TABS, AND THE CARD THAT NEVER DISAPPEARS ===')
check('every attendee card offers Give Prize, whatever they have already won',
  await (async () => {
    const card = (previousAwardCount) =>
      renderUi('src/components/prizes/attendee-card.tsx',
        { attendee: MEERA, previousAwardCount, isBusy: false, onGivePrize: noop })
    const fresh = await card(0)
    const winner = await card(2)
    return [fresh.includes('Give Prize'), winner.includes('Give Prize'),
      /\sdisabled=""/.test(winner), winner.includes('2 prizes already received'),
      fresh.includes('already received')]
  })(), [true, true, false, true, false])
check('  the attendee filters count ATTENDEES, not eligibility',
  await (async () => {
    const html = await renderUi('src/components/prizes/attendee-filters.tsx', {
      state: filters.EMPTY_PRIZE_FILTERS, resultCount: 45, totalCount: 45,
      onChange: noop, onClear: noop,
    })
    return [html.includes('45 attendees'), /eligible/i.test(html)]
  })(), [true, false])
check('13. history lists one row per AWARD, with repeated badges intact',
  await (async () => {
    const html = await renderUi('src/components/prizes/award-history.tsx', {
      awards: [...PREVIOUS, { ...PREVIOUS[1], id: 'eeeeeeee-0000-4000-8000-000000000001' }],
      search: '', onSearchChange: noop,
    })
    return [(html.match(/#9005/g) ?? []).length, html.includes('3 awards'),
      (html.match(/Best Dance - Girl/g) ?? []).length, /Undo|Delete|Remove|Edit/.test(html)]
  })(), [3, true, 2, false])
check('  and the tabs are Attendees and Awards, counted independently',
  (() => {
    const desk = read('src/components/prizes/prize-desk.tsx')
    return [desk.includes('`Attendees (${String(roster.attendees.length)})`'),
      desk.includes('`Awards (${String(roster.awards.length)})`'),
      /Eligible \(|Awarded \(/.test(desk)]
  })(), [true, true, false])
check('  an awarded attendee is NEVER removed from the list locally',
  (() => {
    const desk = stripComments(read('src/components/prizes/prize-desk.tsx'))
    const awarded = desk.slice(desk.indexOf("result.status === 'awarded'"))
    return [/attendees: roster\.attendees,/.test(awarded),
      /attendees:[^,]*\.filter\(/.test(awarded),
      /awards: \[result\.award, \.\.\.roster\.awards\]/.test(awarded)]
  })(), [true, false, true])

/* ============================== 30. THE PRIVACY BOUNDARY, UNCHANGED ==== */

console.log('\n=== 30. NO ATTENDEE PII IN POSTGRES ===')
seedCentral()
seedSheet()
await post({ badgeNumber: 9005, prizeName: 'Best Dance - Girl' })
response = await get()
const rawBody = await response.text()
body = JSON.parse(rawBody)

check('30. the stored ledger row holds NO attendee data',
  Object.keys(fakeDb.state.prizeAwards[0] ?? {}).sort(),
  ['awardedAt', 'awardedByDeviceId', 'badgeNumber', 'eventId', 'id', 'prizeName'])
/**
 * The VALUES, not a substring of the serialised row: `11` occurs inside a
 * UUID, so a regex over the whole JSON would report the attendee's age being
 * stored when nothing of the kind had happened.
 */
check('  and no attendee value reached it',
  Object.values(fakeDb.state.prizeAwards[0] ?? {})
    .map((value) => String(value))
    .filter((value) => ['Meera', PHONE_OF(9005), '11', 'female'].includes(value)), [])
check('  no phone number or WhatsApp link is ever returned',
  [ATTENDEES.some((attendee) => rawBody.includes(PHONE_OF(attendee.badge))),
   /wa\.me|whatsapp|HYPERLINK/i.test(rawBody)], [false, false])
check('  an attendee entry carries exactly four fields',
  [...new Set(body.attendees.flatMap((entry) => Object.keys(entry)))].sort(),
  ['age', 'badgeNumber', 'gender', 'name'])
check('  and gender is the NORMALISED value, not the Sheet label',
  [...new Set(body.attendees.map((entry) => entry.gender))].sort(), ['female', 'male'])
const prizeTableSql = (/CREATE TABLE "prize_awards" \(([\s\S]*?)\n\);/
  .exec(read('drizzle/0003_prize_awards.sql'))?.[1] ?? '').replace(/prize_name/g, 'label')
check('  the migration declares no attendee column either',
  [prizeTableSql === '',
   ['name', 'phone', 'whatsapp', 'age', 'gender', 'payment', 'amount', 'normalized']
     .filter((column) => new RegExp(`"[a-z_]*${column}[a-z_]*"`, 'i').test(prizeTableSql))],
  [false, []])
/**
 * THE SCHEMA'S COLUMN SET, as an exact list.
 *
 * The migration and the insert are both checked above, and neither moves when
 * a column is added to the Drizzle table alone — a canary proved that, and a
 * column added there is the first half of adding it to the database.
 */
check('  and the schema declares exactly the six ledger columns',
  (() => {
    const schema = read('server/db/schema.ts')
    const table = schema.slice(schema.indexOf('export const prizeAwards = pgTable('))
    const columns = stripComments(table.slice(table.indexOf('{'), table.indexOf('\n  },')))

    return [...columns.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((match) => match[1])
  })(),
  ['id', 'eventId', 'badgeNumber', 'prizeName', 'awardedByDeviceId', 'awardedAt'])
check('  the division is a property of the PRIZE, never recorded about a person',
  [/division|boy|girl|adult/i.test(prizeTableSql),
   /division/i.test(stripComments(read('server/prizes/awards.ts')))], [false, false])
check('  and the ledger still has exactly one writer',
  ['api', 'server', 'src'].flatMap((directory) => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (/\bprizeAwards\b/.test(stripComments(read(next)))) found.push(next)
      }
    }
    walk(directory)
    return found
  }).sort(), ['server/db/schema.ts', 'server/prizes/awards.ts'])

/* ================================== THE MIGRATION AND THE OLD RULE ===== */

console.log('\n=== THE RULE WAS CHANGED IN A MIGRATION, NOT IN CODE ===')
const migration0003 = read('drizzle/0003_prize_awards.sql')
const migration0004 = read('drizzle/0004_repeat_prize_awards.sql')

check('0003 is NOT edited, and still creates what it always created',
  [/CONSTRAINT "prize_awards_event_id_badge_number_key" UNIQUE\("event_id","badge_number"\)/
    .test(migration0003),
   /CREATE TABLE "prize_awards"/.test(migration0003)], [true, true])
check('0004 removes that constraint, and does nothing else',
  migration0004.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').trim(),
  'ALTER TABLE "prize_awards" DROP CONSTRAINT "prize_awards_event_id_badge_number_key";')
check('  the journal tracks it, appended after 0003',
  JSON.parse(read('drizzle/meta/_journal.json')).entries.map((entry) => entry.tag).slice(-2),
  ['0003_prize_awards', '0004_repeat_prize_awards'])
check('  and the schema declares no replacement uniqueness over the badge number',
  (() => {
    const schema = read('server/db/schema.ts')
    const table = schema.slice(schema.indexOf('export const prizeAwards = pgTable('),
      schema.indexOf('export type Event ='))
    return [...stripComments(table).matchAll(/(unique|uniqueIndex)\(([\s\S]*?)\)\s*\.on\(([^)]*)\)/g)]
      .filter((match) => /badgeNumber|badge_number/.test(match[3]))
      .map((match) => match[2])
  })(), [])
check('  the one-prize conflict is gone from every prize module',
  ['api/prizes.ts', 'src/shared/prize-contract.ts', 'src/prizes/prize-api.ts',
   'server/prizes/awards.ts', 'server/prizes/eligibility.ts']
    .filter((file) => /already-awarded|alreadyAwarded/.test(stripComments(read(file)))), [])
check('  and its translation module was removed, not left behind',
  existsSync(join(root, 'server/prizes/conflicts.ts')), false)
check('  the writer appends and never updates or deletes history',
  (() => {
    const writer = stripComments(read('server/prizes/awards.ts'))
    return [/\.insert\(prizeAwards\)/.test(writer),
      /\.update\(prizeAwards\)|\.delete\(prizeAwards\)/.test(writer),
      // SQL only: 0003's own commentary explains WHY there is no updated_at.
      /updated_at|updatedAt/.test(migration0003.replace(/^--.*$/gm, ''))]
  })(), [true, false, false])

/* ============================= 31-33. NOTHING ELSE MOVED =============== */

console.log('\n=== 31-33. NOTHING ELSE MOVED ===')
const dexie = read('src/db/database.ts')
check('32. IndexedDB version unchanged (1)', /DATABASE_VERSION = 1\b/.test(dexie), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((entry) => entry.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and no prize state is kept locally at all',
  ['src/prizes/prize-api.ts', 'src/prizes/prize-filters.ts',
   'src/components/prizes/prize-desk.tsx', 'src/pages/prizes-page.tsx',
   'src/components/prizes/prize-chooser.tsx',
   'src/components/prizes/previous-awards-warning.tsx']
    .filter((file) => /@\/db\/database|dexie|outbox|localStorage|sessionStorage/i
      .test(stripComments(read(file)))), [])

const sheet = read('server/sync/sheet-contract.ts')
check('33. the registration Sheet contract is unchanged',
  [/A1:N/.test(sheet), /A1:M/.test(sheet), /Device ID', 'Device Name'/.test(sheet),
   sheetContract.BADGE_REGISTER_HEADERS.length], [true, true, true, 14])
check('  the sync, claim and refill endpoints are untouched by prizes',
  ['api/sync-registration.ts', 'api/device-badge-claim.ts', 'api/device-auth.ts']
    .filter((file) => /prizes\//.test(read(file))), [])
check('  and the D2 / D2.1 suites still exist and still run in `verify`',
  (() => {
    const pkg = JSON.parse(read('package.json'))
    return [existsSync(join(root, 'scripts/verification/phase-d2.mjs')),
      existsSync(join(root, 'scripts/verification/phase-d21.mjs')),
      pkg.scripts.verify.includes('verify:d2 '),
      pkg.scripts.verify.includes('verify:d21'),
      pkg.scripts.verify.includes('verify:p1'),
      pkg.scripts['verify:p1']]
  })(), [true, true, true, true, true, 'node scripts/verification/phase-p1.mjs'])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
console.log(`  Vercel Functions: ${String(budget.actual.length)} / ${String(functionChecker.HOBBY_FUNCTION_LIMIT)}` +
  `   Headroom: ${String(functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length)}`)
check('31. the Function inventory is still exactly nine', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'device-auth', 'device-badge-claim', 'prizes', 'sync-registration',
])
check('  with three slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 3)
check('  and prizes is ONE Function, dispatched by method',
  [[...stripComments(read('api/prizes.ts')).matchAll(/export async function ([A-Z]+)\(/g)]
    .map((match) => match[1]).sort(),
   readdirSync(join(root, 'api')).filter((file) => /prize/.test(file))],
  [['GET', 'POST'], ['prizes.ts']])
check('  no catalog, list, history or award Function was added',
  readdirSync(join(root, 'api'))
    .filter((file) => /award|eligible|history|roster|catalog/.test(file)), [])
check('  and nothing unexpected', budget.problems, [])

/* ============================================= THE ROUTE, FOR REAL ===== */

console.log('\n=== THE ROUTE, RENDERED FOR REAL ===')
const { renderRoute, setDeviceGrant, clearDeviceGrant, setNetworkStatus } =
  await import('./route-render.mjs')
const DEVICE_STATE = { config: PRIZE_CONFIG, enrollment: ENROLLMENT, deviceName: 'Prize Test Desk' }

clearDeviceGrant()
setNetworkStatus('online')
check('an unauthorized browser never reaches the prize desk',
  (() => {
    const refused = renderRoute('/prizes', PRIZE_CONFIG)
    return [refused.html.includes('Device access required'), refused.html.includes('Give Prize')]
  })(), [true, false])

setDeviceGrant(grant({ attributes: ['registration'] }), DEVICE_STATE)
check('a registration-only device is refused at the route',
  [renderRoute('/prizes', PRIZE_CONFIG).html.includes('Not available on this device'),
   renderRoute('/prizes', PRIZE_CONFIG).html.includes('Give Prize')], [true, false])

setDeviceGrant(grant(), DEVICE_STATE)
let prizes = renderRoute('/prizes', PRIZE_CONFIG)
check('a prizes device opens the desk',
  [prizes.error ?? null, prizes.html.includes('Prizes'), prizes.html.includes('Prize Test Desk')],
  [null, true, true])
check('  and it reports no badge range, which a prize desk does not own',
  /Badges #|badgeStart|Next badge/.test(prizes.html), false)

setNetworkStatus('offline')
prizes = renderRoute('/prizes', PRIZE_CONFIG)
check('OFFLINE the desk says so, and exposes no mutation at all',
  [prizes.html.includes('Prizes requires an internet connection.'),
   prizes.html.includes('Give Prize'), prizes.html.includes('Award Prize'),
   prizes.html.includes('Attendees ('), prizes.html.includes('Best Dance')],
  [true, false, false, false, false])
setNetworkStatus('online')

/**
 * HOME IS ATTRIBUTE-AWARE, and it is NOT the security boundary.
 */
const homeFor = (attributes) => {
  setDeviceGrant(grant({ attributes }), DEVICE_STATE)

  return renderRoute('/', PRIZE_CONFIG).html
}
const moduleLinks = (html) =>
  [...html.matchAll(/href="(\/[a-z-]*)"[^>]*class="[^"]*group\/module/g)]
    .map((match) => match[1]).sort()

check('Home offers Prizes to a prizes device, and nothing else',
  [moduleLinks(homeFor(['prizes'])), homeFor(['prizes']).includes('Not on this device')],
  [['/prizes'], true])
check('  Badge Registration to a registration device',
  moduleLinks(homeFor(['registration'])), ['/badge-registration'])
check('  both to a device with both',
  moduleLinks(homeFor(['registration', 'prizes'])), ['/badge-registration', '/prizes'])
check('  and the card is NOT the boundary: the route refuses anyway',
  (() => {
    setDeviceGrant(grant({ attributes: ['prizes'] }), DEVICE_STATE)
    const refused = renderRoute('/badge-registration', PRIZE_CONFIG).html
    return [refused.includes('__REGISTRATION_FORM__'),
      refused.includes('Not available on this device')]
  })(), [false, true])
setDeviceGrant(grant(), DEVICE_STATE)

const desk = stripComments(read('src/components/prizes/prize-desk.tsx'))
/**
 * IDENTIFIERS, not prose. The offline copy legitimately contains the word
 * "queued" — it is telling the operator that nothing is — so matching the
 * word would fail on the very sentence that proves the point.
 */
check('there is no offline queue, optimistic award or poll',
  [/setInterval/.test(desk),
   /enqueue|outbox|localStorage|sessionStorage|indexedDB|db\.(config|registrations|transaction)/i
     .test(desk),
   /navigator\.onLine/.test(desk)], [false, false, false])
check('  the local lists change only AFTER the server confirms',
  [/result\.status === 'awarded'\)\s*\{[\s\S]{0,900}setRoster\(/.test(desk),
   [...desk.matchAll(/setRoster\(/g)].length], [true, 3])
check('  the roster is read on mount and on reconnect, and on nothing else',
  [[...desk.matchAll(/useEffect\(/g)].length, /\[network, readAttempt\]/.test(desk)],
  [1, true])
check('  an explicit Refresh still re-reads from the server',
  [/onClick=\{refresh\}/.test(desk), /setReadAttempt\(\(previous\) => previous \+ 1\)/.test(desk)],
  [true, true])
check('  active filters survive a successful award',
  !/setFilters\(EMPTY_PRIZE_FILTERS\)[\s\S]{0,300}status: 'awarded'/.test(desk) &&
  /filters this volunteer/.test(read('src/components/prizes/prize-desk.tsx')), true)
check('history offers no undo, delete or edit',
  /Undo|Delete|Remove|Edit/.test(stripComments(read('src/components/prizes/award-history.tsx'))),
  false)

/* ===================================== THE RELEASE PROCESS ============= */

console.log('\n=== DOCUMENTATION AND THE RELEASE PROCESS ===')
for (const [doc, needles] of [
  ['docs/PRIZES.md', ['prize_awards', 'Best Dance - Girl', 'Best Dress - Female',
    'repeat', 'Prize Test Desk', 'seed-prizes-development.mjs', 'Online only',
    '0004_repeat_prize_awards']],
  ['docs/VERCEL_FIREWALL.md', ['/api/admin-auth', '/api/device-auth', '10', '/api/prizes']],
  ['AGENTS.md', ['Prize Distribution', 'prize_awards', 'Best Dance - Girl']],
  ['README.md', ['/prizes']],
  ['docs/PRODUCTION_RELEASE_CHECKLIST.md', ['0003_prize_awards', '0004_repeat_prize_awards']],
  ['docs/DATABASE.md', ['0004_repeat_prize_awards']],
]) {
  check(`${doc} documents this phase`,
    needles.filter((needle) => !read(doc).includes(needle)), [])
}
check('  and no document still claims one prize per attendee',
  ['docs/PRIZES.md', 'AGENTS.md', 'docs/DATABASE.md', 'docs/PRODUCTION_RELEASE_CHECKLIST.md']
    .filter((doc) => /one prize per attendee|at most one prize|one-prize-per-attendee/i
      .test(read(doc))), [])

/**
 * `pnpm db:check` IS THE RELEASE PROCESS for a migration. It is the only
 * thing that proves a database a human has migrated actually carries what the
 * migrations describe — and, since P1.1, that it does NOT carry something
 * they removed.
 *
 * Asserted against the MIGRATIONS rather than against a list typed here, so a
 * constraint renamed in 0003 or dropped in 0004 breaks this instead of
 * quietly going unverified.
 */
const dbCheck = read('scripts/db-check.mjs')
/**
 * Membership is checked inside the expectation ARRAY that drives a check, not
 * anywhere in the file: `'prize_awards'` also occurs in the code that reads
 * the table, so a whole-file match would pass with the table deleted from
 * `EXPECTED_TABLES`.
 */
const dbCheckList = (name) => {
  const start = dbCheck.indexOf(`const ${name} = [`)
  const end = start === -1 ? -1 : dbCheck.indexOf('\n]', start)

  return start === -1 || end === -1 ? '' : dbCheck.slice(start, end)
}
const prizeExpectations = ['EXPECTED_PRIZE_CONSTRAINTS', 'EXPECTED_PRIZE_INDEXES']
  .map(dbCheckList).join('\n')
const namesIn = (pattern) =>
  [...new Set([...migration0003.matchAll(pattern)].map((match) => match[1]))].sort()

const removedNames = [...migration0004.matchAll(/DROP CONSTRAINT "([a-z_0-9]+)"/g)]
  .map((match) => match[1])
const prizeConstraints = namesIn(/(?:ADD )?CONSTRAINT "([a-z_0-9]+)"/g)
  .filter((name) => !removedNames.includes(name))
const prizeIndexes = namesIn(/CREATE (?:UNIQUE )?INDEX "([a-z_0-9]+)"/g)
const prizeColumns = namesIn(/^\s*"([a-z_]+)" (?:uuid|integer|text|timestamp)/gm)

check('db:check knows about the prize ledger',
  [dbCheckList('EXPECTED_TABLES').includes("'prize_awards'"),
   removedNames.length, prizeConstraints.length, prizeIndexes.length, prizeColumns.length],
  [true, 1, 6, 2, 6])
check('  and verifies every constraint the two migrations LEAVE BEHIND',
  prizeConstraints.filter((name) => !prizeExpectations.includes(name)), [])
check('  every index too',
  prizeIndexes.filter((name) => !prizeExpectations.includes(name)), [])
check('  and every column, as an exact SET so an added one is caught',
  [prizeColumns.filter((column) => !dbCheckList('PRIZE_COLUMNS').includes(`'${column}'`)),
   /holds exactly its/.test(dbCheck)], [[], true])
/**
 * THE SHAPE, not just the name. A constraint with the right name and the
 * wrong columns would satisfy a name lookup while guaranteeing nothing.
 */
check('  the remaining guarantees are verified by DEFINITION, not by name alone',
  [/pg_get_constraintdef/.test(dbCheck),
   dbCheck.includes('foreign key (awarded_by_device_id, event_id)'),
   dbCheck.includes('references devices(id, event_id)'),
   dbCheck.includes('length(prize_name) <= 80')],
  [true, true, true, true])
/**
 * AND THE DROPPED ONE IS CHECKED THE OTHER WAY ROUND. If `db:check` still
 * demanded P1's UNIQUE, a correctly migrated database would fail and the
 * operator's fix would be to put the constraint back — which is the one thing
 * that must not happen.
 */
check('  the dropped constraint is NOT expected any more',
  removedNames.filter((name) => prizeExpectations.includes(name)), [])
check('  it is proved ABSENT instead, and by shape',
  [/repeated prize awards are allowed/.test(dbCheck),
   dbCheck.includes('create unique index'),
   dbCheck.includes('primary key'),
   dbCheck.includes("includes('badge_number')")],
  [true, true, true, true])
check('  and db:check stays READ-ONLY',
  ['INSERT', 'UPDATE ', 'DELETE', 'CREATE TABLE', 'ALTER ', 'DROP ', 'child_process']
    .filter((statement) => stripComments(dbCheck).includes(statement)), [])

check('release:check expects both prize migrations and guards the new rule',
  (() => {
    const releaseCheck = read('scripts/release-check.mjs')
    return ["'0004_repeat_prize_awards.sql'", 'prize-ledger', 'db-check-coverage',
      'repeat prize', 'suggestedPrizeDivision']
      .filter((needle) => !releaseCheck.includes(needle))
  })(), [])
check('the seed script still refuses outside Development',
  ['VERCEL_ENV', 'SYNC_ALLOWED_VERCEL_ENV', '--confirm', '--cleanup']
    .filter((needle) => !read('scripts/seed-prizes-development.mjs').includes(needle)), [])
check('  and cannot delete a Sheet row',
  /deleteDimension|deleteRange|deleteSheet/
    .test(read('scripts/seed-prizes-development.mjs')), false)

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${String(fails)} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
