#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY prize fixtures for the Badge Register.
 *
 * Usage, with `VERCEL_ENV` supplied explicitly because `vercel dev` does not
 * expose it to this project:
 *
 *   env VERCEL_ENV=development node scripts/seed-prizes-development.mjs --dry-run
 *   env VERCEL_ENV=development node scripts/seed-prizes-development.mjs --confirm
 *   env VERCEL_ENV=development node scripts/seed-prizes-development.mjs --cleanup --confirm
 *
 * `--dry-run` runs every guard and loads the real Sheet contract WITHOUT
 * making a single API request, which is how you confirm the configuration
 * points where you think it does before anything is written.
 *
 * WHY IT WRITES TO A SHEET AT ALL. `/prizes` reads the attendees from the same
 * Badge Register that production registrations sync into, because that is
 * where attendee data lives — Postgres deliberately holds none. Testing the
 * prize desk therefore needs rows in the DEVELOPMENT Badge Register, not a
 * new attendee table invented for the test.
 *
 * IT MUST NEVER BE ABLE TO SEED PRODUCTION, and four independent things have
 * to agree before it writes anything:
 *
 *   1. `--confirm` on the command line
 *   2. `VERCEL_ENV` exactly `development`
 *   3. `SYNC_ALLOWED_VERCEL_ENV` exactly `development`
 *   4. the real release interlock in `server/sync/environment.ts`, which
 *      requires those two to match before it reads a single credential
 *
 * A production deployment sets `SYNC_ALLOWED_VERCEL_ENV=production`, so even a
 * production credential pasted into the environment is refused. The one thing
 * no code can check is whether a development env file points at the
 * production spreadsheet, so the script prints a short NON-REVERSIBLE
 * fingerprint of the spreadsheet id for the operator to compare. It never
 * prints the id, a credential, or any other value.
 *
 * It reuses the REAL Sheet contract — the same row builder, the same shape
 * check, the same initialiser the sync endpoint uses — so a fixture row can
 * never be a shape the application would reject.
 *
 * IDEMPOTENT. Every fixture row has a deterministic Registration ID, so a
 * second run updates the same rows instead of adding thirty more.
 *
 * `--cleanup` blanks ONLY those rows. It never deletes a row — removing a
 * dimension shifts every index below it — and it never touches a row it did
 * not write.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createJiti } from 'jiti'

const root = resolve(import.meta.dirname, '..')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)

  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const CONFIRMED = has('--confirm')
const CLEANUP = has('--cleanup')
/** Every guard, the real modules and the fingerprint — but no API call. */
const DRY_RUN = has('--dry-run')
const ENV_FILE = valueOf('--env-file', '.env.development.local')

const fail = (message) => {
  console.error(`REFUSED  ${message}`)
  process.exit(1)
}

/**
 * The names this script needs, and ONLY those.
 *
 * A local env file legitimately holds real secrets, so nothing is enumerated,
 * echoed or logged: each name is read, used, and never printed.
 */
const NEEDED = [
  'VERCEL_ENV',
  'SYNC_WRITE_ENABLED',
  'SYNC_ALLOWED_VERCEL_ENV',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'SYNC_ALLOWED_ORIGIN',
]

/**
 * A minimal `KEY=value` reader. `export ` prefixes, `#` comments, blank lines
 * and matched surrounding quotes are handled; nothing else is interpreted.
 * An existing process variable always wins, so an explicit `env VAR=…` on the
 * command line is never overridden by a file.
 */
const loadEnvFile = (path) => {
  let text

  try {
    text = readFileSync(resolve(root, path), 'utf8')
  } catch {
    return 0
  }

  let loaded = 0

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^export\s+/, '')

    if (line === '' || line.startsWith('#')) {
      continue
    }

    const equals = line.indexOf('=')

    if (equals === -1) {
      continue
    }

    const name = line.slice(0, equals).trim()

    if (!NEEDED.includes(name) || process.env[name] !== undefined) {
      continue
    }

    let value = line.slice(equals + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[name] = value
    loaded += 1
  }

  return loaded
}

if (/production/i.test(ENV_FILE)) {
  fail(`--env-file ${ENV_FILE} names a production environment.`)
}

const loaded = loadEnvFile(ENV_FILE)

console.log(`Navaratri prize fixtures — ${CLEANUP ? 'CLEANUP' : 'SEED'}`)
console.log(`  env file: ${ENV_FILE} (${String(loaded)} of the needed names supplied)`)

