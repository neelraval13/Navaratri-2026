/**
 * Phase D2 verification — Operator Access retired, the central device made
 * the sole event-operations authority.
 *
 * Run with:  pnpm verify:d2
 *
 * It NEVER connects to Neon, Google or any network. The REAL authorization
 * domain, the REAL router, the REAL sync endpoint and the REAL device
 * primitives all run; only Postgres, IndexedDB and HTTP are stood in for.
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
const LEGACY_DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ASSIGNED_AT = '2026-10-01T00:00:00.000Z'
const RANGE = { rangeStart: 501, rangeEnd: 600, assignedAt: ASSIGNED_AT }

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const authz = await jiti.import(`${root}/src/device-auth/event-authorization.ts`)

/* ------------------------------------------------- 1-29. the pure domain */

/** A CONVERGED browser: `deviceId` IS the central device's UUID. */
const CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 501, badgeEnd: 600, nextBadge: 501,
  badgeConfiguredAt: '2026-10-01T01:00:00.000Z',
  deviceId: DEVICE_ID, deviceName: 'Claim Test Desk 2',
  deviceConfiguredAt: '2026-10-01T01:00:00.000Z',
  centralBadgeRangeBinding: {
    deviceId: DEVICE_ID, eventId: EVENT_ID, rangeStart: 501, rangeEnd: 600,
    assignedAt: ASSIGNED_AT, adoptedAt: '2026-10-01T01:00:00.000Z',
  },
  updatedAt: 'T',
}
/** The same desk BEFORE Phase D1 convergence: a locally minted identity. */
const LEGACY = { ...CONFIG, deviceId: LEGACY_DEVICE_ID, deviceName: 'claim-test-local-2' }
const ENROLLMENT = {
  deviceId: DEVICE_ID, eventId: EVENT_ID, eventSlug: 'navaratri-2026',
  deviceName: 'Claim Test Desk 2', loginName: 'claim-test-2',
  attributes: ['registration'], verifiedAt: 'T',
}
const grant = (over = {}) => ({
  source: 'device-online', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['registration'],
  activeBadgeRange: RANGE, ...over,
})
const offlineGrant = (over = {}) =>
  grant({ source: 'device-offline', expiresAt: 4_102_444_800, ...over })
/**
 * `in` rather than `?? default`: every one of these facts is legitimately
 * `undefined`, and a helper that cannot express "absent" would silently test
 * the default instead of the case it names.
 */
const authorize = (module, over = {}) => authz.authorizeEventModule(module, {
  grant: 'grant' in over ? over.grant : grant(),
  config: 'config' in over ? over.config : CONFIG,
  enrollment: 'enrollment' in over ? over.enrollment : ENROLLMENT,
})

console.log('=== 1-14. AUTHORITY ===')
check('1. an online device on a converged browser authorizes Home',
  authorize('home'), { outcome: 'authorized', source: 'device-online' })
check('2. so does a verified OFFLINE lease',
  authorize('home', { grant: offlineGrant() }),
  { outcome: 'authorized', source: 'device-offline' })
check('3. no grant authorizes nothing',
  authorize('home', { grant: null }), { outcome: 'unavailable', gap: 'no-grant' })
/**
 * THE DECISIVE ONE. A local UUID that happens to equal a central device's is
 * a consistency fact, not a credential. Without a grant it opens nothing,
 * which is why the check takes the grant as its first argument and can only
 * ever return a gap.
 */
check('4. a matching local UUID with NO grant cannot authorize',
  [authorize('home', { grant: null }), authorize('registration', { grant: null })],
  [{ outcome: 'unavailable', gap: 'no-grant' },
   { outcome: 'unavailable', gap: 'no-grant' }])
check('5. a cached enrollment alone cannot authorize',
  authorize('home', { grant: null, enrollment: ENROLLMENT }),
  { outcome: 'unavailable', gap: 'no-grant' })
