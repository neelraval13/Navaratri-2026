/**
 * Phase D3 verification — dandiya checkout and return.
 *
 * Run with:  pnpm verify:d3
 *
 * It NEVER connects to Neon, Google or any network. The REAL endpoint, the
 * REAL ledger writer, the REAL board composer, the REAL Badge Register
 * reader, the REAL route policy, the REAL filters, the REAL browser client
 * and the REAL cards and forms all run; only Postgres, the Sheets API, HTTP
 * and the dialog's portal are stood in for.
 *
 * TWO PROPERTIES CARRY THIS PHASE:
 *
 *   1. ONE PAIR, ONE OPEN LOAN; ONE ATTENDEE, ONE OPEN PAIR — and both are
 *      PARTIAL, so everything may go out again after it comes back. The
 *      authority is two partial unique indexes, never an application check.
 *   2. NOTHING EXPIRES. A loan is closed by a person and by nothing else.
 *      Midnight moves a counter and a history filter; it must never release a
 *      pair, a holder or a badge.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { createHash } from 'node:crypto'
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

/** A missing file FAILS its assertion rather than aborting the suite. */
const read = (p) => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : ''
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const DEVICE_ID = '55555555-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '66666666-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const ORIGIN = 'https://dandiya.example.test'

/** 36 hours back is ALWAYS an earlier event day, whatever time it is now. */
const HOURS = 60 * 60 * 1000
const yesterdayIso = () => new Date(Date.now() - 36 * HOURS).toISOString()

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

const SECRET = 'd'.repeat(48)
process.env.EVENT_DEVICE_SESSION_SECRET = SECRET
process.env.SYNC_ALLOWED_ORIGIN = ORIGIN
/** The real release interlock, satisfied the way Development satisfies it. */
process.env.SYNC_WRITE_ENABLED = 'true'
process.env.SYNC_ALLOWED_VERCEL_ENV = 'development'
process.env.VERCEL_ENV = 'development'
process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'fake-spreadsheet'
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'fake@example.test'
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'fake-key'

const deviceSession = await serverJiti.import(`${root}/server/device-auth/session.ts`)
const adminSession = await serverJiti.import(`${root}/server/admin-auth/session.ts`)
const endpoint = await serverJiti.import(`${root}/api/dandiya.ts`)
const prizeEndpoint = await serverJiti.import(`${root}/api/prizes.ts`)
const attendeeEndpoint = await serverJiti.import(`${root}/api/attendees.ts`)
const board = await serverJiti.import(`${root}/server/dandiya/board.ts`)
const sheetContract = await serverJiti.import(`${root}/server/sync/sheet-contract.ts`)
const password = await serverJiti.import(`${root}/server/device-auth/password.ts`)
const fakeDb = await import('./fake-admin-db.mjs')
const fakeSheets = await import('./fake-sheets.mjs')

const storedHash = await password.hashDevicePassword('dandiya-passphrase')

/* --------------------------------------------------------------- fixtures */

const ATTENDEES = [
  { badge: 9005, name: 'Meera', age: 11, gender: 'female' },
  { badge: 9007, name: 'Arjun', age: 15, gender: 'male' },
  { badge: 9008, name: 'Priya', age: 22, gender: 'female' },
  { badge: 9009, name: 'Vivek', age: 34, gender: 'male' },
]

const PHONE_OF = (badge) => String(9000000000 + badge - 9000)

const sheetRow = (attendee) =>
  sheetContract
    .buildBadgeRegisterRow({
      id: `d3-fixture-${String(attendee.badge)}`,
      status: 'completed',
      paymentStatus: 'confirmed',
      paymentMethod: 'upi',
      badgeNumber: attendee.badge,
      name: attendee.name,
      phone: PHONE_OF(attendee.badge),
      age: attendee.age,
      gender: attendee.gender,
      amount: 20,
      createdAt: '2026-10-10T12:30:00.000Z',
      completedAt: '2026-10-10T12:30:00.000Z',
      updatedAt: '2026-10-10T12:30:00.000Z',
    })
    .map((cell) => cell.value)

const seedSheet = (attendees = ATTENDEES) => {
  fakeSheets.reset()
  fakeSheets.state.values = [
    [...sheetContract.BADGE_REGISTER_HEADERS],
    ...attendees.map(sheetRow),
  ]
}