if (process.env.NODE_ENV === 'production') {
  fail('NODE_ENV is production.')
}

if (process.env.VERCEL_ENV !== 'development') {
  fail('VERCEL_ENV is not exactly "development". This script only runs against Development.')
}

if (process.env.SYNC_ALLOWED_VERCEL_ENV !== 'development') {
  fail(
    'SYNC_ALLOWED_VERCEL_ENV is not exactly "development", so this configuration is not a Development one.',
  )
}

if (!CONFIRMED && !DRY_RUN) {
  fail('add --confirm to write fixture rows to the Development Badge Register.')
}

/* --------------------------------------------- the real modules, not copies */

const jiti = createJiti(import.meta.url, { interopDefault: true })

const environmentModule = await jiti.import(`${root}/server/sync/environment.ts`)
const sheetsModule = await jiti.import(`${root}/server/sync/google-sheets.ts`)
const contract = await jiti.import(`${root}/server/sync/sheet-contract.ts`)
const requests = await jiti.import(`${root}/server/sync/requests.ts`)

const environment = environmentModule.readSyncEnvironment()

if (environment.ok === false) {
  // Names the reason, never a value.
  fail(environmentModule.SYNC_DISABLED_LOG_MESSAGES[environment.reason])
}

const { spreadsheetId } = environment.environment

console.log(
  `  spreadsheet fingerprint: ${createHash('sha256').update(spreadsheetId).digest('hex').slice(0, 8)}`,
)
console.log('  (compare that against your Development sheet before continuing)\n')

const sheets = sheetsModule.createSheetsAccess(environment.environment)

if (DRY_RUN) {
  console.log('--dry-run: every guard passed and the Sheet contract loaded. No request was made.')
  process.exit(0)
}

/* ------------------------------------------------------------- the fixtures */

/**
 * Obviously disposable, and obviously fake.
 *
 * The badge block is #9001-#9030: far above any range a real desk would be
 * handed, so a fixture row is recognisable at a glance and cannot collide
 * with a genuine badge. The Registration ID prefix is what makes the seed
 * idempotent and the cleanup precise.
 */
const FIXTURE_ID_PREFIX = 'prize-test-fixture-'
const FIXTURE_BADGE_START = 9001
const FIXTURE_COUNT = 30

/** Children, teens and adults, so the age filter has something to filter. */
const AGES = [5, 7, 8, 9, 11, 12, 13, 15, 16, 17, 19, 22, 26, 31, 34, 38, 42, 45, 51, 58, 63, 67, 71, 6, 10, 14, 18, 24, 29, 47]

const fixtureBadges = Array.from(
  { length: FIXTURE_COUNT },
  (_unused, index) => FIXTURE_BADGE_START + index,
)

/**
 * One fixture payload.
 *
 * Deliberately carries NO `deviceId`/`deviceName`: the row builder then writes
 * two blank device cells, which keeps a pre-Phase-7 `legacy` Development tab
 * recognisable as legacy rather than turning it into a conflicting shape the
 * sync endpoint would refuse.
 */
const fixturePayload = (badgeNumber, index) => {
  const label = String(index + 1).padStart(2, '0')
  // A fixed instant, so a re-run produces byte-identical rows.
  const when = new Date(Date.UTC(2026, 9, 10, 4, 30, 0) + index * 60_000).toISOString()

  return {
    id: `${FIXTURE_ID_PREFIX}${String(badgeNumber)}`,
    status: 'completed',
    paymentStatus: 'confirmed',
    paymentMethod: index % 3 === 0 ? 'cash' : 'upi',
    badgeNumber,
    name: `Prize Test ${label}`,
    normalizedName: `prize test ${label}`,
    // Valid 10 digits, and a block no real Indian number occupies.
    phone: String(9000000000 + badgeNumber - FIXTURE_BADGE_START + 1),
    age: AGES[index % AGES.length],
    // Alternating, so Male/Female are balanced 15/15 across the block.
    gender: index % 2 === 0 ? 'female' : 'male',
    amount: 20,
    createdAt: when,
    completedAt: when,
    updatedAt: when,
  }
}

/* ------------------------------------------------- the Badge Register itself */

const spreadsheet = await sheets.client.spreadsheets.get({
  auth: sheets.auth,
  spreadsheetId,
})

const existingSheets = spreadsheet.data.sheets ?? []
const findSheetId = (list) =>
  list.find((sheet) => sheet.properties?.title === contract.BADGE_REGISTER_TITLE)
    ?.properties?.sheetId ?? undefined

