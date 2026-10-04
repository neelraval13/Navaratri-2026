/**
 * Consolidated safety verification for Phases 2B/2C/3A/3B/5A/5B/6A/6C/7A.
 *
 * Run with:  pnpm verify:prior
 *
 * Covers the invariants that must never regress: the Held A -> Completed B
 * stale-acknowledgement race, 401 retaining the outbox, the release interlock,
 * session tampering and expiry, sync auth ordering, the Sheet V1 -> V2
 * migration, device provenance, fail-closed device writes, range exhaustion,
 * and the DeviceSetupGate / DeviceLabel regressions.
 *
 * Framework-free on purpose. Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHmac } from 'node:crypto'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')
const FAKE = `${HERE}/fake-db.mjs`

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': FAKE, '@': `${root}/src` }, interopDefault: true,
})
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true })

const distIndex = join(root, 'dist/index.html')
if (!existsSync(distIndex)) {
  console.error('This suite inspects the production build. Run `pnpm build` first.')
  process.exit(1)
}

let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { fails++; console.log(`FAIL ${label}\n     got  ${String(JSON.stringify(actual))}\n     want ${String(JSON.stringify(expected))}`) }
  else console.log(`ok   ${label.padEnd(56)} ${String(JSON.stringify(actual)).slice(0, 38)}`)
}

const { state } = await jiti.import(FAKE)
const device = await jiti.import(`${root}/src/db/device.ts`)
const eventConfig = await jiti.import(`${root}/src/db/event-config.ts`)
const reg = await jiti.import(`${root}/src/db/registrations.ts`)
const contract = await jiti.import(`${root}/src/shared/sync-contract.ts`)
const retry = await jiti.import(`${root}/src/sync/retry-policy.ts`)
const outboxDb = await jiti.import(`${root}/src/db/outbox.ts`)
const sync = await jiti.import(`${root}/src/sync/outbox-sync.ts`)
const name = await jiti.import(`${root}/src/lib/name.ts`)
const identity = await jiti.import(`${root}/src/components/registration/identity-match.ts`)
const upi = await jiti.import(`${root}/src/lib/upi.ts`)
const sheet = await jiti.import(`${root}/server/sync/sheet-contract.ts`)
const requests = await jiti.import(`${root}/server/sync/requests.ts`)
const decisions = await jiti.import(`${root}/server/sync/decisions.ts`)
const syncEnv = await jiti.import(`${root}/server/sync/environment.ts`)

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const CONFIGURED = { id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, badgeEnd: 1000, nextBadge: 47,
  deviceId: DEVICE_ID, deviceName: 'Test Desk', deviceConfiguredAt: 'T1', updatedAt: 'T0' }
const reset = (over = {}) => {
  state.outbox.clear(); state.registrations.clear()
  state.config = { ...CONFIGURED, ...over }
}
const attendee = (phone, nm) => ({ registrationId: null, phone, name: nm, age: 25, gender: 'male' })

console.log('=== 2B. NAME + IDENTITY ===')
check('normalize', [name.normalizeName(' rahul   sharma '), name.normalizeName('RAHUL SHARMA')], ['rahul sharma', 'rahul sharma'])
const mk = (id, st, norm, extra = {}) => ({ id, name: 'X', normalizedName: norm, phone: '9', age: 1, gender: 'male',
  amount: 20, status: st, paymentStatus: st === 'held' ? 'pending' : 'confirmed', heldAt: 'x', createdAt: 'x', updatedAt: 'x', ...extra })
const H = mk('h', 'held', 'a b')
const C = mk('c', 'completed', 'a b', { badgeNumber: 9, completedAt: 'x', paymentMethod: 'upi' })
check('COMPLETED always beats held', identity.getIdentityMatch([H, C], 'A B').kind, 'completed')
check('own record is not a conflict', identity.findOtherRegistrationConflict([H], 'A B', 'h'), null)
check('another held IS a conflict', identity.findOtherRegistrationConflict([H], 'A B', 'z')?.id, 'h')

console.log('\n=== 2C/3A/7A. HOLD, ISSUE, RANGE, PROVENANCE ===')
reset()
let r = await reg.holdRegistration({ ...attendee('9000070001', ' Aarav  Test '), paymentMethod: null })
const held = r.registration
check('hold created', r.outcome, 'created')
check('  consumes no badge', state.config.nextBadge, 47)
check('  no badgeNumber', 'badgeNumber' in held, false)
check('  step-1 hold stores no payment method', 'paymentMethod' in held, false)
check('  edge-trimmed, inner spacing kept', held.name, 'Aarav  Test')
check('  device provenance snapshotted', [held.deviceId, held.deviceName], [DEVICE_ID, 'Test Desk'])
check('  outbox row carries it too', state.outbox.get(`registration:${held.id}`).payload.deviceId, DEVICE_ID)
r = await reg.issueBadge({ registrationId: held.id, phone: '9000070001', name: 'Aarav Test', age: 25, gender: 'male', paymentMethod: 'cash' })
check('issue transitions in place', [r.outcome, r.registration.id === held.id, state.registrations.size], ['issued', true, 1])
check('  badge = nextBadge', r.registration.badgeNumber, 47)
check('  nextBadge +1 exactly', state.config.nextBadge, 48)
check('  one outbox row, now completed', [state.outbox.size, state.outbox.get(`registration:${held.id}`).payload.status], [1, 'completed'])

reset({ nextBadge: 1, badgeEnd: 2 })
await reg.issueBadge({ ...attendee('9000070002', 'One'), paymentMethod: 'cash' })
r = await reg.issueBadge({ ...attendee('9000070003', 'Two'), paymentMethod: 'cash' })
check('last badge in range may be issued', [r.outcome, r.registration.badgeNumber], ['issued', 2])
r = await reg.issueBadge({ ...attendee('9000070004', 'Three'), paymentMethod: 'cash' })
check('past badgeEnd refused', [r.outcome, r.badgeEnd], ['badge-range-exhausted', 2])
check('  no increment, no wrap', state.config.nextBadge, 3)
check('Hold still allowed when exhausted',
  (await reg.holdRegistration({ ...attendee('9000070005', 'Holdable'), paymentMethod: null })).outcome, 'created')

reset({ deviceId: undefined, deviceName: undefined, badgeEnd: undefined })
check('unregistered device: hold fails closed',
  (await reg.holdRegistration({ ...attendee('9000070006', 'X'), paymentMethod: null })).outcome, 'badge-distribution-not-configured')
check('unregistered device: issue fails closed',
  (await reg.issueBadge({ ...attendee('9000070006', 'X'), paymentMethod: 'cash' })).outcome, 'badge-distribution-not-configured')
check('  nothing written', [state.registrations.size, state.outbox.size], [0, 0])
check('  and no badge is considered available', eventConfig.hasBadgeAvailable(state.config), false)

const BOOTSTRAP = { ...CONFIGURED, deviceId: undefined, deviceName: undefined, badgeEnd: undefined, nextBadge: 1 }
check('bootstrap defaults are NOT badge-configured', device.isBadgeDistributionConfigured(BOOTSTRAP), false)
check('exhausted range is still badge-configured', device.isBadgeDistributionConfigured({ ...CONFIGURED, nextBadge: 1001 }), true)
check('nextBadge past badgeEnd+1 is NOT', device.isBadgeDistributionConfigured({ ...CONFIGURED, nextBadge: 1002 }), false)
/**
 * Phase D2 DELETED `registerDevice`, the local random-UUID identity writer.
 * There is no local device registration any more — a browser takes the
 * central device's UUID through Phase D1 convergence — so what was asserted
 * about that writer became an assertion that it cannot come back.
 */