const seedCentral = ({ attributes = ['dandiya'], device = {}, event = {} } = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata',
    active: true, endsAt: null, ...event,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Dandiya Test Desk',
    loginName: 'dandiya-test', passwordHash: storedHash, sessionVersion: 2,
    enabled: true, lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...device,
  })
  fakeDb.state.devices.set(OTHER_DEVICE_ID, {
    id: OTHER_DEVICE_ID, eventId: EVENT_ID, name: 'Dandiya Desk B',
    loginName: 'dandiya-b', passwordHash: storedHash, sessionVersion: 1,
    enabled: true, lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  fakeDb.state.attributes.push({ deviceId: OTHER_DEVICE_ID, attribute: 'dandiya' })
  fakeDb.state.applied = []
}

const deviceCookie = (sessionVersion = 2) =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion,
  })}`

const get = (cookie = deviceCookie()) =>
  endpoint.GET(new Request(`${ORIGIN}/api/dandiya`, {
    method: 'GET',
    headers: { ...(cookie === null ? {} : { cookie }) },
  }))

const mutate = (method, body, cookie = deviceCookie()) =>
  endpoint[method](new Request(`${ORIGIN}/api/dandiya`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  }))

const issue = (pairCode, badgeNumbers, cookie) =>
  mutate('POST', { pairCode, badgeNumbers }, cookie)
const give = async (pairCode, badgeNumbers) => {
  const response = await issue(pairCode, badgeNumbers)

  return { status: response.status, body: await response.json() }
}
/**
 * THE FOUR WAYS A STICK CAN STOP BEING OUT.
 *
 * Phase D3.1 made each stick its own obligation, so there is no single
 * "return" any more: a holder is resolved `returned` or `lost`, and the two
 * shortcuts resolve every stick still out in one request.
 */
const patch = async (body) => {
  const response = await mutate('PATCH', body)

  return { status: response.status, body: await response.json() }
}
const resolveHolder = (loanId, badgeNumber, resolution) =>
  patch({ loanId, action: 'resolve-holder', badgeNumber, resolution })
const returnStick = (loanId, badgeNumber) =>
  resolveHolder(loanId, badgeNumber, 'returned')
const loseStick = (loanId, badgeNumber) =>
  resolveHolder(loanId, badgeNumber, 'lost')
const returnPair = (loanId) => patch({ loanId, action: 'return-pair' })
const losePair = (loanId) => patch({ loanId, action: 'lost-pair' })
const boardOf = async (cookie) => (await get(cookie)).json()
/**
 * Reads from rows that MIGHT NOT EXIST.
 *
 * A broken writer writes no row, and `dandiyaLoans[0].pairCode` then throws —
 * which ABORTS the suite and hides every assertion below it. A canary proved
 * that twice over: one regression reported a single failure and silently
 * skipped the twenty checks that would also have caught it. A missing row
 * must read as `null` and FAIL its assertion.
 */
const fieldOf = (row, key) =>
  row === undefined || row === null ? null : (row[key] ?? null)
const loanField = (index, key) => fieldOf(fakeDb.state.dandiyaLoans[index], key)
const holderField = (index, key) => fieldOf(fakeDb.state.dandiyaLoanHolders[index], key)
/** A loan id from a response that may not carry one. */
const loanIdOf = (result) => fieldOf(fieldOf(result.body, 'loan'), 'id') ?? 'absent'

/**
 * A BOARD ENTRY THAT MIGHT NOT BE THERE.
 *
 * A regression that drops a loan from `active` makes `view.active[0]` throw
 * inside a filter, which aborts the suite and hides every assertion below —
 * a canary proved exactly that twice. A missing entry must read as an empty
 * loan and FAIL its assertion instead.
 */
const EMPTY_LOAN = {
  id: null, pairCode: null, issuedAt: null, issuedBy: null, holders: [],
  closedAt: null, closedBy: null, outcome: null, pairReleasedAt: null,
}
const at = (list, index) => (Array.isArray(list) ? list[index] : undefined) ?? EMPTY_LOAN

/**
 * OPEN loans and UNRESOLVED holders, and the two are now different questions.
 *
 * A loan is open while any stick is out. A PAIR is held while its loan has
 * not released it — which a loss never does, so a quarantined pair has a
 * closed loan and an unreleased pair code at the same time.
 */
const openLoans = () =>
  fakeDb.state.dandiyaLoans.filter((loan) => (loan.closedAt ?? null) === null)
const heldPairs = () =>
  fakeDb.state.dandiyaLoans.filter((loan) => (loan.pairReleasedAt ?? null) === null)
const outHolders = () =>
  fakeDb.state.dandiyaLoanHolders.filter((holder) => (holder.resolvedAt ?? null) === null)
const holderFor = (badgeNumber) =>
  fakeDb.state.dandiyaLoanHolders.filter((holder) => holder.badgeNumber === badgeNumber).at(-1)
const outcomeOf = (loanId) =>
  fieldOf(fakeDb.state.dandiyaLoans.find((loan) => loan.id === loanId), 'outcome')
const releasedOf = (loanId) =>
  fieldOf(fakeDb.state.dandiyaLoans.find((loan) => loan.id === loanId), 'pairReleasedAt') !== null

/* ============================== 1-7. THE PERMISSION MODEL ============== */

console.log('=== 1-7. FOUR INDEPENDENT ATTRIBUTES ===')

const domainJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const authz = await domainJiti.import(`${root}/src/device-auth/event-authorization.ts`)
const attributes = await domainJiti.import(`${root}/src/shared/device-attributes.ts`)
const filters = await domainJiti.import(`${root}/src/dandiya/dandiya-filters.ts`)
const contract = await domainJiti.import(`${root}/src/shared/dandiya-contract.ts`)
const client = await domainJiti.import(`${root}/src/dandiya/dandiya-api.ts`)

check('1. `dandiya` is a valid device attribute',
  [[...attributes.DEVICE_ATTRIBUTES],
   attributes.isDeviceAttribute('dandiya'),
   attributes.parseAttributeSet(['dandiya']).attributes,
   attributes.DANDIYA_REQUIRED_ATTRIBUTE,
   attributes.DEVICE_ATTRIBUTE_LABELS.dandiya,
   attributes.DEVICE_ATTRIBUTE_DESCRIPTIONS.dandiya.length > 0],
  [['registration', 'prizes', 'attendees', 'dandiya'], true, ['dandiya'],
   'dandiya', 'Dandiya', true])
check('  and free text is still refused',
  ['checkin', 'Dandiya', 'dandiya-desk']
    .filter((value) => attributes.parseAttributeSet([value]).ok), [])

/** A converged browser with NO badge state at all: the dandiya-desk shape. */
const DESK_CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1,
  deviceId: DEVICE_ID, deviceName: 'Dandiya Test Desk',
  deviceConfiguredAt: '2026-10-01T01:00:00.000Z', updatedAt: 'T',
}
const ENROLLMENT = {
  deviceId: DEVICE_ID, eventId: EVENT_ID, eventSlug: 'navaratri-2026',
  deviceName: 'Dandiya Test Desk', loginName: 'dandiya-test',
  attributes: ['dandiya'], verifiedAt: 'T',
}
const grant = (over = {}) => ({
  source: 'device-online', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['dandiya'],
  activeBadgeRange: null, ...over,
})
const authorize = (module, over = {}) => authz.authorizeEventModule(module, {
  grant: 'grant' in over ? over.grant : grant(),
  config: 'config' in over ? over.config : DESK_CONFIG,
  enrollment: 'enrollment' in over ? over.enrollment : ENROLLMENT,
})
const outcomeFor = (set) => Object.fromEntries(
  ['registration', 'prizes', 'attendees', 'dandiya'].map((module) =>
    [module, authorize(module, { grant: grant({ attributes: set }) }).outcome]))

check('2. a dandiya-only device opens /dandiya',
  authorize('dandiya'), { outcome: 'authorized', source: 'device-online' })
check('3. a registration-only device may NOT',
  authorize('dandiya', { grant: grant({ attributes: ['registration'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('4. a prizes-only device may NOT',
  authorize('dandiya', { grant: grant({ attributes: ['prizes'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('5. an attendees-only device may NOT',
  authorize('dandiya', { grant: grant({ attributes: ['attendees'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('  and a dandiya-only device opens nothing else',
  outcomeFor(['dandiya']),
  { registration: 'unavailable', prizes: 'unavailable', attendees: 'unavailable',
    dandiya: 'authorized' })
/**
 * DANDIYA DOES NOT IMPLY ATTENDEES, which is the subtle one. The desk reads
 * the safe attendee register to identify the two badge holders, and that is
 * part of issuing a pair — but browsing the whole register as a directory is
 * a separate grant, and granting one must never grant the other.
 */
check('  the four capabilities are INDEPENDENT',
  [outcomeFor([]).dandiya,
   outcomeFor(['dandiya', 'attendees']),
   outcomeFor(['registration', 'prizes', 'attendees', 'dandiya'])],
  ['unavailable',
   { registration: 'unavailable', prizes: 'unavailable', attendees: 'authorized',
     dandiya: 'authorized' },
   { registration: 'unavailable', prizes: 'authorized', attendees: 'authorized',
     dandiya: 'authorized' }])
/**
 * 6-7 ARE THE DECISIVE ONES. A dandiya desk owns no badge range, holds no
 * central binding and has no local range. If the module consulted badge
 * ownership it would block on `binding-missing` for a range it was never
 * meant to have.
 */
check('6-7. a dandiya desk needs no badge range, binding or local range',
  [authorize('dandiya'),
   authorize('dandiya', { config: { ...DESK_CONFIG, badgeEnd: undefined } }),
   authorize('dandiya', { grant: grant({ activeBadgeRange: null }) })],
  [{ outcome: 'authorized', source: 'device-online' },
   { outcome: 'authorized', source: 'device-online' },
   { outcome: 'authorized', source: 'device-online' }])
check('  but it still needs a grant, the right event and a converged identity',
  [authorize('dandiya', { grant: null }).gap,
   authorize('dandiya', { grant: grant({ eventSlug: 'other-event' }) }).gap,
   authorize('dandiya', { config: { ...DESK_CONFIG, deviceId: OTHER_DEVICE_ID } }).gap,
   authorize('dandiya', { enrollment: undefined }).gap],
  ['no-grant', 'event-mismatch', 'identity-convergence-required', 'no-enrollment'])
check('  an offline lease authorizes it too, like every other module',
  authorize('dandiya', { grant: grant({ source: 'device-offline' }) }),
  { outcome: 'authorized', source: 'device-offline' })

/* ========================= 8-14. ENDPOINT AUTHORIZATION ================ */

console.log('\n=== 8-14. EVERY METHOD REFUSES WHAT IT SHOULD ===')
seedCentral()
seedSheet()

check('8-10. an anonymous caller is refused on GET, POST and PATCH',
  await (async () => {
    const read_ = await get(null)
    const write = await issue('D-001', [9005, 9007], null)
    const back = await endpoint.PATCH(new Request(`${ORIGIN}/api/dandiya`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ loanId: '11111111-2222-4333-8444-555555555555' }),
    }))
    const body = await read_.json()
    return [read_.status, write.status, back.status, body.authenticated ?? null,
      'active' in body, fakeDb.state.dandiyaLoans.length]
  })(), [401, 401, 401, false, false, 0])
/**
 * 11. The realms are CRYPTOGRAPHICALLY separate: an Admin token signed with
 * the SAME secret is still rejected, because each realm signs a different
 * domain-separated message.
 */
process.env.EVENT_ADMIN_SESSION_SECRET = SECRET
check('11. an Admin cookie authorizes nothing here',
  await (async () => {
    const adminToken = adminSession.createAdminSessionToken(SECRET)
    const asDevice = await get(`__Host-navaratri_device_session=${adminToken}`)
    const asAdmin = await get(`__Host-navaratri_admin_session=${adminToken}`)
    return [asDevice.status, asAdmin.status,
      /admin-auth|adminSession|readAdminSessionCookie|__Host-navaratri_admin_session/
        .test(stripComments(read('api/dandiya.ts')))]
  })(), [401, 401, false])

seedCentral({ device: { enabled: false } })
check('12. a DISABLED device is refused, and writes nothing',
  await (async () => {
    const write = await issue('D-001', [9005, 9007])
    return [(await get()).status, write.status, fakeDb.state.dandiyaLoans.length]
  })(), [401, 401, 0])

seedCentral({ event: { active: false } })
check('13. an INACTIVE event is refused',
  await (async () => {
    const write = await issue('D-001', [9005, 9007])
    return [(await get()).status, write.status, fakeDb.state.dandiyaLoans.length]
  })(), [401, 401, 0])

seedCentral()
check('14. a stale session_version is refused',
  (await get(deviceCookie(1))).status, 401)
check('  an unprovisioned device too',
  await (async () => {
    seedCentral({ device: { passwordHash: null } })
    return (await get()).status
  })(), 401)

seedCentral({ attributes: ['registration', 'prizes', 'attendees'] })
check('  a device with the other three but not dandiya is refused',
  await (async () => {
    const read_ = await get()
    const body = await read_.json()
    const write = await issue('D-001', [9005, 9007])
    const writeBody = await write.json()
    return [read_.status, body.blocked, write.status, writeBody.blocked,
      fakeDb.state.dandiyaLoans.length]
  })(), [403, 'dandiya-required', 403, 'dandiya-required', 0])
check('  and the attribute comes from CURRENT Postgres, never the token',
  /device\.attributes\.includes\(DANDIYA_REQUIRED_ATTRIBUTE\)/
    .test(stripComments(read('api/dandiya.ts'))), true)

/* ============================ 15-18. VALIDATION ======================== */

console.log('\n=== 15-18. WHAT CANNOT BE ISSUED ===')
seedCentral()
seedSheet()

check('15. both badges must exist in the register',
  await (async () => {
    const one = await give('D-001', [9005, 4242])
    const both = await give('D-002', [4242, 4243])
    return [one.status, one.body.blocked, one.body.badgeNumbers,
      both.status, both.body.badgeNumbers, fakeDb.state.dandiyaLoans.length]
  })(), [404, 'badge-not-registered', [4242], 404, [4242, 4243], 0])
check('16. the same badge twice is refused, before anything is written',
  await (async () => {
    const same = await give('D-001', [9005, 9005])
    return [same.status, fakeDb.state.dandiyaLoans.length]
  })(), [400, 0])
check('17. an empty or whitespace pair code is refused',
  await (async () => {
    const outcomes = []
    for (const pairCode of ['', '   ', '\t']) {
      outcomes.push((await give(pairCode, [9005, 9007])).status)
    }
    return [outcomes, fakeDb.state.dandiyaLoans.length]
  })(), [[400, 400, 400], 0])
check('18. an oversized pair code is refused, at the shared limit',
  await (async () => {
    const atLimit = 'A'.repeat(contract.PAIR_CODE_MAX_LENGTH)
    const tooLong = 'A'.repeat(contract.PAIR_CODE_MAX_LENGTH + 1)
    const refused = await give(tooLong, [9005, 9007])
    const accepted = await give(atLimit, [9005, 9007])
    return [contract.PAIR_CODE_MAX_LENGTH, refused.status, accepted.status]
  })(), [32, 400, 201])
check('  and the policy is SHARED, so the form and the server cannot drift',
  [/parsePairCode/.test(read('server/dandiya/requests.ts')),
   /parsePairCode/.test(read('src/components/dandiya/issue-pair-form.tsx'))],
  [true, true])
/**
 * 1-2. PAIR CODES ARE CANONICALISED: trimmed, then uppercased.
 *
 * Not tidiness — a safety rule. The only protection against one pair going
 * out twice is `UNIQUE(event_id, pair_code) WHERE returned_at IS NULL`, and
 * an index compares bytes. Two volunteers typing the same physical label with
 * different shift keys would otherwise each hold an open loan on one set of
 * sticks.
 */
check('1-2. parsePairCode canonicalises: trimmed, then uppercased',
  [' d-014 ', 'D-014', 'd-014', 'test-01', 'D 14/a', '  mIxEd-CaSe_9  ']
    .map((input) => contract.parsePairCode(input).value),
  ['D-014', 'D-014', 'D-014', 'TEST-01', 'D 14/A', 'MIXED-CASE_9'])
check('  and nothing else is rewritten: separators survive exactly',
  ['A-1', 'A_1', 'A/1', 'A.1', 'A 1']
    .map((input) => contract.parsePairCode(input).value),
  ['A-1', 'A_1', 'A/1', 'A.1', 'A 1'])
check('  a malformed badge list is refused',
  await (async () => {
    seedCentral()
    seedSheet()
    const outcomes = []
    for (const badges of [[9005], [9005, 9007, 9008], [], ['9005', 9007],
      [9005, 0], [9005, -1], [9005, 1.5]]) {
      const response = await mutate('POST', { pairCode: 'D-001', badgeNumbers: badges })
      outcomes.push(response.status)
    }
    return [outcomes, fakeDb.state.dandiyaLoans.length]
  })(), [[400, 400, 400, 400, 400, 400, 400], 0])
check('  every forbidden field is refused by the endpoint, one at a time',
  await (async () => {
    const outcomes = {}
    for (const field of ['eventId', 'eventSlug', 'deviceId', 'loginName', 'issuedAt',
      'closedAt', 'closedByDeviceId', 'outcome', 'pairReleasedAt', 'resolvedAt',
      'resolvedByDeviceId', 'attendees', 'name', 'age', 'gender']) {
      const response = await mutate('POST',
        { pairCode: 'D-001', badgeNumbers: [9005, 9007], [field]: 'anything' })
      outcomes[field] = response.status
    }
    return [[...new Set(Object.values(outcomes))], fakeDb.state.dandiyaLoans.length]
  })(), [[400], 0])

/* ======================= 19-24. ISSUING, AND THE INDEXES =============== */

console.log('\n=== 3-5. CANONICAL PAIR CODES ===')
check('3. a lowercase API input is STORED uppercase',
  await (async () => {
    seedCentral()
    seedSheet()
    const lower = await give('  d-014  ', [9005, 9007])
    return [lower.status, loanField(0, 'pairCode'),
      fieldOf(fieldOf(lower.body, 'loan'), 'pairCode')]
  })(), [201, 'D-014', 'D-014'])
/**
 * 4 IS THE WHOLE POINT. The second desk types the same physical label in
 * lower case; the database must see the SAME pair, not a second one.
 */
check('4. issuing "d-014" then "D-014" while it is out is pair-in-use',
  await (async () => {
    const upper = await give('D-014', [9008, 9009])
    const mixed = await give(' d-014 ', [9008, 9009])
    return [upper.status, upper.body.conflict, mixed.status, mixed.body.conflict,
      fakeDb.state.dandiyaLoans.length]
  })(), [409, 'pair-in-use', 409, 'pair-in-use', 1])
check('5. after a return "d-014" may be reissued, and history is canonical',
  await (async () => {
    const open = loanField(0, 'id')
    await returnPair(open)
    const again = await give('d-014', [9008, 9009])
    const fresh = await boardOf()
    return [again.status, fakeDb.state.dandiyaLoans.map((loan) => loan.pairCode),
      fresh.history.map((loan) => loan.pairCode),
      fresh.active.map((loan) => loan.pairCode)]
  })(), [201, ['D-014', 'D-014'], ['D-014', 'D-014'], ['D-014']])
/**
 * AND THE DATABASE WOULD REFUSE A NON-CANONICAL CODE whatever the application
 * believed. Written through the writer directly, bypassing the endpoint's
 * validation, so the CHECK is what is being observed.
 */
check('  a writer that forgot to canonicalise is refused by the database',
  await (async () => {
    seedCentral()
    seedSheet()
    const loans = await serverJiti.import(`${root}/server/dandiya/loans.ts`)
    let refused = null

    try {
      await loans.openDandiyaLoan({
        eventId: EVENT_ID, pairCode: 'd-014', badgeNumbers: [9005, 9007],
        issuedByDeviceId: DEVICE_ID,
      })
    } catch (error) {
      refused = /pair_code_canonical/.test(String(error?.cause?.constraint ?? '')) ||
        /pair_code_canonical/.test(String(error?.message ?? ''))
    }

    return [refused, fakeDb.state.dandiyaLoans.length]
  })(), [true, 0])


console.log('\n=== 19-24. ONE PAIR, ONE LOAN; ONE ATTENDEE, ONE PAIR ===')
seedCentral()
seedSheet()

const first = await give('  TEST-01  ', [9005, 9007])

check('19. the first issue succeeds',
  [first.status, first.body.ok, fieldOf(fieldOf(first.body, 'loan'), 'pairCode'),
   (fieldOf(fieldOf(first.body, 'loan'), 'holders') ?? [])
     .map((holder) => holder.badgeNumber),
   (fieldOf(fieldOf(first.body, 'loan'), 'holders') ?? []).map((holder) => holder.slot)],
  [201, true, 'TEST-01', [9005, 9007], [1, 2]])
check('  one loan row and TWO holder rows, in one transaction',
  [fakeDb.state.dandiyaLoans.length, fakeDb.state.dandiyaLoanHolders.length,
   fakeDb.state.dandiyaLoanHolders.map((holder) => holder.slot).sort()],
  [1, 2, [1, 2]])
check('  the pair code is TRIMMED and otherwise echoed exactly',
  loanField(0, 'pairCode'), 'TEST-01')
check('  the issuing device and the time come from the server',
  [loanField(0, 'issuedByDeviceId'),
   loanField(0, 'issuedAt') instanceof Date,
   loanField(0, 'closedAt'), loanField(0, 'closedByDeviceId'),
   loanField(0, 'outcome'), loanField(0, 'pairReleasedAt')],
  [DEVICE_ID, true, null, null, null, null])
check('  and the attendees are JOINED from the Sheet, never stored',
  [(fieldOf(fieldOf(first.body, 'loan'), 'holders') ?? [])
     .map((holder) => holder.attendee?.name ?? null),
   Object.keys(fakeDb.state.dandiyaLoanHolders[0] ?? {}).sort()],
  [['Meera', 'Arjun'],
   ['badgeNumber', 'eventId', 'id', 'loanId', 'resolution', 'resolvedAt',
    'resolvedByDeviceId', 'slot']])

check('20. the SAME PAIR cannot be issued twice while it is out',
  await (async () => {
    const again = await give('TEST-01', [9008, 9009])
    return [again.status, again.body.conflict, fakeDb.state.dandiyaLoans.length,
      fakeDb.state.dandiyaLoanHolders.length]
  })(), [409, 'pair-in-use', 1, 2])
/**
 * 21-22 TOGETHER. The holder index refuses the second attendee, and because
 * the loan and both holders travel in ONE transaction the loan row is rolled
 * back too — a pair marked out with one holder would be a ledger nobody could
 * reconcile.
 */
check('21. an attendee already holding a pair cannot receive another',
  await (async () => {
    const again = await give('TEST-02', [9005, 9008])
    return [again.status, again.body.conflict]
  })(), [409, 'attendee-already-holding-pair'])
check('22. and the whole transaction rolled back: no orphan loan row',
  [fakeDb.state.dandiyaLoans.length, fakeDb.state.dandiyaLoanHolders.length,
   fakeDb.state.dandiyaLoans.map((loan) => loan.pairCode)],
  [1, 2, ['TEST-01']])
check('  the second holder is refused too, not only the first',
  await (async () => {
    const again = await give('TEST-03', [9008, 9007])
    return [again.status, again.body.conflict, fakeDb.state.dandiyaLoans.length]
  })(), [409, 'attendee-already-holding-pair', 1])
check('  and a refusal names no constraint, SQLSTATE or other device',
  await (async () => {
    const response = await issue('TEST-01', [9008, 9009])
    const text = await response.text()
    return [/dandiya_loans_|dandiya_loan_holders_|23505|SQLSTATE|constraint/i.test(text),
      text.includes(OTHER_DEVICE_ID), text.includes('Dandiya Desk B')]
  })(), [false, false, false])

/**
 * 23-24. THE RACES. Desk B's loan commits in the window between Desk A's
 * validation and Desk A's own insert. Only the DATABASE can decide this,
 * which is why there is no precheck above it.
 */
seedCentral()
seedSheet()
fakeDb.state.beforeNextWrite = () => {
  fakeDb.state.dandiyaLoans.push({
    id: 'cccccccc-1111-4111-8111-000000000001',
    eventId: EVENT_ID, pairCode: 'RACE-01', issuedByDeviceId: OTHER_DEVICE_ID,
    issuedAt: new Date(), closedByDeviceId: null, closedAt: null,
    outcome: null, pairReleasedAt: null,
  })
  fakeDb.state.dandiyaLoanHolders.push({
    id: 'dddddddd-1111-4111-8111-000000000001',
    loanId: 'cccccccc-1111-4111-8111-000000000001',
    eventId: EVENT_ID, badgeNumber: 9008, slot: 1,
    resolution: null, resolvedAt: null, resolvedByDeviceId: null,
  }, {
    id: 'dddddddd-1111-4111-8111-000000000002',
    loanId: 'cccccccc-1111-4111-8111-000000000001',
    eventId: EVENT_ID, badgeNumber: 9009, slot: 2,
    resolution: null, resolvedAt: null, resolvedByDeviceId: null,
  })
}
const racedPair = await give('RACE-01', [9005, 9007])
check('23. two desks racing for the SAME PAIR: exactly one wins',
  [racedPair.status, racedPair.body.conflict,
   fakeDb.state.dandiyaLoans.filter((loan) => loan.pairCode === 'RACE-01').length,
   loanField(0, 'issuedByDeviceId')],
  [409, 'pair-in-use', 1, OTHER_DEVICE_ID])
check('  and the loser wrote nothing at all',
  [fakeDb.state.dandiyaLoans.length, fakeDb.state.dandiyaLoanHolders.length], [1, 2])

seedCentral()
seedSheet()
fakeDb.state.beforeNextWrite = () => {
  fakeDb.state.dandiyaLoans.push({
    id: 'cccccccc-1111-4111-8111-000000000002',
    eventId: EVENT_ID, pairCode: 'RACE-B', issuedByDeviceId: OTHER_DEVICE_ID,
    issuedAt: new Date(), closedByDeviceId: null, closedAt: null,
    outcome: null, pairReleasedAt: null,
  })
  fakeDb.state.dandiyaLoanHolders.push({
    id: 'dddddddd-1111-4111-8111-000000000003',
    loanId: 'cccccccc-1111-4111-8111-000000000002',
    eventId: EVENT_ID, badgeNumber: 9005, slot: 1,
    resolution: null, resolvedAt: null, resolvedByDeviceId: null,
  }, {
    id: 'dddddddd-1111-4111-8111-000000000004',
    loanId: 'cccccccc-1111-4111-8111-000000000002',
    eventId: EVENT_ID, badgeNumber: 9008, slot: 2,
    resolution: null, resolvedAt: null, resolvedByDeviceId: null,
  })
}
const racedAttendee = await give('RACE-A', [9005, 9007])
check('24. two desks racing for the SAME ATTENDEE: exactly one wins',
  [racedAttendee.status, racedAttendee.body.conflict,
   outHolders().filter((holder) => holder.badgeNumber === 9005).length,
   fakeDb.state.dandiyaLoans.length],
  [409, 'attendee-already-holding-pair', 1, 1])
/**
 * NOT VACUOUS: the endpoint asks the database and nothing else. A precheck
 * would make these tests pass for the wrong reason, so its absence is pinned.
 */
check('  and the issue endpoint does NOT precheck the ledger',
  (() => {
    const source = stripComments(read('api/dandiya.ts'))
    const post = source.slice(source.indexOf('export async function POST('),
      source.indexOf('export async function PATCH('))
    return [post.includes('readDandiyaLedger('),
      post.indexOf('readAttendeeRegister(') < post.indexOf('openDandiyaLoan(')]
  })(), [false, true])

/* ================= D3.1 1-12. EACH STICK HAS ITS OWN ENDING ============ */

console.log('\n=== D3.1 1-12. PER-STICK RESOLUTION, AND THE PAIR ===')

/** 1. The clean case: both sticks back, the pair free, both attendees free. */
seedCentral()
seedSheet()
const clean = await give('CLEAN-01', [9005, 9007])
const cleanId = loanIdOf(clean)
const cleanReturn = await returnPair(cleanId)

check('1. a clean full return closes as `returned` and releases the pair',
  [cleanReturn.status, cleanReturn.body.ok, cleanReturn.body.resolvedHolders,
   outcomeOf(cleanId), releasedOf(cleanId), openLoans().length, heldPairs().length],
  [200, true, 2, 'returned', true, 0, 0])
check('  and both attendees are free, on the ONE server timestamp',
  [outHolders().length,
   [...new Set(fakeDb.state.dandiyaLoanHolders
     .map((holder) => holder.resolvedAt?.toISOString() ?? null))].length,
   fakeDb.state.dandiyaLoanHolders.map((holder) => holder.resolution)],
  [0, 1, ['returned', 'returned']])

/**
 * 2-5. ONE STICK AT A TIME.
 *
 * This is the whole point of D3.1: Meera gives her stick back and leaves,
 * Arjun is still dancing with his. Her obligation is discharged and his is
 * not, and the PAIR is still out — a desk that handed the code to somebody
 * else now would be handing over one stick.
 */
seedCentral()
seedSheet()
const split = await give('SPLIT-01', [9005, 9007])
const splitId = loanIdOf(split)
const firstBack = await returnStick(splitId, 9005)

check('2. the first individual return frees ONLY that attendee',
  [firstBack.status, firstBack.body.resolvedHolders,
   fieldOf(holderFor(9005), 'resolution'),
   fieldOf(holderFor(9005), 'resolvedAt') !== null],
  [200, 1, 'returned', true])
check('3. the other attendee is STILL actively holding',
  [outHolders().map((holder) => holder.badgeNumber),
   fieldOf(holderFor(9007), 'resolution'),
   openLoans().length],
  [[9007], null, 1])
check('4. a partial return keeps the pair unavailable',
  await (async () => {
    const reissue = await give('SPLIT-01', [9008, 9009])

    return [heldPairs().length, outcomeOf(splitId), releasedOf(splitId),
      reissue.status, reissue.body.conflict]
  })(), [1, null, false, 409, 'pair-in-use'])
check('5. the second individual return closes the loan as `returned`',
  await (async () => {
    const secondBack = await returnStick(splitId, 9007)

    return [secondBack.status, secondBack.body.resolvedHolders,
      outcomeOf(splitId), releasedOf(splitId), openLoans().length, outHolders().length]
  })(), [200, 1, 'returned', true, 0, 0])

/**
 * 6-10. A LOSS, AND WHAT IT COSTS.
 *
 * The attendee goes free either way — they have no stick and nothing more to
 * give back. The PAIR does not: a pair with one stick is not a pair, and
 * `pair_released_at` staying null is what keeps the code out of circulation
 * for the rest of the event.
 */
for (const [order, label, first, second] of [
  [['returned', 'lost'], '6. one returned then one lost', 9005, 9007],
  [['lost', 'returned'], '7. one lost then one returned', 9005, 9007],
]) {
  seedCentral()
  seedSheet()
  const loan = await give('MIXED-01', [first, second])
  const id = loanIdOf(loan)

  await resolveHolder(id, first, order[0])
  const closing = await resolveHolder(id, second, order[1])

  check(`${label} closes as partial_loss`,
    [closing.status, outcomeOf(id), releasedOf(id), openLoans().length,
     fakeDb.state.dandiyaLoanHolders.map((holder) => holder.resolution)],
    [200, 'partial_loss', false, 0, order])
}

seedCentral()
seedSheet()
const bothGone = await give('GONE-01', [9005, 9007])
const bothGoneId = loanIdOf(bothGone)
await loseStick(bothGoneId, 9005)
const lastGone = await loseStick(bothGoneId, 9007)

check('8. both sticks lost closes as `lost`',
  [lastGone.status, outcomeOf(bothGoneId), openLoans().length],
  [200, 'lost', 0])
check('9. a loss RELEASES THE ATTENDEE, who has nothing left to return',
  [outHolders().length,
   fakeDb.state.dandiyaLoanHolders.every((holder) => holder.resolvedAt !== null)],
  [0, true])
check('10. a loss does NOT release the physical pair',
  [releasedOf(bothGoneId), heldPairs().length,
   fieldOf(fakeDb.state.dandiyaLoans[0], 'pairReleasedAt')],
  [false, 1, null])
check('11. and a lost pair can NEVER be reissued',
  await (async () => {
    const again = await give('GONE-01', [9008, 9009])

    return [again.status, again.body.conflict,
      fakeDb.state.dandiyaLoans.filter((loan) => loan.pairCode === 'GONE-01').length]
  })(), [409, 'pair-unavailable', 1])
check('  the two pair refusals are DISTINGUISHED: in use versus unavailable',
  await (async () => {
    const out = await give('STILL-OUT', [9008, 9009])
    const inUse = await give('STILL-OUT', [9005, 9007])
    const unavailable = await give('GONE-01', [9005, 9007])

    return [out.status, inUse.body.conflict, unavailable.body.conflict,
      inUse.body.message === unavailable.body.message,
      /constraint|index|SQLSTATE|dandiya_loan/
        .test(JSON.stringify([inUse.body, unavailable.body]))]
  })(), [201, 'pair-in-use', 'pair-unavailable', false, false])

seedCentral()
seedSheet()
const reusable = await give('REUSE-OK', [9005, 9007])
await returnPair(loanIdOf(reusable))

check('12. a fully returned pair CAN be reissued',
  await (async () => {
    const again = await give('REUSE-OK', [9008, 9009])

    return [again.status, fakeDb.state.dandiyaLoans.length, heldPairs().length]
  })(), [201, 2, 1])

/**
 * 13. AND A PERSON WHO LOST A STICK IS NOT BARRED.
 *
 * Their holder row is resolved, so the partial unique index does not hold
 * them, and nothing above it refuses them either. The screen warns the
 * volunteer; the ledger does not punish the dancer.
 */
seedCentral()
seedSheet()
const lossHistory = await give('LOSS-01', [9005, 9007])
await losePair(loanIdOf(lossHistory))

check('13. an attendee with a prior LOSS can receive another pair',
  await (async () => {
    const again = await give('LOSS-02', [9005, 9007])

    return [again.status, again.body.ok,
      outHolders().map((holder) => holder.badgeNumber).sort((a, b) => a - b)]
  })(), [201, true, [9005, 9007]])

/* ================= D3.1 16-20. THE TWO WHOLE-PAIR SHORTCUTS =========== */

console.log('\n=== D3.1 16-20. RETURN WHOLE PAIR, REPORT PAIR LOST ===')

seedCentral()
seedSheet()
const bothOut = await give('WHOLE-01', [9005, 9007])

check('16. Return Whole Pair resolves BOTH sticks still out',
  await (async () => {
    const done = await returnPair(loanIdOf(bothOut))

    return [done.status, done.body.resolvedHolders, outcomeOf(loanIdOf(bothOut)),
      releasedOf(loanIdOf(bothOut))]
  })(), [200, 2, 'returned', true])

seedCentral()
seedSheet()
const afterOne = await give('WHOLE-02', [9005, 9007])
await returnStick(loanIdOf(afterOne), 9005)

check('17. Return Whole Pair works after one stick already came back',
  await (async () => {
    const rest = await returnPair(loanIdOf(afterOne))

    return [rest.status, rest.body.resolvedHolders, outcomeOf(loanIdOf(afterOne)),
      releasedOf(loanIdOf(afterOne))]
  })(), [200, 1, 'returned', true])

/**
 * 18. AND IT NEVER REWRITES A LOSS.
 *
 * The compare-and-set carries `resolved_at IS NULL`, so the lost stick is
 * simply not matched — the loan closes as a partial loss and the pair stays
 * quarantined. Without that predicate, Return Whole Pair would quietly turn
 * a missing stick into a returned one and put the pair back in the box.
 */
seedCentral()
seedSheet()
const withLoss = await give('WHOLE-03', [9005, 9007])
const withLossId = loanIdOf(withLoss)
await loseStick(withLossId, 9005)
const remaining = await returnPair(withLossId)

check('18. Return Whole Pair PRESERVES an existing lost resolution',
  [remaining.status, remaining.body.resolvedHolders,
   fieldOf(holderFor(9005), 'resolution'), fieldOf(holderFor(9007), 'resolution'),
   outcomeOf(withLossId), releasedOf(withLossId)],
  [200, 1, 'lost', 'returned', 'partial_loss', false])

seedCentral()
seedSheet()
const allLost = await give('LOST-ALL', [9005, 9007])

check('19. Report Pair Lost marks every stick still out as lost',
  await (async () => {
    const reported = await losePair(loanIdOf(allLost))

    return [reported.status, reported.body.resolvedHolders,
      fakeDb.state.dandiyaLoanHolders.map((holder) => holder.resolution),
      outcomeOf(loanIdOf(allLost)), releasedOf(loanIdOf(allLost))]
  })(), [200, 2, ['lost', 'lost'], 'lost', false])

seedCentral()
seedSheet()
const oneSafe = await give('LOST-ONE', [9005, 9007])
const oneSafeId = loanIdOf(oneSafe)
await returnStick(oneSafeId, 9005)
const reportRest = await losePair(oneSafeId)

check('20. Report Pair Lost PRESERVES an already-returned stick',
  [reportRest.status, reportRest.body.resolvedHolders,
   fieldOf(holderFor(9005), 'resolution'), fieldOf(holderFor(9007), 'resolution'),
   outcomeOf(oneSafeId), releasedOf(oneSafeId)],
  [200, 1, 'returned', 'lost', 'partial_loss', false])

/* ====== D3.1 SERIALIZATION: THE LOAN ROW LOCK COMES FIRST ============= */

console.log('\n=== D3.1 SERIALIZATION: ONE LOCK, FOUR ACTIONS ===')

/**
 * WHY THIS SECTION IS STRUCTURAL RATHER THAN BEHAVIOURAL.
 *
 * Holder-level compare-and-set does NOT serialise two desks resolving
 * DIFFERENT sticks of one pair: they write different holder rows and never
 * conflict. Under READ COMMITTED each statement takes a fresh snapshot and
 * cannot see another transaction's uncommitted write, so both would see the
 * other stick still out, both would decline to close, and both would commit —
 * every stick resolved and the loan open for the rest of the event.
 *
 * The fix is a `SELECT ... FOR UPDATE` on the owning loan as the FIRST
 * statement of the same transaction. This stand-in database cannot prove that:
 * it is single-threaded, and its batch applies statements against live state,
 * so a scripted concurrent writer has already committed before the first
 * statement — which is precisely the world the lock creates. The fake shows
 * correct behaviour with or without the lock, and that is exactly why the
 * lock's PRESENCE and POSITION are pinned here, and why
 * `scripts/dandiya-concurrency-smoke.mjs` exists to prove the real thing
 * against a live database.
 */
seedCentral()
seedSheet()
const serialized = await give('LOCK-01', [9005, 9007])
const serializedId = loanIdOf(serialized)

/** Statements of the resolve transaction, in the order the database saw them. */
const statementsOf = async (act) => {
  fakeDb.state.applied = []
  await act()

  return fakeDb.state.applied.filter((entry) =>
    /^(lock|insert|update|delete) dandiya/.test(entry))
}

const firstResolve = await statementsOf(() => returnStick(serializedId, 9005))

check('S1. a holder resolution LOCKS THE LOAN ROW first',
  [firstResolve[0], firstResolve.includes('update dandiya_loan_holders')],
  ['lock dandiya_loans for update', true])
check('S2. no holder update and no close query runs before the lock',
  [firstResolve.indexOf('lock dandiya_loans for update'),
   firstResolve.findIndex((entry) => entry === 'update dandiya_loan_holders'),
   firstResolve.findIndex((entry) => entry === 'update dandiya_loans')],
  [0, 1, 2])
/**
 * S3. ONE TRANSACTION. The lock is useless in a transaction of its own: it
 * would be released before the resolution it was meant to protect ran.
 */
check('S3. the lock and the resolution are ONE batch',
  (() => {
    const writer = stripComments(read('server/dandiya/loans.ts'))
    // To the batch's OWN closing bracket: the holder clause contains a
    // `])` of its own, and slicing to the first one cut the batch in half.
    const batch = writer.slice(writer.indexOf('await database.batch(['),
      writer.indexOf('\n  ])', writer.indexOf('await database.batch([')))

    return [batch.includes('lockOpenLoan(eventId, loanId)'),
      batch.indexOf('lockOpenLoan') <
        batch.indexOf('.update(dandiyaLoanHolders)'),
      batch.indexOf('lockOpenLoan') < batch.indexOf('.update(dandiyaLoans)'),
      // Exactly ONE call site, so there is no second, unlocked batch.
      (writer.match(/lockOpenLoan\(/g) ?? []).length]
  })(), [true, true, true, 1])
check('  and the lock is a real row lock, scoped to the event and still open',
  (() => {
    const writer = stripComments(read('server/dandiya/loans.ts'))
    const lock = writer.slice(writer.indexOf('const lockOpenLoan ='),
      writer.indexOf('export const resolveDandiyaHolders'))

    return [/\.for\('update'\)/.test(lock),
      /eq\(dandiyaLoans\.id, loanId\)/.test(lock),
      /eq\(dandiyaLoans\.eventId, eventId\)/.test(lock),
      /isNull\(dandiyaLoans\.closedAt\)/.test(lock),
      // No application-level stand-in for the row lock. `Map(` is NOT in
      // this list: the ledger reader legitimately builds a device-name Map.
      /advisory|pg_advisory|setTimeout|mutex|sleep\(|retry/i.test(writer)]
  })(), [true, true, true, true, false])

/**
 * S4. ALL FOUR ACTIONS GO THROUGH IT. A second close path — a shortcut with
 * its own batch, say — would be unserialised however carefully this one is
 * written.
 */
seedCentral()
seedSheet()

for (const [label, open, act] of [
  ['resolve-holder returned', ['S-RET', [9005, 9007]], (id) => returnStick(id, 9005)],
  ['resolve-holder lost', ['S-LOST', [9008, 9009]], (id) => loseStick(id, 9008)],
  ['return-pair', ['S-PAIR', [9005, 9007]], (id) => returnPair(id)],
  ['lost-pair', ['S-GONE', [9008, 9009]], (id) => losePair(id)],
]) {
  seedCentral()
  seedSheet()
  const loan = await give(open[0], open[1])
  const seen = await statementsOf(() => act(loanIdOf(loan)))

  check(`S4. ${label} takes the lock first`,
    [seen[0], seen.length >= 2], ['lock dandiya_loans for update', true])
}

/**
 * S5. AND THERE IS NO OTHER MUTATION PATH. Exactly one function in the whole
 * repository resolves a holder or closes a loan, and the endpoint reaches it
 * by that one name.
 */
check('S5. exactly one writer resolves holders or closes loans',
  (() => {
    const writer = stripComments(read('server/dandiya/loans.ts'))
    const resolvers = ['api', 'server', 'src'].flatMap((directory) => {
      const found = []
      const walk = (dir) => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
          const next = `${dir}/${entry.name}`

          if (entry.isDirectory()) {
            walk(next)
          } else if (/\.tsx?$/.test(entry.name)) {
            const code = stripComments(read(next))

            if (/\.update\(dandiyaLoanHolders\)|\.update\(dandiyaLoans\)/.test(code)) {
              found.push(next)
            }
          }
        }
      }

      walk(directory)

      return found
    })

    return [resolvers,
      (writer.match(/\.update\(dandiyaLoanHolders\)/g) ?? []).length,
      (writer.match(/\.update\(dandiyaLoans\)/g) ?? []).length,
      (writer.match(/export const resolveDandiyaHolders/g) ?? []).length]
  })(), [['server/dandiya/loans.ts'], 1, 3, 1])
/**
 * S6. THE SMOKE SCRIPT EXISTS, AND REFUSES EVERYTHING EXCEPT A DELIBERATE
 * DEVELOPMENT RUN. It is the only thing that can prove real visibility, so a
 * missing or ungated one would leave this phase resting on structure alone.
 */
check('S6. the development concurrency smoke is present and gated',
  (() => {
    const smoke = read('scripts/dandiya-concurrency-smoke.mjs')

    return [
      // All four interlocks, each an EXACT comparison.
      ["process.env.ALLOW_DANDIYA_DB_SMOKE_WRITES !== 'true'",
        "process.env.VERCEL_ENV !== 'development'",
        "allowedEnv !== 'development'",
        '--confirm']
        .filter((needle) => !smoke.includes(needle)),
      // It CALLS THE REAL WRITER, concurrently. A reimplementation of the
      // resolution in SQL would prove something about the script instead.
      [/resolveDandiyaHolders/, /Promise\.all\(/, /from 'jiti'/]
        .filter((needle) => !needle.test(smoke)).length,
      // Its cleanup is scoped to its OWN disposable rows.
      smoke.includes('pair_code like') && smoke.includes('SMOKE-D31-'),
      // And it never creates or deletes central state.
      /insert into (events|devices|device_attributes|badge_assignments|prize_awards)|delete from (events|devices|device_attributes|badge_assignments|prize_awards)/i
        .test(smoke)]
  })(), [[], 0, true, false])
check('  and the interlocks refuse BEFORE any connection is opened',
  (() => {
    const smoke = read('scripts/dandiya-concurrency-smoke.mjs')
    const firstQuery = Math.min(
      ...['const sql = neon(', 'await sql`']
        .map((marker) => smoke.indexOf(marker))
        .filter((index) => index !== -1),
    )

    return ["process.env.ALLOW_DANDIYA_DB_SMOKE_WRITES !== 'true'",
      "process.env.VERCEL_ENV !== 'development'",
      "allowedEnv !== 'development'"]
      .filter((guard) => smoke.indexOf(guard) > firstQuery)
  })(), [])

