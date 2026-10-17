/**
 * Phase CNG1 / CNG1.1 verification — NAMED CNG members, their own prize
 * ledger, and the date-grouped combined award history.
 *
 * Run with:  pnpm verify:cng1
 *
 * It NEVER connects to Neon, Google or any network. The REAL endpoint, the
 * REAL writers, the REAL roster reader, the REAL composers, the REAL parsers,
 * the REAL grouping and the REAL components all run; only Postgres, the
 * Sheets API, HTTP and the dialog's portal are stood in for.
 *
 * CNG1.1 INVERTED THE CENTRAL DOMAIN ASSUMPTION. CNG1 modelled a volunteer as
 * a registered attendee identified by a BADGE NUMBER, and resolved pasted
 * names against the Badge Register. That was wrong: CNG members do not wear
 * the numbered attendee badges and most never pass the registration desk. The
 * assertions are rewritten rather than deleted — the same situations, with
 * the opposite expected outcome — which is the only honest way to record a
 * deliberate reversal.
 *
 * TWO THINGS ARE BEING PROVED, and they are different kinds of claim.
 *
 *   THE NEW MODEL   a member is a NAME. No badge is required, accepted or
 *                   invented; no Badge Register is read; the name is stored
 *                   deliberately and nothing else about the person is.
 *   THE OLD LEDGER  `prize_awards` is untouched — still six columns, still
 *                   badge-based, still the same contract on `POST`.
 *
 * EVERY FIXTURE NAME IS INVENTED. No organiser-provided volunteer name
 * appears here or anywhere else in the repository: the real list is pasted at
 * runtime and never stored in source.
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

/** Every `.ts`/`.tsx` under a directory, recursively. */
const walk = (directory) => {
  const found = []
  const step = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) { step(next); continue }
      if (/\.(ts|tsx)$/.test(entry.name)) found.push(next)
    }
  }
  step(directory)

  return found
}

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '22222222-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const ORIGIN = 'https://desk.example.test'
const ADDED_AT = '2026-10-16T12:30:00.000Z'

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

const SECRET = 'c'.repeat(48)
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
const cngRequests = await serverJiti.import(`${root}/server/cng/requests.ts`)
const sheetContract = await serverJiti.import(`${root}/server/sync/sheet-contract.ts`)
const password = await serverJiti.import(`${root}/server/device-auth/password.ts`)
const fakeDb = await import('./fake-admin-db.mjs')
const fakeSheets = await import('./fake-sheets.mjs')

const storedHash = await password.hashDevicePassword('cng-passphrase')

/* --------------------------------------------------------------- fixtures */

/**
 * ATTENDEES, for the badge-based half that must stay unchanged. CNG members
 * are NOT drawn from this list and are never matched against it — that is the
 * whole correction.
 */
const ATTENDEES = [
  { badge: 9001, name: 'Fixture Alpha', age: 7, gender: 'female' },
  { badge: 9002, name: 'Fixture Beta', age: 15, gender: 'male' },
  { badge: 9005, name: 'Fixture Gamma', age: 11, gender: 'female' },
]

const PHONE_OF = (badge) => String(9000000000 + badge - 9000)