check('there is no local device-identity writer', typeof device.registerDevice, 'undefined')
check('  and no local module mints a device id',
  /deviceId:\s*crypto\.randomUUID\(\)/.test(readFileSync(join(root, 'src/db/device.ts'), 'utf8')), false)

/**
 * `configureBadgeDistribution` SURVIVES as the canonical range invariant and
 * is still exercised directly, but it has no product caller: a hand-entered
 * range records no central binding, and the access gate refuses that desk.
 * `release:check` fails if a component or page calls it again.
 */
reset({ ...BOOTSTRAP, deviceId: DEVICE_ID, deviceName: 'Registration Desk A' })
r = await device.configureBadgeDistribution({ badgeStart: 1, badgeEnd: 250, physicalStackConfirmed: true })
check('badge distribution configures', [r.outcome, r.config.nextBadge, r.config.badgeEnd], ['configured', 1, 250])
check('  preserves unrelated config', [r.config.eventName, r.config.amount, r.config.timezone], ['Navaratri 2026', 20, 'Asia/Kolkata'])
reset(BOOTSTRAP)
check('a range needs an identity first',
  (await device.configureBadgeDistribution({ badgeStart: 1, badgeEnd: 9, physicalStackConfirmed: true })).outcome,
  'device-not-registered')
reset()
check('already badge-configured refuses again',
  (await device.configureBadgeDistribution({ badgeStart: 5, badgeEnd: 9, physicalStackConfirmed: true })).outcome, 'already-configured')