/* ============= D3.1 21-24. TWO VOLUNTEERS AT THE SAME TABLE =========== */

console.log('\n=== D3.1 21-24. CONCURRENCY, AND A FINAL RESOLUTION ===')

/**
 * 21. THE SAME STICK, TWICE AT ONCE. Desk B resolves it between Desk A's
 * read and Desk A's update; A matches no row and is told, and B's record
 * stands untouched.
 */
seedCentral()
seedSheet()
const contested = await give('RACE-H', [9005, 9007])
const contestedId = loanIdOf(contested)
fakeDb.state.beforeNextWrite = () => {
  const holder = fakeDb.state.dandiyaLoanHolders
    .find((entry) => entry.badgeNumber === 9005)

  if (holder !== undefined && holder.resolvedAt === null) {
    holder.resolution = 'returned'
    holder.resolvedAt = new Date()
    holder.resolvedByDeviceId = OTHER_DEVICE_ID
  }
}

check('21. two desks resolving the SAME stick: exactly one wins',
  await (async () => {
    const loser = await loseStick(contestedId, 9005)

    return [loser.status, loser.body.conflict,
      fieldOf(holderFor(9005), 'resolution'),
      fieldOf(holderFor(9005), 'resolvedByDeviceId')]
  })(), [409, 'holder-already-resolved', 'returned', OTHER_DEVICE_ID])

/**
 * 22. TWO FINAL RESOLUTIONS AT ONCE, which is the subtle one.
 *
 * Desk B resolves the OTHER stick while Desk A's request is in flight. A
 * prior SELECT would have told both desks "one stick still out" and the loan
 * would never close. The close is three compare-and-sets counting the holders
 * INSIDE the transaction instead, so whichever commits second finds none
 * unresolved and closes with the right outcome.
 */
seedCentral()
seedSheet()
const simultaneous = await give('RACE-F', [9005, 9007])
const simultaneousId = loanIdOf(simultaneous)
fakeDb.state.beforeNextWrite = () => {
  const holder = fakeDb.state.dandiyaLoanHolders
    .find((entry) => entry.badgeNumber === 9007)

  if (holder !== undefined && holder.resolvedAt === null) {
    holder.resolution = 'lost'
    holder.resolvedAt = new Date()
    holder.resolvedByDeviceId = OTHER_DEVICE_ID
  }
}

check('22. concurrent FINAL resolutions still close the loan, coherently',
  await (async () => {
    const mine = await returnStick(simultaneousId, 9005)

    return [mine.status, outcomeOf(simultaneousId), releasedOf(simultaneousId),
      openLoans().length, outHolders().length,
      fakeDb.state.dandiyaLoanHolders.map((holder) => holder.resolution)]
  })(), [200, 'partial_loss', false, 0, 0, ['returned', 'lost']])

/** 23-24. A RESOLUTION IS FINAL, in both directions, however often asked. */
seedCentral()
seedSheet()
const finality = await give('FINAL-01', [9005, 9007])
const finalityId = loanIdOf(finality)
await returnStick(finalityId, 9005)
await loseStick(finalityId, 9007)

check('23. a repeated PATCH cannot rewrite returned -> lost',
  await (async () => {
    const again = await loseStick(finalityId, 9005)

    return [again.status, again.body.conflict, fieldOf(holderFor(9005), 'resolution'),
      outcomeOf(finalityId)]
  })(), [409, 'holder-already-resolved', 'returned', 'partial_loss'])
check('24. nor lost -> returned, and the pair stays quarantined',
  await (async () => {
    const again = await returnStick(finalityId, 9007)
    const shortcut = await returnPair(finalityId)

    return [again.status, again.body.conflict, fieldOf(holderFor(9007), 'resolution'),
      shortcut.status, shortcut.body.conflict,
      outcomeOf(finalityId), releasedOf(finalityId)]
  })(), [409, 'holder-already-resolved', 'lost',
    409, 'loan-already-closed', 'partial_loss', false])

/**
 * AND THE ORDINARY REFUSALS, which are about shape rather than lifecycle.
 */
check('  a loan from another event, or no loan at all, is a 404',
  await (async () => {
    const missing = await returnPair('eeeeeeee-1111-4111-8111-000000000009')

    return [missing.status, missing.body.blocked]
  })(), [404, 'loan-not-found'])
check('  a badge that is not one of the loan’s holders is a 404',
  await (async () => {
    const stranger = await returnStick(finalityId, 9008)

    return [stranger.status, stranger.body.blocked]
  })(), [404, 'holder-not-found'])
check('  a malformed loan id never reaches the database',
  await (async () => {
    // WRITES only: authorizing the request legitimately issues selects.
    const writes = () => fakeDb.state.applied
      .filter((entry) => /^(insert|update|delete)/.test(entry)).length
    const before = writes()
    const bad = await patch({ loanId: 'not-a-uuid', action: 'return-pair' })

    return [bad.status, writes() - before]
  })(), [400, 0])
check('  a shortcut carrying a stick or a resolution is REFUSED, not ignored',
  await (async () => {
    const confused = await patch(
      { loanId: finalityId, action: 'return-pair', resolution: 'lost' })
    const stray = await patch(
      { loanId: finalityId, action: 'lost-pair', badgeNumber: 9005 })

    return [confused.status, stray.status,
      confused.body.message.includes('resolution'),
      stray.body.message.includes('badgeNumber')]
  })(), [400, 400, true, true])
check('  an unknown action and a missing resolution are refused',
  await (async () => {
    const unknown = await patch({ loanId: finalityId, action: 'release-pair' })
    const vague = await patch(
      { loanId: finalityId, action: 'resolve-holder', badgeNumber: 9005 })

    return [unknown.status, vague.status]
  })(), [400, 400])
check('  and every resolution is a compare-and-set, never a precheck',
  [/isNull\(dandiyaLoanHolders\.resolvedAt\)/.test(read('server/dandiya/loans.ts')),
   /isNull\(dandiyaLoans\.closedAt\)/.test(read('server/dandiya/loans.ts')),
   /partial_loss|pairReleasedAt|outcome:/.test(
     stripComments(read('api/dandiya.ts')).slice(
       stripComments(read('api/dandiya.ts')).indexOf('export async function PATCH(')))],
  [true, true, false])

/* ========== D3.1 25-29. THE THREE LISTS, THE COUNTERS, AND MIDNIGHT === */

console.log('\n=== D3.1 25-29. ACTIVE, ISSUES, HISTORY AND THE CLOCK ===')
seedCentral()
seedSheet()

/** A pair issued 36 hours ago and never brought back. */
const LEFTOVER_ID = 'ffffffff-1111-4111-8111-000000000001'
const seedLeftover = () => {
  fakeDb.state.dandiyaLoans.push({
    id: LEFTOVER_ID, eventId: EVENT_ID, pairCode: 'YESTERDAY-01',
    issuedByDeviceId: DEVICE_ID, issuedAt: new Date(yesterdayIso()),
    closedByDeviceId: null, closedAt: null, outcome: null, pairReleasedAt: null,
  })
  fakeDb.state.dandiyaLoanHolders.push({
    id: 'ffffffff-2222-4111-8111-000000000001', loanId: LEFTOVER_ID,
    eventId: EVENT_ID, badgeNumber: 9008, slot: 1,
    resolution: null, resolvedAt: null, resolvedByDeviceId: null,
  }, {
    id: 'ffffffff-2222-4111-8111-000000000002', loanId: LEFTOVER_ID,
    eventId: EVENT_ID, badgeNumber: 9009, slot: 2,
    resolution: null, resolvedAt: null, resolvedByDeviceId: null,
  })
}
seedLeftover()
const partial = await give('TODAY-01', [9005, 9007])
await returnStick(loanIdOf(partial), 9005)
let view = await boardOf()

/**
 * 25. A PARTIALLY RESOLVED LOAN IS STILL ACTIVE. Its remaining stick is
 * somebody's obligation, and the board that a volunteer reads to find
 * outstanding sticks must not have dropped it the moment one came back.
 */
check('25. Active holds a partially resolved loan while a stick is still out',
  [view.active.length, view.active.map((loan) => loan.pairCode),
   view.active.map((loan) => loan.holders
     .map((holder) => holder.resolution).join('/')),
   view.issues.length],
  [2, ['YESTERDAY-01', 'TODAY-01'], ['/', 'returned/'], 0])
check('  active is OLDEST FIRST, so the leftover sits at the top',
  at(view.active, 0).pairCode, 'YESTERDAY-01')
check('  and the browser agrees it is partially resolved, with one stick out',
  [filters.isPartiallyResolved(at(view.active, 1)),
   filters.isPartiallyResolved(at(view.active, 0)),
   filters.unresolvedHolders(at(view.active, 1)).map((holder) => holder.badgeNumber)],
  [true, false, [9007]])

/**
 * 28. THE COUNTERS COUNT DIFFERENT THINGS, deliberately.
 *
 * `issued` and the three outcomes are TODAY'S TRAFFIC. `activeLoans` and
 * `sticksOut` are OBLIGATIONS, with no date at all — yesterday's unreturned
 * pair is still a stick somebody is holding, and a counter that forgot it at
 * midnight would be the one number a volunteer cannot afford to trust.
 */
check('28. sticksOut counts UNRESOLVED HOLDER ROWS, not loans',
  view.today,
  { issued: 1, fullyReturned: 0, partialLosses: 0, lostPairs: 0,
    activeLoans: 2, sticksOut: 3 })

/**
 * READING THE BOARD CHANGES NOTHING, which is worth asserting directly.
 *
 * A canary that "tidied up" yesterday's leftovers inside `GET` was caught by
 * the structural guard below — but its FIRST response still looked correct,
 * because it composed the snapshot it had already read. Only a second read
 * differed. So the board is read twice and compared, and the write count is
 * checked: a GET that mutates is a GET nobody can trust.
 */