const sheetRow = (attendee) =>
  sheetContract
    .buildBadgeRegisterRow({
      id: `cng-test-fixture-${String(attendee.badge)}`,
      status: 'completed',
      paymentStatus: 'confirmed',
      paymentMethod: 'upi',
      badgeNumber: attendee.badge,
      name: attendee.name,
      phone: PHONE_OF(attendee.badge),
      age: attendee.age,
      gender: attendee.gender,
      amount: 20,
      createdAt: ADDED_AT,
      completedAt: ADDED_AT,
      updatedAt: ADDED_AT,
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
  members = [],
} = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata',
    active: true, endsAt: null, ...event,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Prize Test Desk', loginName: 'cng-test',
    passwordHash: storedHash, sessionVersion: 2, enabled: true, lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), ...device,
  })
  fakeDb.state.devices.set(OTHER_DEVICE_ID, {
    id: OTHER_DEVICE_ID, eventId: EVENT_ID, name: 'Prize Test Desk B',
    loginName: 'cng-test-b', passwordHash: storedHash, sessionVersion: 1,
    enabled: true, lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  fakeDb.state.attributes.push({ deviceId: OTHER_DEVICE_ID, attribute: 'prizes' })
  for (const award of awards) {
    seeded += 1
    fakeDb.state.prizeAwards.push({
      id: `aaaaaaaa-0000-4000-8000-${String(seeded).padStart(12, '0')}`,
      eventId: EVENT_ID,
      badgeNumber: award.badgeNumber,
      prizeName: award.prizeName,
      awardedByDeviceId: award.deviceId ?? DEVICE_ID,
      awardedAt: new Date(award.awardedAt ?? ADDED_AT),
    })
  }
  for (const member of members) {
    seeded += 1
    fakeDb.state.cngMembers.push({
      id: member.id ?? `cccccccc-0000-4000-8000-${String(seeded).padStart(12, '0')}`,
      eventId: member.eventId ?? EVENT_ID,
      name: member.name,
      addedByDeviceId: DEVICE_ID,
      addedAt: new Date(ADDED_AT),
      removedAt: null,
      removedByDeviceId: null,
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

const mutate = (method, body, cookie = deviceCookie()) =>
  endpoint[method](new Request(`${ORIGIN}/api/prizes`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  }))

const put = (body, cookie) => mutate('PUT', body, cookie)

/**
 * A client-generated member id, in the shape the validator accepts.
 *
 * The suite mints them the way the browser does — once per member it is
 * about to add — because that is what makes `PUT` idempotent. A helper that
 * minted a fresh one per call would turn every retry into a new row and
 * quietly un-test the mechanism, so the retry cases pass an id explicitly.
 */
let mintedIds = 0
const memberId = () =>
  `cccccccc-3333-4333-8333-${String(100000000000 + (mintedIds += 1))}`

/** One add, with a fresh id unless the caller is testing a retry. */
const addPut = (name, cngMemberId = memberId(), cookie) =>
  put({ cngMemberId, name }, cookie)
const remove = (body, cookie) => mutate('DELETE', body, cookie)
const post = (body, cookie) => mutate('POST', body, cookie)
const patch = (body, cookie) => mutate('PATCH', body, cookie)

const roster = async (cookie) => (await get(cookie)).json()
const memberNames = () => fakeDb.state.cngMembers.map((row) => row.name)
const activeNames = () =>
  fakeDb.state.cngMembers.filter((row) => row.removedAt === null).map((row) => row.name)

/**
 * Reads a field from a row that MIGHT NOT EXIST. A broken endpoint writes no
 * row, and `cngMembers[0].name` would then throw — aborting the suite and
 * hiding every assertion below it.
 */
const fieldOf = (row, key) => (row === undefined || row === null ? null : row[key] ?? null)

/** Adds one member through the real endpoint and returns its id. */
const addMember = async (name) => {
  const response = await addPut(name)
  const body = await response.json()

  return fieldOf(body.member, 'id')
}

/* ========================= AUTHORIZATION: WHO MAY CURATE THE GROUP ====== */

console.log('=== AUTHORIZATION IS THE PRIZE DESK\'S, ON ALL FIVE METHODS ===')

seedCentral()
seedSheet()

check('an anonymous caller cannot read the CNG group or its prizes',
  await (async () => {
    const response = await get(null)
    const body = await response.json()
    return [response.status, 'cng' in body, 'cngAwards' in body]
  })(), [401, false, false])
check('  nor add, remove or award',
  await (async () => {
    const added = await addPut('Volunteer One', memberId(), null)
    const removed = await remove({ cngMemberId: EVENT_ID }, null)
    const awarded = await patch({ cngMemberId: EVENT_ID, prizeName: CATALOG[0] }, null)
    return [added.status, removed.status, awarded.status,
      fakeDb.state.cngMembers.length, fakeDb.state.cngPrizeAwards.length]
  })(), [401, 401, 401, 0, 0])

process.env.EVENT_ADMIN_SESSION_SECRET = SECRET
check('  an Admin cookie authorizes nothing here',
  await (async () => {
    const adminToken = adminSession.createAdminSessionToken(SECRET)
    const added = await addPut('Volunteer One', memberId(),
      `__Host-navaratri_device_session=${adminToken}`)
    return [added.status, fakeDb.state.cngMembers.length]
  })(), [401, 0])

seedCentral({ attributes: ['attendees'] })
seedSheet()
check('a device without `prizes` is refused on every method',
  await (async () => {
    const reads = await get()
    const added = await addPut('Volunteer One')
    const addedBody = await added.json()
    const removed = await remove({ cngMemberId: EVENT_ID })
    const awarded = await patch({ cngMemberId: EVENT_ID, prizeName: CATALOG[0] })
    return [reads.status, added.status, addedBody.blocked, removed.status,
      awarded.status, fakeDb.state.cngMembers.length]
  })(), [403, 403, 'prizes-required', 403, 403, 0])
check('  and the attribute comes from CURRENT Postgres on every method',
  (() => {
    const source = stripComments(read('api/prizes.ts'))
    return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((method) => {
      const start = source.indexOf(`export async function ${method}(`)
      const rest = source.slice(start)
      const next = rest.slice(1).search(/export async function [A-Z]+\(/)
      const body = next === -1 ? rest : rest.slice(0, next + 1)
      return /device\.attributes\.includes\(PRIZE_REQUIRED_ATTRIBUTE\)/.test(body)
    })
  })(), [true, true, true, true, true])

seedCentral({ device: { enabled: false } })
seedSheet()
check('a DISABLED device cannot curate the group',
  [(await addPut('Volunteer One')).status, fakeDb.state.cngMembers.length],
  [401, 0])

seedCentral({ event: { active: false } })
seedSheet()
check('nor can a device on an INACTIVE event',
  [(await addPut('Volunteer One')).status, fakeDb.state.cngMembers.length],
  [401, 0])

seedCentral()
seedSheet()
check('a stale session_version is refused too',
  (await addPut('Volunteer One', memberId(), deviceCookie(1))).status, 401)
check('a cross-origin mutation is refused, and reads are not',
  await (async () => {
    const foreign = await endpoint.PATCH(new Request(`${ORIGIN}/api/prizes`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.test',
        cookie: deviceCookie(),
      },
      body: JSON.stringify({ cngMemberId: EVENT_ID, prizeName: CATALOG[0] }),
    }))
    return [foreign.status, fakeDb.state.cngPrizeAwards.length, (await get()).status]
  })(), [403, 0, 200])

/* ================ 1-8. A MEMBER IS A NAME, AND ONLY A NAME ============= */

console.log('\n=== 1-8. A CNG MEMBER IS A NAME ===')

seedCentral()
seedSheet()

let response = await addPut('Volunteer One')
let body = await response.json()

check('1. a CNG member is created with ONLY a name',
  [response.status, body.ok, fieldOf(body.member, 'name'),
   fieldOf(body.member, 'addedBy')?.name ?? null, fakeDb.state.cngMembers.length],
  [201, true, 'Volunteer One', 'Prize Test Desk', 1])
check('  the stored row holds the name, the device, the event and the times',
  Object.keys(fakeDb.state.cngMembers[0] ?? {}).sort(),
  ['addedAt', 'addedByDeviceId', 'eventId', 'id', 'name', 'removedAt',
   'removedByDeviceId'])
check('  and no badge number is stored, returned or invented',
  [JSON.stringify(fakeDb.state.cngMembers[0] ?? {}).includes('badge'),
   JSON.stringify(body.member ?? {}).includes('badge'),
   'badgeNumber' in (body.member ?? {})],
  [false, false, false])
/**
 * 2 IS THE HEART OF THE CORRECTION. CNG1 read the Badge Register to resolve a
 * member; a volunteer is not in it, so CNG1.1 must not look.
 */
check('2. creating a CNG member performs NO Badge Register lookup',
  [fakeSheets.state.reads, fakeSheets.state.mutations], [[], []])
check('  it still works when the register cannot be read at all',
  await (async () => {
    fakeSheets.state.failNextRead = true
    const added = await addPut('Volunteer Two')
    return [added.status, fakeDb.state.cngMembers.length, fakeSheets.state.reads]
  })(), [201, 2, []])
check('  and neither the PUT body nor the writer names a register reader',
  (() => {
    const source = stripComments(read('api/prizes.ts'))
    const putText = source.slice(source.indexOf('export async function PUT('))
    const bodyText = putText.slice(0, putText.indexOf('export async function DELETE('))
    return [/readAttendeeRegister|readSheetAccess/.test(bodyText),
      /readAttendeeRegister|attendees\//.test(stripComments(read('server/cng/members.ts')))]
  })(), [false, false])

seedCentral()
seedSheet()
check('3. a BADGE NUMBER in the body is REFUSED, not ignored',
  await (async () => {
    const outcomes = {}
    for (const field of ['badgeNumber', 'badge']) {
      outcomes[field] = (await put({ cngMemberId: memberId(), name: 'Volunteer One', [field]: 42 })).status
    }
    return [outcomes, fakeDb.state.cngMembers.length]
  })(), [{ badgeNumber: 400, badge: 400 }, 0])
check('4. phone, age, gender, payment and WhatsApp are REFUSED too',
  await (async () => {
    const outcomes = {}
    for (const field of ['phone', 'age', 'gender', 'payment', 'paymentMethod',
      'amount', 'whatsapp', 'attendee', 'normalizedName', 'eventId', 'deviceId',
      'addedAt', 'addedBy', 'id']) {
      outcomes[field] = (await put({ cngMemberId: memberId(), name: 'Volunteer One', [field]: 'x' })).status
    }
    return [[...new Set(Object.values(outcomes))], Object.keys(outcomes).length,
      fakeDb.state.cngMembers.length]
  })(), [[400], 14, 0])
check('  and every one of them is named in the forbidden list',
  ['badgeNumber', 'badge', 'phone', 'age', 'gender', 'payment', 'paymentMethod',
   'amount', 'whatsapp', 'attendee', 'normalizedName', 'eventId', 'eventSlug',
   'deviceId', 'loginName', 'addedAt', 'addedBy', 'removedAt', 'id']
    .filter((field) => !cngRequests.FORBIDDEN_CNG_FIELDS.includes(field)), [])
check('5. an EMPTY name is refused',
  await (async () => {
    const outcomes = []
    for (const name of ['', undefined, null, 42, []]) {
      outcomes.push((await put(name === undefined
        ? { cngMemberId: memberId() }
        : { cngMemberId: memberId(), name })).status)
    }
    return [outcomes, fakeDb.state.cngMembers.length]
  })(), [[400, 400, 400, 400, 400], 0])
check('6. a WHITESPACE-ONLY name is refused',
  await (async () => {
    const outcomes = []
    for (const name of ['   ', '\t', '\n', ' \t \n ']) {
      outcomes.push((await addPut(name)).status)
    }
    return [outcomes, fakeDb.state.cngMembers.length]
  })(), [[400, 400, 400, 400], 0])
check('  and a name beyond the bound is refused',
  await (async () => {
    const ok = await addPut('v'.repeat(120))
    const tooLong = await addPut('v'.repeat(121))
    return [ok.status, tooLong.status, fakeDb.state.cngMembers.length]
  })(), [201, 400, 1])

seedCentral()
seedSheet()
check('7. the stored name is TRIMMED, and its internal spacing is kept',
  await (async () => {
    const added = await addPut('  Volunteer   Three  ')
    const addedBody = await added.json()
    return [fieldOf(fakeDb.state.cngMembers[0], 'name'),
      fieldOf(addedBody.member, 'name')]
  })(), ['Volunteer   Three', 'Volunteer   Three'])

seedCentral()
seedSheet()
check('8. two CNG rows may share the SAME name, and both are kept',
  await (async () => {
    const first = await addPut('Volunteer Same')
    const second = await addPut('Volunteer Same')
    const firstBody = await first.json()
    const secondBody = await second.json()
    return [first.status, second.status, memberNames(),
      fieldOf(firstBody.member, 'id') === fieldOf(secondBody.member, 'id')]
  })(), [201, 201, ['Volunteer Same', 'Volunteer Same'], false])
check('  and nothing in the schema makes the name unique',
  (() => {
    const schema = read('server/db/schema.ts')
    const start = schema.indexOf('export const cngMembers = pgTable(')
    const end = Math.min(...['\nexport const ', '\nexport type ']
      .map((marker) => schema.indexOf(marker, start + 1))
      .filter((index) => index !== -1))
    const table = stripComments(schema.slice(start, end))
    return [...table.matchAll(/(unique|uniqueIndex)\(([\s\S]*?)\)\s*\.on\(([^)]*)\)/g)]
      .filter((match) => /name/.test(match[3]))
      .map((match) => match[2])
  })(), [])

/* ============== A-E. THE EXACT CONTRACTS, AND REAL IDEMPOTENCY ========= */

console.log('\n=== A-E. EXACT PER-METHOD CONTRACTS, AND A RETRYABLE PUT ===')

/**
 * A. EACH METHOD HAS AN EXACT CONTRACT, which is what makes `name` legal on
 * PUT and refused on the other two.
 *
 * A single shared deny-list cannot express that: a field REQUIRED by one
 * method and MEANINGLESS on another would either break the method that needs
 * it or be accepted everywhere. So each parser declares its own key set and
 * refuses everything else by name.
 */
seedCentral()
seedSheet()

check('A. PUT takes exactly { cngMemberId, name } and refuses anything else',
  await (async () => {
    const complete = await put({ cngMemberId: memberId(), name: 'Volunteer One' })
    const noName = await put({ cngMemberId: memberId() })
    const noId = await put({ name: 'Volunteer One' })
    const extra = await put({
      cngMemberId: memberId(), name: 'Volunteer One', prizeName: CATALOG[0],
    })
    const unknown = await put({ cngMemberId: memberId(), name: 'V', nickname: 'x' })
    return [complete.status, noName.status, noId.status, extra.status,
      unknown.status, fakeDb.state.cngMembers.length]
  })(), [201, 400, 400, 400, 400, 1])
check('  `name` is legal on PUT and refused on DELETE and PATCH',
  await (async () => {
    const id = fakeDb.state.cngMembers[0].id
    const removeByName = await remove({ cngMemberId: id, name: 'Volunteer One' })
    const awardWithName = await patch({
      cngMemberId: id, name: 'Volunteer One', prizeName: CATALOG[0],
    })
    // And it is NOT in the shared deny-list, which is what made that possible.
    return [removeByName.status, awardWithName.status,
      cngRequests.FORBIDDEN_CNG_FIELDS.includes('name')]
  })(), [400, 400, false])
check('  DELETE takes exactly { cngMemberId }',
  await (async () => {
    const id = fakeDb.state.cngMembers[0].id
    const extra = await remove({ cngMemberId: id, prizeName: CATALOG[0] })
    const empty = await remove({})
    const removed = await remove({ cngMemberId: id })
    return [extra.status, empty.status, removed.status]
  })(), [400, 400, 200])
check('  PATCH takes exactly { cngMemberId, prizeName }',
  await (async () => {
    seedCentral()
    seedSheet()
    const id = await addMember('Volunteer One')
    const extra = await patch({ cngMemberId: id, prizeName: CATALOG[0], badgeNumber: 1 })
    const noPrize = await patch({ cngMemberId: id })
    const awarded = await patch({ cngMemberId: id, prizeName: CATALOG[0] })
    return [extra.status, noPrize.status, awarded.status,
      fakeDb.state.cngPrizeAwards.length]
  })(), [400, 400, 201, 1])
check('  and every method still refuses the badge and the attendee facts',
  await (async () => {
    seedCentral()
    seedSheet()
    const id = await addMember('Volunteer One')
    const refused = {}

    for (const field of ['badge', 'badgeNumber', 'eventId', 'eventSlug',
      'deviceId', 'loginName', 'phone', 'age', 'gender', 'payment',
      'paymentMethod', 'amount', 'whatsapp', 'addedAt', 'awardedAt',
      'removedAt', 'id']) {
      refused[field] = [
        (await put({ cngMemberId: memberId(), name: 'V', [field]: 'x' })).status,
        (await remove({ cngMemberId: id, [field]: 'x' })).status,
        (await patch({ cngMemberId: id, prizeName: CATALOG[0], [field]: 'x' })).status,
      ].join(',')
    }

    return [[...new Set(Object.values(refused))], Object.keys(refused).length,
      fakeDb.state.cngMembers.length, fakeDb.state.cngPrizeAwards.length]
  })(), [['400,400,400'], 17, 1, 0])

/**
 * B. A REAL `PUT { cngMemberId, name }` REACHES THE WRITER.
 *
 * Not a parser test: the REAL handler runs, the REAL writer runs, and the row
 * is read back out of the stand-in database — with the name trimmed.
 */
seedCentral()
seedSheet()
const draftId = memberId()
response = await put({ cngMemberId: draftId, name: '  Volunteer   Drafted  ' })
body = await response.json()

check('B. a real PUT { cngMemberId, name } reaches the writer',
  [response.status, body.ok, body.outcome,
   fieldOf(body.member, 'id'), fieldOf(body.member, 'name'),
   fakeDb.state.cngMembers.length],
  [201, true, 'added', draftId, 'Volunteer   Drafted', 1])
check('  and the STORED name is trimmed, under the id the client supplied',
  [fieldOf(fakeDb.state.cngMembers[0], 'id'),
   fieldOf(fakeDb.state.cngMembers[0], 'name'),
   fieldOf(fakeDb.state.cngMembers[0], 'eventId'),
   fakeDb.state.cngMembers[0]?.addedAt instanceof Date],
  [draftId, 'Volunteer   Drafted', EVENT_ID, true])

/**
 * C-E. IDEMPOTENCY, keyed on the ROW ID because a name cannot be: two
 * volunteers may genuinely share one.
 */
response = await put({ cngMemberId: draftId, name: '  Volunteer   Drafted  ' })
body = await response.json()

check('C. the SAME id and name again is 200 already-member, not a second row',
  [response.status, body.ok, body.outcome, fieldOf(body.member, 'id'),
   fakeDb.state.cngMembers.length],
  [200, true, 'already-member', draftId, 1])
check('  and the row it returns is the AUTHORITATIVE one',
  [fieldOf(body.member, 'name'),
   fieldOf(body.member, 'addedAt') === fakeDb.state.cngMembers[0].addedAt.toISOString()],
  ['Volunteer   Drafted', true])

response = await put({ cngMemberId: draftId, name: 'Somebody Else' })
body = await response.json()

check('D. the same id with a DIFFERENT name is REFUSED, never overwritten',
  [response.status, body.ok ?? false, body.conflict,
   fakeDb.state.cngMembers.length,
   // The stored name is untouched.
   fieldOf(fakeDb.state.cngMembers[0], 'name'),
   // And the response shows what actually exists.
   fieldOf(body.member, 'name')],
  [409, false, 'cng-id-in-use', 1, 'Volunteer   Drafted', 'Volunteer   Drafted'])
check('  an id belonging to ANOTHER event is refused, and discloses nothing',
  await (async () => {
    seedCentral({ members: [{ name: 'Other Event', eventId: 'other-event-id',
      id: 'eeeeeeee-0000-4000-8000-000000000009' }] })
    seedSheet()
    const refused = await put({
      cngMemberId: 'eeeeeeee-0000-4000-8000-000000000009', name: 'Volunteer One',
    })
    const refusedBody = await refused.json()
    return [refused.status, refusedBody.conflict, 'member' in refusedBody,
      fakeDb.state.cngMembers.length]
  })(), [409, 'cng-id-in-use', false, 1])

seedCentral()
seedSheet()
check('E. two DIFFERENT ids with the same name both succeed',
  await (async () => {
    const first = await put({ cngMemberId: memberId(), name: 'Volunteer Same' })
    const second = await put({ cngMemberId: memberId(), name: 'Volunteer Same' })
    const firstBody = await first.json()
    const secondBody = await second.json()
    return [first.status, second.status,
      [firstBody.outcome, secondBody.outcome],
      memberNames(),
      fieldOf(firstBody.member, 'id') === fieldOf(secondBody.member, 'id')]
  })(), [201, 201, ['added', 'added'], ['Volunteer Same', 'Volunteer Same'], false])
check('  the key is the PRIMARY KEY, and the group is never pre-read to decide',
  (() => {
    const writer = stripComments(read('server/cng/members.ts'))
    const add = writer.slice(writer.indexOf('export const addCngMember'),
      writer.indexOf('export const removeCngMember'))
    return [/onConflictDoNothing\(\{ target: cngMembers\.id \}\)/.test(add),
      /onConflictDoNothing\(\)/.test(add),
      // The read-back happens only AFTER the key has refused the insert.
      add.indexOf('.insert(cngMembers)') < add.indexOf('readCngMember('),
      // And nothing keys idempotency on the name.
      /eq\(cngMembers\.name/.test(writer)]
  })(), [true, false, true, false])
/* =================== 9-12. ADD, BULK ADD, AND NO NAMES IN SOURCE ======= */

console.log('\n=== 9-12. INDIVIDUAL ADD, BULK PASTE, AND NO NAMES IN SOURCE ===')

const domainJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const contract = await domainJiti.import(`${root}/src/shared/cng-contract.ts`)
const group = await domainJiti.import(`${root}/src/cng/cng-group.ts`)
const awardGroups = await domainJiti.import(`${root}/src/prizes/award-groups.ts`)
const filters = await domainJiti.import(`${root}/src/prizes/prize-filters.ts`)

seedCentral()
seedSheet()
check('9. individual Add creates exactly one member',
  await (async () => {
    const added = await addPut('Volunteer Solo')
    return [added.status, activeNames(), fakeDb.state.cngMembers.length]
  })(), [201, ['Volunteer Solo'], 1])

const PASTED = [
  'Volunteer One',
  '',
  '   ',
  '  Volunteer   Two  ',
  '\t',
  'Volunteer Three',
  '',
].join('\n')

check('10. a pasted list becomes one member per non-empty line',
  contract.parsePastedCngNames(PASTED),
  ['Volunteer One', 'Volunteer   Two', 'Volunteer Three'])
check('  every line ending splits, and a trailing newline costs nothing',
  [contract.parsePastedCngNames('A\nB\n'),
   contract.parsePastedCngNames('A\r\nB'),
   contract.parsePastedCngNames('A\rB'),
   contract.parsePastedCngNames(''),
   contract.parsePastedCngNames('   \n\n  ')],
  [['A', 'B'], ['A', 'B'], ['A', 'B'], [], []])
check('11. blank and whitespace-only lines are ignored',
  [contract.parsePastedCngNames('A\n\n\n   \n\t\nB').length,
   contract.parsePastedCngNames('\n\n   \n\t\n')],
  [2, []])
check('  a duplicate line is KEPT: two volunteers may share a name',
  contract.parsePastedCngNames('Volunteer Same\nVolunteer Same'),
  ['Volunteer Same', 'Volunteer Same'])
check('  and the whole paste adds through the SAME single-member endpoint',
  await (async () => {
    seedCentral()
    seedSheet()

    const statuses = []
    for (const name of contract.parsePastedCngNames(PASTED)) {
      statuses.push((await addPut(name)).status)
    }

    return [[...new Set(statuses)], activeNames(),
      // No bulk endpoint exists to carry a list to.
      readdirSync(join(root, 'api')).filter((file) => /bulk|cng|names/i.test(file))]
  })(), [[201], ['Volunteer One', 'Volunteer   Two', 'Volunteer Three'], []])
check('  a retried bulk run adds each member exactly once',
  await (async () => {
    seedCentral()
    seedSheet()

    /** One id per candidate, minted once — as the dialog does. */
    const drafts = contract.parsePastedCngNames(PASTED)
      .map((name) => ({ cngMemberId: memberId(), name }))

    const first = []
    for (const draft of drafts) {
      first.push((await put(draft)).status)
    }

    /** The whole run again, with the SAME ids: a lost-response retry. */
    const second = []
    for (const draft of drafts) {
      second.push((await put(draft)).status)
    }

    return [first, second, memberNames(), fakeDb.state.cngMembers.length]
  })(), [[201, 201, 201], [200, 200, 200],
    ['Volunteer One', 'Volunteer   Two', 'Volunteer Three'], 3])

check('  nothing matches a pasted name against the register',
  [fakeSheets.state.reads,
   // CODE, not copy: the dialog legitimately TELLS the operator that nothing
   // is matched, and a scan that fired on that sentence would delete it.
   /readAttendeeRegister|filterAttendees|EventAttendee|formatBadgeNumber|badgeNumber/
     .test(stripComments(read('src/components/cng/bulk-add-cng-names-dialog.tsx')))],
  [[], false])

/**
 * 12 IS STRUCTURAL, and it has to be: a test that searched for a real
 * volunteer's name would have to contain one, which is the thing being
 * forbidden. So what is asserted is that no mechanism for hard-coding a list
 * exists — the file is gone, the constant is gone, nothing imports or
 * declares either, and the CNG modules declare no list of strings at all.
 */
const RETIRED_MODULE = 'cng-initial' + '-names'
const RETIRED_CONSTANT = ['CNG', 'INITIAL', 'NAMES'].join('_')
const IMPORTS_NAME_LIST = new RegExp(`from\\s*['"\`][^'"\`]*${RETIRED_MODULE}`)
const DECLARES_NAME_LIST = new RegExp(`(const|let|var)\\s+${RETIRED_CONSTANT}\\b`)

check('12. no compiled-in volunteer name list exists anywhere',
  [existsSync(join(root, `src/cng/${RETIRED_MODULE}.ts`)),
   existsSync(join(root, `src/shared/${RETIRED_MODULE}.ts`)),
   existsSync(join(root, `src/components/cng/${RETIRED_MODULE}-panel.tsx`))],
  [false, false, false])
check('  and nothing imports or declares one, with nothing exempt',
  ['api', 'server', 'src', 'scripts', 'docs', 'drizzle'].flatMap((directory) => {
    const found = []
    const step = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) { step(next); continue }
        if (!/\.(ts|tsx|mjs|md|sql)$/.test(entry.name)) continue
        const text = read(next)
        if (IMPORTS_NAME_LIST.test(text) || DECLARES_NAME_LIST.test(text)) {
          found.push(next)
        }
      }
    }
    step(directory)
    return found
  }), [])
check('  the CNG modules declare no hard-coded list of strings',
  ['src/cng', 'src/components/cng'].flatMap((directory) =>
    readdirSync(join(root, directory))
      .filter((file) => /:\s*(readonly\s+)?string\[\]\s*=(?!>)/
        .test(stripComments(read(`${directory}/${file}`))))
      .map((file) => `${directory}/${file}`)), [])
check('  and the paste reaches no storage, URL, log or analytics sink',
  ['src/components/cng/bulk-add-cng-names-dialog.tsx',
   'src/components/cng/add-cng-member-dialog.tsx']
    .flatMap((file) => {
      const code = stripComments(read(file))
      return ['localStorage', 'sessionStorage', 'indexedDB', '@/db/database',
        "from 'dexie'", 'URLSearchParams', 'location.search', 'history.pushState',
        'sendBeacon', 'gtag(', 'analytics', 'console.', 'fetch(', 'XMLHttpRequest',
        'document.cookie', 'setInterval', 'setTimeout(']
        .filter((sink) => code.includes(sink))
        .map((sink) => `${file}:${sink}`)
    }), [])

/* ====================== 13-15. SOFT REMOVAL ============================ */

console.log('\n=== 13-15. REMOVAL IS SOFT, AND HISTORY SURVIVES IT ===')

seedCentral()
seedSheet()
const keptId = await addMember('Volunteer Kept')
const goneId = await addMember('Volunteer Gone')
await patch({ cngMemberId: goneId, prizeName: CATALOG[1] })
await patch({ cngMemberId: keptId, prizeName: CATALOG[0] })

const awardsBeforeRemoval = JSON.parse(JSON.stringify(fakeDb.state.cngPrizeAwards))

response = await remove({ cngMemberId: goneId })
body = await response.json()

check('13. removal hides the member from the ACTIVE list',
  [response.status, body.ok, activeNames(), memberNames().length],
  [200, true, ['Volunteer Kept'], 2])
check('  the row survives with its removal stamped, as one fact',
  (() => {
    const row = fakeDb.state.cngMembers.find((entry) => entry.id === goneId)
    return [row?.removedAt instanceof Date, row?.removedByDeviceId ?? null,
      row?.name ?? null]
  })(), [true, DEVICE_ID, 'Volunteer Gone'])
check('  and GET no longer lists them, while their prize stays named',
  await (async () => {
    const fresh = await roster()
    return [fresh.cng.map((member) => member.name),
      fresh.cngAwards.length,
      fresh.cngAwards.filter((award) => award.cngMemberId === goneId)
        .map((award) => award.memberName)]
  })(), [['Volunteer Kept'], 2, ['Volunteer Gone']])
check('14. removal deletes NO prior CNG award, byte for byte',
  [JSON.stringify(fakeDb.state.cngPrizeAwards) === JSON.stringify(awardsBeforeRemoval),
   fakeDb.state.cngPrizeAwards.length],
  [true, 2])
check('15. a REMOVED member cannot receive a new prize, and nothing is written',
  await (async () => {
    const refused = await patch({ cngMemberId: goneId, prizeName: CATALOG[2] })
    const refusedBody = await refused.json()
    return [refused.status, refusedBody.blocked, fakeDb.state.cngPrizeAwards.length]
  })(), [404, 'cng-member-unavailable', 2])
check('  and the active one still can',
  await (async () => {
    const allowed = await patch({ cngMemberId: keptId, prizeName: CATALOG[2] })
    return [allowed.status, fakeDb.state.cngPrizeAwards.length]
  })(), [201, 3])
check('  a removal is by ID, never by name, and is event-scoped',
  await (async () => {
    const byName = await remove({ name: 'Volunteer Kept' })
    const notMine = await remove({ cngMemberId: '00000000-0000-4000-8000-000000000000' })
    const twice = await remove({ cngMemberId: goneId })
    return [byName.status, notMine.status, twice.status, activeNames()]
  })(), [400, 404, 404, ['Volunteer Kept']])
check('  and another event\'s member is neither listed nor removable',
  await (async () => {
    seedCentral({ members: [{ name: 'Other Event', eventId: 'other-event-id',
      id: 'eeeeeeee-0000-4000-8000-000000000001' }] })
    seedSheet()
    const fresh = await roster()
    const removed = await remove({ cngMemberId: 'eeeeeeee-0000-4000-8000-000000000001' })
    return [fresh.cng.length, removed.status, fakeDb.state.cngMembers.length]
  })(), [0, 404, 1])

/**
 * THE MEMBER ROW IS LOCKED FIRST, AND THAT IS THE SERIALISATION.
 *
 * A pre-read of `removed_at` followed by an insert is not enough: a process
 * can pause for any length of time between them, and a removal can commit
 * inside that window. So the award opens its transaction by locking the
 * member row `FOR UPDATE` — the same row `removeCngMember` updates — and the
 * guarded insert re-states the predicate inside that same transaction.
 *
 * Asserted from the TRANSACTION'S OWN RECORD as well as the structure: the
 * stand-in records every applied statement in order, so "the lock is first"
 * is read off the batch rather than inferred from the source.
 */
check('  the member row is LOCKED FOR UPDATE as the first statement',
  (() => {
    const writer = stripComments(read('server/cng/awards.ts'))
    const record = writer.slice(writer.indexOf('export const recordCngPrizeAward'))
    return [
      // The lock exists, is event-scoped and is scoped to an ACTIVE member.
      /\.for\('update'\)/.test(writer),
      /eq\(cngMembers\.eventId, input\.eventId\)[\s\S]{0,120}isNull\(cngMembers\.removedAt\)/
        .test(writer),
      // It is the FIRST statement of the batch that writes.
      /batch\(\[\s*lockCngMember\(/.test(record),
      // And the guarded insert still carries the predicate itself.
      /\.insert\(cngPrizeAwards\)[\s\S]{0,300}\.select\(/.test(writer),
      // One definition, one call site.
      [...writer.matchAll(/lockCngMember\b/g)].length,
      // No pre-read decides anything: there is no SELECT above the batch.
      /await[\s\S]{0,80}select\([\s\S]{0,200}removedAt[\s\S]{0,200}\n\n  const \[locked/
        .test(record),
    ]
  })(), [true, true, true, true, 2, false])
check('  and the lock is recorded FIRST in the transaction itself',
  await (async () => {
    seedCentral()
    seedSheet()
    const id = await addMember('Volunteer Locked')

    fakeDb.state.applied = []

    const awarded = await patch({ cngMemberId: id, prizeName: CATALOG[0] })

    /**
     * THE CNG STATEMENTS ONLY. The session check legitimately reads devices,
     * events, attributes and assignments first; those are separate queries
     * before the transaction, not part of it.
     */
    return [awarded.status,
      fakeDb.state.applied.filter((entry) => entry.includes('cng'))]
  })(), [201, ['lock cng_members for update', 'insert cng_prize_awards select']])
/**
 * THE POST-LOCK BEHAVIOUR, scripted. The stand-in is single-threaded, so a
 * concurrent writer has ALWAYS already committed by the time the first
 * statement runs — which is exactly the world the real lock produces when the
 * removal wins the race. The award must then observe the removal and refuse.
 *
 * What this CANNOT prove is PostgreSQL's visibility rules; that is the real-DB
 * smoke's job. What it does prove is that nothing in the writer decides from
 * a stale read.
 */
check('  a removal that commits first makes the waiting award refuse',
  await (async () => {
    seedCentral()
    seedSheet()
    const id = await addMember('Volunteer Racing')

    /** Commits BEFORE the award's transaction opens, like the real winner. */
    fakeDb.state.beforeNextWrite = () => {
      const row = fakeDb.state.cngMembers.find((entry) => entry.id === id)

      row.removedAt = new Date('2026-10-16T13:00:00.000Z')
      row.removedByDeviceId = OTHER_DEVICE_ID
    }

    const refused = await patch({ cngMemberId: id, prizeName: CATALOG[0] })
    const refusedBody = await refused.json()

    return [refused.status, refusedBody.blocked,
      fakeDb.state.cngPrizeAwards.length, activeNames()]
  })(), [404, 'cng-member-unavailable', 0, []])
check('  while an award that gets there first still lands, and then removal works',
  await (async () => {
    seedCentral()
    seedSheet()
    const id = await addMember('Volunteer Racing')
    const awarded = await patch({ cngMemberId: id, prizeName: CATALOG[0] })
    const removed = await remove({ cngMemberId: id })

    return [awarded.status, removed.status,
      fakeDb.state.cngPrizeAwards.length, activeNames()]
  })(), [201, 200, 1, []])

/* ============ 16-19. THE ATTENDEE LEDGER IS UNTOUCHED ================== */

console.log('\n=== 16-19. `prize_awards` IS SACRED ===')

seedCentral()
seedSheet()

response = await post({ badgeNumber: 9005, prizeName: 'Best Dance - Girl' })
body = await response.json()

check('16. the attendee POST workflow is unchanged: badge in, badge row out',
  [response.status, body.ok, fieldOf(body.award, 'badgeNumber'),
   fieldOf(body.award, 'prizeName'),
   fieldOf(fieldOf(body.award, 'attendee'), 'name'),
   fakeDb.state.prizeAwards.length],
  [201, true, 9005, 'Best Dance - Girl', 'Fixture Gamma', 1])
check('  its stored row still holds exactly the six badge-based columns',
  Object.keys(fakeDb.state.prizeAwards[0] ?? {}).sort(),
  ['awardedAt', 'awardedByDeviceId', 'badgeNumber', 'eventId', 'id', 'prizeName'])
check('  it still refuses an unregistered badge, reads the register first, and knows nothing of CNG',
  await (async () => {
    const refused = await post({ badgeNumber: 4242, prizeName: CATALOG[0] })
    const refusedBody = await refused.json()
    const source = stripComments(read('api/prizes.ts'))
    const postText = source.slice(source.indexOf('export async function POST('),
      source.indexOf('export async function PUT('))
    return [refused.status, refusedBody.blocked,
      postText.indexOf('readAttendeeRegister(') < postText.indexOf('recordPrizeAward('),
      /cngMemberId|cngPrizeAwards|recordCngPrizeAward/.test(postText)]
  })(), [404, 'badge-not-registered', true, false])
check('  a repeat attendee prize is still allowed',
  await (async () => {
    const again = await post({ badgeNumber: 9005, prizeName: 'Best Dance - Girl' })
    return [again.status, fakeDb.state.prizeAwards.length]
  })(), [201, 2])

const attendeeLedgerBefore = JSON.parse(JSON.stringify(fakeDb.state.prizeAwards))
const cngId = await addMember('Volunteer Winner')
response = await patch({ cngMemberId: cngId, prizeName: 'Best Dress - Male' })
body = await response.json()

check('17. a CNG prize writes ONLY `cng_prize_awards`',
  [response.status, body.ok, fakeDb.state.cngPrizeAwards.length,
   fieldOf(body.award, 'memberName'), fieldOf(body.award, 'prizeName')],
  [201, true, 1, 'Volunteer Winner', 'Best Dress - Male'])
check('19. and the attendee ledger is byte-for-byte unchanged by it',
  [JSON.stringify(fakeDb.state.prizeAwards) === JSON.stringify(attendeeLedgerBefore),
   fakeDb.state.prizeAwards.length],
  [true, 2])
check('  the CNG award row carries a member reference, never a badge',
  Object.keys(fakeDb.state.cngPrizeAwards[0] ?? {}).sort(),
  ['awardedAt', 'awardedByDeviceId', 'cngMemberId', 'eventId', 'id', 'prizeName'])
check('18. repeat CNG prizes are allowed, including the same prize twice',
  await (async () => {
    const second = await patch({ cngMemberId: cngId, prizeName: 'Best Dance - Male' })
    const third = await patch({ cngMemberId: cngId, prizeName: 'Best Dress - Male' })
    return [second.status, third.status, fakeDb.state.cngPrizeAwards.length,
      new Set(fakeDb.state.cngPrizeAwards.map((row) => row.id)).size]
  })(), [201, 201, 3, 3])
check('  and nothing in the schema makes a CNG award unique',
  (() => {
    const schema = read('server/db/schema.ts')
    const start = schema.indexOf('export const cngPrizeAwards = pgTable(')
    const end = Math.min(...['\nexport const ', '\nexport type ']
      .map((marker) => schema.indexOf(marker, start + 1))
      .filter((index) => index !== -1))
    return [...stripComments(schema.slice(start, end))
      .matchAll(/(unique|uniqueIndex)\(/g)].length
  })(), 0)
check('  a CNG prize must be one of the SAME eight, and an invented one is refused',
  await (async () => {
    const refused = await patch({ cngMemberId: cngId, prizeName: 'Best Volunteering' })
    const accepted = []
    for (const prizeName of CATALOG) {
      accepted.push((await patch({ cngMemberId: cngId, prizeName })).status)
    }
    return [refused.status, [...new Set(accepted)]]
  })(), [400, [201]])
check('  each ledger has exactly one writer module, and they are different',
  ['api', 'server', 'src'].flatMap((directory) => walk(directory))
    .flatMap((path) => {
      const code = stripComments(read(path))
      const tables = []
      if (/\bprizeAwards\b/.test(code)) tables.push(`prizeAwards:${path}`)
      if (/\bcngPrizeAwards\b/.test(code)) tables.push(`cngPrizeAwards:${path}`)
      return tables
    }).sort(),
  ['cngPrizeAwards:server/cng/awards.ts', 'cngPrizeAwards:server/db/schema.ts',
   'prizeAwards:server/db/schema.ts', 'prizeAwards:server/prizes/awards.ts'])
check('  and neither writer can reach the other\'s table',
  [/cngPrizeAwards|cngMembers/.test(stripComments(read('server/prizes/awards.ts'))),
   /\bprizeAwards\b/.test(stripComments(read('server/cng/awards.ts')))],
  [false, false])

/* ============= 20-22. THE COMBINED, DATE-GROUPED HISTORY =============== */

console.log('\n=== 20-22. BOTH LEDGERS, ONE DATE-GROUPED HISTORY ===')

const attendeeAward = (id, iso, over = {}) => ({
  id: `aaaaaaaa-1111-4000-8000-${String(id).padStart(12, '0')}`,
  badgeNumber: 188,
  prizeName: 'Best Dance - Female',
  awardedAt: iso,
  awardedBy: { id: DEVICE_ID, name: 'Prize Test Desk' },
  attendee: { badgeNumber: 188, name: 'Fixture Ranita', age: 20, gender: 'female' },
  ...over,
})

const cngAward = (id, iso, over = {}) => ({
  id: `dddddddd-1111-4000-8000-${String(id).padStart(12, '0')}`,
  cngMemberId: 'cccccccc-1111-4000-8000-000000000001',
  memberName: 'Volunteer Winner',
  prizeName: 'Best Dance - Female',
  awardedAt: iso,
  awardedBy: { id: DEVICE_ID, name: 'Prize Test Desk' },
  ...over,
})

/** 16:20 and 16:25 UTC are 9:50 pm and 9:55 pm in Asia/Kolkata. */
const ATTENDEE_950 = attendeeAward(1, '2026-10-16T16:20:00.000Z')
const CNG_955 = cngAward(2, '2026-10-16T16:25:00.000Z')
const ATTENDEE_925 = attendeeAward(3, '2026-10-16T15:55:00.000Z',
  { badgeNumber: 102, prizeName: 'Best Dress - Girl' })
const CNG_LAST_NIGHT = cngAward(4, '2026-10-15T16:00:00.000Z',
  { memberName: 'Volunteer Other' })

const combined = awardGroups.combineAwardHistory(
  [ATTENDEE_950, ATTENDEE_925], [CNG_955, CNG_LAST_NIGHT])

check('20. the two ledgers combine, each keeping its own identity',
  combined.map((award) =>
    award.source === 'attendee'
      ? ['attendee', award.badgeNumber, award.attendee?.name ?? null]
      : ['cng', award.cngMemberId, award.memberName]),
  [['cng', 'cccccccc-1111-4000-8000-000000000001', 'Volunteer Winner'],
   ['attendee', 188, 'Fixture Ranita'],
   ['attendee', 102, 'Fixture Ranita'],
   ['cng', 'cccccccc-1111-4000-8000-000000000001', 'Volunteer Other']])
check('  and NO badge is invented for a CNG award',
  combined.filter((award) => award.source === 'cng')
    .map((award) => 'badgeNumber' in award), [false, false])
check('21. the combined order is newest first, across both sources',
  combined.map((award) => award.awardedAt),
  ['2026-10-16T16:25:00.000Z', '2026-10-16T16:20:00.000Z',
   '2026-10-16T15:55:00.000Z', '2026-10-15T16:00:00.000Z'])
check('  and the order is deterministic when two land in the same millisecond',
  awardGroups.combineAwardHistory(
    [attendeeAward(9, '2026-10-16T16:20:00.000Z')],
    [cngAward(8, '2026-10-16T16:20:00.000Z')],
  ).map((award) => award.id),
  ['dddddddd-1111-4000-8000-000000000008', 'aaaaaaaa-1111-4000-8000-000000000009'])
check('22. grouping is by the EVENT-LOCAL day, and both sources share a heading',
  awardGroups.groupAwardsByEventDay(combined)
    .map((entry) => [entry.dayKey, entry.awards.map((award) => award.source)]),
  [['2026-10-16', ['cng', 'attendee', 'attendee']], ['2026-10-15', ['cng']]])
/**
 * 18:29 UTC is 23:59 IST on the 16th; 18:31 UTC is 00:01 IST on the 17th.
 * Two minutes apart, and two different nights.
 */
check('  23:59 and 00:01 IST are different nights, for a CNG award too',
  awardGroups.groupAwardsByEventDay(awardGroups.combineAwardHistory(
    [attendeeAward(10, '2026-10-16T18:29:00.000Z')],
    [cngAward(11, '2026-10-16T18:31:00.000Z')],
  )).map((entry) => [entry.dayKey, entry.awards[0].source]),
  [['2026-10-17', 'cng'], ['2026-10-16', 'attendee']])
check('  and the answer is identical under UTC, America/Los_Angeles and Pacific/Kiritimati',
  await (async () => {
    const answers = []
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      const isolated = createJiti(import.meta.url, {
        alias: { '@': `${root}/src` }, interopDefault: true,
      })
      process.env.TZ = zone
      const module_ = await isolated.import(`${root}/src/prizes/award-groups.ts`)
      answers.push(module_.groupAwardsByEventDay(module_.combineAwardHistory(
        [attendeeAward(10, '2026-10-16T18:29:00.000Z')],
        [cngAward(11, '2026-10-16T18:31:00.000Z')],
      )).map((entry) => entry.dayKey))
    }
    process.env.TZ = 'UTC'
    return answers
  })(), [['2026-10-17', '2026-10-16'], ['2026-10-17', '2026-10-16'],
    ['2026-10-17', '2026-10-16']])
check('  the grouping still reads the ONE shared definition and no local date maths',
  (() => {
    const code = stripComments(read('src/prizes/award-groups.ts'))
    return [/from '@\/shared\/event-time'/.test(code),
      ['.getDate(', '.getMonth(', '.getFullYear(', 'toLocaleDateString(',
        'getTimezoneOffset(', 'Asia/Kolkata', '+05:30', 'new Date()', 'Date.now(']
        .filter((local) => code.includes(local))]
  })(), [true, []])
check('  grouping loses nothing: flattening restores the combined list exactly',
  awardGroups.groupAwardsByEventDay(combined).flatMap((entry) => entry.awards)
    .map((award) => award.id),
  combined.map((award) => award.id))
check('  search finds an attendee badge, an attendee name, a CNG name or a prize',
  [filters.filterPrizeAwards(combined, '188').map((a) => a.id),
   filters.filterPrizeAwards(combined, '#102').map((a) => a.id),
   filters.filterPrizeAwards(combined, 'Ranita').length,
   filters.filterPrizeAwards(combined, 'Volunteer Winner').map((a) => a.id),
   filters.filterPrizeAwards(combined, 'Volunteer Other').map((a) => a.id),
   filters.filterPrizeAwards(combined, 'Best Dress').map((a) => a.id),
   filters.filterPrizeAwards(combined, 'nobody').length],
  [['aaaaaaaa-1111-4000-8000-000000000001'],
   ['aaaaaaaa-1111-4000-8000-000000000003'],
   2,
   ['dddddddd-1111-4000-8000-000000000002'],
   ['dddddddd-1111-4000-8000-000000000004'],
   ['aaaaaaaa-1111-4000-8000-000000000003'],
   0])
check('  and a CNG award is never matched by a number, because it has none',
  filters.filterPrizeAwards(combined, '188')
    .filter((award) => award.source === 'cng').length, 0)

seedCentral()
seedSheet()
check('  GET returns the two ledgers SEPARATELY, and the client combines them',
  await (async () => {
    const id = await addMember('Volunteer Winner')
    await patch({ cngMemberId: id, prizeName: CATALOG[0] })
    await post({ badgeNumber: 9005, prizeName: CATALOG[1] })
    const fresh = await roster()
    return [fresh.awards.length, fresh.cngAwards.length,
      Object.keys(fresh.cngAwards[0] ?? {}).sort(),
      // Nothing badge-shaped on a CNG award, on the wire either.
      JSON.stringify(fresh.cngAwards).includes('badge')]
  })(), [1, 1,
    ['awardedAt', 'awardedBy', 'cngMemberId', 'id', 'memberName', 'prizeName'],
    false])

/* ====================== 23-24. NO FAKE BADGE, SAME BUDGET ============== */

console.log('\n=== 23-24. NO FAKE BADGE, AND NO NEW FUNCTION ===')

/**
 * 23. THE WHOLE POINT OF THE CORRECTION. A synthetic badge would sort, match
 * a search and collide with a real attendee's, so none may exist anywhere in
 * the CNG implementation — not `0`, not `-1`, not `999999`, and not a
 * nullable badge column on the attendee ledger.
 */
/**
 * IDENTIFIERS, not the word. The Add dialog legitimately tells the operator
 * that volunteers "have no attendee badge", and a scan that fired on that
 * sentence would delete the one place the correction is explained to a human.
 * What must not exist is a badge being read, written, formatted or defaulted.
 */
check('23. no CNG module reads, writes or formats a badge',
  [...walk('server/cng'), ...walk('src/cng'), ...walk('src/components/cng')]
    .filter((path) =>
      /badgeNumber|badge_number|formatBadgeNumber|@\/lib\/badge/
        .test(stripComments(read(path))))
    .filter((path) => path !== 'server/cng/requests.ts'),
  [])
check('  and the retired name resolver is gone with the model it served',
  [existsSync(join(root, 'src/cng/cng-name-resolution.ts')),
   ['api', 'server', 'src'].flatMap((directory) => walk(directory))
     .filter((path) => /cng-name-resolution|resolveCngName|cngNameMatches/
       .test(read(path)))],
  [false, []])
check('  and the one that does only REFUSES it',
  (() => {
    const requests = stripComments(read('server/cng/requests.ts'))
    return [/'badgeNumber',/.test(requests), /'badge',/.test(requests),
      // No badge is ever read, defaulted or written there.
      /badgeNumber:|badge_number/.test(requests)]
  })(), [true, true, false])
check('  neither CNG table declares a badge column',
  (() => {
    const schema = read('server/db/schema.ts')
    return ['cngMembers', 'cngPrizeAwards'].map((table) => {
      const start = schema.indexOf(`export const ${table} = pgTable(`)
      const end = Math.min(...['\nexport const ', '\nexport type ']
        .map((marker) => schema.indexOf(marker, start + 1))
        .filter((index) => index !== -1))
      return /badge/i.test(stripComments(schema.slice(start, end)))
    })
  })(), [false, false])
check('  0008 declares no badge column and DROPS the one 0007 had',
  (() => {
    const sql = read('drizzle/0008_cng_named_members.sql').replace(/^--.*$/gm, '')
    return [/ADD COLUMN "badge_number"/.test(sql),
      sql.includes('DROP COLUMN "badge_number"'),
      sql.includes('ADD COLUMN "name" text NOT NULL')]
  })(), [false, true, true])
check('  `prize_awards.badge_number` is still NOT NULL and badge-based',
  (() => {
    const schema = read('server/db/schema.ts')
    const start = schema.indexOf('export const prizeAwards = pgTable(')
    const end = Math.min(...['\nexport const ', '\nexport type ']
      .map((marker) => schema.indexOf(marker, start + 1))
      .filter((index) => index !== -1))
    const table = schema.slice(start, end)
    return [/badgeNumber: integer\('badge_number'\)\.notNull\(\)/.test(table),
      /**
       * And no migration ever made IT nullable. Scoped to the prize ledger:
       * 0006 legitimately dropped NOT NULL from `dandiya_loan_holders`, which
       * is a different table and a different product rule.
       */
      readdirSync(join(root, 'drizzle'))
        .filter((file) => file.endsWith('.sql'))
        .filter((file) => /ALTER TABLE "prize_awards"[\s\S]{0,120}DROP NOT NULL/
          .test(read(`drizzle/${file}`)))]
  })(), [true, []])
check('  and no synthetic badge value is constructed anywhere',
  [...walk('server/cng'), ...walk('src/cng'), ...walk('src/components/cng'),
   'server/cng/requests.ts']
    .filter((path) =>
      /badgeNumber:\s*-?\d|badge_number.*-1|badgeNumber = -?\d|GUEST-\d/
        .test(stripComments(read(path)))),
  [])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
console.log(`  Vercel Functions: ${String(budget.actual.length)} / ${String(functionChecker.HOBBY_FUNCTION_LIMIT)}` +
  `   Headroom: ${String(functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length)}`)

check('24. the Function inventory is UNCHANGED at eleven', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'attendees', 'dandiya', 'device-auth', 'device-badge-claim',
  'prizes', 'sync-registration',
])
check('  with the same one slot of headroom, and nothing unexpected',
  [functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, budget.problems],
  [1, []])
check('  prizes serves the whole screen through five methods',
  [...stripComments(read('api/prizes.ts')).matchAll(/export async function ([A-Z]+)\(/g)]
    .map((match) => match[1]).sort(),
  ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'])
check('  and the three CNG methods never reach the attendee ledger',
  (() => {
    const source = stripComments(read('api/prizes.ts'))
    return ['PUT', 'DELETE', 'PATCH'].flatMap((method) => {
      const start = source.indexOf(`export async function ${method}(`)
      const rest = source.slice(start)
      const next = rest.slice(1).search(/export async function [A-Z]+\(/)
      const bodyText = next === -1 ? rest : rest.slice(0, next + 1)
      return ['recordPrizeAward', 'readPrizeAwards', 'prizeAwards']
        .filter((name) => bodyText.includes(name))
        .map((name) => `${method}:${name}`)
    })
  })(), [])

/* ====================================== THE SCREEN, RENDERED FOR REAL == */

console.log('\n=== THE CNG TAB AND THE COMBINED HISTORY, ON SCREEN ===')

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

const MEMBER = {
  id: 'cccccccc-1111-4000-8000-000000000001',
  name: 'Volunteer Winner',
  addedAt: ADDED_AT,
  addedBy: { id: DEVICE_ID, name: 'Prize Test Desk' },
}

const cngTab = (over = {}) => renderUi('src/components/cng/cng-roster.tsx', {
  members: [MEMBER], cngAwards: [], isBusy: false,
  onAdd: noop, onBulkAdd: noop, onGivePrize: noop, onRemove: noop, ...over,
})

const tabHtml = await cngTab()

check('the CNG card shows a NAME and says CNG Member',
  [tabHtml.includes('Volunteer Winner'), tabHtml.includes('CNG Member'),
   tabHtml.includes('Give Prize'), tabHtml.includes('Remove')],
  [true, true, true, true])
check('  and shows NO badge, age or gender, because none exist',
  [/#\d/.test(tabHtml), /Age /.test(tabHtml), /Male|Female/.test(tabHtml)],
  [false, false, false])
check('  the tab offers Add and Bulk Add Names',
  [tabHtml.includes('CNG Members (1)'), tabHtml.includes('>Add<'),
   tabHtml.includes('Bulk Add Names'), tabHtml.includes('Resolve Name List')],
  [true, true, true, false])
check('  previous prizes are a COUNT on the card, never a refusal',
  await (async () => {
    const html = await cngTab({
      cngAwards: [cngAward(20, ADDED_AT, { cngMemberId: MEMBER.id }),
        cngAward(21, ADDED_AT, { cngMemberId: MEMBER.id })],
    })
    return [html.includes('2 prizes already received'), html.includes('Give Prize'),
      /\sdisabled=""/.test(html)]
  })(), [true, true, false])
check('  an empty group says so rather than looking broken',
  (await cngTab({ members: [] })).includes('No CNG members yet'), true)
check('  and a request in flight disables Add, Bulk Add, Remove and Give Prize',
  (((await cngTab({ isBusy: true })).match(/\sdisabled=""/g) ?? []).length >= 4), true)

check('Add is one NAME field, and shows the trimmed name back',
  await (async () => {
    const html = await renderUi('src/components/cng/add-cng-member-dialog.tsx', {
      isSubmitting: false, onCancel: noop, onAdd: noop,
    })
    return [html.includes('Add a CNG Member'), html.includes('>Name<'),
      (html.match(/<input/g) ?? []).length,
      html.includes('no attendee badge'),
      // Nothing to search, and no badge, age or gender asked for.
      /Badge number or name|registered attendees|Age|Gender/.test(html),
      /<button[^>]*disabled=""[^>]*>Add CNG Member/.test(html.replace(/\n\s*/g, ''))]
  })(), [true, true, 1, true, false, true])

check('Bulk Add Names takes a paste and previews it',
  await (async () => {
    const html = await renderUi('src/components/cng/bulk-add-cng-names-dialog.tsx', {
      isSubmitting: false, onCancel: noop, onAdd: noop,
    })
    return [html.includes('Bulk Add Names'), html.includes('<textarea'),
      html.includes('One name per line'), html.includes('Blank lines are ignored.'),
      html.includes('nothing is matched against the attendee register'),
      /autocomplete="off"/i.test(html), /\sname="/.test(html)]
  })(), [true, true, true, true, true, true, false])
check('  closing it DISCARDS the list, by unmounting it',
  (() => {
    const desk = read('src/components/prizes/prize-desk.tsx')
    const dialog = stripComments(read('src/components/cng/bulk-add-cng-names-dialog.tsx'))
    return [/isBulkAddingCng \? \(\s*<BulkAddCngNamesDialog/.test(desk),
      /<BulkAddCngNamesDialog[\s\S]{0,400}open=\{/.test(desk),
      /const discard = \(\): void => \{/.test(dialog),
      /setText\(''\)/.test(dialog)]
  })(), [true, false, true, true])

check('the CNG award dialog names the member and offers the same eight prizes',
  await (async () => {
    const html = await renderUi('src/components/cng/award-cng-prize-dialog.tsx', {
      member: MEMBER, previousAwards: [], isSubmitting: false,
      onCancel: noop, onAward: noop,
    })
    return [html.includes('Volunteer Winner'), html.includes('CNG Member'),
      CATALOG.filter((label) => !html.includes(label)),
      // No demographic suggestion: a volunteer has no age or gender.
      html.includes('Suggested'),
      /#\d|Age /.test(html)]
  })(), [true, true, [], false, false])
check('  and it warns about previous prizes without blocking',
  await (async () => {
    const html = await renderUi('src/components/cng/award-cng-prize-dialog.tsx', {
      member: MEMBER,
      previousAwards: [cngAward(30, '2026-10-16T16:20:00.000Z',
        { cngMemberId: MEMBER.id, prizeName: 'Best Dress - Male' })],
      isSubmitting: false, onCancel: noop, onAward: noop,
    })
    return [html.includes('Previous prizes'), html.includes('Best Dress - Male'),
      html.includes('Award Another Prize'), html.includes('still award another'),
      /**
       * THE WARNING BLOCK ONLY, which ends where the chooser begins. The
       * submit button below it is correctly disabled in a server render —
       * no prize is selected — and slicing past the chooser would report
       * that as the warning blocking the award.
       */
      /disabled|override|approval/i
        .test(html.slice(html.indexOf('Previous prizes'),
          html.indexOf('role="radiogroup"')))]
  })(), [true, true, true, true, false])

const history = (awards, search = '') =>
  renderUi('src/components/prizes/award-history.tsx',
    { awards, search, onSearchChange: noop })

const combinedHtml = await history(combined)
const normalised = combinedHtml.replace(/&nbsp;| | /g, ' ')

check('the combined history shows a badge for an attendee and CNG for a volunteer',
  [normalised.includes('#188'), normalised.includes('>CNG<'),
   normalised.includes('Fixture Ranita'), normalised.includes('Volunteer Winner'),
   /9:55\s*pm/i.test(normalised), /9:50\s*pm/i.test(normalised)],
  [true, true, true, true, true, true])
check('  under ONE date heading per night, latest expanded and older collapsed',
  [combinedHtml.includes('16 October 2026'), combinedHtml.includes('15 October 2026'),
   (combinedHtml.match(/aria-expanded="true"/g) ?? []).length,
   (combinedHtml.match(/aria-expanded="false"/g) ?? []).length,
   combinedHtml.includes('3 awards'), combinedHtml.includes('1 award<')],
  [true, true, 1, 1, true, true])
check('  a card shows the TIME only, never the date',
  [/16 Oct[^<]*9:50/i.test(normalised),
   /formatEventDateTime/.test(read('src/components/prizes/award-history.tsx'))],
  [false, false])
check('  and history still offers no undo, delete or edit',
  /Undo|Delete|Remove|Edit/.test(stripComments(combinedHtml)), false)

const desk = stripComments(read('src/components/prizes/prize-desk.tsx'))

check('the desk counts Awards as attendee + CNG records',
  [desk.includes('roster.awards.length + roster.cngAwards.length'),
   desk.includes('`CNG (${String(roster.cng.length)})`'),
   desk.includes('`Attendees (${String(roster.attendees.length)})`')],
  [true, true, true])
check('  and the history is combined for DISPLAY only',
  /combineAwardHistory\(roster\.awards, roster\.cngAwards\)/.test(desk), true)
/**
 * THE TWO AWARD DIALOGS ARE SIBLINGS, so their keys must not collide.
 *
 * They did. Each was rendered unconditionally and keyed
 * `<target> === null ? 'none' : <target>.<id>`, so whenever neither was open
 * — the resting state of the screen — both carried the key `none` and React
 * warned "Encountered two children with the same key". CNG1.1 is what exposed
 * it: with one such dialog the fallback was unique by construction, and the
 * volunteer dialog copied the idiom.
 *
 * `renderToStaticMarkup` cannot catch this — React 19's server renderer emits
 * no duplicate-key warning — so the key expressions are pinned directly.
 */
check('the two award dialogs are keyed by their own item, not by a shared fallback',
  (() => {
    const desk = stripComments(read('src/components/prizes/prize-desk.tsx'))

    return [
      /\{selected === null \? null : \(\s*<AwardPrizeDialog\s+key=\{String\(selected\.badgeNumber\)\}/
        .test(desk),
      /\{cngAwarding === null \? null : \(\s*<AwardCngPrizeDialog\s+key=\{cngAwarding\.id\}/
        .test(desk),
      // And no key in the desk reaches for a literal at all.
      [...desk.matchAll(/key=\{[^}\n]*\}/g)].map((match) => match[0])
        .filter((expression) => /['"]/.test(expression)),
    ]
  })(), [true, true, []])
check('  and the volunteer chooser still passes no demographic suggestion',
  (() => {
    const dialog = stripComments(read('src/components/cng/award-cng-prize-dialog.tsx'))

    return [/suggestedDivision=\{null\}/.test(dialog),
      /key=/.test(dialog)]
  })(), [true, false])
check('  a CNG prize leaves the attendee ledger and the group alone',
  [/cngAwards: \[result\.award, \.\.\.roster\.cngAwards\]/.test(desk),
   /awards: roster\.awards,[\s\S]{0,200}cngAwards: \[result\.award/.test(desk)],
  [true, true])
check('  one in-flight guard covers all four writes',
  [...desk.matchAll(/setIsSubmitting\(true\)/g)].length, 4)
check('  the roster is still read on mount and on reconnect, and nowhere else',
  [[...desk.matchAll(/useEffect\(/g)].length, /\[network, readAttempt\]/.test(desk)],
  [1, true])
check('  the pure group helpers key on the row id, never the name',
  [group.withCngMember([], MEMBER).map((m) => m.id),
   group.withCngMember([MEMBER], { ...MEMBER, id: 'other' }).length,
   group.withCngMember([MEMBER], MEMBER).length,
   group.withoutCngMember([MEMBER], MEMBER.id).length,
   /\.name/.test(stripComments(read('src/cng/cng-group.ts')))],
  [[MEMBER.id], 2, 1, 0, false])

/* ========================================= THE MIGRATION AND db:check == */

console.log('\n=== 0007 IS HISTORY; 0008 CORRECTS IT, LOUDLY ===')

const migration = read('drizzle/0008_cng_named_members.sql')
const statements = migration.replace(/^--.*$/gm, '')

check('the journal appends 0008 after 0007',
  JSON.parse(read('drizzle/meta/_journal.json')).entries.map((entry) => entry.tag)
    .slice(-2),
  ['0007_cng_members', '0008_cng_named_members'])
check('  0007 is untouched and still creates the badge-based model',
  [/CONSTRAINT "cng_members_event_id_badge_number_key" UNIQUE\("event_id","badge_number"\)/
    .test(read('drizzle/0007_cng_members.sql')),
   /"badge_number" integer NOT NULL/.test(read('drizzle/0007_cng_members.sql'))],
  [true, true])
check('0008 REFUSES to run if cng_members holds any row',
  [/DO \$\$/.test(statements), /RAISE EXCEPTION/.test(statements),
   /IF EXISTS \(SELECT 1 FROM "cng_members"\)/.test(statements),
   // The guard is the FIRST statement, before anything is altered.
   statements.indexOf('RAISE EXCEPTION') < statements.indexOf('ALTER TABLE')],
  [true, true, true, true])
/**
 * ORDERING, NOT SHAPE. The composite FK into `cng_members("id","event_id")`
 * cannot be created before that column pair carries a UNIQUE constraint; the
 * primary key on `id` alone does not satisfy PostgreSQL. Drizzle emitted them
 * the other way round, which no schema-shape assertion can see.
 */
check('  and the referenced UNIQUE(id, event_id) precedes the composite FK',
  (() => {
    const key = statements.indexOf('ADD CONSTRAINT "cng_members_id_event_id_key"')
    const fk = statements.indexOf('ADD CONSTRAINT "cng_prize_awards_member_event_fk"')
    return [key !== -1, fk !== -1, key < fk]
  })(), [true, true, true])
check('  and it never converts a badge number into a name',
  [/UPDATE "cng_members"/.test(statements), /INSERT INTO/i.test(statements),
   /SET "name"/.test(statements)],
  [false, false, false])
check('  it alters cng_members only, and creates one table',
  [[...new Set([...statements.matchAll(/ALTER TABLE "([a-z_]+)"/g)]
    .map((match) => match[1]))].sort(),
   [...statements.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((match) => match[1])],
  [['cng_members', 'cng_prize_awards'], ['cng_prize_awards']])
check('  and it names none of the protected tables',
  ['prize_awards', 'device_attributes', 'badge_assignments',
   'dandiya_loans', 'dandiya_loan_holders']
    .filter((table) => statements.includes(`"${table}"`)), [])
check('  every guarantee the schema declares is in the migration',
  [...new Set([
    ...[...statements.matchAll(/(?:ADD )?CONSTRAINT "([a-z_0-9]+)"/g)].map((m) => m[1]),
    ...[...statements.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_0-9]+)"/g)].map((m) => m[1]),
  ])].sort(),
  ['cng_members_badge_number_positive', 'cng_members_event_id_badge_number_key',
   'cng_members_id_event_id_key', 'cng_members_name_max_length',
   'cng_members_name_not_empty', 'cng_members_removal_paired',
   'cng_members_removed_by_device_id_devices_id_fk',
   'cng_members_removed_device_event_fk',
   'cng_prize_awards_awarded_by_device_id_devices_id_fk',
   'cng_prize_awards_awarded_by_device_id_idx',
   'cng_prize_awards_cng_member_id_cng_members_id_fk',
   'cng_prize_awards_cng_member_id_idx',
   'cng_prize_awards_device_event_fk', 'cng_prize_awards_event_id_events_id_fk',
   'cng_prize_awards_event_id_idx', 'cng_prize_awards_member_event_fk',
   'cng_prize_awards_prize_name_max_length',
   'cng_prize_awards_prize_name_not_empty'])

/**
 * THE REAL-DB SMOKE: present, gated, and wired into no unattended gate.
 *
 * It is the only thing that can prove the lock's EFFECT — a writer that began
 * before the removal committed still observing it afterwards. This suite
 * cannot: it is single-threaded, so it proves the post-lock behaviour and the
 * statement order instead.
 */
check('the CNG award smoke exists, writes only its own rows, and is gated',
  (() => {
    const smoke = read('scripts/cng-award-concurrency-smoke.mjs')
    return [
      ["process.env.ALLOW_CNG_DB_SMOKE_WRITES !== 'true'",
       "process.env.VERCEL_ENV !== 'development'",
       "allowedEnv !== 'development'", '--confirm', 'SMOKE-CNG11-',
       'recordCngPrizeAward', 'removeCngMember', 'for update', 'pg_sleep']
        .filter((needle) => !smoke.includes(needle)),
      // It touches no central table, and never the attendee ledger.
      /(insert into|delete from) (events|devices|device_attributes|badge_assignments|prize_awards|dandiya_)/i
        .test(smoke),
      // Every interlock refuses before a connection is opened.
      Math.max(
        smoke.indexOf("process.env.ALLOW_CNG_DB_SMOKE_WRITES !== 'true'"),
        smoke.indexOf("process.env.VERCEL_ENV !== 'development'"),
        smoke.indexOf("allowedEnv !== 'development'"),
      ) < smoke.indexOf('const sql ='),
    ]
  })(), [[], false, true])
check('  and it is wired into no unattended gate',
  (() => {
    const pkg = JSON.parse(read('package.json'))
    return [pkg.scripts['db:smoke:cng-award'],
      ['verify', 'build', 'lint', 'release:check']
        .filter((gate) => /db:smoke|concurrency-smoke/.test(pkg.scripts[gate]))]
  })(), ['node scripts/cng-award-concurrency-smoke.mjs', []])

const dbCheck = read('scripts/db-check.mjs')
const dbCheckList = (name) => {
  const start = dbCheck.indexOf(`const ${name} = [`)
  const end = start === -1 ? -1 : dbCheck.indexOf('\n]', start)

  return start === -1 || end === -1 ? '' : dbCheck.slice(start, end)
}
const cngExpectations = ['EXPECTED_CNG_CONSTRAINTS', 'EXPECTED_CNG_INDEXES',
  'EXPECTED_CNG_AWARD_CONSTRAINTS']
  .map(dbCheckList).join('\n')

check('db:check knows both CNG tables',
  [dbCheckList('EXPECTED_TABLES').includes("'cng_members'"),
   dbCheckList('EXPECTED_TABLES').includes("'cng_prize_awards'")],
  [true, true])
check('  and verifies every guarantee the FINAL schema has',
  ['cng_members_name_not_empty', 'cng_members_name_max_length',
   'cng_members_removal_paired', 'cng_members_removed_device_event_fk',
   'cng_members_device_event_fk', 'cng_members_id_event_id_key',
   'cng_prize_awards_member_event_fk', 'cng_prize_awards_device_event_fk',
   'cng_prize_awards_prize_name_not_empty',
   'cng_prize_awards_prize_name_max_length',
   'cng_prize_awards_event_id_idx', 'cng_prize_awards_cng_member_id_idx',
   'cng_prize_awards_awarded_by_device_id_idx']
    .filter((name) => !cngExpectations.includes(name)), [])
check('  and expects NONE of the guarantees 0008 dropped',
  ['cng_members_event_id_badge_number_key', 'cng_members_badge_number_positive']
    .filter((name) => cngExpectations.includes(name)), [])
check('  the final column sets, as exact SETS',
  [dbCheck.includes('const CNG_COLUMNS = {'),
   dbCheck.includes('const CNG_AWARD_COLUMNS = {'),
   ['added_at', 'added_by_device_id', 'event_id', 'id', 'name', 'removed_at',
    'removed_by_device_id'].filter((column) => !dbCheck.includes(`'${column}'`))],
  [true, true, []])
check('  it proves repeat CNG awards stay possible',
  /repeated CNG prize awards are allowed/.test(dbCheck), true)
check('  and it STILL proves the attendee ledger is untouched',
  [/repeated prize awards are allowed/.test(dbCheck),
   /prize ledger holds exactly its/.test(dbCheck),
   dbCheckList('PRIZE_COLUMNS').split('\n').filter((line) => /^\s+'/.test(line)).length],
  [true, true, 6])
check('  and db:check stays READ-ONLY',
  ['INSERT', 'UPDATE ', 'DELETE', 'CREATE TABLE', 'ALTER ', 'DROP ', 'child_process']
    .filter((statement) => stripComments(dbCheck).includes(statement)), [])
check('release:check guards the named model',
  ["'cng-membership'", 'cng_prize_awards', '0008_cng_named_members.sql',
   'DELETE,GET,PATCH,POST,PUT', 'recordPrizeAward is called from']
    .filter((needle) => !read('scripts/release-check.mjs').includes(needle)), [])
/**
 * AND THREE GUARDS THAT A CANARY SWEEP FOUND TOO WEAK TO BITE.
 *
 * Each one passed while the regression it names was actually present: the
 * exact-key refusal was pinned at the call sites but not where it happens,
 * the history guard pinned only the ATTENDEE branch of the ternary, and
 * "0007 is history" was read as "0007 still mentions a badge column". A
 * guard that cannot fail is a comment, so the proof is kept here.
 */
check('  including the three a canary sweep had to sharpen',
  ['parseExactBody does not refuse a key outside',
   "formatBadgeNumber\\([\\s\\S]{0,120}:\\s*'CNG'",
   '0007 is no longer byte-identical',
   'before the UNIQUE(id, event_id) it references',
   'keys a child by a shared literal fallback']
    .filter((needle) => !read('scripts/release-check.mjs').includes(needle)), [])

console.log('\n=== DOCUMENTATION ===')
for (const [doc, needles] of [
  ['docs/CNG.md', ['cng_members', 'cng_prize_awards', '0008_cng_named_members',
    'PATCH  /api/prizes', 'soft', 'Bulk Add Names']],
  ['AGENTS.md', ['CNG Volunteers', 'cng_prize_awards', 'PATCH  /api/prizes']],
  ['docs/PRIZES.md', ['cng_prize_awards', 'CNG']],
  ['docs/DATABASE.md', ['0008_cng_named_members']],
  ['docs/PRODUCTION_RELEASE_CHECKLIST.md', ['0008_cng_named_members']],
  ['README.md', ['CNG']],
]) {
  check(`${doc} documents this phase`,
    needles.filter((needle) => !read(doc).includes(needle)), [])
}
check('  and no document still calls a CNG member a badge or an attendee subset',
  ['docs/CNG.md', 'AGENTS.md', 'README.md', 'docs/PRIZES.md']
    .filter((doc) => /curated subset of the (same )?(live )?(registered )?attendees|CNG member = registered attendee|membership is a badge number|identified by (their )?badge number/i
      .test(read(doc))), [])
check('  the suite runs inside `pnpm verify`',
  (() => {
    const pkg = JSON.parse(read('package.json'))
    return [pkg.scripts.verify.includes('verify:cng1'),
      pkg.scripts['verify:cng1']]
  })(), [true, 'node scripts/verification/phase-cng1.mjs'])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${String(fails)} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