console.log('\n=== 3B. UPI ===')
check('URI exact', upi.buildUpiPaymentUri({ upiId: 'example@upi', payeeName: 'Example Name', amount: 20, eventName: 'Navaratri 2026' }),
  'upi://pay?pa=example%40upi&pn=Example%20Name&am=20.00&cu=INR&tn=Navaratri%202026%20Badge%20Fee')
check('non-INR fails closed', upi.resolveUpiPayment({ upiId: 'a@b', payeeName: 'N', currency: 'USD', amount: 20, eventName: 'E' }), null)

console.log('\n=== 5A/7A. SHEET CONTRACT + V1->V2 ===')
check('A1 titles quoted, V2 widths', [sheet.BADGE_REGISTER_RANGE, sheet.HELD_REGISTRATIONS_RANGE], ["'Badge Register'!A1:N", "'Held Registrations'!A1:M"])
check('visible columns unmoved', sheet.BADGE_REGISTER_HEADERS.slice(0, 10).join(','),
  'Badge,Name,Phone,WhatsApp Link,Age,Gender,Payment,Amount,Date,Time')
check('technical columns unmoved', [sheet.BADGE_REGISTER_COLUMNS.registrationId, sheet.BADGE_REGISTER_COLUMNS.updatedAt], [10, 11])
const completed5a = { id: 'i', name: '=HYPERLINK("https://evil.example","x")', phone: '9876543210', age: 8, gender: 'male',
  amount: 20, status: 'completed', paymentStatus: 'confirmed', paymentMethod: 'upi', badgeNumber: 47,
  completedAt: '2026-09-14T17:05:09.000Z', createdAt: 'x', updatedAt: 'x', deviceId: DEVICE_ID, deviceName: 'Test Desk' }
const row = sheet.buildBadgeRegisterRow(completed5a)
check('formula injection: name stays a string cell', requests.toCellData(row[1]), { userEnteredValue: { stringValue: completed5a.name } })
check('  exactly one formula cell (WhatsApp)', row.filter((c) => c.kind === 'formula').length, 1)
check('  device cells are literal strings', [requests.toCellData(row[12]), requests.toCellData(row[13])],
  [{ userEnteredValue: { stringValue: DEVICE_ID } }, { userEnteredValue: { stringValue: 'Test Desk' } }])