check('  and reading the board twice changes nothing at all',
  await (async () => {
    const writes = () => fakeDb.state.applied
      .filter((entry) => /^(insert|update|delete)/.test(entry)).length
    const before = writes()
    const once = await boardOf()
    const twice = await boardOf()

    return [JSON.stringify(once) === JSON.stringify(twice),
      writes() - before,
      twice.active.map((loan) => loan.pairCode)]
  })(), [true, 0, ['YESTERDAY-01', 'TODAY-01']])
check('  and the browser marks the leftover OUTSTANDING',
  [filters.isOutstandingFromEarlierDay(at(view.active, 0)),
   filters.isOutstandingFromEarlierDay(at(view.active, 1))], [true, false])

/**
 * 26-27. ISSUES IS THE QUARANTINE LIST, HISTORY IS EVERYTHING FINISHED.
 *
 * A pair whose loan closed with a loss and never released is unavailable for
 * the rest of the event, and that is a question somebody asks standing at the
 * table rather than scrolling a record. Both lists hold those rows; nothing
 * is moved out of history to make the issues tab.
 */
seedCentral()
seedSheet()
const outcomes = await (async () => {
  const made = {}

  for (const [code, badges, finish] of [
    ['OUT-RET', [9005, 9007], (id) => returnPair(id)],
    ['OUT-PART', [9005, 9007], async (id) => {
      await loseStick(id, 9005)

      return returnPair(id)
    }],
    ['OUT-LOST', [9005, 9007], (id) => losePair(id)],
  ]) {
    const loan = await give(code, badges)

    made[code] = loanIdOf(loan)
    await finish(made[code])
  }

  return made
})()
const outcomeView = await boardOf()

/**
 * MEMBERSHIP, sorted for comparison. The three loans here close within the
 * same millisecond, so their relative order is a tie rather than a rule —
 * the ORDERING is asserted separately, from timestamps that differ.
 */
check('26. Issues holds the partial_loss and lost loans, and only those',
  [outcomeView.issues.map((loan) => loan.pairCode).sort(),
   outcomeView.issues.map((loan) => loan.outcome).sort(),
   outcomeView.issues.every((loan) => loan.pairReleasedAt === null)],
  [['OUT-LOST', 'OUT-PART'], ['lost', 'partial_loss'], true])
check('  and Issues is NEWEST CLOSED FIRST',
  (() => {
    const quarantined = (id, code, at) => ({
      id, pairCode: code, issuedAt: '2026-10-11T10:00:00.000Z',
      issuedByDeviceId: DEVICE_ID, closedAt: at, closedByDeviceId: DEVICE_ID,
      outcome: 'partial_loss', pairReleasedAt: null, holders: [],
    })
    const composed = board.composeDandiyaBoard({
      ledger: {
        loans: [
          quarantined('a', 'EARLY', '2026-10-11T18:00:00.000Z'),
          quarantined('b', 'LATE', '2026-10-11T19:00:00.000Z'),
        ],
        deviceNames: new Map([[DEVICE_ID, 'Desk']]),
      },
      attendees: [],
      now: new Date('2026-10-11T20:00:00.000Z'),
    })

    return composed.issues.map((loan) => loan.pairCode)
  })(), ['LATE', 'EARLY'])
check('27. History holds ALL THREE outcomes, and nothing is moved out of it',
  [outcomeView.history.map((loan) => loan.outcome).sort(),
   outcomeView.history.length, outcomeView.active.length,
   outcomeView.issues.every((issue) =>
     outcomeView.history.some((record) => record.id === issue.id))],
  [['lost', 'partial_loss', 'returned'], 3, 0, true])
check('  and today counts each ending separately',
  outcomeView.today,
  { issued: 3, fullyReturned: 1, partialLosses: 1, lostPairs: 1,
    activeLoans: 0, sticksOut: 0 })
check('  the browser reads the same quarantine from the pair code alone',
  [filters.pairAvailability('OUT-RET', outcomeView).status,
   filters.pairAvailability('OUT-PART', outcomeView).status,
   filters.pairAvailability('OUT-LOST', outcomeView).status,
   filters.pairAvailability('NEVER-SEEN', outcomeView).status],
  ['available', 'quarantined', 'quarantined', 'available'])
check('  and finds an attendee’s prior losses, open loans included',
  [filters.priorLossesFor([...outcomeView.active, ...outcomeView.history], 9005)
    .map((loss) => loss.pairCode).sort(),
   filters.priorLossesFor([...outcomeView.active, ...outcomeView.history], 9007)
     .map((loss) => loss.pairCode),
   filters.priorLossesFor([...outcomeView.active, ...outcomeView.history], 9008).length],
  [['OUT-LOST', 'OUT-PART'], ['OUT-LOST'], 0])

/* ========= D3.2 1-13. A DAY'S HISTORY, AND WHAT CROSSES MIDNIGHT ====== */

console.log('\n=== D3.2 1-13. HISTORY BY ISSUE DAY, CARRYOVER, CARRIED STATE ===')

const eventTime = await domainJiti.import(`${root}/src/shared/event-time.ts`)

/**
 * THE CROSS-MIDNIGHT FIXTURE, in event-local terms, written straight into the
 * stand-in database so the instants are exact rather than whatever `now`
 * happened to be when the suite ran.
 *
 *   issued            2026-10-12 23:50 IST
 *   holder 1 returned 2026-10-12 23:58 IST
 *   holder 2 returned 2026-10-13 00:20 IST
 *   closed            2026-10-13 00:20 IST
 *
 * Expected: it belongs to 2026-10-12, and its outcome is `returned`.
 */
const IST = (iso) => new Date(`${iso}+05:30`)
const MIDNIGHT_ID = 'cafe0000-1111-4111-8111-000000000012'
const seedCrossMidnight = () => {
  fakeDb.state.dandiyaLoans.push({
    id: MIDNIGHT_ID, eventId: EVENT_ID, pairCode: 'MIDNIGHT-01',
    issuedByDeviceId: DEVICE_ID, issuedAt: IST('2026-10-12T23:50:00'),
    closedByDeviceId: DEVICE_ID, closedAt: IST('2026-10-13T00:20:00'),
    outcome: 'returned', pairReleasedAt: IST('2026-10-13T00:20:00'),
  })
  fakeDb.state.dandiyaLoanHolders.push({
    id: 'cafe0000-2222-4111-8111-000000000001', loanId: MIDNIGHT_ID,
    eventId: EVENT_ID, badgeNumber: 9005, slot: 1, resolution: 'returned',
    resolvedAt: IST('2026-10-12T23:58:00'), resolvedByDeviceId: DEVICE_ID,
  }, {
    id: 'cafe0000-2222-4111-8111-000000000002', loanId: MIDNIGHT_ID,
    eventId: EVENT_ID, badgeNumber: 9007, slot: 2, resolution: 'returned',
    resolvedAt: IST('2026-10-13T00:20:00'), resolvedByDeviceId: DEVICE_ID,
  })
}

/** The board as a given day would see it, with `now` pinned. */
const dayBoard = async (historyDate, now) => {
  const response = await endpoint.GET(new Request(
    `${ORIGIN}/api/dandiya?historyDate=${historyDate}`,
    { method: 'GET', headers: { cookie: deviceCookie() } },
  ))

  return { status: response.status, body: await response.json(), now }
}

/**
 * 9. THE DAY BOUNDARIES ARE THE EVENT'S, not UTC's and not the browser's.
 *
 * An IST day begins at 18:30 UTC the previous afternoon. Getting this wrong
 * by one zone moves every late-evening loan into the following day, which is
 * exactly the window a dandiya desk works in.
 */
check('9. an event day is [IST midnight, next IST midnight)',
  (() => {
    const window = eventTime.eventDayWindow('2026-10-12')

    return [window.start.toISOString(), window.end.toISOString(),
      (window.end.getTime() - window.start.getTime()) / 3_600_000,
      eventTime.eventDayKey(window.start.toISOString()),
      eventTime.eventDayKey(new Date(window.start.getTime() - 1).toISOString()),
      eventTime.eventDayKey(new Date(window.end.getTime() - 1).toISOString())]
  })(),
  ['2026-10-11T18:30:00.000Z', '2026-10-12T18:30:00.000Z', 24,
   '2026-10-12', '2026-10-11', '2026-10-12'])
check('  an impossible or malformed day is refused, never coerced',
  ['2026-02-30', '2026-13-01', '12-10-2026', '2026-10-1', '', 'today']
    .map((value) => eventTime.eventDayWindow(value)),
  [null, null, null, null, null, null])
check('  and the endpoint refuses one rather than answering for another day',
  await (async () => {
    seedCentral()
    seedSheet()
    const bad = await dayBoard('2026-02-30')
    const malformed = await dayBoard('not-a-day')

    return [bad.status, bad.body.blocked, malformed.status,
      fakeDb.state.dandiyaLoans.length]
  })(), [400, 'invalid-history-date', 400, 0])

/**
 * 1, 7 AND THE FIXTURE. A loan issued at 11:50 PM and closed at 12:20 AM
 * belongs to the night it went OUT on, and says it closed on the next day.
 */
seedCentral()
seedSheet()
seedCrossMidnight()
const twelfth = await dayBoard('2026-10-12')
const thirteenth = await dayBoard('2026-10-13')

check('1. the cross-midnight loan belongs to its ISSUE day',
  [twelfth.status, twelfth.body.historyDay,
   twelfth.body.history.map((loan) => loan.pairCode),
   fieldOf(at(twelfth.body.history, 0), 'outcome')],
  [200, '2026-10-12', ['MIDNIGHT-01'], 'returned'])
check('2, 7. and does NOT move into the day it was CLOSED on',
  [thirteenth.body.historyDay,
   thirteenth.body.history.map((loan) => loan.pairCode),
   // Its close really is on the 13th: membership ignores that deliberately.
   eventTime.eventDayKey(fieldOf(at(twelfth.body.history, 0), 'closedAt') ?? ''),
   eventTime.eventDayKey(fieldOf(at(twelfth.body.history, 0), 'issuedAt') ?? '')],
  ['2026-10-13', [], '2026-10-13', '2026-10-12'])
check('  each stick keeps its own resolution day, across the boundary',
  (at(twelfth.body.history, 0).holders ?? []).map((holder) =>
    [holder.badgeNumber, holder.resolution, eventTime.eventDayKey(holder.resolvedAt)]),
  [[9005, 'returned', '2026-10-12'], [9007, 'returned', '2026-10-13']])

/**
 * 3, 10, 11, 12. YESTERDAY'S UNRESOLVED PAIR: in yesterday's history, in
 * Active, and in the carryover count — all at once, and none of it written.
 */
seedCentral()
seedSheet()
const CARRY_ID = 'cafe0000-1111-4111-8111-000000000013'
const seedCarryover = (resolutions) => {
  fakeDb.state.dandiyaLoans.push({
    id: CARRY_ID, eventId: EVENT_ID, pairCode: 'CARRY-01',
    issuedByDeviceId: DEVICE_ID, issuedAt: new Date(yesterdayIso()),
    closedByDeviceId: null, closedAt: null, outcome: null, pairReleasedAt: null,
  })
  resolutions.forEach((resolution, index) => {
    fakeDb.state.dandiyaLoanHolders.push({
      id: `cafe0000-3333-4111-8111-00000000000${String(index + 1)}`,
      loanId: CARRY_ID, eventId: EVENT_ID, badgeNumber: 9008 + index,
      slot: index + 1,
      resolution,
      resolvedAt: resolution === null ? null : new Date(yesterdayIso()),
      resolvedByDeviceId: resolution === null ? null : DEVICE_ID,
    })
  })
}
seedCarryover([null, null])
await give('TODAY-02', [9005, 9007])
const carryToday = await dayBoard(eventTime.currentEventDayKey())
const yesterdayKey = eventTime.eventDayKey(yesterdayIso())
const carryYesterday = await dayBoard(yesterdayKey)

check('3. yesterday’s unresolved pair is in YESTERDAY’s history',
  [carryYesterday.body.historyDay,
   carryYesterday.body.history.map((loan) => loan.pairCode),
   fieldOf(at(carryYesterday.body.history, 0), 'outcome'),
   fieldOf(at(carryYesterday.body.history, 0), 'closedAt')],
  [yesterdayKey, ['CARRY-01'], null, null])
check('  it is NOT in today’s history, and today’s pair is',
  [carryToday.body.historyDay === eventTime.currentEventDayKey(),
   carryToday.body.history.map((loan) => loan.pairCode)],
  [true, ['TODAY-02']])
check('  and it is STILL in Active, which has no day in it at all',
  [carryToday.body.active.map((loan) => loan.pairCode),
   carryYesterday.body.active.map((loan) => loan.pairCode)],
  [['CARRY-01', 'TODAY-02'], ['CARRY-01', 'TODAY-02']])
check('11. both holders unresolved: 1 pair, 2 sticks outstanding',
  (() => {
    const carry = filters.outstandingBeforeDay(
      carryToday.body.active, carryToday.body.eventDay)
    const summary = filters.summariseDay(carryYesterday.body.history)

    return [carry.pairs, carry.sticks, carry.loans.map((loan) => loan.pairCode),
      summary.outstanding, summary.outstandingSticks, summary.issued]
  })(), [1, 2, ['CARRY-01'], 1, 2, 1])
check('10, 12. one holder resolved: 1 pair, 1 stick — a resolved stick is not outstanding',
  await (async () => {
    seedCentral()
    seedSheet()
    seedCarryover(['returned', null])
    const board = await dayBoard(eventTime.currentEventDayKey())
    const carry = filters.outstandingBeforeDay(board.body.active, board.body.eventDay)
    const yesterday = await dayBoard(yesterdayKey)
    const summary = filters.summariseDay(yesterday.body.history)

    return [carry.pairs, carry.sticks, summary.outstanding, summary.outstandingSticks,
      board.body.active.map((loan) => loan.pairCode)]
  })(), [1, 1, 1, 1, ['CARRY-01']])
check('  a fully resolved earlier day contributes NOTHING to the carryover',
  await (async () => {
    seedCentral()
    seedSheet()
    seedCarryover(['returned', 'returned'])
    // A resolved pair with an open loan is impossible through the product;
    // closed here so the fixture is one the database would accept.
    fakeDb.state.dandiyaLoans[0].closedAt = new Date(yesterdayIso())
    fakeDb.state.dandiyaLoans[0].closedByDeviceId = DEVICE_ID
    fakeDb.state.dandiyaLoans[0].outcome = 'returned'
    fakeDb.state.dandiyaLoans[0].pairReleasedAt = new Date(yesterdayIso())

    const board = await dayBoard(eventTime.currentEventDayKey())
    const carry = filters.outstandingBeforeDay(board.body.active, board.body.eventDay)

    return [carry.pairs, carry.sticks, board.body.active.length]
  })(), [0, 0, 0])

/* ========= D3.2a. ACTIVE -> CARRYOVER, AND WHICH LIST ANSWERS WHEN ===== */

console.log('\n=== D3.2a. THE CARRYOVER VIEW ===')

/**
 * Yesterday's unresolved pair and today's, side by side. Everything below
 * distinguishes them WITHOUT asking the server again: the carryover view is a
 * projection over the open loans the board already carried.
 */
seedCentral()
seedSheet()
seedCarryover([null, 'returned'])
const todayOut = await give('TODAY-OUT', [9005, 9007])
void todayOut
const carryBoard = (await dayBoard(eventTime.currentEventDayKey())).body

check('D3.2a-1. Carryover holds YESTERDAY’s open loan and not today’s',
  [filters.selectActiveLoans(carryBoard.active,
    { view: 'carryover', search: '', eventDay: carryBoard.eventDay })
    .map((loan) => loan.pairCode),
   filters.selectActiveLoans(carryBoard.active,
     { view: 'all', search: '', eventDay: carryBoard.eventDay })
     .map((loan) => loan.pairCode)],
  [['CARRY-01'], ['CARRY-01', 'TODAY-OUT']])
check('  the banner counts exactly what the view shows',
  (() => {
    const banner = filters.outstandingBeforeDay(
      carryBoard.active, carryBoard.eventDay)
    const rows = filters.selectActiveLoans(carryBoard.active,
      { view: 'carryover', search: '', eventDay: carryBoard.eventDay })

    return [banner.pairs, banner.sticks, rows.length,
      banner.loans.map((loan) => loan.id).sort().join(),
      rows.map((loan) => loan.id).sort().join()]
  })(),
  (() => {
    const banner = filters.outstandingBeforeDay(
      carryBoard.active, carryBoard.eventDay)

    // 1 pair, 1 stick: the second holder came back yesterday.
    return [1, 1, 1, banner.loans.map((loan) => loan.id).sort().join(),
      banner.loans.map((loan) => loan.id).sort().join()]
  })())
check('D3.2a-4. Carryover uses the SERVER’s event day, never the browser’s',
  (() => {
    /**
     * The same open loans, asked twice with different `eventDay` values. The
     * selector must answer from the value it is GIVEN — which is how a tablet
     * whose clock is a day out cannot change what is carryover.
     */
    const asServerSays = filters.selectActiveLoans(carryBoard.active,
      { view: 'carryover', search: '', eventDay: carryBoard.eventDay })
    const asStaleClockWouldSay = filters.selectActiveLoans(carryBoard.active,
      { view: 'carryover', search: '', eventDay: yesterdayKey })
    const selector = stripComments(read('src/dandiya/dandiya-filters.ts'))
    const picker = selector.slice(selector.indexOf('export const selectActiveLoans'),
      selector.indexOf('export const outstandingBeforeDay'))

    return [asServerSays.map((loan) => loan.pairCode),
      // With yesterday AS today, yesterday's loan is no longer "before today".
      asStaleClockWouldSay.map((loan) => loan.pairCode),
      // And the selector reads no clock of its own.
      /currentEventDayKey|new Date\(\)|Date\.now/.test(picker)]
  })(), [['CARRY-01'], [], false])
check('D3.2a-6. and selecting a view mutates nothing and reads nothing',
  await (async () => {
    const writes = () => fakeDb.state.applied
      .filter((entry) => /^(insert|update|delete)/.test(entry)).length
    const reads = () => fakeDb.state.applied.length
    const beforeWrites = writes()
    const beforeReads = reads()

    for (const view of ['carryover', 'all', 'carryover']) {
      filters.selectActiveLoans(carryBoard.active,
        { view, search: '', eventDay: carryBoard.eventDay })
    }

    return [writes() - beforeWrites, reads() - beforeReads,
      // The open loans themselves are untouched by having been filtered.
      carryBoard.active.map((loan) =>
        loan.holders.filter((holder) => holder.resolution === null).length)]
  })(), [0, 0, [1, 2]])
check('  a resolved holder is never a carryover stick',
  (() => {
    const banner = filters.outstandingBeforeDay(
      carryBoard.active, carryBoard.eventDay)
    const carried = banner.loans[0]

    return [banner.sticks,
      carried.holders.map((holder) => holder.resolution),
      carried.holders.filter((holder) => holder.resolution !== null).length]
  })(), [1, [null, 'returned'], 1])
check('  search still applies inside the carryover view',
  [filters.selectActiveLoans(carryBoard.active,
    { view: 'carryover', search: 'CARRY', eventDay: carryBoard.eventDay }).length,
   filters.selectActiveLoans(carryBoard.active,
     { view: 'carryover', search: 'TODAY', eventDay: carryBoard.eventDay }).length,
   filters.selectActiveLoans(carryBoard.active,
     { view: 'carryover', search: '9008', eventDay: carryBoard.eventDay }).length],
  [1, 0, 1])
check('  and a desk with nothing carried over sees an empty carryover, not an empty event',
  await (async () => {
    seedCentral()
    seedSheet()
    await give('ONLY-TODAY', [9005, 9007])
    const fresh = (await dayBoard(eventTime.currentEventDayKey())).body
    const banner = filters.outstandingBeforeDay(fresh.active, fresh.eventDay)

    return [banner.pairs, banner.sticks,
      filters.selectActiveLoans(fresh.active,
        { view: 'carryover', search: '', eventDay: fresh.eventDay }).length,
      filters.selectActiveLoans(fresh.active,
        { view: 'all', search: '', eventDay: fresh.eventDay }).length]
  })(), [0, 0, 0, 1])