let sheetId = findSheetId(existingSheets)

if (sheetId === undefined) {
  if (CLEANUP) {
    console.log('Nothing to clean up: the Badge Register does not exist.')
    process.exit(0)
  }

  await sheets.client.spreadsheets.batchUpdate({
    auth: sheets.auth,
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: contract.BADGE_REGISTER_TITLE } } }],
    },
  })

  sheetId = findSheetId(
    (await sheets.client.spreadsheets.get({ auth: sheets.auth, spreadsheetId })).data.sheets ?? [],
  )
}

if (sheetId === undefined) {
  fail('the Badge Register tab could not be created.')
}

const readRows = async () => {
  const response = await sheets.client.spreadsheets.values.get({
    auth: sheets.auth,
    spreadsheetId,
    range: contract.BADGE_REGISTER_RANGE,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })

  return response.data.values ?? []
}

let values = await readRows()

const shape = contract.checkTabShape(
  values,
  contract.BADGE_REGISTER_HEADERS,
  contract.BADGE_REGISTER_HEADERS_V1,
)

if (shape === 'conflicting') {
  fail(
    `"${contract.BADGE_REGISTER_TITLE}" holds a different layout or unexpected data. Resolve it by hand.`,
  )
}

/**
 * A provably BLANK tab is initialised with the application's own initialiser,
 * which is the same thing the sync endpoint does and is safe for exactly the
 * same reason. A tab with data in it is never reshaped here.
 */
if (shape === 'empty') {
  if (CLEANUP) {
    console.log('Nothing to clean up: the Badge Register is empty.')
    process.exit(0)
  }

  console.log('  initialising the empty Badge Register with the application header')

  await sheets.client.spreadsheets.batchUpdate({
    auth: sheets.auth,
    spreadsheetId,
    requestBody: {
      requests: requests.buildTabInitializationRequests(
        sheetId,
        contract.BADGE_REGISTER_HEADERS,
        contract.BADGE_REGISTER_COLUMNS.registrationId,
        contract.BADGE_REGISTER_COLUMNS.phone,
        contract.BADGE_REGISTER_COLUMNS.badge,
      ),
    },
  })

  values = await readRows()
}

/** Data row index by Registration ID, for the rows this script owns. */
const fixtureRowIndex = new Map()

values.slice(1).forEach((row, index) => {
  const id = String((row ?? [])[contract.BADGE_REGISTER_COLUMNS.registrationId] ?? '').trim()

  if (id.startsWith(FIXTURE_ID_PREFIX)) {
    fixtureRowIndex.set(id, index)
  }
})

const pending = []

if (CLEANUP) {
  for (const index of fixtureRowIndex.values()) {
    pending.push(
      requests.updateCellsRequest(
        sheetId,
        index,
        contract.buildBlankRow(contract.BADGE_REGISTER_COLUMNS.count),
      ),
    )
  }

  if (pending.length === 0) {
    console.log('No fixture rows found. Nothing to remove.')
    process.exit(0)
  }

  await sheets.client.spreadsheets.batchUpdate({
    auth: sheets.auth,
    spreadsheetId,
    requestBody: { requests: pending },
  })

  console.log(`Cleared ${String(pending.length)} fixture row(s). No other row was touched.`)
  process.exit(0)
}

let appended = 0
let updated = 0

fixtureBadges.forEach((badgeNumber, index) => {
  const payload = fixturePayload(badgeNumber, index)
  const row = contract.buildBadgeRegisterRow(payload)
  const existing = fixtureRowIndex.get(payload.id)

  if (existing === undefined) {
    pending.push(requests.appendCellsRequest(sheetId, row))
    appended += 1

    return
  }

  // The SAME row, rewritten: this is what makes a second run a no-op rather
  // than thirty more attendees.
  pending.push(requests.updateCellsRequest(sheetId, existing, row))
  updated += 1
})

pending.push(requests.sortBadgeRegisterRequest(sheetId))

await sheets.client.spreadsheets.batchUpdate({
  auth: sheets.auth,
  spreadsheetId,
  requestBody: { requests: pending },
})

console.log(
  `Seeded the Development Badge Register: ${String(appended)} appended, ${String(updated)} rewritten.`,
)
console.log(
  `  badges #${String(FIXTURE_BADGE_START)}-#${String(FIXTURE_BADGE_START + FIXTURE_COUNT - 1)}, names "Prize Test 01" … "Prize Test ${String(FIXTURE_COUNT)}"`,
)
console.log('  remove them again with: --cleanup --confirm')