const domain = stripComments(read('src/device-auth/event-authorization.ts'))
check('6. no localStorage marker can reach the decision',
  /localStorage|sessionStorage|operator-device-unlocked|isDeviceTrusted/.test(domain), false)
check('7. Operator concepts are absent from event authorization',
  /Operator|operatorAuthorized|accessCode|unlockOperator/.test(domain), false)
check('8. a legacy local UUID is refused',
  authorize('home', { config: LEGACY }),
  { outcome: 'unavailable', gap: 'identity-convergence-required' })
check('  and registration too',
  authorize('registration', { config: LEGACY }),
  { outcome: 'unavailable', gap: 'identity-convergence-required' })
const refusalCopy = stripComments(read('src/components/event-access/device-access-required.tsx'))
check('9. the refusal points at convergence and Device Sign-In',
  [/identity-convergence-required':[\s\S]{0,200}older local identity/.test(refusalCopy),
   /ROUTES\.deviceLogin/.test(refusalCopy)], [true, true])
check('10. a missing local identity is refused',
  authorize('home', { config: { ...CONFIG, deviceId: undefined, deviceName: undefined } }),
  { outcome: 'unavailable', gap: 'missing-local-identity' })
check('  an unreadable store too',
  authorize('home', { config: undefined }),
  { outcome: 'unavailable', gap: 'storage-unavailable' })
check('11. a missing enrollment is refused and asks for sign-in',
  [authorize('home', { enrollment: undefined }),
   /'no-enrollment':[\s\S]{0,160}Sign in with this event Device/.test(refusalCopy)],
  [{ outcome: 'unavailable', gap: 'no-enrollment' }, true])
check('12. an enrollment naming a different device BLOCKS',
  authorize('home', { enrollment: { ...ENROLLMENT, deviceId: OTHER_DEVICE_ID } }).conflict,
  'enrollment-device-mismatch')
check('13. an enrollment naming a different event BLOCKS',
  authorize('home', { enrollment: { ...ENROLLMENT, eventId: OTHER_EVENT_ID } }).conflict,
  'enrollment-event-mismatch')
check('  and a grant for another event is simply unavailable',
  authorize('home', { grant: grant({ eventSlug: 'some-other-event' }) }),
  { outcome: 'unavailable', gap: 'event-mismatch' })
/**
 * The NAME is editable Admin metadata. Comparing it would turn an ordinary
 * rename into a desk that cannot open, so only the UUID is identity.
 */
check('14. a renamed device is still the same device',
  authorize('registration', { config: { ...CONFIG, deviceName: 'Renamed Desk' } }),
  { outcome: 'authorized', source: 'device-online' })

console.log('\n=== 15-29. REGISTRATION ===')
check('15. an online converged Registration device with a matching range authorizes',
  authorize('registration'), { outcome: 'authorized', source: 'device-online' })
check('16. so does a verified offline lease',
  authorize('registration', { grant: offlineGrant() }),
  { outcome: 'authorized', source: 'device-offline' })