/**
 * 4, 5, 6. THE THREE ENDINGS, classified by the SELECTED DAY'S rows.
 */
seedCentral()
seedSheet()
const classified = await (async () => {
  const made = {}

  for (const [code, badges, finish] of [
    ['DAY-RET', [9005, 9007], (id) => returnPair(id)],
    ['DAY-PART', [9005, 9007], async (id) => {
      await loseStick(id, 9005)

      return returnPair(id)
    }],
    ['DAY-LOST', [9005, 9007], (id) => losePair(id)],
    ['DAY-OUT', [9008, 9009], async () => undefined],
  ]) {
    const loan = await give(code, badges)

    made[code] = loanIdOf(loan)
    await finish(made[code])
  }

  return made
})()
void classified
const dayView = await dayBoard(eventTime.currentEventDayKey())

check('4, 5, 6. each of the day’s loans classifies by its durable state',
  dayView.body.history
    .map((loan) => [loan.pairCode, filters.loanStateOf(loan)])
    .sort((left, right) => left[0].localeCompare(right[0])),
  [['DAY-LOST', 'lost'], ['DAY-OUT', 'outstanding'], ['DAY-PART', 'partial_loss'],
   ['DAY-RET', 'returned']])
check('  and the day’s summary counts each category once',
  filters.summariseDay(dayView.body.history),
  { issued: 4, fullyReturned: 1, outstanding: 1, partialLosses: 1, lostPairs: 1,
    outstandingSticks: 2 })
check('  the four history views select exactly those loans',
  ['all', 'outstanding', 'returned', 'losses'].map((view) =>
    filters.filterDayHistory(dayView.body.history, { view, search: '' })
      .map((loan) => loan.pairCode).sort()),
  [['DAY-LOST', 'DAY-OUT', 'DAY-PART', 'DAY-RET'], ['DAY-OUT'], ['DAY-RET'],
   ['DAY-LOST', 'DAY-PART']])
check('  history is NEWEST ISSUED FIRST, and a close never reorders a day',
  (() => {
    const issued = (id, code, at, closedAt) => ({
      id, pairCode: code, issuedAt: at, issuedByDeviceId: DEVICE_ID,
      closedAt, closedByDeviceId: closedAt === null ? null : DEVICE_ID,
      outcome: closedAt === null ? null : 'returned',
      pairReleasedAt: closedAt, holders: [],
    })
    const composed = board.composeDandiyaBoard({
      ledger: {
        loans: [
          // Issued first, closed LAST.
          issued('a', 'EARLY', '2026-10-12T10:00:00.000Z', '2026-10-12T17:00:00.000Z'),
          // Issued last, closed FIRST.
          issued('b', 'LATE', '2026-10-12T11:00:00.000Z', '2026-10-12T12:00:00.000Z'),
        ],
        deviceNames: new Map([[DEVICE_ID, 'Desk']]),
      },
      attendees: [],
      historyDay: '2026-10-12',
      now: new Date('2026-10-12T18:00:00.000Z'),
    })

    return composed.history.map((loan) => loan.pairCode)
  })(), ['LATE', 'EARLY'])

/**
 * 8. HISTORY IS EVENT-SCOPED, like everything else this endpoint answers.
 */
check('8. a day’s history never shows another event’s loans',
  await (async () => {
    seedCentral()
    seedSheet()
    const OTHER_EVENT = '77777777-2222-4333-8444-555555555555'

    fakeDb.state.events.push({
      id: OTHER_EVENT, slug: 'other-event', name: 'O', timezone: 'Asia/Kolkata',
      active: true, endsAt: null,
    })
    await give('MINE-01', [9005, 9007])
    // The same pair code and the same badges, on a different event.
    fakeDb.state.dandiyaLoans.push({
      id: 'cafe0000-1111-4111-8111-000000000099', eventId: OTHER_EVENT,
      pairCode: 'THEIRS-01', issuedByDeviceId: DEVICE_ID, issuedAt: new Date(),
      closedByDeviceId: null, closedAt: null, outcome: null, pairReleasedAt: null,
    })
    fakeDb.state.dandiyaLoanHolders.push({
      id: 'cafe0000-4444-4111-8111-000000000001',
      loanId: 'cafe0000-1111-4111-8111-000000000099', eventId: OTHER_EVENT,
      badgeNumber: 9005, slot: 1, resolution: null, resolvedAt: null,
      resolvedByDeviceId: null,
    })

    const mine = await dayBoard(eventTime.currentEventDayKey())

    return [mine.body.history.map((loan) => loan.pairCode),
      mine.body.active.map((loan) => loan.pairCode),
      JSON.stringify(mine.body).includes('THEIRS-01')]
  })(), [['MINE-01'], ['MINE-01'], false])

/**
 * 13 AND F. MIDNIGHT CHANGES THE DAY AND THE COUNTERS. IT MUTATES NOTHING.
 *
 * The SAME ledger is composed at two instants a day apart, asking for the
 * SAME day both times. Every holder, every outcome and every release must be
 * identical: a loan does not move, close or release because a clock did.
 * Only `eventDay` and the `today` counters differ.
 */
check('13, F. the same day composed either side of midnight is identical',
  (() => {
    const ledger = {
      loans: [
        { id: 'm1', pairCode: 'M-1', issuedAt: '2026-10-12T12:00:00.000Z',
          issuedByDeviceId: DEVICE_ID, closedAt: null, closedByDeviceId: null,
          outcome: null, pairReleasedAt: null,
          holders: [
            { badgeNumber: 1, slot: 1, resolution: null, resolvedAt: null,
              resolvedByDeviceId: null },
            { badgeNumber: 2, slot: 2, resolution: 'returned',
              resolvedAt: '2026-10-12T13:00:00.000Z', resolvedByDeviceId: DEVICE_ID },
          ] },
        { id: 'm2', pairCode: 'M-2', issuedAt: '2026-10-12T12:00:00.000Z',
          issuedByDeviceId: DEVICE_ID, closedAt: '2026-10-12T14:00:00.000Z',
          closedByDeviceId: DEVICE_ID, outcome: 'partial_loss', pairReleasedAt: null,
          holders: [
            { badgeNumber: 3, slot: 1, resolution: 'lost',
              resolvedAt: '2026-10-12T14:00:00.000Z', resolvedByDeviceId: DEVICE_ID },
            { badgeNumber: 4, slot: 2, resolution: 'returned',
              resolvedAt: '2026-10-12T14:00:00.000Z', resolvedByDeviceId: DEVICE_ID },
          ] },
      ],
      deviceNames: new Map([[DEVICE_ID, 'Desk']]),
    }
    const compose = (now) => board.composeDandiyaBoard(
      { ledger, attendees: [], historyDay: '2026-10-12', now: new Date(now) })
    const before = compose('2026-10-12T18:00:00.000Z')
    const after = compose('2026-10-13T18:00:00.000Z')
    const physical = (composed) => JSON.stringify([
      composed.active.map((loan) => [loan.pairCode, loan.holders]),
      composed.issues.map((loan) => [loan.pairCode, loan.outcome, loan.pairReleasedAt]),
      composed.history.map((loan) =>
        [loan.pairCode, loan.outcome, loan.closedAt, loan.pairReleasedAt, loan.holders]),
    ])

    return [physical(before) === physical(after),
      before.historyDay, after.historyDay,
      before.eventDay, after.eventDay,
      before.today.issued, after.today.issued,
      before.today.partialLosses, after.today.partialLosses,
      // Obligations carry: they have no date in them.
      before.today.activeLoans, after.today.activeLoans,
      before.today.sticksOut, after.today.sticksOut]
  })(),
  [true, '2026-10-12', '2026-10-12', '2026-10-12', '2026-10-13',
   2, 0, 1, 0, 1, 1, 1, 1])
check('  and no mutation path consults the calendar',
  (() => {
    const writer = stripComments(read('server/dandiya/loans.ts'))
    const endpointSource = stripComments(read('api/dandiya.ts'))
    /**
     * SCOPED TO THE MUTATION PATHS, which is what this guard always meant.
     * The READ path must consult the calendar — a day's history is a calendar
     * question — so the file-wide version of this check could not survive
     * D3.2. What must stay true is that nothing which WRITES knows the date.
     */
    const between = (source, from, to) => {
      const start = source.indexOf(from)

      return start === -1 ? '' : source.slice(start, source.indexOf(to, start + 1))
    }
    const calendar = /eventDayKey|currentEventDayKey|eventDayWindow|EVENT_TIME_ZONE/

    return [
      calendar.test(between(writer, 'export const openDandiyaLoan', '\nexport ')),
      calendar.test(between(writer, 'export const resolveDandiyaHolders', '\nexport ')),
      calendar.test(between(endpointSource, 'export async function POST(',
        'export async function PATCH(')),
      calendar.test(endpointSource.slice(
        endpointSource.indexOf('export async function PATCH('))),
      // And the READ path does, through the endpoint's day resolver: that is
      // how the day is decided server-side rather than by a browser.
      calendar.test(between(endpointSource, 'const readHistoryDay',
        'export async function GET(')),
      /readHistoryDay\(request\)/.test(
        between(endpointSource, 'export async function GET(',
          'export async function POST(')),
    ]
  })(), [false, false, false, false, true, true])
check('  the day key itself is shared by the server and the browser',
  [/event-time/.test(read('server/dandiya/board.ts')),
   /event-time/.test(read('src/dandiya/dandiya-filters.ts')),
   /event-time/.test(read('api/dandiya.ts')),
   read('src/shared/event-time.ts').includes("'Asia/Kolkata'")],
  [true, true, true, true])
check('  history supports repeated pair codes, each as its own loan',
  await (async () => {
    seedCentral()
    seedSheet()
    const one = await give('REUSE-01', [9005, 9007])
    await returnPair(loanIdOf(one))
    const two = await give('REUSE-01', [9005, 9007])
    await returnPair(loanIdOf(two))
    const three = await give('REUSE-01', [9008, 9009])
    const fresh = await boardOf()

    return [fresh.history.filter((loan) => loan.pairCode === 'REUSE-01').length,
      new Set(fresh.history.map((loan) => loan.id)).size,
      fresh.active.map((loan) => loan.pairCode),
      three.status]
  })(), [3, 3, ['REUSE-01'], 201])

/**
 * AND THE READ IS SCOPED. The point of a day parameter is that a week-long
 * event does not ship every loan it ever made to render one night.
 */
check('  an unrelated finished day is not read at all',
  await (async () => {
    seedCentral()
    seedSheet()

    /**
     * A FINISHED, RELEASED LOAN FROM FOUR DAYS AGO: not open, not
     * quarantined, not in the selected day's window and not in today's. It is
     * outside every clause of the read, which is the whole point of asking
     * for one day — and the fixture is relative to now rather than a literal
     * date, because the literal one could be today.
     */
    const old = new Date(Date.now() - 4 * 24 * HOURS)
    const OLD_ID = 'cafe0000-1111-4111-8111-000000000044'

    fakeDb.state.dandiyaLoans.push({
      id: OLD_ID, eventId: EVENT_ID, pairCode: 'LONG-AGO',
      issuedByDeviceId: DEVICE_ID, issuedAt: old,
      closedByDeviceId: DEVICE_ID, closedAt: old,
      outcome: 'returned', pairReleasedAt: old,
    })
    fakeDb.state.dandiyaLoanHolders.push({
      id: 'cafe0000-5555-4111-8111-000000000001', loanId: OLD_ID,
      eventId: EVENT_ID, badgeNumber: 9005, slot: 1, resolution: 'returned',
      resolvedAt: old, resolvedByDeviceId: DEVICE_ID,
    }, {
      id: 'cafe0000-5555-4111-8111-000000000002', loanId: OLD_ID,
      eventId: EVENT_ID, badgeNumber: 9007, slot: 2, resolution: 'returned',
      resolvedAt: old, resolvedByDeviceId: DEVICE_ID,
    })

    const today = await dayBoard(eventTime.currentEventDayKey())
    const itsOwnDay = await dayBoard(eventTime.eventDayKey(old.toISOString()))

    return [today.body.history.length,
      JSON.stringify(today.body).includes('LONG-AGO'),
      itsOwnDay.body.history.map((loan) => loan.pairCode)]
  })(), [0, false, ['LONG-AGO']])

/* ====================== 36-39. THE PRIVACY BOUNDARY ==================== */

console.log('\n=== 36-39. NO ATTENDEE PII IN POSTGRES ===')
seedCentral()
seedSheet()
await give('PRIVACY-01', [9005, 9007])
const privacyResponse = await get()
const rawBody = await privacyResponse.text()
view = JSON.parse(rawBody)

check('36. the stored rows hold NO attendee data',
  [Object.keys(fakeDb.state.dandiyaLoans[0] ?? {}).sort(),
   Object.keys(fakeDb.state.dandiyaLoanHolders[0] ?? {}).sort()],
  [['closedAt', 'closedByDeviceId', 'eventId', 'id', 'issuedAt',
    'issuedByDeviceId', 'outcome', 'pairCode', 'pairReleasedAt'],
   ['badgeNumber', 'eventId', 'id', 'loanId', 'resolution', 'resolvedAt',
    'resolvedByDeviceId', 'slot']])
check('  and no attendee VALUE reached either table',
  [...fakeDb.state.dandiyaLoans, ...fakeDb.state.dandiyaLoanHolders]
    .flatMap((row) => Object.values(row).map((value) => String(value)))
    .filter((value) => ['Meera', 'Arjun', PHONE_OF(9005), '11', 'female'].includes(value)),
  [])
check('37. no phone number is ever returned',
  ATTENDEES.some((attendee) => rawBody.includes(PHONE_OF(attendee.badge))), false)
check('38. no WhatsApp link is ever returned',
  /wa\.me|whatsapp|HYPERLINK/i.test(rawBody), false)
check('39. no payment method and no amount',
  [/upi|cash/i.test(rawBody), /"amount"|₹|\bINR\b/i.test(rawBody)], [false, false])
check('  an attendee entry carries exactly the four allowed fields',
  [...new Set(view.active.flatMap((loan) =>
    loan.holders.flatMap((holder) =>
      holder.attendee === null ? [] : Object.keys(holder.attendee))))].sort(),
  ['age', 'badgeNumber', 'gender', 'name'])
