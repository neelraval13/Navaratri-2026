/**
 * Phase 9B verification — Admin control plane and central device registry.
 *
 * Run with:  pnpm verify:9b
 *
 * It NEVER connects to Neon. The registry's rules live in pure functions
 * (validation, allow-list, precondition checks, conflict mapping) which are
 * exercised directly; the thin database plumbing around them is asserted
 * structurally.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { clearDeviceGrant, renderRoute, setAdminAccess, setDeviceGrant } from './route-render.mjs'

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
const walkSource = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSource(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const jiti = createJiti(import.meta.url, { alias: { '@': `${root}/src` }, interopDefault: true })
const adminEnv = await jiti.import(`${root}/server/admin-auth/environment.ts`)
const adminSession = await jiti.import(`${root}/server/admin-auth/session.ts`)
const adminCookies = await jiti.import(`${root}/server/admin-auth/cookies.ts`)
const deviceCookies = await jiti.import(`${root}/server/device-auth/cookies.ts`)
const deviceSession = await jiti.import(`${root}/server/device-auth/session.ts`)
const validation = await jiti.import(`${root}/server/admin/validation.ts`)
const adminErrors = await jiti.import(`${root}/server/admin/errors.ts`)
const attributes = await jiti.import(`${root}/src/shared/device-attributes.ts`)

const CODE = 'a-very-strong-admin-passphrase'
const SECRET = 'a'.repeat(48)

console.log('=== 1-20. ADMIN AUTH ===')
const reason = (over) => {
  const r = adminEnv.readAdminAuthEnvironment({
    EVENT_ADMIN_ACCESS_CODE: CODE, EVENT_ADMIN_SESSION_SECRET: SECRET, ...over,
  })
  return r.ok ? 'OK' : r.reason
}
check('valid admin config accepted', reason({}), 'OK')
check('  7 characters fails closed', reason({ EVENT_ADMIN_ACCESS_CODE: 'x'.repeat(7) }), 'access-code-too-short')
check('  exactly 8 accepted', reason({ EVENT_ADMIN_ACCESS_CODE: 'x'.repeat(8) }), 'OK')
check('  9 accepted', reason({ EVENT_ADMIN_ACCESS_CODE: 'x'.repeat(9) }), 'OK')
check('  missing code fails closed', reason({ EVENT_ADMIN_ACCESS_CODE: undefined }), 'access-code-missing')
check('  blank code fails closed', reason({ EVENT_ADMIN_ACCESS_CODE: '' }), 'access-code-missing')
check('  secret under 32 fails closed', reason({ EVENT_ADMIN_SESSION_SECRET: 'y'.repeat(31) }), 'session-secret-too-short')
check('  missing secret fails closed', reason({ EVENT_ADMIN_SESSION_SECRET: undefined }), 'session-secret-missing')
check('  no log message leaks a value',
  Object.values(adminEnv.ADMIN_AUTH_LOG_MESSAGES).some((m) => m.includes(CODE) || m.includes(SECRET)), false)
check('admin access-code minimum is 8', adminEnv.MIN_ADMIN_ACCESS_CODE_LENGTH, 8)
/**
 * The session secret is NOT relaxed with it: the access code is something a
 * human types, the signing key is not.
 */
check('  session-secret minimum stays 32', adminEnv.MIN_ADMIN_SESSION_SECRET_LENGTH, 32)
check('  31 characters still fails closed',
  reason({ EVENT_ADMIN_SESSION_SECRET: 'y'.repeat(31) }), 'session-secret-too-short')
check('  exactly 32 accepted', reason({ EVENT_ADMIN_SESSION_SECRET: 'y'.repeat(32) }), 'OK')
check('  a short code leans on the edge rate limit, and the docs say so',
  [/5 attempts per minute per IP|5 attempts \/ 60 seconds/i.test(read('docs/ADMIN.md')),
   /floor, not a recommendation/i.test(read('docs/ADMIN.md'))], [true, true])
// The path consolidated to /api/admin-auth; the POLICY is unchanged, and the
// rule must now also condition on the method, since one path serves three.
check('  the admin login firewall policy is unchanged',
  [/\/api\/admin-auth/.test(read('docs/VERCEL_FIREWALL.md')),
   /\| \*\*Limit\*\* \| 5 \|/.test(read('docs/VERCEL_FIREWALL.md')),
   /\| \*\*Window\*\* \| 60 seconds \|/.test(read('docs/VERCEL_FIREWALL.md'))], [true, true, true])
// Phase D2 retired the operator rule, leaving the two POSTs that still exist.
check('  and it rate-limits POST only',
  (read('docs/VERCEL_FIREWALL.md').match(/\| \*\*Condition — Method\*\* \| `POST` \|/g) ?? []).length, 2)
check('  every doc states the same minimum',
  [/`EVENT_ADMIN_ACCESS_CODE` \(8\+\)/.test(read('README.md')),
   /minimum 8 characters/.test(read('docs/ADMIN.md')),
   /Minimum 8 characters/.test(read('.env.example')),
   /8 char minimum/.test(read('docs/PRODUCTION_RELEASE_CHECKLIST.md')),
   /minimum of 8 characters/.test(read('AGENTS.md'))], [true, true, true, true, true])
check('  no stale 16-character claim remains',
  ['README.md', 'docs/ADMIN.md', '.env.example', 'docs/PRODUCTION_RELEASE_CHECKLIST.md']
    .filter((f) => /EVENT_ADMIN_ACCESS_CODE[^\n]*16|16\+\)|Minimum 16/.test(read(f))), [])

check('code comparison is exact', adminSession.isAdminAccessCodeValid(CODE, CODE), true)
// Exactness is unchanged by the shorter minimum.
const SHORT = 'abcd1234'
check('  an 8-character code compares exactly', adminSession.isAdminAccessCodeValid(SHORT, SHORT), true)
for (const [label, value] of [['leading space', ` ${SHORT}`], ['trailing space', `${SHORT} `],
  ['upper case', SHORT.toUpperCase()], ['one char short', SHORT.slice(0, 7)]])
  check(`    rejected: ${label}`, adminSession.isAdminAccessCodeValid(value, SHORT), false)
for (const [label, value] of [['leading space', ` ${CODE}`], ['trailing space', `${CODE} `],
  ['upper case', CODE.toUpperCase()], ['empty', ''], ['wrong', 'nope']])
  check(`  rejected: ${label}`, adminSession.isAdminAccessCodeValid(value, CODE), false)

const NOW = 1_800_000_000
const token = adminSession.createAdminSessionToken(SECRET, NOW)
check('signed admin session verifies', adminSession.verifyAdminSessionToken(token, SECRET, NOW + 10), true)
check('  12-hour TTL', adminSession.ADMIN_SESSION_TTL_SECONDS, 12 * 60 * 60)
check('  expired rejected', adminSession.verifyAdminSessionToken(token, SECRET, NOW + adminSession.ADMIN_SESSION_TTL_SECONDS), false)
check('  wrong secret rejected', adminSession.verifyAdminSessionToken(token, 'z'.repeat(48), NOW + 10), false)
const [payloadPart, signaturePart] = token.split('.')
const reencode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
check('  tampered payload rejected',
  adminSession.verifyAdminSessionToken(`${reencode({ v: 1, t: 'admin', iat: NOW, exp: NOW + 9e8 })}.${signaturePart}`, SECRET, NOW + 10), false)
check('  tampered signature rejected',
  adminSession.verifyAdminSessionToken(`${payloadPart}.${signaturePart.slice(0, -1)}${signaturePart.endsWith('A') ? 'B' : 'A'}`, SECRET, NOW + 10), false)