check('IST date/time, server-TZ independent', [row[8].value, row[9].value], ['14/09/2026', '10:35:09 PM'])
const V1 = [...sheet.BADGE_REGISTER_HEADERS_V1], V2 = [...sheet.BADGE_REGISTER_HEADERS]
check('V1 header -> legacy', sheet.checkTabShape([V1], V2, V1), 'legacy')
check('V2 header -> matching', sheet.checkTabShape([V2], V2, V1), 'matching')
check('blank -> empty', sheet.checkTabShape([], V2, V1), 'empty')
check('blank header over data -> conflicting', sheet.checkTabShape([[''], ['Neel']], V2, V1), 'conflicting')
check('V1 with data in device columns -> conflicting',
  sheet.checkTabShape([V1, [1, 'N', '9', '', '', '', '', '', '', '', '', '', 'X']], V2, V1), 'conflicting')
const upgrade = requests.buildTabUpgradeRequests(10, V2, sheet.BADGE_REGISTER_COLUMNS.legacyCount, 10)
check('upgrade writes only appended header cells', [upgrade[0].updateCells.range.startColumnIndex, upgrade[0].updateCells.range.endColumnIndex], [12, 14])
check('  no destructive request', upgrade.some((q) => 'deleteDimension' in q || 'moveDimension' in q), false)
check('completed batch stays atomic',
  requests.buildCompletedSyncRequests({ kind: 'append', heldRowIndex: 3 }, completed5a, 10, 20).map((q) => Object.keys(q)[0]),
  ['appendCells', 'updateCells', 'sortRange'])
check('duplicate registration ids detected',
  decisions.findDuplicateRegistrationId([{ index: 0, registrationId: 'd', updatedAt: 'a' }, { index: 1, registrationId: 'd', updatedAt: 'b' }]), 'd')

console.log('\n=== 7A. WIRE DEVICE PROVENANCE ===')
const heldPayload = (over = {}) => ({ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'P', normalizedName: 'p',
  phone: '9000070001', age: 25, gender: 'male', amount: 20, status: 'held', paymentStatus: 'pending',
  heldAt: '2026-09-20T10:00:00.000Z', createdAt: '2026-09-20T09:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z', ...over })
const parse = (over) => contract.parseSyncRegistrationRequest({
  outboxId: 'registration:aaaaaaaa-0000-4000-8000-000000000001',
  registrationId: 'aaaaaaaa-0000-4000-8000-000000000001', operation: 'upsert', payload: heldPayload(over) })
check('both device fields valid -> accepted', parse({ deviceId: DEVICE_ID, deviceName: 'Desk A' }).ok, true)
check('both absent (legacy) -> accepted', parse({}).ok, true)
check('deviceId only -> rejected', parse({ deviceId: DEVICE_ID }).ok, false)
check('deviceName only -> rejected', parse({ deviceName: 'Desk A' }).ok, false)
check('malformed UUID -> rejected', parse({ deviceId: 'nope', deviceName: 'Desk A' }).ok, false)
check('untrimmed name -> rejected', parse({ deviceId: DEVICE_ID, deviceName: ' Desk ' }).ok, false)

console.log('\n=== 5B. RETRY POLICY + CONDITIONAL ACKNOWLEDGEMENT ===')
check('backoff 1..6', [1, 2, 3, 4, 5, 6].map(retry.getRetryDelayMs), [5000, 15000, 30000, 60000, 300000, 300000])
for (const c of ['unauthorized', 'invalid-request', 'forbidden-origin', 'sync-not-configured', 'badge-conflict', 'sheet-shape-conflict'])
  check(`  attention: ${c}`, [retry.isAttentionError(c), retry.isRetryableError(c)], [true, false])
for (const c of ['sync-failed', 'network-error', 'timeout', 'invalid-response', 'unexpected-http'])
  check(`  retryable: ${c}`, retry.isRetryableError(c), true)
check('unauthorized is global', retry.isGlobalFailure('unauthorized'), true)
check('attention rows get no retry timer',
  retry.getNextRetryAtMs([{ attemptCount: 1, lastAttemptAt: new Date().toISOString(), lastErrorCode: 'unauthorized' }], Date.now()), undefined)