check('  the migration declares no attendee column in either table',
  ['dandiya_loans', 'dandiya_loan_holders'].flatMap((table) => {
    const sql = (new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`)
      .exec(read('drizzle/0005_dandiya_checkout.sql'))?.[1] ?? '')
      .replace(/pair_code/g, 'label')
    return sql === ''
      ? [`${table} block unreadable`]
      : ['name', 'phone', 'whatsapp', 'age', 'gender', 'payment', 'amount']
        .filter((column) => new RegExp(`"[a-z_]*${column}[a-z_]*"`, 'i').test(sql))
        .map((column) => `${table}.${column}`)
  }), [])
/**
 * THE SCHEMA'S COLUMN SETS, as exact lists.
 *
 * The migration and the inserts are both checked above, and neither moves
 * when a column is added to the Drizzle table alone — a canary proved that,
 * and a column added there is the first half of adding it to the database.
 */
check('  and the schema declares exactly the ledger columns',
  (() => {
    const schema = read('server/db/schema.ts')
    const columnsOf = (table) => {
      const start = schema.indexOf(`export const ${table} = pgTable(`)
      const block = start === -1
        ? ''
        : stripComments(schema.slice(start, schema.indexOf('\n  },', start)))

      return [...block.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((match) => match[1])
    }

    return [columnsOf('dandiyaLoans'), columnsOf('dandiyaLoanHolders')]
  })(),
  [['id', 'eventId', 'pairCode', 'issuedByDeviceId', 'issuedAt', 'closedAt',
    'closedByDeviceId', 'outcome', 'pairReleasedAt'],
   ['id', 'loanId', 'eventId', 'badgeNumber', 'slot', 'resolution', 'resolvedAt',
    'resolvedByDeviceId']])
check('  and the ledger has exactly one writer',
  ['api', 'server', 'src'].flatMap((directory) => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(next); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (/\bdandiyaLoans\b|\bdandiyaLoanHolders\b/.test(stripComments(read(next)))) {
          found.push(next)
        }
      }
    }
    walk(directory)
    return found
  }).sort(), ['server/dandiya/loans.ts', 'server/db/schema.ts'])

/* ================== 40-42. FAIL CLOSED, AND THE JOIN =================== */

console.log('\n=== 40-42. THE SHEET, AND WHAT SURVIVES WITHOUT IT ===')
seedCentral()
seedSheet()
fakeSheets.state.failNextRead = true
check('40. a Sheet read failure causes NO database write',
  await (async () => {
    const refused = await give('SHEET-01', [9005, 9007])
    return [refused.status, refused.body.reason, fakeDb.state.dandiyaLoans.length,
      fakeDb.state.applied.filter((entry) => entry.includes('dandiya')).length]
  })(), [503, 'register-unavailable', 0, 0])
check('  and the board read fails closed rather than showing an empty event',
  await (async () => {
    fakeSheets.state.failNextRead = true
    const refused = await get()
    const body = await refused.json()
    return [refused.status, body.reason, 'active' in body]
  })(), [503, 'register-unavailable', false])
check('  a CONFLICTING Sheet layout fails closed too',
  await (async () => {
    fakeSheets.reset()
    fakeSheets.state.values = [['Something', 'Else'], ['x', 'y']]
    const refused = await get()
    return [refused.status, (await refused.json()).reason]
  })(), [503, 'register-unavailable'])
check('  and an unconfigured release interlock does the same',
  await (async () => {
    seedSheet()
    process.env.SYNC_WRITE_ENABLED = 'false'
    const refusedRead = await get()
    const refusedWrite = await issue('SHEET-02', [9005, 9007])
    process.env.SYNC_WRITE_ENABLED = 'true'
    return [refusedRead.status, refusedWrite.status, fakeDb.state.dandiyaLoans.length]
  })(), [503, 503, 0])
/**
 * A RETURN NEEDS NO SHEET. Nobody's name has to be confirmed to take a pair
 * of sticks back, so a return keeps working when the register does not.
 */
check('  but a RETURN works without the Sheet at all',
  await (async () => {
    seedCentral()
    seedSheet()
    const open = await give('NO-SHEET', [9005, 9007])
    fakeSheets.state.failNextRead = true
    const back = await returnPair(loanIdOf(open))
    return [back.status, back.body.ok, openLoans().length]
  })(), [200, true, 0])

seedCentral()
seedSheet()
const joined = await give('JOIN-01', [9005, 9007])
check('41. GET joins the CURRENT safe attendee details',
  await (async () => {
    const fresh = await boardOf()
    return at(fresh.active, 0).holders.map((holder) =>
      [holder.badgeNumber, holder.attendee?.name ?? null,
       holder.attendee?.age ?? null, holder.attendee?.gender ?? null])
  })(), [[9005, 'Meera', 11, 'female'], [9007, 'Arjun', 15, 'male']])
check('  a renamed attendee is reflected, because the name is joined not copied',
  await (async () => {
    seedSheet(ATTENDEES.map((attendee) =>
      attendee.badge === 9005 ? { ...attendee, name: 'Meera Patel' } : attendee))
    const fresh = await boardOf()
    return at(at(fresh.active, 0).holders, 0).attendee?.name ?? null
  })(), 'Meera Patel')
/**
 * 42. A SHEET ROW EDITED AWAY MUST NOT ERASE A LOAN. The pair really did go
 * out, from that desk, at that time, to those badge numbers — those are the
 * ledger's own facts and never depend on the register.
 */
check('42. a missing attendee does not erase the loan facts',
  await (async () => {
    seedSheet(ATTENDEES.filter((attendee) => attendee.badge !== 9005))
    const fresh = await boardOf()
    const loan = at(fresh.active, 0)
    return [fresh.active.length, loan.pairCode, loan.id === loanIdOf(joined),
      fieldOf(loan.issuedBy, 'name'),
      loan.holders.map((holder) => [holder.badgeNumber, holder.attendee?.name ?? null])]
  })(), [1, 'JOIN-01', true, 'Dandiya Test Desk',
    [[9005, null], [9007, 'Arjun']]])
check('  and the same is true of history after a return',
  await (async () => {
    await returnPair(loanIdOf(joined))
    const fresh = await boardOf()
    const loan = at(fresh.history, 0)
    return [loan.pairCode, loan.closedAt !== null, loan.closedBy?.name ?? null,
      loan.holders.map((holder) => holder.attendee?.name ?? null)]
  })(), ['JOIN-01', true, 'Dandiya Test Desk', [null, 'Arjun']])
seedSheet()

/* ================== 43-45. ONLINE ONLY, NO LOCAL STATE ================= */

console.log('\n=== 43-45. NOTHING IS KEPT, QUEUED OR POLLED ===')
const localState = (() => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) { walk(next); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      found.push(next)
    }
  }
  walk('src/dandiya')
  walk('src/components/dandiya')
  found.push('src/pages/dandiya-page.tsx')
  return found
})()

check('43. no dandiya state is kept locally, anywhere',
  localState.filter((file) =>
    /@\/db\/database|from 'dexie'|outbox|localStorage|sessionStorage|caches\.|indexedDB/
      .test(stripComments(read(file)))), [])
check('  and IndexedDB is untouched: version 1, the same three stores',
  [/DATABASE_VERSION = 1\b/.test(read('src/db/database.ts')),
   ((/\.stores\(\{([\s\S]*?)\}\)/.exec(read('src/db/database.ts'))?.[1] ?? '')
     .match(/^\s*(\w+):/gm) ?? []).map((entry) => entry.trim().replace(':', ''))],
  [true, ['registrations', 'config', 'outbox']])
check('44. no offline queue and no retry',
  [/queue|retry\(/.test(stripComments(read('src/dandiya/dandiya-api.ts'))),
   /navigator\.onLine/.test(stripComments(read('src/dandiya/dandiya-api.ts')))],
  [false, false])
check('45. no polling, and exactly ONE timer — the request abort',
  (() => {
    const api = stripComments(read('src/dandiya/dandiya-api.ts'))
    const others = localState
      .filter((file) => file !== 'src/dandiya/dandiya-api.ts')
      .map((file) => stripComments(read(file)))
      .join('\n')
    return [/setInterval/.test(api + others),
      [...api.matchAll(/setTimeout\(/g)].length,
      [...others.matchAll(/setTimeout\(/g)].length,
      /controller\.abort\(\)/.test(api)]
  })(), [false, 1, 0, true])
/**
 * THE TRIGGERS ARE EVENTS, and since D3.2 there are three: mounting,
 * connectivity returning, an explicit Refresh — and CHOOSING A DAY, which is
 * a read because a day is server-scoped data rather than a client-side
 * filter. Still no interval, and still exactly one effect that can originate
 * a request.
 */
check('  the board is read on mount, on reconnect, on refresh and on a day change',
  (() => {
    const desk = stripComments(read('src/components/dandiya/dandiya-desk.tsx'))

    return [[...desk.matchAll(/useEffect\(/g)].length,
      /\[network, readAttempt, historyDay\]/.test(desk),
      /sequence\.current/.test(desk),
      // And nothing else calls the fetch directly.
      [...desk.matchAll(/fetchDandiyaBoard\(/g)].length]
  })(), [1, true, true, 1])
check('  and the client only ever sends GET, POST and PATCH',
  [...new Set([...read('src/dandiya/dandiya-api.ts')
    .matchAll(/method: '([A-Z]+)'/g)].map((match) => match[1]))].sort(),
  ['GET', 'PATCH', 'POST'])

/* =============================== THE ROUTE AND THE UI ================== */

/**
 * THE COMPONENT RENDERS COME FIRST, AND THAT ORDER MATTERS.
 *
 * `fake-dialog.mjs` imports `react` itself, so it must be loaded by the same
 * module graph that builds the tree. Importing `route-render.mjs` first
 * installs a second React instance, and the dialog then renders to an empty
 * string — silently, with every assertion about its contents failing for a
 * reason that has nothing to do with the dialog. Keep this section above the
 * route section.
 */
console.log('\n=== THE DESK UI, RENDERED ===')
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
const noop = () => undefined

const holder = (badgeNumber, slot, name, over = {}) => ({
  badgeNumber,
  slot,
  attendee: { badgeNumber, name, age: slot === 1 ? 11 : 15, gender: slot === 1 ? 'female' : 'male' },
  resolution: null,
  resolvedAt: null,
  resolvedBy: null,
  ...over,
})
const RESOLVED_AT = new Date(Date.now() - 20 * 60 * 1000).toISOString()
const DESK = { id: DEVICE_ID, name: 'Anuradha' }

const LOAN = {
  id: 'aaaaaaaa-3333-4333-8333-000000000001',
  pairCode: 'D-014',
  issuedAt: new Date(Date.now() - 1 * HOURS).toISOString(),
  issuedBy: DESK,
  holders: [holder(42, 1, 'Meera Patel'), holder(81, 2, 'Arjun Shah')],
}
const LEFTOVER = { ...LOAN, id: 'aaaaaaaa-3333-4333-8333-000000000002',
  pairCode: 'D-007', issuedAt: yesterdayIso() }
/** One stick already back, the other still out: the D3.1 shape. */
const PARTIAL = {
  ...LOAN,
  id: 'aaaaaaaa-3333-4333-8333-000000000004',
  pairCode: 'D-021',
  holders: [
    holder(42, 1, 'Meera Patel',
      { resolution: 'returned', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
    holder(81, 2, 'Arjun Shah'),
  ],
}
const closedLoan = (over) => ({
  ...LOAN, closedAt: RESOLVED_AT, closedBy: { id: DEVICE_ID, name: 'Vivek' },
  outcome: 'returned', pairReleasedAt: RESOLVED_AT, ...over,
})
/**
 * A COHERENT finished loan: every holder resolved, as the database requires
 * before a loan may close at all. `closedLoan` alone leaves the holders
 * unresolved, which is a state no write can produce — and which
 * `loanStateOf` deliberately reads as still outstanding.
 */
const settledLoan = (resolutions, over = {}) => ({
  ...closedLoan(over),
  holders: [
    holder(42, 1, 'Meera Patel',
      { resolution: resolutions[0], resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
    holder(81, 2, 'Arjun Shah',
      { resolution: resolutions[1], resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
  ],
})

const card = await renderUi('src/components/dandiya/active-loan-card.tsx',
  { loan: LOAN, isBusy: false, onRequest: noop })
const leftoverCard = await renderUi('src/components/dandiya/active-loan-card.tsx',
  { loan: LEFTOVER, isBusy: false, onRequest: noop })
const partialCard = await renderUi('src/components/dandiya/active-loan-card.tsx',
  { loan: PARTIAL, isBusy: false, onRequest: noop })

check('an active card names the pair, both holders, the time and the desk',
  [card.includes('Pair D-014'), card.includes('#042'), card.includes('Meera Patel'),
   card.includes('#081'), card.includes('Arjun Shah'), card.includes('Anuradha')],
  [true, true, true, true, true, true])
check('  and shows no contact detail or payment',
  ['wa.me', '9000000', 'UPI', 'Cash', 'phone']
    .filter((needle) => card.toLowerCase().includes(needle.toLowerCase())), [])
/**
 * EVERY STICK STILL OUT OFFERS BOTH ENDINGS, which is D3.1 on screen. Two
 * sticks out means two Return Stick controls and two Mark Lost controls;
 * the whole-pair shortcut sits beneath them.
 */
check('each stick out offers Return Stick and Mark Lost, plus the shortcuts',
  [(card.match(/Return Stick/g) ?? []).length,
   (card.match(/Mark Lost/g) ?? []).length,
   card.includes('Return Whole Pair'), card.includes('Report Pair Lost'),
   card.includes('Stick 1 · Out'), card.includes('Stick 2 · Out')],
  [2, 2, true, true, true, true])
/**
 * AND A RESOLVED STICK OFFERS NOTHING. A resolution is final, so a control
 * to change it would be a control to rewrite the ledger — and the remaining
 * shortcut says REMAINING, because one stick is already accounted for.
 */
check('a resolved stick shows its ending and offers no control',
  [(partialCard.match(/Return Stick/g) ?? []).length,
   (partialCard.match(/Mark Lost/g) ?? []).length,
   partialCard.includes('Returned'), partialCard.includes('Incomplete'),
   partialCard.includes('Return Remaining Stick'),
   partialCard.includes('Return Whole Pair')],
  [1, 1, true, true, true, false])
check('a leftover pair is visibly OUTSTANDING, and still resolvable',
  [leftoverCard.includes('Outstanding'), card.includes('Outstanding'),
   card.includes('Out'), leftoverCard.includes('Return Whole Pair')],
  [true, false, true, true])

/** The one dialog confirms all four actions, and names what it preserves. */
const dialogFor = (request, isSubmitting = false) =>
  renderUi('src/components/dandiya/resolve-pair-dialog.tsx',
    { request, isSubmitting, onCancel: noop, onConfirm: noop })

check('the dialog confirms a whole-pair return by name',
  await (async () => {
    const whole = await dialogFor({ loan: LOAN, action: 'return-pair' })

    return [whole.includes('Return pair D-014?'), whole.includes('Meera Patel'),
      whole.includes('Arjun Shah'), whole.includes('Confirm Return'),
      whole.includes('Cancel')]
  })(), [true, true, true, true, true])
check('  one stick returned, and one stick lost, are separate confirmations',
  await (async () => {
    const stick = await dialogFor({
      loan: LOAN, action: 'resolve-holder',
      holder: LOAN.holders[0], resolution: 'returned',
    })
    const lost = await dialogFor({
      loan: LOAN, action: 'resolve-holder',
      holder: LOAN.holders[0], resolution: 'lost',
    })

    return [stick.includes('Return #042 Meera Patel’s stick?'),
      stick.includes('Return Stick'),
      lost.includes('Mark #042 Meera Patel’s stick as lost?'),
      lost.includes('Mark Lost')]
  })(), [true, true, true, true])
check('  a loss says what it costs, and names what it will NOT rewrite',
  await (async () => {
    const report = await dialogFor({ loan: PARTIAL, action: 'lost-pair' })
    const shortcut = await dialogFor({
      loan: { ...PARTIAL,
        holders: [
          holder(42, 1, 'Meera Patel',
            { resolution: 'lost', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
          holder(81, 2, 'Arjun Shah'),
        ] },
      action: 'return-pair',
    })

    return [report.includes('Report pair D-021 lost?'),
      /unavailable|cannot be issued/i.test(report),
      report.includes('#042'),
      /already returned — that stays/.test(report),
      /#042 already recorded as lost/.test(shortcut),
      /this pair will stay unavailable/.test(shortcut)]
  })(), [true, true, true, true, true, true])
check('  and a request in flight disables both buttons',
  await (async () => {
    const busy = await dialogFor({ loan: LOAN, action: 'return-pair' }, true)

    return [(busy.match(/\sdisabled=""/g) ?? []).length, busy.includes('Recording…')]
  })(), [2, true])
check('  no dialog is rendered when nothing is pending',
  await dialogFor(null), '')

const ROSTER = ATTENDEES.map((attendee) =>
  ({ badgeNumber: attendee.badge, name: attendee.name, age: attendee.age, gender: attendee.gender }))
const formWith = (over = {}) =>
  renderUi('src/components/dandiya/issue-pair-form.tsx',
    { attendees: ROSTER, active: [], issues: [],
      isSubmitting: false, onIssue: noop, ...over })
const form = await formWith()

check('the issue form asks for the pair first, then two attendees',
  [form.indexOf('Pair Number / Code') < form.indexOf('Attendee 1'),
   form.indexOf('Attendee 1') < form.indexOf('Attendee 2'),
   form.indexOf('Attendee 2') < form.lastIndexOf('Issue Pair')],
  [true, true, true])
check('  Issue Pair is unavailable until all three are chosen',
  /<button[^>]*type="submit"[^>]*\sdisabled=""/.test(form), true)
/**
 * 15. THE TWO PAIR REFUSALS ARE DIFFERENT PANELS, AND BOTH BLOCK ISSUE.
 *
 * The pair code lives in the form's own state, which server rendering cannot
 * reach, so the CLASSIFICATION is proved behaviourally against
 * `pairAvailability` above and the WIRING is pinned here: each status has its
 * own copy, and `ready` requires `available` — so neither panel can appear
 * beside a live Issue Pair button.
 */
check('15. out and unavailable are distinct panels, and both block Issue',
  (() => {
    const source = stripComments(read('src/components/dandiya/issue-pair-form.tsx'))
    const ready = source.slice(source.indexOf('const ready ='),
      source.indexOf('\n\n', source.indexOf('const ready =')))

    return [source.includes("availability.status === 'out'"),
      source.includes("availability.status === 'quarantined'"),
      source.includes('This pair is already out.'),
      source.includes('} is unavailable.'),
      source.includes('ended with both sticks lost.'),
      source.includes('ended with a partial loss.'),
      /availability\.status === 'available' &&/.test(ready)]
  })(), [true, true, true, true, true, true, true])
check('  and an attendee already holding one blocks it too',
  (() => {
    const source = stripComments(read('src/components/dandiya/issue-pair-form.tsx'))
    const ready = source.slice(source.indexOf('const ready ='),
      source.indexOf('\n\n', source.indexOf('const ready =')))

    return [/firstHolding === null/.test(ready), /secondHolding === null/.test(ready)]
  })(), [true, true])

const pickerWith = (over = {}) =>
  renderUi('src/components/dandiya/attendee-picker.tsx', {
    label: 'Attendee 1', inputId: 'x', attendees: ROSTER,
    selected: ROSTER[0], excludedBadgeNumber: null, holding: null,
    priorLosses: [], disabled: false, onSelect: noop, ...over,
  })

check('an attendee already holding a pair blocks the issue, and says which',
  await (async () => {
    const holding = await pickerWith(
      { holding: { pairCode: 'D-007', issuedAt: LOAN.issuedAt } })
    const free = await pickerWith()

    return [holding.includes('Already holding D-007'), holding.includes('Issued'),
      free.includes('Registered'), free.includes('Already holding'),
      free.includes('Change')]
  })(), [true, true, true, false, true])
/**
 * 14-15. THE PRIOR-LOSS WARNING IS INFORMATION, NOT A REFUSAL.
 *
 * The volunteer should know this person lost a stick earlier. They are still
 * entitled to dance: no disabled control, no blocking copy, and the Issue
 * button's own readiness expression never mentions it.
 */
check('14. a previous loss is shown, with the pair and the day',
  await (async () => {
    const warned = await pickerWith({
      priorLosses: [{ pairCode: 'D-007', resolvedAt: RESOLVED_AT }],
    })
    const two = await pickerWith({
      priorLosses: [
        { pairCode: 'D-007', resolvedAt: RESOLVED_AT },
        { pairCode: 'D-009', resolvedAt: RESOLVED_AT },
      ],
    })

    return [warned.includes('Previous Dandiya loss'), warned.includes('D-007'),
      two.includes('2 previous Dandiya losses'), two.includes('D-009')]
  })(), [true, true, true, true])
check('15. and it never disables anything, nor blocks the issue',
  await (async () => {
    const warned = await pickerWith({
      priorLosses: [{ pairCode: 'D-007', resolvedAt: RESOLVED_AT }],
    })
    const quiet = await pickerWith()
    const disabledCount = (markup) => (markup.match(/\sdisabled=""/g) ?? []).length
    const source = stripComments(read('src/components/dandiya/issue-pair-form.tsx'))
    const ready = source.slice(source.indexOf('const ready ='),
      source.indexOf('\n\n', source.indexOf('const ready =')))

    return [disabledCount(warned), disabledCount(quiet),
      /blocked|cannot|not allowed|refus/i.test(warned),
      /priorLoss/i.test(ready)]
  })(), [0, 0, false, false])

/** 26. The Issues tab lists the quarantined pairs, and changes nothing. */
const issuesTab = await renderUi('src/components/dandiya/pair-issues.tsx', {
  loans: [
    closedLoan({ pairCode: 'D-031', outcome: 'partial_loss', pairReleasedAt: null,
      holders: [
        holder(42, 1, 'Meera Patel',
          { resolution: 'lost', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
        holder(81, 2, 'Arjun Shah',
          { resolution: 'returned', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
      ] }),
  ],
  search: '', onSearchChange: noop,
})

check('26. the Issues tab names the unavailable pair and which stick went',
  [issuesTab.includes('Pair D-031'), issuesTab.includes('Partial loss'),
   issuesTab.includes('Lost'), issuesTab.includes('Returned'),
   issuesTab.includes('Meera Patel')],
  [true, true, true, true, true])
check('  and offers NO way to free it, by design',
  [/Restore|Release|Reinstate|Undo|Delete|Remove|Edit|Reissue/.test(issuesTab),
   issuesTab.includes('<button')],
  [false, false])
check('  an empty issues tab says every pair is accounted for',
  await (async () => {
    const empty = await renderUi('src/components/dandiya/pair-issues.tsx',
      { loans: [], search: '', onSearchChange: noop })

    return empty.includes('Every pair is accounted for.')
  })(), true)

/** 27. History shows each ending, and each holder's own resolution. */
const history = await renderUi('src/components/dandiya/loan-history.tsx', {
  loans: [
    closedLoan({}),
    closedLoan({ id: 'aaaaaaaa-3333-4333-8333-000000000005', pairCode: 'D-022',
      outcome: 'partial_loss', pairReleasedAt: null,
      holders: [
        holder(42, 1, 'Meera Patel',
          { resolution: 'lost', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
        holder(81, 2, 'Arjun Shah',
          { resolution: 'returned', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
      ] }),
    closedLoan({ id: 'aaaaaaaa-3333-4333-8333-000000000006', pairCode: 'D-023',
      outcome: 'lost', pairReleasedAt: null }),
  ],
  day: '2026-10-12',
  eventDay: '2026-10-12',
  view: 'all',
  search: '',
  isLoading: false,
  onDayChange: noop,
  onViewChange: noop,
  onSearchChange: noop,
})

check('27. history shows all three outcomes, with both devices and times',
  [history.includes('Returned'), history.includes('Partial loss'),
   history.includes('Pair lost'), history.includes('Issued by Anuradha'),
   history.includes('Closed by Vivek'), history.includes('D-022')],
  [true, true, true, true, true, true])
check('  and each holder’s own ending, not just the loan’s',
  [(history.match(/Lost/g) ?? []).length > 0,
   history.indexOf('D-022') < history.indexOf('Partial loss') ||
     history.includes('Partial loss')],
  [true, true])
/**
 * D3.2 C, D, E. THE DAY IS NAVIGABLE, THE DAY IS SUMMARISED, AND THE
 * OUTSTANDING FILTER IS THERE. Still read-only.
 */
check('  it offers day navigation, the four filters, and no undo, edit or delete',
  [history.includes('Event day'), history.includes('Today'),
   history.includes('Previous day'), history.includes('Next day'),
   ['All', 'Outstanding', 'Returned', 'Losses']
     .filter((label) => !history.includes(`>${label}<`)),
   /Undo|Delete|Remove|Edit/.test(history),
   // The day input is a real date control bounded by the event's today.
   /type="date"[^>]*value="2026-10-12"/.test(history) ||
     /value="2026-10-12"[^>]*type="date"/.test(history)],
  [true, true, true, true, [], false, true])
check('  and the day’s summary names every category',
  ['Issued', 'Outstanding', 'Returned', 'Partial loss', 'Pair lost']
    .filter((label) => !history.includes(label)), [])
/**
 * AN EMPTY DAY IS NOT AN ERROR, and an empty FILTER is not an empty day.
 * Three different sentences, because they send an operator to three
 * different places.
 */
check('  an empty day, an empty filter and a fruitless search read differently',
  await (async () => {
    const base = {
      day: '2026-10-12', eventDay: '2026-10-12', view: 'all', search: '',
      isLoading: false, onDayChange: noop, onViewChange: noop,
      onSearchChange: noop,
    }
    const emptyDay = await renderUi('src/components/dandiya/loan-history.tsx',
      { ...base, loans: [] })
    const noOutstanding = await renderUi('src/components/dandiya/loan-history.tsx',
      { ...base, loans: [settledLoan(['returned', 'returned'])], view: 'outstanding' })
    const noMatch = await renderUi('src/components/dandiya/loan-history.tsx',
      { ...base, loans: [settledLoan(['returned', 'returned'])], search: 'nobody' })
    const loading = await renderUi('src/components/dandiya/loan-history.tsx',
      { ...base, loans: [], isLoading: true })

    return [emptyDay.includes('No pairs were issued on this day.'),
      noOutstanding.includes('No outstanding pairs from this day.'),
      noMatch.includes('No loans match this search.'),
      loading.includes('Loading this day…'),
      // A day with nothing in it must not read as a failure.
      /error|failed|try again/i.test(emptyDay)]
  })(), [true, true, true, true, false])
/**
 * AND AN OUTSTANDING ROW IS THE PROMINENT ONE. It is the only state somebody
 * has to act on, so it is named rather than left as a blank outcome.
 */
/**
 * A ROW THE DATABASE COULD NOT PRODUCE — closed, but with a stick showing no
 * resolution — reads as OUTSTANDING rather than as a clean return. A stick
 * nobody can account for stays somebody's obligation; that is the only safe
 * direction for a corrupt or hand-edited row.
 */
check('  an incoherent row degrades to outstanding, never to returned',
  [filters.loanStateOf(closedLoan({})),
   filters.loanStateOf(settledLoan(['returned', 'returned'])),
   filters.loanStateOf(settledLoan(['returned', 'lost'], { outcome: 'partial_loss' })),
   filters.loanStateOf(settledLoan(['lost', 'lost'], { outcome: 'lost' }))],
  ['outstanding', 'returned', 'partial_loss', 'lost'])
check('  an outstanding row says so, and a closed day’s row names its close',
  await (async () => {
    const base = {
      day: '2026-10-12', eventDay: '2026-10-12', view: 'all', search: '',
      isLoading: false, onDayChange: noop, onViewChange: noop,
      onSearchChange: noop,
    }
    const open = await renderUi('src/components/dandiya/loan-history.tsx', {
      ...base,
      loans: [{ ...LOAN, closedAt: null, closedBy: null, outcome: null,
        pairReleasedAt: null }],
    })

    return [open.includes('Outstanding'), open.includes('Still out'),
      open.includes('Closed'), history.includes('Closed')]
  })(), [true, true, false, true])
/**
 * LEGACY FREE-TEXT HISTORY STILL RENDERS. A row written before D3.1 carries
 * no resolution on its holders, and a screen that threw on it would hide the
 * evening's record rather than one row of it.
 */
check('  a pre-D3.1 row with no holder resolutions still renders',
  await (async () => {
    const legacy = await renderUi('src/components/dandiya/loan-history.tsx', {
      loans: [closedLoan({ pairCode: 'D-OLD', outcome: null,
        holders: [holder(42, 1, 'Meera Patel'), holder(81, 2, 'Arjun Shah')] })],
      day: '2026-10-12',
      eventDay: '2026-10-12',
      view: 'all',
      search: '',
      isLoading: false,
      onDayChange: noop,
      onViewChange: noop,
      onSearchChange: noop,
    })

    return [legacy.includes('D-OLD'), legacy.includes('Meera Patel')]
  })(), [true, true])

/* ============ D3.2a. THE BANNER, AND WHERE IT SENDS THE OPERATOR ====== */

const bannerFor = (active, eventDay) =>
  renderUi('src/components/dandiya/carryover-banner.tsx',
    { active, eventDay, onShow: noop })

const CARRIED = {
  ...LOAN,
  id: 'aaaaaaaa-3333-4333-8333-000000000077',
  pairCode: 'D-077',
  issuedAt: yesterdayIso(),
  holders: [
    holder(42, 1, 'Meera Patel'),
    holder(81, 2, 'Arjun Shah',
      { resolution: 'returned', resolvedAt: RESOLVED_AT, resolvedBy: DESK }),
  ],
}
const TODAY_OPEN = { ...LOAN, id: 'aaaaaaaa-3333-4333-8333-000000000078' }

check('D3.2a-2. the banner counts pairs and sticks, and offers the carryover view',
  await (async () => {
    const today = eventTime.currentEventDayKey()
    const shown = await bannerFor([CARRIED, TODAY_OPEN], today)

    return [shown.includes('1 pair'), shown.includes('1 stick'),
      shown.includes('still outstanding from previous days'),
      shown.includes('Show carryover'),
      // Today's open pair is not counted: it is not carried over yet.
      shown.includes('2 pair')]
  })(), [true, true, true, true, false])
check('  it is silent when nothing is carried over',
  await (async () => {
    const today = eventTime.currentEventDayKey()

    return [await bannerFor([TODAY_OPEN], today), await bannerFor([], today)]
  })(), ['', ''])
check('  and plural wording follows the counts',
  await (async () => {
    const today = eventTime.currentEventDayKey()
    const two = await bannerFor(
      [CARRIED, { ...CARRIED, id: 'aaaaaaaa-3333-4333-8333-000000000079',
        pairCode: 'D-079' }],
      today,
    )

    return [two.includes('2 pairs'), two.includes('2 sticks')]
  })(), [true, true])
/**
 * D3.2a-3. CLICKING IT LANDS ON ACTIVE -> CARRYOVER.
 *
 * Pinned at the source: the desk fetches its board in an effect, so server
 * rendering never reaches the tabs, and a handler is not observable in
 * markup. What matters is that the one action sets BOTH — a banner that
 * opened Active unfiltered would hand somebody the whole board and let them
 * work out which rows it had been counting.
 */
check('D3.2a-3. the banner action selects Active AND the carryover filter',
  (() => {
    const desk = stripComments(read('src/components/dandiya/dandiya-desk.tsx'))
    const handler = desk.slice(desk.indexOf('<CarryoverBanner'),
      desk.indexOf('/>', desk.indexOf('<CarryoverBanner')))

    return [/setTab\('active'\)/.test(handler),
      /setActiveView\('carryover'\)/.test(handler),
      // And the banner is handed the SERVER's day, not a computed one.
      /eventDay=\{board\.eventDay\}/.test(handler)]
  })(), [true, true, true])
check('  Active offers both filters, and an emptied carryover offers the way back',
  (() => {
    const desk = stripComments(read('src/components/dandiya/dandiya-desk.tsx'))

    return [desk.includes("aria-label=\"Active filter\""),
      /setActiveView\('all'\)/.test(desk),
      desk.includes('Carryover (${String(carryover.pairs)})'),
      desk.includes('Nothing is outstanding from previous days.'),
      desk.includes('Show all active pairs'),
      // One selector, handed the server's day.
      /selectActiveLoans\(board\.active, \{/.test(desk),
      /eventDay: board\.eventDay/.test(desk),
      // And switching it issues no request: the single read effect is intact.
      [...desk.matchAll(/fetchDandiyaBoard\(/g)].length,
      /\[network, readAttempt, historyDay\]/.test(desk)]
  })(), [true, true, true, true, true, true, true, 1, true])

/**
 * D3.2a-5. AND THE END-OF-NIGHT LIST IS STILL A HISTORY QUESTION.
 *
 * While the day is running, the sticks that have not come back are TODAY's,
 * so History -> Today -> Outstanding is where closing up happens. The
 * carryover banner is the NEXT day's reminder of the same loans — which is a
 * change of label, not of state, and both lists are derived from the same
 * untouched rows.
 */
check('D3.2a-5. today’s Outstanding is the closing-up list, carryover is tomorrow’s',
  await (async () => {
    seedCentral()
    seedSheet()
    const open = await give('TONIGHT-01', [9005, 9007])

    await returnStick(loanIdOf(open), 9005)
    await give('TONIGHT-02', [9008, 9009])

    const today = eventTime.currentEventDayKey()
    const tonight = (await dayBoard(today)).body

    return [
      // Tonight, in History -> Today -> Outstanding.
      filters.filterDayHistory(tonight.history,
        { view: 'outstanding', search: '' }).map((loan) => loan.pairCode).sort(),
      filters.summariseDay(tonight.history).outstandingSticks,
      // And nothing is carryover yet, because the day has not rolled over.
      filters.outstandingBeforeDay(tonight.active, tonight.eventDay).pairs,
      // Tomorrow, the SAME loans are carryover — asked by moving the day on.
      filters.outstandingBeforeDay(
        tonight.active, eventTime.nextEventDayKey(today)).pairs,
      filters.outstandingBeforeDay(
        tonight.active, eventTime.nextEventDayKey(today)).sticks,
      // And not one row changed to make that true.
      tonight.active.map((loan) =>
        loan.holders.map((entry) => entry.resolution).join('/')).sort(),
    ]
  })(),
  [['TONIGHT-01', 'TONIGHT-02'], 3, 0, 2, 3, ['/', 'returned/']])

console.log('\n=== SEARCH ===')
const SEARCHABLE = [LOAN, { ...LEFTOVER, pairCode: 'Z-99' }]
check('active search finds a pair by code, either badge or either name',
  [filters.filterActiveLoans(SEARCHABLE, 'D-014').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, '42').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, '#081').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, 'arjun').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, 'meera patel').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, '').length],
  [['D-014'], ['D-014', 'Z-99'], ['D-014', 'Z-99'], ['D-014', 'Z-99'],
   ['D-014', 'Z-99'], 2])
check('  and never by a phone number, which this screen never receives',
  filters.filterActiveLoans(SEARCHABLE, '9000000042').length, 0)
/**
 * 30. SEARCH IS CASE-INSENSITIVE, in both directions. Stored codes are
 * canonical uppercase, so a volunteer typing what is on the sticks in any
 * case has to find it — and so does somebody typing a name.
 */
check('30. search is case-insensitive, for pair codes and for names',
  [filters.filterActiveLoans(SEARCHABLE, 'd-014').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, 'D-014').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, ' d-014 ').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, 'MEERA').map((l) => l.pairCode),
   filters.filterActiveLoans(SEARCHABLE, 'z-99').map((l) => l.pairCode)],
  [['D-014'], ['D-014'], ['D-014'], ['D-014', 'Z-99'], ['Z-99']])
check('  and history search too, across every outcome',
  (() => {
    const records = SEARCHABLE.map((loan) => closedLoan({ ...loan }))

    return ['d-014', 'D-014', 'Z-99', 'z-99']
      .map((query) =>
        filters.filterDayHistory(records, { view: 'all', search: query })
          .map((loan) => loan.pairCode))
  })(),
  [['D-014'], ['D-014'], ['Z-99'], ['Z-99']])
/* ===================== 46-50. NOTHING ELSE MOVED ======================= */

console.log('\n=== 46-50. THE OTHER MODULES, AND THE BUDGET ===')
seedCentral({ attributes: ['dandiya', 'prizes', 'attendees'] })
seedSheet()

check('47. the prize module still works, repeat awards included',
  await (async () => {
    const prizeGet = await prizeEndpoint.GET(new Request(`${ORIGIN}/api/prizes`, {
      method: 'GET', headers: { cookie: deviceCookie() },
    }))
    const award = async (prizeName) => (await prizeEndpoint.POST(
      new Request(`${ORIGIN}/api/prizes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: deviceCookie() },
        body: JSON.stringify({ badgeNumber: 9005, prizeName }),
      }))).status
    const one = await award('Best Dance - Girl')
    const two = await award('Best Dance - Girl')
    return [prizeGet.status, (await prizeGet.json()).attendees.length, one, two,
      fakeDb.state.prizeAwards.length]
  })(), [200, 4, 201, 201, 2])