for (const [l, bad] of [['undefined', undefined], ['empty', ''], ['no dot', 'abc'],
  ['three parts', `${payloadPart}.${signaturePart}.x`], ['non-base64url', `no*pe.${signaturePart}`]])
  check(`  malformed rejected: ${l}`, adminSession.verifyAdminSessionToken(bad, SECRET, NOW + 10), false)

console.log('  -- the two realms are separate --')
check('admin cookie is its own name', adminCookies.ADMIN_SESSION_COOKIE, '__Host-navaratri_admin_session')
check('  it differs from the device cookie',
  adminCookies.ADMIN_SESSION_COOKIE === deviceCookies.DEVICE_SESSION_COOKIE, false)
const cookie = adminCookies.serializeAdminSessionCookie(token)
check('  __Host- prefixed', cookie.startsWith('__Host-navaratri_admin_session='), true)
check('  Secure + HttpOnly + SameSite=Strict + Path=/',
  [/;\s*Secure/.test(cookie), /;\s*HttpOnly/.test(cookie), /;\s*SameSite=Strict/.test(cookie), /;\s*Path=\//.test(cookie)],
  [true, true, true, true])
check('  no Domain', /;\s*Domain=/i.test(cookie), false)
check('  12-hour Max-Age', /;\s*Max-Age=43200/.test(cookie), true)
check('  admin reader ignores the device cookie',
  adminCookies.readAdminSessionCookie(`${deviceCookies.DEVICE_SESSION_COOKIE}=${token}`), undefined)
check('  device reader ignores the admin cookie',
  deviceCookies.readDeviceSessionCookie(`${adminCookies.ADMIN_SESSION_COOKIE}=${token}`), undefined)
/**
 * PHASE D2 RE-SCOPE. This block paired Admin against the OPERATOR realm,
 * which no longer exists. The rule it proves is unchanged and now pairs
 * Admin against the realm that survived: two realms, two signing contexts,
 * and neither verifier accepts the other's token EVEN WITH THE SAME SECRET.
 */
const SHARED = 'identical-secret-for-both-realms-0000000000'
const DEVICE_CLAIMS = {
  deviceId: '11111111-2222-4333-8444-555555555555',
  eventId: '99999999-2222-4333-8444-555555555555',
  sessionVersion: 1,
}
const sharedAdminToken = adminSession.createAdminSessionToken(SHARED, NOW)
const sharedDeviceToken = deviceSession.createDeviceSessionToken(SHARED, DEVICE_CLAIMS, NOW)
check('SAME SECRET: admin token accepted by the admin verifier',
  adminSession.verifyAdminSessionToken(sharedAdminToken, SHARED, NOW + 10), true)
check('SAME SECRET: device token accepted by the device verifier',
  deviceSession.verifyDeviceSessionToken(sharedDeviceToken, SHARED, NOW + 10) !== null, true)
check('SAME SECRET: device token REJECTED by the admin verifier',
  adminSession.verifyAdminSessionToken(sharedDeviceToken, SHARED, NOW + 10), false)
check('SAME SECRET: admin token REJECTED by the device verifier',
  deviceSession.verifyDeviceSessionToken(sharedAdminToken, SHARED, NOW + 10), null)
check('  separation is cryptographic: a signing context is prepended',
  [/navaratri-admin-session-v1:/.test(read('server/admin-auth/session.ts')),
   /navaratri-device-session-v1:/.test(read('server/device-auth/session.ts'))], [true, true])
check('  the context is part of the signed message',
  /ADMIN_SIGNING_CONTEXT\}\$\{encodedPayload\}/.test(read('server/admin-auth/session.ts')), true)
check('  the retired operator signer is gone',
  existsSync(join(root, 'server/auth/operator-session.ts')), false)
check('  distinct secrets are recommended, not required for isolation',
  [/recommended/i.test(read('docs/ADMIN.md')),
   /no longer depends on it/i.test(read('docs/ADMIN.md'))], [true, true])
const v2 = reencode({ v: 1, t: 'device', iat: NOW, exp: NOW + 1000 })
check('  a forged type claim is rejected',
  adminSession.verifyAdminSessionToken(`${v2}.${createHmac('sha256', SECRET).update(v2, 'utf8').digest('base64url')}`, SECRET, NOW + 10), false)

console.log('\n=== 21-37. REGISTRY RULES (pure, no database) ===')
const ev = (over) => validation.parseCreateEventInput({
  name: 'Navaratri 2026', slug: 'navaratri-2026', timezone: 'Asia/Kolkata', ...over })