const UPD_A = '2026-09-14T17:00:00.000Z', UPD_B = '2026-09-14T18:00:00.000Z'
const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const payloadFor = (updatedAt, status = 'held') => ({ ...heldPayload({ updatedAt }), status,
  ...(status === 'completed' ? { paymentStatus: 'confirmed', paymentMethod: 'cash', badgeNumber: 47, completedAt: updatedAt } : {}) })
const outboxRow = (payload, over = {}) => ({ id: `registration:${payload.id}`, registrationId: payload.id,
  operation: 'upsert', payload, createdAt: '2026-09-14T16:00:00.000Z', attemptCount: 0, ...over })
const refA = { outboxId: `registration:${ID_A}`, registrationId: ID_A, payloadUpdatedAt: UPD_A }
const seed = (...rows) => { state.outbox.clear(); for (const row of rows) state.outbox.set(row.id, structuredClone(row)) }

seed(outboxRow(payloadFor(UPD_A)))
check('exact snapshot is acknowledged', await outboxDb.acknowledgeSnapshot(refA), 'deleted')
seed(outboxRow(payloadFor(UPD_B)))
check('NEWER snapshot is never deleted by an older ack', await outboxDb.acknowledgeSnapshot(refA), 'superseded')
check('  the row survives', state.outbox.size, 1)
seed(outboxRow(payloadFor(UPD_B)))
check('stale failure cannot contaminate a newer snapshot',
  await outboxDb.recordSnapshotFailure(refA, 'sync-failed', 'x'), 'superseded')
check('  no failure metadata written', state.outbox.get(refA.outboxId).lastErrorCode, undefined)

console.log('\n=== 5B. HELD A -> COMPLETED B RACE (mandatory) ===')
state.config = { ...CONFIGURED }
seed(outboxRow(payloadFor(UPD_A)))
let posts = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  posts.push(body)
  // While A is in flight, the badge is issued: B overwrites the row.
  if (posts.length === 1) {
    state.outbox.set(refA.outboxId, structuredClone(outboxRow(payloadFor(UPD_B, 'completed'))))
  }
  return { ok: true, status: 200, async json() {
    return { ok: true, outcome: 'synced', registrationId: body.registrationId, payloadUpdatedAt: body.payload.updatedAt }
  } }
}
await sync.requestOutboxSync({ manual: true })
check('A acknowledged, then B sent in the SAME cycle', posts.length, 2)
check('  first request was Held A', [posts[0].payload.status, posts[0].payload.updatedAt], ['held', UPD_A])
check('  second request was Completed B', [posts[1].payload.status, posts[1].payload.updatedAt], ['completed', UPD_B])
check('  queue empty only after B was acked', state.outbox.size, 0)

seed(outboxRow(payloadFor(UPD_A)))
posts = []
globalThis.fetch = async (url, init) => {
  posts.push(JSON.parse(init.body))
  return { ok: false, status: 401, async json() { return { ok: false, outcome: 'unauthorized', message: 'Operator session required.' } } }
}
await sync.requestOutboxSync({ manual: true })
check('401 retains the row', state.outbox.size, 1)
check('  flagged unauthorized', state.outbox.get(refA.outboxId).lastErrorCode, 'unauthorized')
sync.stopOutboxSyncScheduling()

console.log('\n=== 6A. RELEASE INTERLOCK ===')
const CREDS = { GOOGLE_SHEETS_SPREADSHEET_ID: 's', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'e', GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'k', SYNC_ALLOWED_ORIGIN: 'o' }
const verdict = (over) => { const v = syncEnv.readSyncEnvironment({ ...CREDS, ...over }); return v.ok ? 'OK' : v.reason }
check('exactly "true" enables', syncEnv.parseSyncWriteEnabled('true'), true)
for (const v of [undefined, '', ' true', 'true ', 'TRUE', '1', 'yes', 'false'])
  check(`  rejected: ${JSON.stringify(v)}`, syncEnv.parseSyncWriteEnabled(v), false)