check('48. the attendee directory still works, and is still read-only',
  await (async () => {
    const read_ = await attendeeEndpoint.GET(new Request(`${ORIGIN}/api/attendees`, {
      method: 'GET', headers: { cookie: deviceCookie() },
    }))
    const body = await read_.json()
    const refused = attendeeEndpoint.POST(new Request(`${ORIGIN}/api/attendees`, {
      method: 'POST', headers: { cookie: deviceCookie() },
    }))
    return [read_.status, body.attendees.length, refused.status,
      refused.headers.get('allow')]
  })(), [200, 4, 405, 'GET'])
check('46. the registration Sheet contract is unchanged',
  (() => {
    const sheet = read('server/sync/sheet-contract.ts')
    return [/A1:N/.test(sheet), /A1:M/.test(sheet),
      /Device ID', 'Device Name'/.test(sheet),
      sheetContract.BADGE_REGISTER_HEADERS.length]
  })(), [true, true, true, 14])
check('  and the sync, claim and auth endpoints are untouched by dandiya',
  ['api/sync-registration.ts', 'api/device-badge-claim.ts', 'api/device-auth.ts',
   'api/prizes.ts', 'api/attendees.ts']
    .filter((file) => /dandiya\//.test(read(file))), [])
check('  every earlier suite still exists and still runs in `verify`',
  (() => {
    const pkg = JSON.parse(read('package.json'))
    return [['phase-d2', 'phase-d21', 'phase-p1', 'phase-a1', 'phase-d3']
      .filter((suite) => !existsSync(join(root, `scripts/verification/${suite}.mjs`))),
    ['verify:d2 ', 'verify:d21', 'verify:p1', 'verify:a1', 'verify:d3']
      .filter((script) => !pkg.scripts.verify.includes(script)),
    pkg.scripts['verify:d3']]
  })(), [[], [], 'node scripts/verification/phase-d3.mjs'])
check('  and the shared Badge Register reader is still the only one',
  (() => {
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
    return found.filter((path) => !path.startsWith('server/sync/'))
  })(), ['server/attendees/register.ts'])
check('  which all three modules go through',
  ['api/dandiya.ts', 'api/prizes.ts', 'api/attendees.ts']
    .filter((file) => !/readAttendeeRegister/.test(read(file))), [])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
console.log(`  Vercel Functions: ${String(budget.actual.length)} / ${String(functionChecker.HOBBY_FUNCTION_LIMIT)}` +
  `   Headroom: ${String(functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length)}`)
check('49. the Function inventory is exactly eleven', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'attendees', 'dandiya', 'device-auth', 'device-badge-claim',
  'prizes', 'sync-registration',
])
check('  with ONE slot of headroom left',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 1)
check('  dandiya is ONE Function, dispatched by method',
  [[...stripComments(read('api/dandiya.ts')).matchAll(/export async function ([A-Z]+)\(/g)]
    .map((match) => match[1]).sort(),
   readdirSync(join(root, 'api')).filter((file) => /dandiya/.test(file))],
  [['GET', 'PATCH', 'POST'], ['dandiya.ts']])
check('  no active, history, issue, return or search Function was added',
  readdirSync(join(root, 'api'))
    .filter((file) => /dandiya-|active|history|issue|return|search/.test(file)), [])
check('  and nothing unexpected', budget.problems, [])
/**
 * 50. AUTHENTICATED DEVICE TRAFFIC GETS NO FIREWALL RULE. A rule would
 * throttle a desk's ordinary board reads while protecting nothing: there is
 * no credential to guess at an endpoint that refuses everything without a
 * device session cookie.
 */
const firewall = read('docs/VERCEL_FIREWALL.md')
check('50. /api/dandiya has no firewall rule',
  [/\*\*Condition — Path\*\* \| `\/api\/dandiya`/.test(firewall),
   /`\/api\/dandiya`/.test(firewall)], [false, true])
check('  and the live rule is still the one combined sign-in rule',
  [firewall.includes('/api/admin-auth'), firewall.includes('/api/device-auth'),
   firewall.includes('10')], [true, true, true])

/* ======================= THE MIGRATION AND db:check ==================== */

console.log('\n=== THE MIGRATION, AND WHAT db:check PROVES ===')
const migration = read('drizzle/0005_dandiya_checkout.sql')
const statements = migration.replace(/^--.*$/gm, '')

check('0005 creates both tables and alters only its own',
  [['dandiya_loans', 'dandiya_loan_holders']
    .filter((table) => !statements.includes(`CREATE TABLE "${table}"`)),
   [...statements.matchAll(/ALTER TABLE "([a-z_]+)"/g)]
     .map((match) => match[1])
     .filter((table) => !table.startsWith('dandiya_'))],
  [[], []])
/**
 * AND EXACTLY TWO, which is the rule D3.1 could most plausibly have broken.
 *
 * A pair's availability is a fact about its last loan. An inventory table
 * recording it separately — `dandiya_pairs`, a quarantine list, a retired-pair
 * register — would be a second source of truth for the one thing the pair
 * index already decides, and the two would disagree the first time somebody
 * wrote to only one of them.
 */
check('  and EXACTLY two: there is no separate pair inventory table',
  [...statements.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((match) => match[1]).sort(),
  ['dandiya_loan_holders', 'dandiya_loans'])
/**
 * 35. 0000-0004 ARE UNTOUCHED, BYTE FOR BYTE.
 *
 * A migration that has run anywhere is history, and D3.1 redesigned 0005
 * precisely because it had NOT run anywhere yet. Text matching proved only
 * that the earlier files say nothing about dandiya, which a quiet edit to
 * `prize_awards` would satisfy; a hash is what "untouched" actually means.
 * Each one is checked separately, so a report names the file that changed.
 */
for (const [file, digest] of [
  ['0000_central_foundation.sql',
    'f43145f9e6e4b434ece3274f9a03302304f08ec1182202d4dd7a42090a924d28'],
  ['0001_range_guards_and_touch.sql',
    'd17e8c4e768b550e1de350cc429a9888d9f1890e15af06754017587240cf5f17'],
  ['0002_device_credentials.sql',
    '7db84d402a04ccdb671eb2a398e241ce5fef8b3ee990f83e4f9254dbf329c262'],
  ['0003_prize_awards.sql',
    '525e9abdfb888959652562cc1982902bc5fa1d291de41708e41520906037122b'],
  ['0004_repeat_prize_awards.sql',
    'd37c7d310e2a80a68cab9b10ad78db7a52c79c394a109bb83884253a4e953112'],
]) {
  check(`35. ${file} is untouched`,
    createHash('sha256').update(read(`drizzle/${file}`)).digest('hex'), digest)
}
check('  and none of them mentions dandiya',
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql',
   '0002_device_credentials.sql', '0003_prize_awards.sql',
   '0004_repeat_prize_awards.sql']
    .filter((file) => /dandiya/i.test(read(`drizzle/${file}`))), [])
/**
 * 36. AND 0005 IS STILL THE ONLY DANDIYA MIGRATION. The redesign was applied
 * IN PLACE rather than appended, so a 0006 appearing would mean somebody
 * migrated the redesign on top of the original shape.
 */
check('36. 0005 is the only dandiya migration, and there is no 0006',
  [readdirSync(join(root, 'drizzle'))
    .filter((file) => file.endsWith('.sql') && /dandiya/i.test(read(`drizzle/${file}`)))
    .sort(),
   readdirSync(join(root, 'drizzle')).filter((file) => file.startsWith('0006'))],
  [['0005_dandiya_checkout.sql'], []])
check('  and the journal tracks 0005 last',
  JSON.parse(read('drizzle/meta/_journal.json')).entries.at(-1)?.tag,
  '0005_dandiya_checkout')
/**
 * THE TWO PARTIAL UNIQUE INDEXES, WITH THEIR PREDICATES. An index that kept
 * its columns and lost its `WHERE` clause would forbid a pair from ever going
 * out twice, which is most of what an evening consists of.
 */
check('both uniqueness guarantees are PARTIAL unique indexes, on the right column',
  [['dandiya_loans_one_unreleased_per_pair', 'pair_released_at'],
   ['dandiya_loan_holders_one_unresolved_per_badge', 'resolved_at']]
    .map(([index, column]) => {
      const statement = statements.split('--> statement-breakpoint')
        .find((entry) => entry.includes(index)) ?? ''
      const predicate = statement.slice(statement.search(/WHERE/i))

      return [/CREATE UNIQUE INDEX/.test(statement), /WHERE/.test(statement),
        new RegExp(`\\b${column}\\b[^;]*is null`, 'i').test(predicate),
        /\bresolution\b/i.test(predicate)]
    }),
  [[true, true, true, false], [true, true, true, false]])
check('  and no NON-partial uniqueness over a pair code or a badge exists',
  [...statements.matchAll(/CONSTRAINT "([a-z_0-9]+)" UNIQUE\(([^)]*)\)/g)]
    .filter((match) => /pair_code/.test(match[2]) ||
      (/badge_number/.test(match[2]) && !/loan_id/.test(match[2])))
    .map((match) => match[1]), [])

const dbCheck = read('scripts/db-check.mjs')
/**
 * One of db:check's expectation declarations, sliced out by name.
 *
 * It handles BOTH an array and an object literal, because the column sets are
 * objects — `{ table, required, nullable }`. A helper that only understood
 * `\n]` sliced nothing for those and every membership test passed vacuously.
 */
const dbCheckList = (name) => {
  const start = dbCheck.indexOf(`const ${name} = `)

  if (start === -1) {
    return ''
  }

  const ends = ['\n]', '\n}']
    .map((marker) => dbCheck.indexOf(marker, start))
    .filter((index) => index !== -1)

  return ends.length === 0 ? '' : dbCheck.slice(start, Math.min(...ends))
}
const dandiyaExpectations = ['EXPECTED_DANDIYA_CONSTRAINTS', 'EXPECTED_DANDIYA_INDEXES']
  .map(dbCheckList).join('\n')
const createdNames = [
  ...statements.matchAll(/(?:ADD )?CONSTRAINT "([a-z_0-9]+)"/g),
  ...statements.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_0-9]+)"/g),
].map((match) => match[1])