check('valid event accepted', ev({}).ok, true)
for (const [label, over] of [
  ['blank name', { name: '  ' }], ['oversized name', { name: 'x'.repeat(200) }],
  ['uppercase slug', { slug: 'Navaratri' }], ['underscored slug', { slug: 'a_b' }],
  ['leading hyphen slug', { slug: '-a' }], ['doubled hyphen slug', { slug: 'a--b' }],
  ['bogus timezone', { timezone: 'Mars/Olympus' }], ['blank timezone', { timezone: '' }],
  ['bad start', { startsAt: 'yesterday' }], ['end before start', { startsAt: '2026-10-02T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }],
]) check(`  rejected: ${label}`, ev(over).ok, false)
check('  optional dates may be omitted', ev({ startsAt: null, endsAt: '' }).ok, true)
check('  a real timezone is required, checked via Intl', ev({ timezone: 'Europe/London' }).ok, true)

const dev = (over) => validation.parseCreateDeviceInput({ name: 'Registration Desk A', ...over })
check('valid device accepted', dev({}).ok, true)
check('  loginName optional -> null', dev({}).value.loginName, null)
check('  loginName normalized', dev({ loginName: ' desk-a ' }).value.loginName, 'desk-a')
for (const [label, over] of [['blank name', { name: ' ' }], ['bad login shape', { loginName: 'Desk A' }],
  ['login underscore', { loginName: 'desk_a' }], ['non-boolean enabled', { enabled: 'yes' }]])
  check(`  rejected: ${label}`, dev(over).ok, false)
check('  enabled defaults true', dev({}).value.enabled, true)

check('the allow-list is exactly the two capabilities',
  [...attributes.DEVICE_ATTRIBUTES], ['registration', 'prizes'])
check('  each is labelled',
  attributes.DEVICE_ATTRIBUTES.map((a) => attributes.DEVICE_ATTRIBUTE_LABELS[a]),
  ['Registration', 'Prizes'])
check('  badge issuance is NOT a separate capability',
  [...attributes.DEVICE_ATTRIBUTES].some((a) => /badge|distribut|issue/i.test(a)), false)
check('  and registration is described as including it',
  /badge/i.test(attributes.DEVICE_ATTRIBUTE_DESCRIPTIONS.registration), true)
check('  no dependency machinery survives',
  ['ATTRIBUTE_DEPENDENCIES', 'resolveAttributeSelection']
    .map((name) => name in attributes), [false, false])
check('attribute allow-list accepts known values',
  attributes.parseAttributeSet(['prizes', 'registration']).attributes, ['registration', 'prizes'])
check('  duplicates collapse', attributes.parseAttributeSet(['prizes', 'prizes']).attributes, ['prizes'])
check('  unknown value rejected', attributes.parseAttributeSet(['dandiya']).ok, false)
check('  free text rejected', attributes.parseAttributeSet(['anything']).ok, false)
check('  non-array rejected', attributes.parseAttributeSet('registration').ok, false)
check('  empty set is valid (a device may do none of them)', attributes.parseAttributeSet([]).attributes, [])

check('  both together accepted',
  attributes.parseAttributeSet(['prizes', 'registration']).attributes, ['registration', 'prizes'])
check('  order is normalised', attributes.parseAttributeSet(['prizes', 'registration']).attributes,
  attributes.parseAttributeSet(['registration', 'prizes']).attributes)
check('  the old badge_distribution value is now unknown text and REFUSED',
  attributes.parseAttributeSet(['registration', 'badge' + '_distribution']).ok, false)
check('  registration alone is fine', attributes.parseAttributeSet(['registration']).ok, true)
check('  prizes alone is fine', attributes.parseAttributeSet(['prizes']).ok, true)
check('  every valid combination passes',
  [[], ['registration'], ['prizes'], ['registration', 'prizes']]
    .every((set) => attributes.parseAttributeSet(set).ok), true)

const edit = (body) => validation.parseDeviceConfigurationInput(body)
check('the edit parser refuses createdAt', edit({ createdAt: 'x', name: 'y' }).ok, false)
check('  and a snake_case event', edit({ event_id: 'x', name: 'y' }).ok, false)
check('  allows name/loginName/enabled', edit({ name: 'A', loginName: 'a', enabled: false }).ok, true)
check('  empty update rejected', edit({}).ok, false)
check('ONE body carries the fields AND the attribute set',
  edit({ name: 'A', enabled: false, attributes: ['registration'] }).value,
  { eventId: null, fields: { name: 'A', enabled: false }, attributes: ['registration'] })
check('  eventId is a scope assertion, never a field to write',
  [edit({ eventId: 'e1', name: 'A' }).ok, 'eventId' in edit({ eventId: 'e1', name: 'A' }).value.fields],
  [true, false])
check('  an invalid attribute rejects the WHOLE edit',
  edit({ name: 'A', attributes: ['dandiya'] }).ok, false)
check('  absent attributes means leave them alone', edit({ name: 'A' }).value.attributes, null)
check('  an empty array means clear them', edit({ attributes: [] }).value.attributes, [])
check('  attributes alone is a valid edit', edit({ attributes: ['prizes'] }).ok, true)

const device = { eventId: 'event-a', enabled: true }
const allowed = (over) => validation.checkBadgeAssignmentAllowed({
  device, eventId: 'event-a', attributes: ['registration'],
  hasActiveAssignment: false, ...over })
check('a REGISTRATION device may receive a range', allowed({}), null)
check('  registration + prizes too', allowed({ attributes: ['prizes', 'registration'] }), null)
check('  a PRIZE-ONLY device may NOT', allowed({ attributes: ['prizes'] }), 'device-not-registration')
check('  a device with no attributes may NOT', allowed({ attributes: [] }), 'device-not-registration')
check('  missing device blocked', allowed({ device: null }), 'device-not-found')
check('  wrong event blocked', allowed({ eventId: 'event-b' }), 'device-event-mismatch')
check('  disabled device blocked', allowed({ device: { eventId: 'event-a', enabled: false } }), 'device-disabled')
check('  already assigned blocked', allowed({ hasActiveAssignment: true }), 'badge-range-already-assigned')

const removal = (requested, hasActiveAssignment = true) =>
  validation.checkAttributeRemovalAllowed({ requested, hasActiveAssignment })
check('an active range blocks removing registration',
  removal(['prizes']), 'registration-required-by-badge-range')
check('  it also blocks removing everything',
  removal([]), 'registration-required-by-badge-range')
check('  keeping registration is fine', removal(['registration']), null)
check('  keeping registration plus prizes is fine', removal(['registration', 'prizes']), null)
check('  without a range anything may be removed', removal([], false), null)

const range = (body) => validation.parseBadgeRangeInput(body)
check('valid range accepted', range({ rangeStart: 1, rangeEnd: 200 }).ok, true)
for (const [label, body] of [['zero start', { rangeStart: 0, rangeEnd: 5 }], ['start > end', { rangeStart: 9, rangeEnd: 2 }],
  ['fractional', { rangeStart: 1.5, rangeEnd: 5 }], ['string', { rangeStart: '1', rangeEnd: '5' }]])
  check(`  rejected: ${label}`, range(body).ok, false)

console.log('  -- database conflicts map safely --')
for (const [constraint, conflict] of [
  ['badge_assignments_active_ranges_no_overlap', 'badge-range-overlap'],
  ['badge_assignments_one_active_per_device', 'badge-range-already-assigned'],
  ['badge_assignments_device_event_fk', 'device-event-mismatch'],
  ['devices_event_id_login_name_key', 'login-name-taken'],
  ['events_slug_key', 'event-slug-taken'],
]) {
  check(`  ${constraint} -> ${conflict}`, adminErrors.mapDatabaseConflict({ constraint }), conflict)
  check(`    also from the message`, adminErrors.mapDatabaseConflict({ message: `violates "${constraint}"` }), conflict)
}
check('  an unknown error is never guessed at', adminErrors.mapDatabaseConflict({ constraint: 'something_else' }), null)
check('  nor is a bare error', adminErrors.mapDatabaseConflict(new Error('boom')), null)
// Word-boundary matched: "selected" is ordinary English, not leaked SQL.
check('  no conflict message contains SQL',
  Object.values(adminErrors.ADMIN_CONFLICT_MESSAGES)
    .some((m) => /\b(SELECT|INSERT|UPDATE|DELETE|constraint|postgres|SQLSTATE)\b/i.test(m)), false)

const registrySource = stripComments(read('server/admin/registry.ts'))
check('no range edit/release/transfer exists',
  /releaseBadgeRange|updateBadgeRange|transferBadgeRange|extendBadgeRange|deleteAssignment/.test(registrySource), false)
check('no device delete exists', /deleteDevice|removeDevice/.test(registrySource), false)
check('  nor any delete API route',
  readdirSync(join(root, 'api')).filter((f) => /delete|release|transfer/i.test(f)), [])
check('device + attributes are written atomically', /db\.batch\(/.test(registrySource), true)
const editFunction = registrySource.slice(
  registrySource.indexOf('export const updateDeviceConfiguration'),
  registrySource.indexOf('export const setDevicePassword'),
)
check('Edit Device is ONE registry operation', editFunction.length > 0, true)
check('  every refusal returns BEFORE the batch',
  editFunction.lastIndexOf('return { ok: false, blocked') < editFunction.indexOf('db.batch('), true)
check('  and it issues exactly one batch',
  (editFunction.match(/db\.batch\(/g) ?? []).length, 1)
check('  with no write awaited outside it',
  /await db\.(update|insert|delete)\(/.test(editFunction), false)
check('the separate attribute writer is gone',
  [/replaceDeviceAttributes/.test(registrySource),
   existsSync(join(root, 'api/admin-device-attributes.ts'))], [false, false])
check('  and no client calls one',
  spawnSync('grep', ['-rl', 'admin-device-attributes', join(root, 'src')], { encoding: 'utf8' }).stdout.trim(), '')

console.log('\n=== 38-53. ADMIN ROUTE + API SHAPE ===')
setAdminAccess('checking')
const adminChecking = renderRoute('/admin', null)
check('`/admin` route exists and renders', adminChecking.error ?? null, null)
check('  while checking it shows neither login nor registry',
  [adminChecking.html.includes('Checking admin access'), adminChecking.html.includes('Devices')], [true, false])

setAdminAccess('locked')
const adminUnauth = renderRoute('/admin', null)
check('  unauthenticated shows Admin Access, not the registry',
  [adminUnauth.html.includes('Admin Access'), adminUnauth.html.includes('Devices')], [true, false])
check('  it does not render the badge workflow', adminUnauth.html.includes('__REGISTRATION_FORM__'), false)
check('  no access code is echoed into the markup', /accessCode|EVENT_ADMIN/.test(adminUnauth.html), false)

setAdminAccess('unavailable', 'not-configured')
check('  unconfigured admin fails closed with a clear message',
  renderRoute('/admin', null).html.includes('Admin is unavailable'), true)
check('  and says the event app is unaffected',
  renderRoute('/admin', null).html.includes('event application is unaffected'), true)

setAdminAccess('authenticated')
const adminAuthed = renderRoute('/admin', null)
check('  authenticated renders the control plane, not the login',
  [adminAuthed.html.includes('Admin Access'), adminAuthed.html.includes('Sign out')], [false, true])
setAdminAccess('checking')
const gateSource = read('src/components/admin/admin-access-gate.tsx')
const routerSource = read('src/components/app-router.tsx')
check('the admin gate wraps ONLY the admin page', routerSource.includes('<AdminPage />'), true)
check('  the event app is not wrapped in admin auth', /AdminAccessGate/.test(read('src/App.tsx')), false)

console.log('  -- the two realms are routed apart --')
/**
 * `/admin` must not be double-gated. It is matched BEFORE the event route
 * pattern and rendered outside EventAppGate, so it neither requires Operator
 * Access nor mounts the offline registration workflow.
 */
const routerJsx = routerSource.slice(routerSource.indexOf('<Switch>'))
check('/admin is matched before the event routes',
  routerJsx.indexOf('ROUTES.admin') < routerJsx.indexOf('EVENT_ROUTE_PATTERN'), true)
check('  and renders OUTSIDE the event shell',
  routerSource.indexOf('<AdminPage />') < routerSource.indexOf('<EventAppGate>'), true)
check('  the event shell is not in App.tsx any more',
  /OperatorAccessGate|DatabaseGate|SyncManager/.test(stripComments(read('src/App.tsx'))), false)
check('  the event route pattern excludes /admin',
  [/^\/(?:badge-registration|device-registration)?$/.test('/admin'),
   /^\/(?:badge-registration|device-registration)?$/.test('/'),
   /^\/(?:badge-registration)?$/.test('/badge-registration')], [false, true, true])
// 9C-C3B mounts the processor through EventSyncManager, still exactly once.
check('  exactly one EventAppGate, one DatabaseGate, one SyncManager',
  [(routerSource.match(/<EventAppGate>/g) ?? []).length,
   (read('src/components/event-app-gate.tsx').match(/<DatabaseGate>/g) ?? []).length,
   (read('src/components/event-app-gate.tsx').match(/<EventSyncManager \/>/g) ?? []).length,
   (read('src/components/event-access/event-sync-manager.tsx')
     .match(/<SyncManager \/>/g) ?? []).length], [1, 1, 1, 1])

/**
 * REALM SEPARATION, restated for Phase D2. The operator realm is gone, so
 * the pairing this section proves is Admin against the CENTRAL DEVICE: one
 * must never unlock the other, in either direction.
 */
const D2_DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const D2_EVENT_ID = '99999999-2222-4333-8444-555555555555'
const D2_ASSIGNED_AT = '2026-09-27T05:00:00.000Z'
const D2_CONFIG = { id: 'event', deviceId: D2_DEVICE_ID, deviceName: 'Desk A',
  badgeStart: 1, badgeEnd: 250, nextBadge: 5, updatedAt: 'T1',
  centralBadgeRangeBinding: { deviceId: D2_DEVICE_ID, eventId: D2_EVENT_ID, rangeStart: 1,
    rangeEnd: 250, assignedAt: D2_ASSIGNED_AT, adoptedAt: 'T1' } }
const D2_ENROLLMENT = { deviceId: D2_DEVICE_ID, eventId: D2_EVENT_ID, eventSlug: 'navaratri-2026',
  deviceName: 'Desk A', loginName: 'desk-a', attributes: ['registration'], verifiedAt: 'T' }
const deviceGrant = () => ({ source: 'device-online', deviceId: D2_DEVICE_ID, eventId: D2_EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['registration'],
  activeBadgeRange: { rangeStart: 1, rangeEnd: 250, assignedAt: D2_ASSIGNED_AT } })
const signDeviceIn = () =>
  setDeviceGrant(deviceGrant(), { config: D2_CONFIG, enrollment: D2_ENROLLMENT, deviceName: 'Desk A' })

// A fresh browser: no device grant, no admin session.
clearDeviceGrant()
setAdminAccess('locked')
const freshAdmin = renderRoute('/admin', null)
check('fresh browser at /admin does NOT ask for event access',
  /Device access required|Operator Access/.test(freshAdmin.html), false)
check('  it shows Admin Access directly', freshAdmin.html.includes('Admin Access'), true)
check('  and never mounts the event database gate',
  /Preparing registration data|Loading event configuration/.test(freshAdmin.html), false)

// A device session alone must not unlock Admin.
signDeviceIn()
setAdminAccess('locked')
check('a valid device session alone does NOT unlock Admin',
  renderRoute('/admin', null).html.includes('Admin Access'), true)

// An admin session alone must unlock Admin, with no device grant.
clearDeviceGrant()
setAdminAccess('authenticated')
const adminOnly = renderRoute('/admin', null)
check('a valid admin session unlocks Admin with NO device session',
  [adminOnly.html.includes('Admin Access'), adminOnly.html.includes('Sign out')], [false, true])

// Event routes require the DEVICE, and an admin session is not one.
setAdminAccess('authenticated')
clearDeviceGrant()
for (const path of ['/', '/badge-registration']) {
  const gated = renderRoute(path, null)
  check(`  ${path} still requires device access`,
    /Device access required/.test(gated.html), true)
  check('    an admin session does not unlock it',
    gated.html.includes('__REGISTRATION_FORM__'), false)
  check('    and no operator credential is offered',
    /Operator Access|access code/i.test(gated.html), false)
}
check('  /device-registration is retired, not admin-gated',
  renderRoute('/device-registration', null).html, '')

// Not Found needs no credential at all.
clearDeviceGrant()
setAdminAccess('locked')
const notFound = renderRoute('/definitely-not-a-route', null)
check('Not Found requires neither realm',
  [notFound.html.includes('Page not found'),
   /Device access required|Admin Access/.test(notFound.html)], [true, false])

// Signing out of one realm leaves the other alone.
signDeviceIn()
setAdminAccess('locked')
check('Admin logout leaves the device session alone',
  renderRoute('/', D2_CONFIG).html.includes('Event Operations'), true)
clearDeviceGrant()
setAdminAccess('authenticated')
check('losing device access leaves the admin session alone',
  renderRoute('/admin', null).html.includes('Sign out'), true)
const adminAuthSource = read('api/admin-auth.ts')
const adminLogoutBody = adminAuthSource.slice(adminAuthSource.indexOf('export function DELETE'))
check('  the admin sign-out clears only the admin cookie',
  [/serializeClearedAdminSessionCookie/.test(adminLogoutBody),
   /device|operator/i.test(stripComments(adminLogoutBody).replace(/isSameOriginAdminRequest/g, ''))],
  [true, false])
signDeviceIn()
setAdminAccess('checking')
check('  authenticated renders the control plane',
  /phase === 'authenticated'[\s\S]{0,80}children/.test(gateSource), true)

const planeSource = read('src/components/admin/admin-control-plane.tsx')
check('zero events shows Event Setup', /Event Setup/.test(planeSource), true)
check('  one event auto-selects', /events\.length === 1 \? events\[0\]\.id/.test(planeSource), true)
check('  several events show a selector', /Select an event/.test(planeSource), true)
const cardSource = read('src/components/admin/device-card.tsx')
check('device cards show name, login, enabled, attributes',
  ['device.name', 'device.loginName', 'Enabled', 'device.attributes'].every((f) => cardSource.includes(f)), true)
check('  lastSeen null renders "Never seen"', /Never seen/.test(cardSource), true)
check('  badge range shown when present', /activeBadgeRange/.test(cardSource), true)
check('  NEVER claims Online or Offline', /\bOnline\b|\bOffline\b/.test(stripComments(cardSource)), false)
check('  no delete control', /Delete|Remove/.test(stripComments(cardSource)), false)
check('  no range edit once assigned',
  /Edit Range|Release|Replace Range|Reset/.test(stripComments(cardSource)), false)
const deviceDialogSource = stripComments(read('src/components/admin/device-dialog.tsx'))
const fieldsSource = stripComments(read('src/components/admin/device-form-fields.tsx'))
check('create-device UI has NO password field',
  /type="password"|passwordHash|"password"/.test(`${deviceDialogSource}\n${fieldsSource}`), false)
check('  and says where passwords arrive', /no password yet/i.test(read('src/components/admin/device-form-fields.tsx')), true)

const httpSource = stripComments(read('server/admin/http.ts'))
check('every admin response is no-store', /'cache-control': 'no-store'/.test(httpSource), true)
check('  and varies on Cookie', /vary: 'Cookie'/.test(httpSource), true)
check('auth is verified BEFORE the database is consulted',
  httpSource.indexOf('verifyAdminSessionToken') < httpSource.indexOf('isDatabaseConfigured'), true)
const adminRoutes = readdirSync(join(root, 'api')).filter((f) => f.startsWith('admin-'))
check('admin API routes exist as Functions', adminRoutes.sort(),
  ['admin-auth.ts', 'admin-badge-assignment.ts', 'admin-device-password.ts',
   'admin-devices.ts', 'admin-events.ts'])
for (const file of ['api/admin-events.ts', 'api/admin-devices.ts', 'api/admin-badge-assignment.ts',
  'api/admin-device-password.ts']) {
  const source = stripComments(read(file))
  check(`  ${file.replace('api/', '')} guards before touching the registry`,
    source.indexOf('guardAdminRequest') < source.indexOf('await '), true)
}
const vercelRewrites = JSON.parse(read('vercel.json')).rewrites
check('/admin has an explicit SPA rewrite',
  vercelRewrites.some((r) => r.source === '/admin' && r.destination === '/index.html'), true)
check('  no wildcard rewrite could capture /api',
  vercelRewrites.some((r) => /[*:()]/.test(r.source)), false)
check('  /api/admin-* is never rewritten',
  vercelRewrites.some((r) => r.source.startsWith('/api')), false)

console.log('\n=== ATOMIC EDIT DEVICE (real registry, fake database) ===')
/**
 * A second jiti instance so ONLY the registry sees the stand-in database.
 * The registry code under test is the real one; its Postgres dependency is
 * replaced, so nothing here opens a socket or reads DATABASE_URL.
 */
for (const file of ['fake-admin-db.mjs', 'fake-drizzle.mjs', 'admin-render.mjs'])
  check(`${file} is durable in the repository`, existsSync(join(root, 'scripts/verification', file)), true)
check('  and none of them can reach a real database',
  ['fake-admin-db.mjs', 'fake-drizzle.mjs', 'admin-render.mjs']
    // Comments stripped first: they DESCRIBE the driver they stand in for.
    .map((file) => /@neondatabase|DATABASE_URL|postgres:\/\//i.test(
      stripComments(readFileSync(join(root, 'scripts/verification', file), 'utf8')))),
  [false, false, false])

const dbJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})
const registry = await dbJiti.import(`${root}/server/admin/registry.ts`)
const fakeDb = await import('./fake-admin-db.mjs')

const seedDesk = ({ range = true, attributes = ['registration'] } = {}) => {
  fakeDb.reset()
  fakeDb.state.devices.set('d1', {
    id: 'd1', eventId: 'e1', name: 'Desk A', loginName: 'desk-a', enabled: true,
    lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const attribute of attributes) fakeDb.state.attributes.push({ deviceId: 'd1', attribute })
  if (range) {
    fakeDb.state.assignments.push({
      id: 'a1', eventId: 'e1', deviceId: 'd1', rangeStart: 1, rangeEnd: 200,
      assignedAt: new Date('2026-01-02T00:00:00.000Z'), releasedAt: null,
    })
  }
  fakeDb.state.applied = []
}
const storedName = () => fakeDb.state.devices.get('d1').name
const storedAttributes = () => fakeDb.state.attributes.map((row) => row.attribute).sort()
const writes = () => fakeDb.state.applied.filter((entry) => !entry.startsWith('select'))

console.log('  -- the manual-test regression: rename + drop registration --')
seedDesk()
const refused = await registry.updateDeviceConfiguration('d1', {
  eventId: 'e1', fields: { name: 'Renamed Desk' }, attributes: [],
})
check('the combined edit is BLOCKED', refused, { ok: false, blocked: 'registration-required-by-badge-range' })
check('  the name is STILL Desk A', storedName(), 'Desk A')
check('  registration is STILL present', storedAttributes(), ['registration'])
check('  and NOTHING was written at all', writes(), [])

console.log('  -- the same edit, valid --')
seedDesk()
const saved = await registry.updateDeviceConfiguration('d1', {
  eventId: 'e1', fields: { name: 'Renamed Desk' }, attributes: ['registration', 'prizes'],
})
check('both changes save together', [saved.ok, storedName(), storedAttributes()],
  [true, 'Renamed Desk', ['prizes', 'registration']])
check('  one batch carried them', writes(),
  ['update devices', 'delete device_attributes', 'insert device_attributes', 'insert device_attributes'])
check('  the reply is the COMPLETE updated device',
  Object.keys(saved.value).sort(),
  ['activeBadgeRange', 'attributes', 'createdAt', 'credentialsConfigured', 'enabled',
   'eventId', 'id', 'lastSeenAt', 'loginName', 'name'])
check('  echoing what was stored',
  [saved.value.name, saved.value.attributes, saved.value.activeBadgeRange.rangeEnd],
  ['Renamed Desk', ['prizes', 'registration'], 200])

console.log('  -- a constraint violation rolls the whole batch back --')
seedDesk()
fakeDb.state.failNextWrite = 'duplicate key value violates unique constraint "devices_event_id_login_name_key"'
const clashed = await registry.updateDeviceConfiguration('d1', {
  eventId: 'e1', fields: { name: 'Renamed Desk', loginName: 'taken' }, attributes: ['registration', 'prizes'],
})
check('a unique-violation becomes a typed conflict', clashed, { ok: false, conflict: 'login-name-taken' })
check('  the name did not change', storedName(), 'Desk A')
check('  the attributes did not change', storedAttributes(), ['registration'])

console.log('  -- preconditions refuse before any write --')
seedDesk()
check('a missing device is blocked',
  await registry.updateDeviceConfiguration('nope', { eventId: 'e1', fields: { name: 'X' }, attributes: null }),
  { ok: false, blocked: 'device-not-found' })
seedDesk()
check('a device in another event is blocked',
  await registry.updateDeviceConfiguration('d1', { eventId: 'other', fields: { name: 'X' }, attributes: null }),
  { ok: false, blocked: 'device-event-mismatch' })
check('  and neither wrote anything', writes(), [])

console.log('  -- without a range the attribute set is free --')
seedDesk({ range: false })
const cleared = await registry.updateDeviceConfiguration('d1', {
  eventId: 'e1', fields: {}, attributes: [],
})
check('attributes can be cleared', [cleared.ok, storedAttributes()], [true, []])
check('  the device row was left alone', writes(), ['delete device_attributes'])
check('  and the name is untouched', storedName(), 'Desk A')

seedDesk({ range: false })
const renamed = await registry.updateDeviceConfiguration('d1', {
  eventId: 'e1', fields: { name: 'Desk B' }, attributes: null,
})
check('a fields-only edit touches no attribute row',
  [renamed.ok, writes(), storedAttributes()], [true, ['update devices'], ['registration']])

console.log('\n=== ACTIVE-RANGE GUARD IN THE EDIT UI ===')
const { renderDeviceForm, checkboxes } = await import('./admin-render.mjs')
const RANGE = { rangeStart: 1, rangeEnd: 200, assignedAt: '2026-01-02T00:00:00.000Z' }
const lockedForm = renderDeviceForm({ activeBadgeRange: RANGE })
const openForm = renderDeviceForm({})
const attributeBoxes = (html) => checkboxes(html).filter((box) => box.id.includes('-attribute-'))
const box = (html, attribute) =>
  attributeBoxes(html).find((entry) => entry.attribute === attribute)

check('an active range LOCKS Registration on',
  box(lockedForm, 'registration'), { id: 'edit-d1-attribute-registration', attribute: 'registration', checked: true, disabled: true })
check('  the explanation names the actual range',
  /Required while this device owns badge range #001–#200\./.test(lockedForm), true)
check('  Prizes stays freely editable',
  box(lockedForm, 'prizes'), { id: 'edit-d1-attribute-prizes', attribute: 'prizes', checked: false, disabled: false })
check('  exactly one checkbox is locked',
  attributeBoxes(lockedForm).filter((entry) => entry.disabled).length, 1)
check('without a range Registration is editable',
  [box(openForm, 'registration').disabled, box(openForm, 'prizes').disabled], [false, false])
check('  and Create Device is never locked',
  attributeBoxes(renderDeviceForm({ values: { name: '', loginName: '', enabled: true, attributes: [] }, idPrefix: 'create-device' }))
    .some((entry) => entry.disabled), false)

const formSource = stripComments(read('src/components/admin/device-form-fields.tsx'))
check('the locked attribute comes from the SHARED rule, not a literal',
  [/BADGE_RANGE_REQUIRED_ATTRIBUTE/.test(formSource),
   /lockedAttribute = [\s\S]{0,60}'registration'/.test(formSource)], [true, false])
check('  which the server uses for the same decision',
  /BADGE_RANGE_REQUIRED_ATTRIBUTE/.test(stripComments(read('server/admin/validation.ts'))), true)
check('  the client guard does NOT replace the server one',
  /checkAttributeRemovalAllowed/.test(stripComments(read('server/admin/registry.ts'))), true)

console.log('\n=== ONE REQUEST, NO FULL-SCREEN RELOAD ===')
const dialogSource = stripComments(read('src/components/admin/device-dialog.tsx'))
check('Edit Device sends fields AND attributes in one call',
  /updateDevice\(\{[\s\S]{0,240}attributes: values\.attributes/.test(dialogSource), true)
check('  and never sequences a second attribute request',
  [/replaceAttributes/.test(dialogSource),
   (dialogSource.match(/await (updateDevice|createDevice|replaceAttributes)\(/g) ?? []).length], [false, 2])
check('  a failed save keeps the dialog open with its values',
  /if \(!result\.ok\) \{\s*setError\(result\.message\)\s*return/.test(dialogSource), true)
check('  and reports nothing upward on failure',
  dialogSource.slice(0, dialogSource.indexOf('setIsOpen(false)')).includes('onSaved('), false)
check('  success hands the server-confirmed device up',
  /setIsOpen\(false\)\s*onSaved\(result\.value\)/.test(dialogSource), true)

const planeCode = stripComments(read('src/components/admin/admin-control-plane.tsx'))
check('mutations update local state instead of re-fetching',
  [/upsertDevice/.test(planeCode), /onSaved=\{upsertDevice\}/.test(planeCode),
   /onChanged=\{upsertDevice\}/.test(planeCode)], [true, true, true])
check('  no mutation handler bumps the fetch counter',
  /onSaved=\{refresh\}|onChanged=\{refresh\}|onAssigned=\{refresh\}|onCreated=\{\(\) => \{[\s\S]{0,80}refresh/.test(planeCode), false)
check('  only the explicit control refreshes',
  (planeCode.match(/onClick=\{refresh\}/g) ?? []).length, 2)
check('the loading card is reachable ONLY on a first load',
  /if \(loaded === null\) \{\s*return \([\s\S]{0,240}Loading the central registry/.test(planeCode), true)
check('  a refresh never discards what is rendered',
  [/loaded\.attempt === attempt \? loaded : null/.test(planeCode),
   /previous\?\.events \?\? \[\]/.test(planeCode)], [false, true])
check('  the refresh state is derived, never stored',
  [/const isFetching = /.test(planeCode), /setIsFetching|setIsRefreshing/.test(planeCode)], [true, false])
check('  and it is scoped to the Refresh button',
  /disabled=\{isFetching\}[\s\S]{0,200}Refreshing…/.test(planeCode), true)
check('a mutation never clears the selected event',
  /const upsertDevice[\s\S]*?\n  \}/.exec(planeCode)?.[0].includes('setSelectedEventId'), false)
check('  and never remounts the plane',
  /key=\{attempt\}|key=\{`\$\{attempt/.test(planeCode), false)
check('assigning a range updates that one device',
  /onAssigned=\{\(activeBadgeRange\) => \{\s*onChanged\(\{ \.\.\.device, activeBadgeRange \}\)/
    .test(stripComments(read('src/components/admin/device-card.tsx'))), true)
check('  from the range the SERVER reserved',
  /onAssigned\(result\.value\)/.test(stripComments(read('src/components/admin/assign-range-dialog.tsx'))), true)
check('creating the first event appends it locally',
  /onCreated=\{addEvent\}/.test(planeCode), true)
check('every mutating client call returns the updated entity',
  ['createDevice', 'updateDevice', 'assignBadgeRange', 'createEvent']
    .map((name) => new RegExp(`export const ${name}[\\s\\S]{0,420}?Promise<AdminResult<(AdminDevice|AdminBadgeRange|AdminEvent)>>`).test(read('src/admin/admin-api.ts'))),
  [true, true, true, true])

console.log('\n=== ADMIN LOGIN FIELD + CARD LAYOUT ===')
const loginSource = read('src/components/admin/admin-login-form.tsx')
check('the access code defaults to a password field',
  /type=\{isVisible \? 'text' : 'password'\}/.test(loginSource), true)
check('  an Eye / EyeOff toggle exists',
  [/EyeOff/.test(loginSource), /<Eye className/.test(loginSource)], [true, true])
check('  it is a button, never a submit',
  [/type="button"/.test(loginSource), /Never `submit`/.test(loginSource),
   /type="submit"[\s\S]*aria-label=\{isVisible/.test(loginSource)], [true, true, false])
check('  both accessible labels are present',
  [loginSource.includes("'Hide access code'"), loginSource.includes("'Show access code'")], [true, true])
check('  its pressed state is exposed', /aria-pressed=\{isVisible\}/.test(loginSource), true)
check('  autocomplete is unchanged', /autoComplete="current-password"/.test(loginSource), true)
check('  the code is never persisted',
  /localStorage|sessionStorage|indexedDB|\.setItem\(/.test(stripComments(loginSource)), false)

const cardSourceLayout = read('src/components/admin/device-card.tsx')
const badgeSection = cardSourceLayout.slice(
  cardSourceLayout.indexOf('<Field label="Badge Distribution">'),
  cardSourceLayout.indexOf('<Field label="Last seen">'),
)
check('the Assign control lives INSIDE the badge section',
  badgeSection.includes('<AssignRangeDialog'), true)
check('  and nowhere else on the card',
  (cardSourceLayout.match(/<AssignRangeDialog/g) ?? []).length, 1)
check('  no registration -> "Not available", and NO assign control',
  [/!registers \? \([\s\S]{0,120}Not available/.test(badgeSection),
   /!registers \? \([\s\S]*?<AssignRangeDialog/.test(
     badgeSection.slice(0, badgeSection.indexOf('activeBadgeRange === null')))], [true, false])
check('  registration without a range -> "Not assigned" plus the control',
  [/Not assigned/.test(badgeSection), /<AssignRangeDialog/.test(badgeSection)], [true, true])
check('  assigned -> the range and a badge count',
  [/formatBadgeRange/.test(badgeSection), /badges/.test(badgeSection)], [true, true])
check('  an assigned range is read-only',
  /Edit|Release|Replace|Transfer|Reset/.test(stripComments(badgeSection)), false)
check('  the section is operational STATE, keyed off registration',
  [/attributes\.includes\('registration'\)/.test(cardSourceLayout),
   new RegExp('badge' + '_distribution').test(cardSourceLayout)], [true, false])
check('  and a disabled device still cannot be assigned',
  /canAssignRange =\s*\n?\s*device\.enabled && registers/.test(cardSourceLayout), true)
check('both capabilities render as access badges',
  /DEVICE_ATTRIBUTE_LABELS\[attribute\]/.test(cardSourceLayout), true)

console.log('  -- the 9C self-claim design is documented, not built --')
const adminDoc = read('docs/ADMIN.md')
check('the self-claim flow is documented',
  ['Admin grants it **Registration**', 'submits that range **online**',
   'atomically reserves', 'cached into that device', 'range_start'].every((p) => adminDoc.includes(p)), true)
check('  and the offline prohibition is explicit',
  /NEVER establish a new badge range purely offline/.test(adminDoc), true)
check('  both assignment models are described',
  [/Admin pre-assigns centrally/.test(adminDoc), /device claims its own range/i.test(adminDoc)], [true, true])
/**
 * Phase 9C-A stores credentials; the self-claim and the device login do not
 * exist. `password_hash` is deliberately absent from this list now, and
 * comments are stripped first — the files that must not implement a device
 * login are the ones whose comments SAY there is no device login.
 */
check('none of the self-claim is implemented',
  [join(root, 'src'), join(root, 'server'), join(root, 'api')]
    .flatMap((dir) => walkSource(dir))
    .filter((file) =>
      // `device-login` is Phase 9C-B/C1 and now legitimately exists. What must
      // still be absent is the SELF-CLAIM and any heartbeat.
      /claimBadgeRange|admin-badge-claim|selfClaimRange|adoptCentralRange|heartbeat(At|_at)/
        .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])

console.log('\n=== THE ADMIN REALM IS ONE FUNCTION, THREE METHODS ===')
/**
 * `admin-login`, `admin-session` and `admin-logout` were three deployment
 * Functions for one credential's lifecycle. Every file under `api/` is a
 * Function and the Hobby plan allows twelve, so they are now one endpoint
 * dispatched by HTTP method. Behaviour is unchanged; only the path and the
 * sign-out method moved.
 */
const adminAuthJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../server/db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})
process.env.EVENT_ADMIN_ACCESS_CODE = CODE
process.env.EVENT_ADMIN_SESSION_SECRET = SECRET
const adminAuth = await adminAuthJiti.import(`${root}/api/admin-auth.ts`)

const ADMIN_ORIGIN = 'https://admin.example.test'
const adminRequest = (method, { body, cookie, origin = ADMIN_ORIGIN } = {}) =>
  new Request(`${ADMIN_ORIGIN}/api/admin-auth`, {
    method,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const settleAdmin = async (response) => ({
  status: response.status,
  body: await response.json(),
  cookie: response.headers.get('set-cookie'),
  cacheControl: response.headers.get('cache-control'),
})

check('the Admin realm exports exactly three methods',
  ['POST', 'GET', 'DELETE'].map((method) => typeof adminAuth[method]),
  ['function', 'function', 'function'])
check('  and nothing else',
  Object.keys(adminAuth).filter((key) => /^[A-Z]+$/.test(key)).sort(),
  ['DELETE', 'GET', 'POST'])
check('  the three old Functions are gone',
  ['api/admin-login.ts', 'api/admin-session.ts', 'api/admin-logout.ts']
    .filter((file) => existsSync(join(root, file))), [])

console.log('  -- POST signs in --')
const adminIn = await settleAdmin(await adminAuth.POST(adminRequest('POST', { body: { accessCode: CODE } })))
check('a correct access code authenticates',
  [adminIn.status, adminIn.body.ok, adminIn.body.authenticated], [200, true, true])
check('  it sets the Admin cookie with every attribute',
  [adminIn.cookie.startsWith('__Host-navaratri_admin_session='),
   ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']
     .every((attribute) => adminIn.cookie.includes(attribute)),
   /Domain=/i.test(adminIn.cookie)], [true, true, false])
check('  and touches no other realm\'s cookie',
  /device_session|operator_session/.test(adminIn.cookie), false)
check('  it is never cached', adminIn.cacheControl, 'no-store')
const adminCookie = `__Host-navaratri_admin_session=${adminIn.cookie.split(';')[0].split('=')[1]}`

const adminWrong = await settleAdmin(await adminAuth.POST(adminRequest('POST', { body: { accessCode: 'wrong-code-entirely' } })))
check('a wrong code is 401 with no cookie',
  [adminWrong.status, adminWrong.body.message, adminWrong.cookie],
  [401, 'Access code is incorrect.', null])
const adminCrossSite = await settleAdmin(
  await adminAuth.POST(adminRequest('POST', { body: { accessCode: CODE }, origin: 'https://evil.test' })))
check('  a cross-site sign-in is refused first',
  [adminCrossSite.status, adminCrossSite.cookie], [403, null])

console.log('  -- GET introspects --')
const adminIntrospect = await settleAdmin(await adminAuth.GET(adminRequest('GET', { cookie: adminCookie })))
check('a valid cookie is authenticated',
  [adminIntrospect.status, adminIntrospect.body.authenticated, adminIntrospect.body.configured],
  [200, true, true])
check('  the safe fields are unchanged',
  Object.keys(adminIntrospect.body).sort(), ['authenticated', 'configured', 'databaseConfigured'])
check('  and it is never cached', adminIntrospect.cacheControl, 'no-store')
const adminAnon = await settleAdmin(await adminAuth.GET(adminRequest('GET')))
check('no cookie is unauthenticated, not an error',
  [adminAnon.status, adminAnon.body.authenticated], [200, false])
const adminForeign = await settleAdmin(await adminAuth.GET(adminRequest('GET', {
  cookie: '__Host-navaratri_device_session=x; __Host-navaratri_operator_session=y',
})))
check('  a device or operator cookie authorizes nothing here',
  [adminForeign.status, adminForeign.body.authenticated], [200, false])

console.log('  -- DELETE signs out --')
const adminOut = await settleAdmin(await adminAuth.DELETE(adminRequest('DELETE')))
check('logout clears the Admin cookie',
  [adminOut.status, adminOut.body.ok,
   adminOut.cookie.includes('__Host-navaratri_admin_session='),
   adminOut.cookie.includes('Max-Age=0')], [200, true, true, true])
check('  it leaves the Device cookie alone',
  /navaratri_device_session/.test(adminOut.cookie), false)
check('  and the Operator cookie alone',
  /navaratri_operator_session/.test(adminOut.cookie), false)
check('  it sets exactly one cookie', adminOut.cookie.split('__Host-').length - 1, 1)
const adminOutCrossSite = await settleAdmin(await adminAuth.DELETE(adminRequest('DELETE', { origin: 'https://evil.test' })))
check('  a cross-site sign-out is refused',
  [adminOutCrossSite.status, adminOutCrossSite.cookie], [403, null])

fakeDb.state.applied = []
await adminAuth.DELETE(adminRequest('DELETE'))
await adminAuth.GET(adminRequest('GET', { cookie: adminCookie }))
check('  neither sign-out nor introspection writes anything', writes(), [])

console.log('\n=== DEPLOYMENT FUNCTION BUDGET ===')
const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()

console.log(`  Vercel Functions: ${String(budget.actual.length)} / ${String(functionChecker.HOBBY_FUNCTION_LIMIT)}` +
  `   Headroom: ${String(functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length)}`)
for (const [index, name] of budget.actual.entries()) console.log(`    ${String(index + 1).padStart(2)}  ${name}`)

// Phase D2 DELETED the three Operator Functions. The Admin inventory is
// unchanged, and the budget gained three slots rather than spending any.
check('the inventory is exactly the expected eight', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'device-auth', 'device-badge-claim', 'sync-registration',
])
check('  which is within the Hobby limit',
  budget.actual.length <= functionChecker.HOBBY_FUNCTION_LIMIT, true)
check('  with four slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 4)
check('  and nothing unexpected', budget.problems, [])
check('no api file is a helper rather than a Function',
  functionChecker.functionEntrypoints()
    .filter((file) => !/export (async )?function (GET|POST|DELETE|PUT|PATCH)\(/
      .test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${root}/`, '')), [])
check('the Operator realm was REMOVED, not consolidated into another Function',
  ['operator-login', 'operator-session', 'operator-logout']
    .some((name) => budget.actual.includes(name)), false)

console.log('\n=== CLIENT SAFETY ===')
const clientFiles = walkSource(join(root, 'src')).map((f) => ({ file: f.replace(`${root}/src/`, ''), code: read(`src/${f.replace(`${root}/src/`, '')}`) }))
for (const name of ['EVENT_ADMIN_ACCESS_CODE', 'EVENT_ADMIN_SESSION_SECRET', 'DATABASE_URL'])
  check(`no ${name} in client source`, clientFiles.filter((f) => f.code.includes(name)).map((f) => f.file), [])
for (const name of ['EVENT_ADMIN_ACCESS_CODE', 'EVENT_ADMIN_SESSION_SECRET', '__Host-navaratri_admin_session'])
  check(`  nor in the built bundle`, spawnSync('grep', ['-rl', name, join(root, 'dist')], { encoding: 'utf8' }).stdout.trim(), '')
check('no client module imports server/admin',
  spawnSync('grep', ['-rl', 'server/admin', join(root, 'src')], { encoding: 'utf8' }).stdout.trim(), '')
const apiSource = stripComments(read('src/admin/admin-api.ts'))
check('admin 429 is handled safely',
  /Too many admin login attempts/.test(apiSource), true)
check('  it reveals no address or counter', /remaining|retryAfter|ipAddress/i.test(apiSource), false)
check('  raw server text is never rendered', /response\.text\(\)/.test(apiSource), false)
check('registry data is never cached in IndexedDB',
  /indexedDB|Dexie|db\./.test(apiSource), false)

console.log('\n=== 54-67. NOTHING EXISTING CHANGED ===')
check('device auth untouched by admin',
  /adminLogin|adminSession|AdminAccess|api\/admin/i
    .test(stripComments(read('src/device-auth/device-api.ts'))), false)
check('  device cookie module untouched by admin',
  /admin/i.test(stripComments(read('server/device-auth/cookies.ts'))), false)
signDeviceIn()
setAdminAccess('checking')
for (const [label, path, marker] of [
  ['/', '/', 'Event Operations'],
  ['/badge-registration', '/badge-registration', '__REGISTRATION_FORM__'],
]) {
  check(`${label} still renders`, renderRoute(path, D2_CONFIG).html.includes(marker), true)
}
const dbSource = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION\s*=\s*1\b/.test(dbSource), true)
check('  exactly three stores', ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dbSource)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
  .map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
const sheet = read('server/sync/sheet-contract.ts')
check('Google Sheet ranges unchanged', [/A1:N/.test(sheet), /A1:M/.test(sheet)], [true, true])
check('sync contract untouched by admin', /admin|drizzle|neon/i.test(read('src/shared/sync-contract.ts')), false)
check('badge allocation remains local',
  [/nextBadge/.test(read('src/db/registrations.ts')), /server\/db|drizzle/.test(read('src/db/registrations.ts'))], [true, false])
const migrations = readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).sort()
// Phase 9B needed no migration of its own; 0002 belongs to Phase 9C-A.
check('9B added no migration',
  migrations.filter((file) => !file.startsWith('0002_')),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql'])
const schemaSource = stripComments(read('server/db/schema.ts'))
check('  no admin, session or token TABLE added',
  /CREATE TABLE|admin_users|device_sessions|refresh_tokens/i.test(schemaSource), false)
check('  no next_badge added', /next_badge|nextBadge/.test(schemaSource), false)
check('  no attendee column added', /phone|attendee|payment|gender/i.test(schemaSource), false)
check('  the attribute column is free text, so the allow-list change needed no migration',
  [/attribute: text\('attribute'\)/.test(schemaSource), /pgEnum/.test(schemaSource),
   /'registration'|'prizes'/.test(schemaSource)], [true, false, false])
check('  its only constraint is non-emptiness, never an allow-list',
  [/attribute_not_empty/.test(schemaSource),
   /length\(btrim\(\$\{table\.attribute\}\)\) > 0/.test(schemaSource)], [true, true])
const migrationSql = migrations.map((f) => read(join('drizzle', f))).join('\n')
check('  and the SQL never enumerated the allowed values',
  [/'registration'/.test(migrationSql), /'prizes'/.test(migrationSql),
   /attribute[\s\S]{0,40}IN \(/i.test(migrationSql)], [false, false, false])
// Phase D2 retired the page; the PATH survives as a redirect for bookmarks.
check('/device-registration is retired, and nothing of Admin depends on it',
  [existsSync(join(root, 'src/pages/device-registration-page.tsx')),
   /device-registration/.test(read('src/components/admin/admin-control-plane.tsx'))], [false, false])
check('  admin never mutates a browser IndexedDB',
  /indexedDB|Dexie/.test(stripComments(read('server/admin/registry.ts'))), false)

const pkg = JSON.parse(read('package.json'))
check('verify:9b registered', [pkg.scripts['verify:9b'], pkg.scripts.verify.includes('verify:9b')],
  ['node scripts/verification/phase-9b.mjs', true])
check('no new dependency for admin',
  Object.keys(pkg.dependencies).filter((d) => /admin|jwt|jose|passport|bcrypt|argon/.test(d)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