check('env must match exactly', verdict({ SYNC_WRITE_ENABLED: 'true', SYNC_ALLOWED_VERCEL_ENV: 'production', VERCEL_ENV: 'production' }), 'OK')
check('  mismatch fails closed', verdict({ SYNC_WRITE_ENABLED: 'true', SYNC_ALLOWED_VERCEL_ENV: 'production', VERCEL_ENV: 'preview' }), 'runtime-environment-mismatch')
check('  absent VERCEL_ENV fails closed', verdict({ SYNC_WRITE_ENABLED: 'true', SYNC_ALLOWED_VERCEL_ENV: 'production' }), 'runtime-environment-unknown')
check('  interlock precedes credentials', syncEnv.readSyncEnvironment({ SYNC_WRITE_ENABLED: 'false' }).reason, 'writes-disabled')
check('  padded config never matches', verdict({ SYNC_WRITE_ENABLED: 'true', SYNC_ALLOWED_VERCEL_ENV: ' production', VERCEL_ENV: 'production' }), 'runtime-environment-mismatch')

console.log('\n=== 6C. THE OPERATOR AUTH REALM IS GONE ===')
/**
 * Phase D2 DELETED Operator Access. What used to be exercised here — the
 * access-code policy, the HMAC session, the `__Host-` cookie — no longer
 * exists in any form, so the assertions became "it is gone and stays gone".
 * The live boundary is the central device session, proven below and in the
 * device suites.
 */
for (const gone of ['server/auth', 'src/auth', 'src/components/operator',
  'api/operator-login.ts', 'api/operator-session.ts', 'api/operator-logout.ts',
  'src/hooks/use-operator-access.ts', 'src/pages/device-registration-page.tsx']) {
  check(`retired: ${gone}`, existsSync(join(root, gone)), false)
}