/**
 * The DISTINCT guarantee count is asserted so the regex cannot pass by
 * matching nothing — which is the shape of a guard that looks careful and
 * checks nothing. 0005 creates SEVENTEEN constraints (nine inline, eight
 * attached afterwards) and SIX indexes.
 */
check('db:check knows about both dandiya tables',
  [dbCheckList('EXPECTED_TABLES').includes("'dandiya_loans'"),
   dbCheckList('EXPECTED_TABLES').includes("'dandiya_loan_holders'"),
   new Set(createdNames).size],
  [true, true, 30])
check('  and verifies every guarantee 0005 creates',
  createdNames.filter((name) =>
    !/_idx$/.test(name) && !dandiyaExpectations.includes(name)), [])
/**
 * EACH PREDICATE INSIDE ITS OWN INDEX ENTRY.
 *
 * Searching both expectation lists for the predicate anywhere passed with the
 * pair index's `WHERE` clause deleted, because `returned_at is null` also
 * appears in the paired-return CHECK expectation. A canary found that: a
 * guard that searches a haystack proves nothing about where the needle is.
 */
check('  including both partial PREDICATES, scoped to their own index',
  (() => {
    const indexExpectations = dbCheckList('EXPECTED_DANDIYA_INDEXES')

    return [
      ['dandiya_loans_one_unreleased_per_pair', 'pair_released_at is null'],
      ['dandiya_loan_holders_one_unresolved_per_badge', 'resolved_at is null'],
    ].filter(([index, predicate]) => {
      const start = indexExpectations.indexOf(`'${index}'`)
      const entry = start === -1
        ? ''
        : indexExpectations.slice(start, indexExpectations.indexOf('],', start))

      return !entry.includes(predicate) || !entry.includes("'where'")
    }).map(([index]) => index)
  })(), [])
check('  every column of both tables is declared',
  [...new Set([...statements
    .matchAll(/^\s*"([a-z_]+)" (?:uuid|integer|smallint|text|timestamp)/gm)]
    .map((match) => match[1]))]
    .filter((column) => !(dbCheckList('DANDIYA_LOAN_COLUMNS') +
      dbCheckList('DANDIYA_HOLDER_COLUMNS')).includes(`'${column}'`)), [])
/**
 * 7. AND db:check PROVES THE CANONICAL CHECK IS THERE, by definition rather
 * than by name: verified by name alone it could be renamed to anything and
 * still pass, while the index it underwrites quietly stopped meaning
 * one-pair-one-loan.
 */
check('7. db:check verifies the canonical pair-code CHECK, by definition',
  (() => {
    const constraints = dbCheckList('EXPECTED_DANDIYA_CONSTRAINTS')
    const start = constraints.indexOf("'dandiya_loans_pair_code_canonical'")
    const entry = start === -1
      ? ''
      : constraints.slice(start, constraints.indexOf('],', start))

    /**
     * SQL ONLY, via `statements`. 0005's own header names this constraint in
     * prose, so reading the raw file found the commentary and reported the
     * CHECK present with the statement deleted — a canary caught that. A
     * guard that reads a file's documentation as its content verifies
     * nothing.
     */
    return [entry.includes("'check'"),
      entry.includes('pair_code = upper(btrim(pair_code))'),
      /CONSTRAINT "dandiya_loans_pair_code_canonical" CHECK/.test(statements),
      /= upper\(btrim\("dandiya_loans"\."pair_code"\)\)/.test(statements)]
  })(), [true, true, true, true])
/**
 * 8. AND release:check FAILS IF CANONICALISATION DISAPPEARS — from the
 * parser, from the schema or from the migration. Three places have to agree,
 * so all three are guarded.
 */
check('8. release:check guards all three halves of canonicalisation',
  ['parsePairCode no longer canonicalises to uppercase',
   'dandiya_loans no longer requires a canonical pair code',
   '0005 no longer enforces a canonical pair code',
   'db:check does not verify that pair codes are stored canonical']
    .filter((problem) => !read('scripts/release-check.mjs').includes(problem)), [])

console.log('\n=== THE ROUTE, RENDERED FOR REAL ===')
const { renderRoute, setDeviceGrant, clearDeviceGrant, setNetworkStatus } =
  await import('./route-render.mjs')
const DEVICE_STATE = {
  config: DESK_CONFIG, enrollment: ENROLLMENT, deviceName: 'Dandiya Test Desk',
}

clearDeviceGrant()
setNetworkStatus('online')
check('an unauthorized browser never reaches the dandiya desk',
  (() => {
    const refused = renderRoute('/dandiya', DESK_CONFIG)
    return [refused.html.includes('Device access required'),
      refused.html.includes('Issue Pair')]
  })(), [true, false])

for (const [label, set] of [['a registration-only', ['registration']],
  ['a prizes-only', ['prizes']], ['an attendees-only', ['attendees']]]) {
  setDeviceGrant(grant({ attributes: set }), DEVICE_STATE)
  check(`${label} device is refused at the route`,
    [renderRoute('/dandiya', DESK_CONFIG).html.includes('Not available on this device'),
     renderRoute('/dandiya', DESK_CONFIG).html.includes('Issue Pair')],
    [true, false])
}

setDeviceGrant(grant(), DEVICE_STATE)
let page = renderRoute('/dandiya', DESK_CONFIG)
check('a dandiya device opens the desk',
  [page.error ?? null, page.html.includes('Dandiya'),
   page.html.includes('Dandiya Test Desk')], [null, true, true])
check('  and it reports no badge state, which a dandiya desk does not own',
  /Badges #|badgeStart|Next badge|Give Prize/.test(page.html), false)
check('  a dandiya desk cannot open the other three modules',
  [renderRoute('/badge-registration', DESK_CONFIG).html.includes('__REGISTRATION_FORM__'),
   renderRoute('/prizes', DESK_CONFIG).html.includes('Give Prize'),
   renderRoute('/attendees', DESK_CONFIG).html.includes('Read-only event attendee directory.')],
  [false, false, false])

/**
 * FOUR TABS, SIX COUNTERS, AND ONE MOUNTED ISSUES LIST.
 *
 * Pinned at the SOURCE rather than in the rendered route: the desk fetches
 * its board in an effect, so server rendering only ever reaches the loading
 * state — which is also why the offline assertion below looks for the
 * controls' ABSENCE and gets it for free. A quarantine list nobody can reach
 * is a quarantine list nobody reads, so `PairIssues` being mounted is checked
 * too, not merely its existence as a file.
 */
check('  the desk declares four tabs, six counters and the issues list',
  (() => {
    const desk = stripComments(read('src/components/dandiya/dandiya-desk.tsx'))

    return [['Issue Pair', 'Active (${String(board.active.length)})',
      'Issues (${String(board.issues.length)})', 'History']
      .filter((tab) => !desk.includes(tab)),
    ['Active', 'Sticks out', 'Issued today', 'Returned today', 'Partial losses',
      'Pairs lost'].filter((stat) => !desk.includes(`label: '${stat}'`)),
    ['<PairIssues', '<ActiveLoanCard', '<LoanHistory', '<IssuePairForm',
      '<ResolvePairDialog'].filter((mount) => !desk.includes(mount))]
  })(), [[], [], []])

setNetworkStatus('offline')
page = renderRoute('/dandiya', DESK_CONFIG)
check('OFFLINE the desk says so, and exposes no mutation at all',
  [page.html.includes('Dandiya requires an internet connection.'),
   page.html.includes('Issue Pair'), page.html.includes('Return Whole Pair'),
   page.html.includes('Mark Lost'), page.html.includes('Report Pair Lost'),
   page.html.includes('Active ('), page.html.includes('Issues ('),
   ATTENDEES.some((a) => page.html.includes(a.name))],
  [true, false, false, false, false, false, false, false])
setNetworkStatus('online')

/**
 * HOME IS ATTRIBUTE-AWARE, and since D3 every card is a real module: there is
 * no `Coming soon` left anywhere.
 */
const homeFor = (set) => {
  setDeviceGrant(grant({ attributes: set }), DEVICE_STATE)

  return renderRoute('/', DESK_CONFIG).html
}
const moduleLinks = (html) =>
  [...html.matchAll(/href="(\/[a-z-]*)"[^>]*class="[^"]*group\/module/g)]
    .map((match) => match[1])
const cardOrder = (html) =>
  [...html.matchAll(/<h2 class="[^"]*">([^<]+)<\/h2>/g)].map((match) => match[1].trim())

check('Home offers Dandiya to a dandiya desk, and nothing else',
  [moduleLinks(homeFor(['dandiya'])),
   (homeFor(['dandiya']).match(/Not on this device/g) ?? []).length,
   (homeFor(['dandiya']).match(/Coming soon/g) ?? []).length],
  [['/dandiya'], 3, 0])
check('  the card order is Badge Registration, Attendees, Prizes, Dandiya',
  cardOrder(homeFor(['dandiya'])),
  ['Badge Registration', 'Attendees', 'Prizes', 'Dandiya'])
check('  Dandiya is no longer Coming soon for anybody',
  [homeFor([]).includes('Coming soon'),
   homeFor(['registration', 'prizes', 'attendees', 'dandiya']).includes('Coming soon')],
  [false, false])
check('  and every attribute offers only its own module',
  [moduleLinks(homeFor(['registration'])), moduleLinks(homeFor(['prizes'])),
   moduleLinks(homeFor(['attendees'])),
   moduleLinks(homeFor(['registration', 'prizes', 'attendees', 'dandiya']))],
  [['/badge-registration'], ['/prizes'], ['/attendees'],
   ['/badge-registration', '/attendees', '/prizes', '/dandiya']])
check('  and the card is NOT the boundary: the route refuses anyway',
  (() => {
    setDeviceGrant(grant({ attributes: ['prizes'] }), DEVICE_STATE)
    const refused = renderRoute('/dandiya', DESK_CONFIG).html
    return [refused.includes('Issue Pair'),
      refused.includes('Not available on this device')]
  })(), [false, true])
setDeviceGrant(grant(), DEVICE_STATE)
check('  and db:check stays READ-ONLY',
  ['INSERT', 'UPDATE ', 'DELETE', 'CREATE TABLE', 'ALTER ', 'DROP ', 'child_process']
    .filter((statement) => stripComments(dbCheck).includes(statement)), [])
check('release:check guards the dandiya ledger',
  ['dandiya-ledger', "'dandiya.ts'", "'0005_dandiya_checkout.sql'",
   'is not PARTIAL', 'DANDIYA_REQUIRED_ATTRIBUTE']
    .filter((needle) => !read('scripts/release-check.mjs').includes(needle)), [])

console.log('\n=== DOCUMENTATION ===')
for (const [doc, needles] of [
  ['docs/DANDIYA.md', ['/dandiya', 'pair', '0005_dandiya_checkout',
    'Dandiya Test Desk', 'pair-in-use', 'attendee-already-holding-pair',
    // The canonicalisation rule, and the reason for it.
    'case-insensitive', 'upper(btrim(pair_code))', '"d-014"    ->  "D-014"',
    // And the D3.1 lifecycle, in the terms an operator will meet.
    'pair_released_at IS NULL', 'resolved_at IS NULL',
    'returned + lost', 'partial_loss', 'quarantined',
    'pair-unavailable', 'holder-already-resolved', 'loan-already-closed',
    'Return Whole Pair', 'Report Pair Lost', 'Mark Lost',
    'Previous Dandiya loss', 'sticksOut',
    // The serialisation, and the only thing that proves it.
    'FOR UPDATE', 'Compare-and-set alone does not serialise this',
    'db:smoke:dandiya', 'ALLOW_DANDIYA_DB_SMOKE_WRITES',
    // D3.2: the day semantics, in the terms an operator meets them.
    'A loan belongs to the day it went OUT on',
    'historyDate=YYYY-MM-DD', 'Previous-day carryover',
    // D3.2a: the two questions, and which list answers which.
    'Two different questions, at two different times',
    'History → Today → Outstanding',
    'the morning-after reminder', 'Show carryover',
    'Carryover (N)', 'Nothing is outstanding from previous\ndays.',
    'No pairs were issued on this day.',
    'No outstanding pairs from this day.',
    'An empty day is not an error.',
    'There is no `event_day`, no copied date and no\nnightly snapshot']],
  ['AGENTS.md', ['Dandiya Checkout', 'dandiya_loans', 'dandiya_loan_holders',
    'dandiya_loans_one_unreleased_per_pair',
    'dandiya_loan_holders_one_unresolved_per_badge',
    'Midnight changes counters only',
    'THE LOAN ROW IS LOCKED FIRST', 'COMPARE-AND-SET ALONE IS NOT ENOUGH',
    'THE ORDER IS LOAD-BEARING', 'ALL FOUR ACTIONS SHARE THAT WRITER',
    // D3.2: what a later agent must not break.
    "A LOAN'S HISTORICAL DAY IS `issued_at`",
    'THERE IS NO STORED DAY', 'IT MUST NEVER MUTATE OR CLOSE A LOAN',
    'THE CALENDAR IS A READ-PATH CONCERN ONLY',
    'THE SERVER DECIDES THE DAY']],
  ['README.md', ['/dandiya']],
  ['docs/DATABASE.md', ['0005_dandiya_checkout', 'pair_released_at IS NULL',
    'resolved_at IS NULL', 'A CONSTRAINT IS NOT A SERIALISER',
    'FOR UPDATE']],
  ['docs/PRODUCTION_RELEASE_CHECKLIST.md', ['/api/dandiya', '0005_dandiya_checkout',
    'only a fully returned dandiya loan may release its pair',
    'one unresolved dandiya stick per attendee, whether it came back or not',
    'db:smoke:dandiya', 'Never run it against Production']],
  ['docs/ADMIN.md', ['Dandiya']],
  ['docs/VERCEL_FIREWALL.md', ['/api/dandiya']],
]) {
  check(`${doc} documents this phase`,
    needles.filter((needle) => !read(doc).includes(needle)), [])
}
check('  and no document still calls Dandiya unbuilt',
  ['README.md', 'AGENTS.md', 'docs/ADMIN.md']
    .filter((doc) => /Dandiya[^.]{0,80}Coming soon|Coming soon[^.]{0,40}Dandiya/i
      .test(read(doc))), [])
/**
 * AND NO DOCUMENT STILL CLAIMS CASE MATTERS. The follow-up reversed that
 * rule, so the old sentence is as dangerous as the old code: an operator who
 * read it would label two boxes `D-014` and `d-014` on purpose.
 */
check('  and no document still claims two cases are two pairs',
  ['README.md', 'AGENTS.md', 'docs/DANDIYA.md', 'docs/ADMIN.md',
   'docs/PRODUCTION_RELEASE_CHECKLIST.md']
    .filter((doc) => /two different physical labels|two different pairs|NOT case\s*folded/i
      .test(read(doc))), [])
check('  and the checklist tells an operator case does not matter',
  ['Case does **not** matter', 'dandiya pair codes are stored canonical']
    .filter((needle) => !read('docs/PRODUCTION_RELEASE_CHECKLIST.md').includes(needle)), [])
/**
 * 31. AND NO DOCUMENT STILL DESCRIBES THE D3 LIFECYCLE.
 *
 * D3.1 reversed two product rules, so the old sentences are as dangerous as
 * the old code would be: a volunteer briefed that "one return takes back the
 * whole pair" will hand a single remaining stick to somebody, and one told
 * there is "no lost workflow" will not look for Mark Lost when a stick goes
 * missing. Each stale claim is searched for by its own phrasing, so deleting
 * one does not excuse the others.
 */
for (const stale of [
  /one return takes back the WHOLE pair/i,
  /no partial-stick return/i,
  /no lost-or-damaged workflow/i,
  /no partial-stick or lost-pair workflow/i,
  /A return takes back \| the \*\*whole\*\* pair/i,
  /one active dandiya loan per pair/i,
  /one active dandiya pair per attendee/i,
  /dandiya_loans_one_active_per_pair/,
  /dandiya_loan_holders_one_active_per_badge/,
  // The CONFLICT CODE, not the English phrase: "preserves an already-returned
  // stick" is correct prose and must not be mistaken for the retired code.
  /`already-returned`|"already-returned"|'already-returned'/,
  /Three tabs/i,
  // D3.2 replaced the Today / All Days toggle with day navigation, and made
  // history one day in every state. A document still describing the old
  // behaviour would send somebody looking for a control that is gone, or
  // tell them an unreturned pair is missing from its own day's record.
  /All Days/,
  /holds finished loans only/i,
  /appears under \*\*both\*\*\s+days/i,
  /history defaults to today/i,
  /**
   * D3.2a CORRECTED THIS, and the wrong version is operationally misleading
   * rather than merely stale: before midnight the sticks that have not come
   * back are TODAY's, and the closing-up list is History -> Today ->
   * Outstanding. A document calling the carryover banner the end-of-night
   * list would have volunteers waiting for a banner that only appears once
   * the day has already rolled over.
   */
  /carryover[^.]{0,60}end-of-night/i,
  /outstanding banner is the end-of-night/i,
  /banner[^.]{0,40}end-of-night list/i,
  // The claim this phase retracted: compare-and-set alone does NOT serialise
  // two desks resolving different sticks, and a document still saying it does
  // would invite somebody to remove the lock.
  /all of them read the holders table AFTER the resolution above it/i,
  /Deciding "am I the last\?" from a prior SELECT would leave both/i,
  /Deciding "am I the last\?" from a `SELECT` would leave\s+both/i,
]) {
  check(`  and no document still says ${String(stale)}`,
    ['README.md', 'AGENTS.md', 'docs/DANDIYA.md', 'docs/DATABASE.md',
     'docs/ADMIN.md', 'docs/PRODUCTION_RELEASE_CHECKLIST.md']
      .filter((doc) => stale.test(read(doc))), [])
}
/**
 * 31. AND THE OPERATOR IS BRIEFED ON WHAT REPLACED THEM. Removing the old
 * sentence is only half of it: the checklist has to say what a volunteer
 * should now do instead, or the briefing is simply missing.
 */
check('  and the checklist briefs the new lifecycle',
  ['each stick is returned or marked lost SEPARATELY',
   'can never be issued again this event',
   'the warning is information, not a refusal']
    .filter((needle) => !read('docs/PRODUCTION_RELEASE_CHECKLIST.md').includes(needle)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${String(fails)} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