check('17. without the registration attribute it is refused',
  authorize('registration', { grant: grant({ attributes: ['prizes'] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('  but Home still opens for that device',
  authorize('home', { grant: grant({ attributes: ['prizes'] }) }),
  { outcome: 'authorized', source: 'device-online' })
check('18. a central range with no local adoption does not authorize',
  (() => {
    const result = authorize('registration', {
      config: { ...CONFIG, badgeEnd: undefined, centralBadgeRangeBinding: undefined },
    })
    return [result.outcome, result.conflict]
  })(), ['blocked', 'binding-missing'])
check('  and it is presented as badge SETUP, not a ledger conflict',
  /SETUP_REQUIRED[\s\S]{0,80}'binding-missing'/.test(
    stripComments(read('src/components/event-access/badge-ownership-block.tsx'))), true)
check('19. a local range with NO central range is refused, not authorized',
  authorize('registration', {
    grant: grant({ activeBadgeRange: null }),
    config: { ...CONFIG, centralBadgeRangeBinding: undefined },
  }), { outcome: 'unavailable', gap: 'no-central-range' })
check('  and a binding whose assignment is gone BLOCKS',
  authorize('registration', { grant: grant({ activeBadgeRange: null }) }).conflict,
  'central-range-missing')
const conflictOf = (over) => {
  const result = authorize('registration', over)
  return [result.outcome, result.conflict ?? null]
}
const binding = (over) => ({ ...CONFIG, centralBadgeRangeBinding: { ...CONFIG.centralBadgeRangeBinding, ...over } })
check('20. binding missing', conflictOf({
  config: { ...CONFIG, centralBadgeRangeBinding: undefined } }), ['blocked', 'binding-missing'])
check('21. binding device mismatch',
  conflictOf({ config: binding({ deviceId: OTHER_DEVICE_ID }) }), ['blocked', 'binding-device-mismatch'])
check('22. binding event mismatch',
  conflictOf({ config: binding({ eventId: OTHER_EVENT_ID }) }), ['blocked', 'binding-event-mismatch'])
check('23. binding range mismatch',
  conflictOf({ config: binding({ rangeEnd: 599 }) }), ['blocked', 'binding-range-mismatch'])
check('24. binding assignedAt mismatch',
  conflictOf({ config: binding({ assignedAt: '2026-10-02T00:00:00.000Z' }) }),
  ['blocked', 'binding-assigned-at-mismatch'])
check('25. local range mismatch',
  conflictOf({ config: { ...CONFIG, badgeStart: 401, badgeEnd: 500 } }),
  ['blocked', 'local-range-mismatch'])
check('26. nextBadge below the range',
  conflictOf({ config: { ...CONFIG, nextBadge: 500 } }), ['blocked', 'local-range-incoherent'])
check('27. nextBadge above badgeEnd + 1',
  conflictOf({ config: { ...CONFIG, nextBadge: 602 } }), ['blocked', 'local-range-incoherent'])
/**
 * `nextBadge === badgeEnd + 1` is the CANONICAL exhausted state. It must
 * reach the existing badge-range-exhausted workflow, never be mistaken for
 * an authorization failure.
 */
check('28. nextBadge === badgeEnd + 1 is coherent and still AUTHORIZED',
  authorize('registration', { config: { ...CONFIG, nextBadge: 601 } }),
  { outcome: 'authorized', source: 'device-online' })
/**
 * ORDER MATTERS. A legacy browser whose badge ownership is otherwise
 * perfect is still refused: the identity check runs first, because every
 * registration it wrote would carry an identity central has never seen.
 */
check('29. perfect badge ownership cannot rescue a legacy identity',
  authorize('registration', { config: LEGACY }),
  { outcome: 'unavailable', gap: 'identity-convergence-required' })

console.log('\n=== 30-38. OPERATOR REMOVAL ===')
for (const [index, name] of [[30, 'operator-login'], [31, 'operator-session'], [32, 'operator-logout']]) {
  check(`${String(index)}. api/${name}.ts does not exist`,
    existsSync(join(root, 'api', `${name}.ts`)), false)
}
const PRODUCT_DIRECTORIES = ['api', 'server', 'src']
const productFiles = PRODUCT_DIRECTORIES.flatMap((directory) => walk(join(root, directory)))
const offenders = (pattern) => productFiles
  .filter((file) => pattern.test(stripComments(readFileSync(file, 'utf8'))))
  .map((file) => file.replace(`${root}/`, '')).sort()
check('33. no product module calls an operator endpoint',
  offenders(/\/api\/operator-(login|session|logout)/), [])
check('34. no operator auth provider, gate, form or hook survives',
  [offenders(/OperatorAccessGate|OperatorAccessForm|OperatorAccessBanner|useOperatorAccess/),
   ['src/auth', 'server/auth', 'src/components/operator', 'src/hooks/use-operator-access.ts']
     .filter((path) => existsSync(join(root, path)))], [[], []])
check('35. no event route falls back to a second authority',
  (() => {
    const gate = stripComments(read('src/components/event-access/event-access-gate.tsx'))
    return [/OperatorAccess|accessCode|unlock/i.test(gate),
            (gate.match(/authorization\.outcome === '/g) ?? []).length]
  })(), [false, 2])
check('36. the trusted-device marker is read by nothing',
  offenders(/navaratri-2026\.operator-device-unlocked/), [])
check('37. the operator session cookie is read by nothing',
  offenders(/__Host-navaratri_operator_session/), [])
check('38. no runtime module requires the operator environment variables',
  offenders(/EVENT_OPERATOR_ACCESS_CODE|EVENT_SESSION_SECRET/), [])
check('  and release:check no longer lists them as server-only names',
  /'EVENT_OPERATOR_ACCESS_CODE'|'EVENT_SESSION_SECRET'/
    .test(read('scripts/release-check.mjs')), false)
check('  .env.example records them as obsolete rather than required',
  [/OBSOLETE/.test(read('.env.example')),
   /^EVENT_OPERATOR_ACCESS_CODE=/m.test(read('.env.example'))], [true, false])

console.log('\n=== 39-43. THE LEGACY ROUTE ===')
const { renderRoute, setDeviceGrant, clearDeviceGrant, hrefsIn } =
  await import('./route-render.mjs')
const MARKER = '__REGISTRATION_FORM__'
const DEVICE_STATE = { config: CONFIG, enrollment: ENROLLMENT, deviceName: 'Claim Test Desk 2' }
setDeviceGrant(grant(), DEVICE_STATE)
const retired = renderRoute('/device-registration', CONFIG)
check('39. /device-registration renders no registration form',
  [retired.error ?? null, retired.html], [null, ''])
const router = stripComments(read('src/components/app-router.tsx'))
check('40. and cannot call a local device identity writer',
  [/DeviceRegistrationPage|DeviceRegistrationForm/.test(router),
   existsSync(join(root, 'src/pages/device-registration-page.tsx')),
   existsSync(join(root, 'src/components/device/device-registration-form.tsx'))],
  [false, false, false])
/**
 * NOT a blanket ban on `crypto.randomUUID`: registration ids legitimately
 * use one. What must not exist is one reaching `EventConfig.deviceId`.
 */
check('41. no product UI can mint a local config.deviceId',
  [offenders(/deviceId:\s*crypto\.randomUUID\(\)/),
   walk(join(root, 'src')).filter((file) => /crypto\.randomUUID\(\)/
     .test(stripComments(readFileSync(file, 'utf8'))))
     .map((file) => file.replace(`${root}/src/`, '')).sort()],
  [[], ['db/registrations.ts']])
check('42. navigation does not advertise Device Registration',
  [...new Set(hrefsIn(renderRoute('/', CONFIG).html))].sort(),
  ['/admin', '/badge-registration', '/device-login'])
check('43. the old route points users to Device Sign-In',
  /ROUTES\.deviceRegistration\}> <Redirect to=\{ROUTES\.deviceLogin\} \/>/
    .test(router.replace(/\s+/g, ' ')), true)
check('  and its path still resolves to the SPA, so a bookmark is not a 404',
  JSON.parse(read('vercel.json')).rewrites.some((rule) => rule.source === '/device-registration'), true)
check('  the event route pattern no longer includes it',
  /\^\\\/\(\?:badge-registration\)\?\$/.test(read('src/app/routes.ts')), true)

console.log('  -- the route policy, rendered for real --')
clearDeviceGrant()
for (const path of ['/', '/badge-registration']) {
  const refused = renderRoute(path, CONFIG)
  check(`${path} is refused with no device grant`,
    [refused.html.includes('Device access required'), refused.html.includes(MARKER)], [true, false])
  check('  and offers no credential',
    /Operator Access|access code|operator-gate/i.test(refused.html), false)
}
setDeviceGrant(grant(), { ...DEVICE_STATE, config: LEGACY })
check('a legacy browser is sent to converge, not to a login',
  [renderRoute('/', LEGACY).html.includes('Device setup required'),
   renderRoute('/badge-registration', LEGACY).html.includes(MARKER)], [true, false])
setDeviceGrant(offlineGrant(), DEVICE_STATE)
check('a verified offline lease opens both modules',
  [renderRoute('/', CONFIG).html.includes('Event Operations'),
   renderRoute('/badge-registration', CONFIG).html.includes(MARKER)], [true, true])

console.log('\n=== 44-55. SYNC ===')
const syncJiti = createJiti(import.meta.url, {
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
const deviceSession = await syncJiti.import(`${root}/server/device-auth/session.ts`)
const syncAuth = await syncJiti.import(`${root}/server/sync/device-authorization.ts`)
const fakeDb = await import('./fake-admin-db.mjs')
const password = await syncJiti.import(`${root}/server/device-auth/password.ts`)
const storedHash = await password.hashDevicePassword('desk-passphrase')

const seedCentral = ({ device = {}, event = {}, attributes = ['registration'], range = RANGE } = {}) => {
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
  for (const attribute of attributes) {
    fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  }
  if (range !== null) {
    fakeDb.state.assignments.push({
      id: 'a1', eventId: EVENT_ID, deviceId: DEVICE_ID,
      rangeStart: range.rangeStart, rangeEnd: range.rangeEnd,
      assignedAt: new Date(range.assignedAt), releasedAt: null,
    })
  }
  fakeDb.state.applied = []
}
const deviceCookie = (sessionVersion = 3) =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion,
  })}`
const authorizeSync = (cookie) => syncAuth.authorizeSyncByDevice(
  new Request('https://desk.example.test/api/sync-registration', {
    method: 'POST', headers: cookie === null ? {} : { cookie },
  }))

seedCentral()
check('44. no device session is refused',
  (await authorizeSync(null)).ok, false)
check('  and so is the retired operator cookie',
  (await authorizeSync('__Host-navaratri_operator_session=anything')).ok, false)
check('45. a Registration device with a current range is authorized',
  (await authorizeSync(deviceCookie())).ok, true)
seedCentral({ attributes: ['prizes'] })
check('46. without the registration attribute it is refused',
  (await authorizeSync(deviceCookie())), { ok: false, reason: 'device-not-permitted' })
seedCentral({ range: null })
check('47. with no active central range it is refused',
  (await authorizeSync(deviceCookie())), { ok: false, reason: 'device-not-permitted' })
seedCentral()
const authorization = (await authorizeSync(deviceCookie())).authorization
check('48. a completed badge outside the central range is rejected',
  [500, 601].map((badge) => syncAuth.isBadgeWithinDeviceRange(authorization, badge)), [false, false])
check('  and one inside it is accepted',
  [501, 600].map((badge) => syncAuth.isBadgeWithinDeviceRange(authorization, badge)), [true, true])
check('49. a held row carries no badge and is not range-checked',
  syncAuth.isBadgeWithinDeviceRange(authorization, undefined), true)
const syncEndpoint = stripComments(read('api/sync-registration.ts'))
const syncHandler = syncEndpoint.slice(syncEndpoint.indexOf('export async function POST'))
/**
 * HISTORICAL PROVENANCE IS NOT A CREDENTIAL. A row queued before this
 * browser converged carries the old local device id; requiring it to equal
 * the authenticated device would strand exactly the rows the Phase D1
 * migration creates.
 */
check('50. the endpoint never compares a payload device id to the session',
  /payload\.deviceId|snapshot\.deviceId|\.deviceId === (authorization|device|context)/
    .test(syncHandler + stripComments(read('server/sync/device-authorization.ts'))), false)
check('51. a post-convergence payload is accepted on the same rules',
  syncAuth.isBadgeWithinDeviceRange(authorization, 550), true)
check('52. the offline lease is never server sync authorization',
  /verifyOfflineAuthorization|offline-lease|centralDeviceOfflineAuthorization|Bearer/
    .test(syncHandler), false)
check('53. the operator realm cannot authorize sync',
  [/operator/i.test(syncHandler),
   syncHandler.indexOf('authorizeSyncByDevice(request)') <
     syncHandler.indexOf('readSyncEnvironment()')], [false, true])
seedCentral({ device: { enabled: false } })
check('54. a disabled device is rejected', (await authorizeSync(deviceCookie())).ok, false)
seedCentral({ event: { active: false } })
check('  an inactive event too', (await authorizeSync(deviceCookie())).ok, false)
seedCentral({ device: { passwordHash: null } })
check('  and an unprovisioned device', (await authorizeSync(deviceCookie())).ok, false)
seedCentral()
check('55. a stale session_version is rejected',
  (await authorizeSync(deviceCookie(2))).ok, false)

console.log('\n=== 56-61. RUNTIME ===')
const runtime = await jiti.import(`${root}/src/device-auth/event-authorization-runtime.ts`)
const sharedModule = await jiti.import(`${root}/src/shared/device-offline-authorization.ts`)
const LEASE_CLAIMS = {
  v: 1, t: 'device-offline', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['registration'],
  activeBadgeRange: RANGE, iat: 1_000, exp: 2_000,
}
const makeSources = ({ session = { status: 'unreachable' } } = {}) => {
  const calls = { checkSession: 0, acceptLease: 0, revokeLease: 0, readVerifiedLease: 0 }

  return {
    calls,
    sources: {
      checkSession: async () => { calls.checkSession += 1; return session },
      acceptLease: async () => { calls.acceptLease += 1; return { status: 'cached' } },
      revokeLease: async () => { calls.revokeLease += 1 },
      readVerifiedLease: async (now = new Date(1_500 * 1000)) => {
        calls.readVerifiedLease += 1
        const failure = sharedModule.checkOfflineClaimsClock(
          LEASE_CLAIMS, Math.floor(now.getTime() / 1000))
        return failure === null
          ? { status: 'valid', claims: LEASE_CLAIMS, receivedAt: 'T' }
          : { status: failure === 'expired' ? 'expired' : 'invalid' }
      },
      readLocalFacts: async () => ({ config: CONFIG, enrollment: ENROLLMENT }),
    },
  }
}
const expiry = makeSources()
const afterExpiry = await runtime.resolveFromCachedLease(expiry.sources, new Date(2_001 * 1000))
check('56. a lease expiry performs ZERO session checks',
  [expiry.calls.checkSession, afterExpiry.grant], [0, null])
const refresh = makeSources({ session: { status: 'unauthenticated' } })
await runtime.resolveFromServer(refresh.sources)
check('57. an explicit refresh performs exactly ONE session check',
  refresh.calls.checkSession, 1)
const reconnect = makeSources({
  session: {
    status: 'authenticated',
    context: {
      device: { id: DEVICE_ID, eventId: EVENT_ID, name: 'Claim Test Desk 2',
        loginName: 'claim-test-2', attributes: ['registration'], lastSeenAt: null },
      event: { id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata' },
      activeBadgeRange: RANGE,
    },
    offlineAuthorization: { configured: false },
  },
})
const reconnected = await runtime.resolveFromServer(reconnect.sources)
check('58. an offline → online reconnect performs exactly ONE session check',
  [reconnect.calls.checkSession, reconnected.grant.source], [1, 'device-online'])
const provider = stripComments(
  read('src/components/device-auth/device-event-authorization-provider.tsx'))
check('59. nothing polls', /setInterval/.test(provider + stripComments(
  read('src/device-auth/event-authorization-runtime.ts'))), false)
check('60. there is no heartbeat',
  /heartbeat|keepAlive|poll/i.test(provider), false)
check('  and exactly one timer, armed from the signed expiry',
  [(provider.match(/setTimeout\(/g) ?? []).length,
   /resolveFromCachedLease/.test(provider.slice(provider.indexOf('const expiresAt')))], [1, true])
check('61. badge issuance performs ZERO device-auth requests',
  /getDeviceSession|event-authorization|fetch\(|\/api\//
    .test(stripComments(read('src/db/registrations.ts'))), false)

console.log('\n=== 62-70. DATA ===')
const convergence = stripComments(read('src/db/device-identity-convergence.ts'))
check('62. convergence still writes only the identity fields',
  ['badgeStart:', 'badgeEnd:', 'nextBadge:', 'badgeConfiguredAt:']
    .filter((field) => convergence.includes(field)), [])
check('63. and never rewrites a registration',
  /db\.registrations\.(put|add|update|delete|clear)/.test(convergence), false)
check('64. nor an outbox row',
  /db\.outbox\.(put|add|update|delete|clear)/.test(convergence), false)
check('65. nor the central badge binding', convergence.includes('centralBadgeRangeBinding:'), false)
check('66. nor the central enrollment', convergence.includes('centralDeviceEnrollment:'), false)
check('67. nor the offline lease',
  convergence.includes('centralDeviceOfflineAuthorization:'), false)
const dexie = read('src/db/database.ts')
check('68. IndexedDB version unchanged (1)', /DATABASE_VERSION = 1/.test(dexie), true)
check('  and exactly three stores',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((entry) => entry.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('69. no Postgres migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
const sheet = read('server/sync/sheet-contract.ts')
check('70. the Sheet contract is unchanged',
  [/A1:N/.test(sheet), /A1:M/.test(sheet), /Device ID', 'Device Name'/.test(sheet)],
  [true, true, true])

console.log('\n=== 71-73. BUDGET ===')
const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
console.log(`  Vercel Functions: ${String(budget.actual.length)} / ${String(functionChecker.HOBBY_FUNCTION_LIMIT)}` +
  `   Headroom: ${String(functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length)}`)
check('71. the Function inventory is exactly eight', budget.actual, [
  'admin-auth', 'admin-badge-assignment', 'admin-device-password', 'admin-devices',
  'admin-events', 'device-auth', 'device-badge-claim', 'sync-registration',
])
check('72. with four slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 4)
check('73. and no Function was introduced to replace the operator realm',
  [budget.problems,
   readdirSync(join(root, 'api')).filter((file) => /^operator-/.test(file))], [[], []])

console.log('\n=== DOCUMENTATION + HARNESS ===')
for (const [doc, needles] of [
  ['AGENTS.md', ['Operator Access Is Retired', 'sole event-operations authority']],
  ['README.md', ['Device Sign-In', 'no operator code']],
  ['docs/DEVICE_AUTH.md', ['Phase D2', 'retired']],
  ['docs/PRODUCTION_RELEASE_CHECKLIST.md', ['EVENT_OPERATOR_ACCESS_CODE']],
]) {
  // Whitespace-normalised: a doc line wraps, and a phrase split across two
  // lines is still the phrase.
  const flat = read(doc).replace(/\s+/g, ' ')
  for (const needle of needles) {
    check(`${doc} documents "${needle.slice(0, 38)}"`, flat.includes(needle), true)
  }
}
check('no doc still presents Operator Access as an active fallback',
  ['README.md', 'docs/DEVICE_AUTH.md']
    .filter((doc) => /Operator Access remains|operator code remains|falls? back to Operator/i
      .test(read(doc))), [])
const pkg = JSON.parse(read('package.json'))
check('verify:d2 is registered', pkg.scripts['verify:d2'], 'node scripts/verification/phase-d2.mjs')
check('  and included in verify', pkg.scripts.verify.includes('verify:d2'), true)
check('release:check guards the retirement',
  /operator-realm-retired/.test(read('scripts/release-check.mjs')), true)
check('no dependency was added',
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => /operator|auth0|passport|next-auth/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