console.log('\n=== 6C. SYNC ENDPOINT IS DEVICE-AUTHORIZED ONLY ===')
const ORIGIN = 'https://navaratri.test'
const route = await jiti.import(`${root}/api/sync-registration.ts`)
const setEnv = (over) => {
  for (const k of ['EVENT_DEVICE_SESSION_SECRET', 'DATABASE_URL', 'SYNC_WRITE_ENABLED',
    'SYNC_ALLOWED_VERCEL_ENV', 'VERCEL_ENV', 'SYNC_ALLOWED_ORIGIN', 'GOOGLE_SHEETS_SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY']) delete process.env[k]
  Object.assign(process.env, over)
}
const post = (cookieHeader) => new Request(`${ORIGIN}/api/sync-registration`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookieHeader ? { cookie: cookieHeader } : {}) }, body: '{}' })
const SECRET = 'x'.repeat(48)
const FULL = { EVENT_DEVICE_SESSION_SECRET: SECRET, SYNC_WRITE_ENABLED: 'true',
  SYNC_ALLOWED_VERCEL_ENV: 'production', VERCEL_ENV: 'production', SYNC_ALLOWED_ORIGIN: ORIGIN,
  GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@x.iam.gserviceaccount.com', GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'k' }
setEnv(FULL)
let res = await route.POST(post())
check('no device session -> 401 unauthorized', [res.status, (await res.json()).outcome], [401, 'unauthorized'])
/**
 * The retired operator cookie is not merely rejected as a bad credential —
 * nothing on the server knows the name any more. A browser still carrying
 * one gets the same generic 401 as a browser carrying nothing.
 */
res = await route.POST(post('__Host-navaratri_operator_session=anything-at-all'))
check('  a lingering operator cookie authorizes nothing',
  [res.status, (await res.json()).outcome], [401, 'unauthorized'])
res = await route.POST(post('__Host-navaratri_device_session=not-a-real-token'))
check('  an unverifiable device cookie is the same generic 401',
  [res.status, (await res.json()).outcome], [401, 'unauthorized'])
setEnv({ ...FULL, SYNC_WRITE_ENABLED: 'false' })
check('auth precedes the release interlock', (await route.POST(post())).status, 401)
setEnv({ ...FULL, SYNC_ALLOWED_ORIGIN: 'https://other.test' })
check('auth precedes the origin guard', (await route.POST(post())).status, 401)

console.log('\n=== 7A/8A/D2. ACCESS REFUSAL FAILS CLOSED + LABEL IS STATIC ===')
/**
 * Phase D2 deleted the in-page `DeviceRegisteredGate`. The same question is
 * now asked once at the route, and its refusal screen is what the desk sees
 * — so that screen is what is rendered here, for every reason it can give.
 */
const rendered = JSON.parse(spawnSync('node', [`${HERE}/component-render.mjs`], { cwd: root, encoding: 'utf8' }).stdout.trim())
const showsForm = (v) => v.text.includes('__REGISTRATION_FORM__')
const textOf = (v) => v.text.join(' ')
for (const [gap, view] of Object.entries(rendered.refusal)) {
  check(`refusal ${gap} renders no workflow`, showsForm(view), false)
  check('  and offers Device Sign-In', textOf(view).includes('Open Device Sign-In'), true)
}
check('an unset-up browser is told to set the Device up',
  textOf(rendered.refusal['missing-local-identity']).includes('Device setup required'), true)
check('  a legacy local identity is told to converge it',
  textOf(rendered.refusal['identity-convergence-required'])
    .includes('still uses an older local identity'), true)
check('  an unadopted central range is badge setup, not a conflict',
  [textOf(rendered.refusal['no-central-range']).includes('Badge setup required'),
   /conflict|blocked/i.test(textOf(rendered.refusal['no-central-range']))], [true, false])
check('  no refusal offers an access code',
  Object.values(rendered.refusal).some((v) => /operator|access code|unlock/i.test(textOf(v))), false)
check('offline with no grant asks for verification, not a sign-in it cannot do',
  [textOf(rendered.refusalOffline).includes('Device verification required'),
   textOf(rendered.refusalOffline).includes('Connect to the internet')], [true, true])
check('device label shows name + range', textOf(rendered.label.configured), 'Registration Desk A · Badges  #001\u2013#250')
check('  renders NO remaining count', /remaining/i.test(textOf(rendered.label.configured)), false)
check('  identical after nextBadge advances', textOf(rendered.label.afterIssue), textOf(rendered.label.configured))
check('  identical when exhausted', textOf(rendered.label.exhausted), textOf(rendered.label.configured))
check('  hidden on an unregistered device', rendered.label.unconfigured.components.length, 0)
check('  hidden on a registered device with NO badge range',
  rendered.label.registeredNoBadges.components.length, 0)

console.log('\n=== RELEASE CHECK ===')
const release = JSON.parse(spawnSync('node', [join(root, 'scripts/release-check.mjs'), '--root', root, '--json'], { encoding: 'utf8' }).stdout)
check('release:check fully green', release.checks.filter((c) => c.status === 'fail').map((c) => c.id), [])
const swText = readFileSync(join(root, 'dist/sw.js'), 'utf8')
check('no API caching in the service worker', /sync-registration|operator-login|NetworkFirst|StaleWhileRevalidate/.test(swText), false)
check('manifest still uses credentials',
  /rel="manifest"[^>]*crossorigin="use-credentials"/.test(readFileSync(join(root, 'dist/index.html'), 'utf8')), true)
for (const n of ['EVENT_OPERATOR_ACCESS_CODE', 'EVENT_SESSION_SECRET'])
  check(`  ${n} absent from bundle`, spawnSync('grep', ['-rl', n, join(root, 'dist')], { encoding: 'utf8' }).stdout.trim(), '')

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
