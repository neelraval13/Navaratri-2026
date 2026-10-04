/**
 * Phase 9C-C3B verification — device-authorized event operations, offline
 * route authorization, and the reconnect revocation bridge.
 *
 * Run with:  pnpm verify:9cc3b
 *
 * It NEVER connects to Neon, Google or any network. The REAL authorization
 * domain, the REAL router, the REAL sync endpoint and the REAL device
 * primitives all run; only Postgres, IndexedDB and HTTP are stood in for.
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
const LOCAL_DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ASSIGNED_AT = '2026-10-01T00:00:00.000Z'
const RANGE = { rangeStart: 501, rangeEnd: 600, assignedAt: ASSIGNED_AT }

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const authz = await jiti.import(`${root}/src/device-auth/event-authorization.ts`)

/* --------------------------------------------- 1-12. the pure domain */

const CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 501, badgeEnd: 600, nextBadge: 501,
  badgeConfiguredAt: '2026-10-01T01:00:00.000Z',
  deviceId: LOCAL_DEVICE_ID, deviceName: 'claim-test-local-2',
  deviceConfiguredAt: '2026-09-01T00:00:00.000Z',
  centralBadgeRangeBinding: {
    deviceId: DEVICE_ID, eventId: EVENT_ID, rangeStart: 501, rangeEnd: 600,
    assignedAt: ASSIGNED_AT, adoptedAt: '2026-10-01T01:00:00.000Z',
  },
  updatedAt: 'T',
}
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

console.log('=== 2, 9. TWO AUTHORITIES, ONE NORMALISED GRANT ===')
const sessionContext = {
  device: {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Claim Test Desk 2',
    loginName: 'claim-test-2', attributes: ['registration'], lastSeenAt: null,
  },
  event: { id: EVENT_ID, slug: 'navaratri-2026', name: 'N', timezone: 'Asia/Kolkata' },
  activeBadgeRange: RANGE,
}
const online = authz.grantFromDeviceSession(sessionContext)
check('a live session becomes a device-online grant',
  [online.source, online.deviceId, online.eventSlug, online.attributes, online.activeBadgeRange],
  ['device-online', DEVICE_ID, 'navaratri-2026', ['registration'], RANGE])
check('  and carries no expiry', online.expiresAt, undefined)
const offline = authz.grantFromOfflineClaims({
  v: 1, t: 'device-offline', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['registration'],
  activeBadgeRange: RANGE, iat: 1000, exp: 2000,
})
check('verified lease claims become a device-offline grant',
  [offline.source, offline.expiresAt, offline.activeBadgeRange],
  ['device-offline', 2000, RANGE])
check('  the two normalise to the same shape',
  Object.keys(online).sort(),
  Object.keys(offline).filter((key) => key !== 'expiresAt').sort())
check('the domain is PURE: no React, database or network',
  /react|useState|useEffect|db\.|fetch\(/
    .test(stripComments(read('src/device-auth/event-authorization.ts'))), false)
check('  and reads no unsigned flag as authority',
  /localStorage|sessionStorage|isDeviceTrusted|centralDeviceOfflineAuthorization/
    .test(stripComments(read('src/device-auth/event-authorization.ts'))), false)

console.log('\n=== 5, 10, 13, 42-43. REGISTRATION IS AUTHORIZED ===')
check('a complete online device authorizes registration',
  authorize('registration'), { outcome: 'authorized', source: 'device-online' })
check('  and so does a verified OFFLINE lease, with no network',
  authorize('registration', { grant: grant({ source: 'device-offline', expiresAt: 2000 }) }),
  { outcome: 'authorized', source: 'device-offline' })
check('  an exhausted range is still AUTHORIZED, not a failure',
  authorize('registration', { config: { ...CONFIG, nextBadge: 601 } }),
  { outcome: 'authorized', source: 'device-online' })
check('  because nextBadge === badgeEnd + 1 is the canonical exhausted state',
  authorize('registration', { config: { ...CONFIG, nextBadge: 602 } }).outcome, 'blocked')
check('  prizes alongside registration is fine',
  authorize('registration', {
    grant: grant({ attributes: ['prizes', 'registration'] }),
    enrollment: { ...ENROLLMENT, attributes: ['prizes', 'registration'] },
  }).outcome, 'authorized')

console.log('\n=== 6, 12, 46. HOME NEEDS NO BADGE RANGE ===')
check('home opens for a registration device', authorize('home').outcome, 'authorized')
check('a PRIZES-ONLY device reaches home',
  authorize('home', {
    grant: grant({ attributes: ['prizes'], activeBadgeRange: null }),
    config: { ...CONFIG, badgeEnd: undefined, centralBadgeRangeBinding: undefined },
  }), { outcome: 'authorized', source: 'device-online' })
check('  but NOT badge registration',
  authorize('registration', {
    grant: grant({ attributes: ['prizes'], activeBadgeRange: null }),
    config: { ...CONFIG, badgeEnd: undefined, centralBadgeRangeBinding: undefined },
  }), { outcome: 'unavailable', gap: 'not-permitted' })
check('  which is a FALLBACK case, not a block',
  authorize('registration', {
    grant: grant({ attributes: ['prizes'], activeBadgeRange: null }),
    config: { ...CONFIG, badgeEnd: undefined, centralBadgeRangeBinding: undefined },
  }).outcome === 'blocked', false)
check('an attribute-less device reaches nothing',
  authorize('home', { grant: grant({ attributes: [] }) }),
  { outcome: 'unavailable', gap: 'not-permitted' })
check('home needs no badge range at all',
  /badgeStart|badgeEnd|nextBadge|Binding/.test(
    (() => {
      const domain = stripComments(read('src/device-auth/event-authorization.ts'))
      return domain.slice(domain.indexOf("module === 'home'"), domain.indexOf('config === undefined'))
    })()), false)

console.log('\n=== 8, 21, 44. OPERATOR FALLBACK IS STILL POSSIBLE ===')
for (const [label, over, gap] of [
  ['no grant at all', { grant: null }, 'no-grant'],
  ['a different event', { grant: grant({ eventSlug: 'other-event' }) }, 'event-mismatch'],
  ['no central enrollment', { enrollment: undefined }, 'no-enrollment'],
  ['no local device identity', {
    config: { ...CONFIG, deviceId: undefined, deviceName: undefined },
  }, 'local-device-not-registered'],
  ['a device with no central range', { grant: grant({ activeBadgeRange: null }),
    config: { ...CONFIG, centralBadgeRangeBinding: undefined } }, 'no-central-range'],
  ['storage not ready', { config: undefined }, 'storage-unavailable'],
]) check(`fallback allowed: ${label}`, authorize('registration', over), { outcome: 'unavailable', gap })
check('29. a lease WITHOUT central enrollment fails closed',
  authorize('registration', { enrollment: undefined }).outcome, 'unavailable')
check('  and enrollment is never reconstructed from signed claims',
  /saveCentralDeviceEnrollment|toEnrollment/
    .test(stripComments(read('src/device-auth/event-authorization.ts')) +
      stripComments(read('src/components/device-auth/device-event-authorization-provider.tsx'))),
  false)

console.log('\n=== 7, 8, 24, 45. HARD BLOCKS — NO OPERATOR OVERRIDE ===')
for (const [label, over, conflict] of [
  ['central #501-600 vs local #401-500',
   { config: { ...CONFIG, badgeStart: 401, badgeEnd: 500,
       centralBadgeRangeBinding: { ...CONFIG.centralBadgeRangeBinding, rangeStart: 501, rangeEnd: 600 } } },
   'local-range-mismatch'],
  ['the binding names another device',
   { config: { ...CONFIG, centralBadgeRangeBinding: { ...CONFIG.centralBadgeRangeBinding, deviceId: OTHER_DEVICE_ID } } },
   'binding-device-mismatch'],
  ['the binding names another event',
   { config: { ...CONFIG, centralBadgeRangeBinding: { ...CONFIG.centralBadgeRangeBinding, eventId: OTHER_DEVICE_ID } } },
   'binding-event-mismatch'],
  ['the binding records a different range',
   { config: { ...CONFIG, centralBadgeRangeBinding: { ...CONFIG.centralBadgeRangeBinding, rangeEnd: 700 } } },
   'binding-range-mismatch'],
  ['the assignment was reissued since adoption',
   { config: { ...CONFIG, centralBadgeRangeBinding: { ...CONFIG.centralBadgeRangeBinding, assignedAt: '2026-09-01T00:00:00.000Z' } } },
   'binding-assigned-at-mismatch'],
  ['nextBadge below the range', { config: { ...CONFIG, nextBadge: 1 } }, 'local-range-incoherent'],
  ['nextBadge far above the range', { config: { ...CONFIG, nextBadge: 900 } }, 'local-range-incoherent'],
  ['a binding with no central assignment',
   { grant: grant({ activeBadgeRange: null }) }, 'central-range-missing'],
  ['a central assignment with no binding',
   { config: { ...CONFIG, centralBadgeRangeBinding: undefined } }, 'binding-missing'],
  ['a central assignment with no local range',
   { config: { ...CONFIG, badgeEnd: undefined } }, 'local-range-missing'],
  ['an enrollment for another device',
   { enrollment: { ...ENROLLMENT, deviceId: OTHER_DEVICE_ID } }, 'enrollment-device-mismatch'],
  ['an enrollment for another event',
   { enrollment: { ...ENROLLMENT, eventSlug: 'other-event' } }, 'enrollment-event-mismatch'],
]) {
  const result = authorize('registration', over)
  check(`HARD BLOCK: ${label}`, [result.outcome, result.conflict], ['blocked', conflict])
}
check('a hard block survives even a prizes-only grant',
  authorize('registration', { grant: grant({ attributes: ['prizes'] }),
    config: { ...CONFIG, badgeStart: 401, badgeEnd: 500 } }).outcome, 'blocked')
check('  safety is checked BEFORE permission, deliberately',
  (() => {
    const domain = stripComments(read('src/device-auth/event-authorization.ts'))
    const body = domain.slice(domain.indexOf('export const authorizeEventModule'))
    return body.indexOf('checkBadgeOwnership') < body.indexOf("includes('registration')")
  })(), true)
check('a legacy local range with NO binding and no central range is not a conflict',
  authorize('registration', {
    grant: grant({ activeBadgeRange: null }),
    config: { ...CONFIG, centralBadgeRangeBinding: undefined },
  }), { outcome: 'unavailable', gap: 'no-central-range' })

console.log('\n=== 27. AUTHORIZATION NEVER REPAIRS BADGE STATE ===')
check('the domain writes nothing',
  /adoptCentralBadgeRange|configureBadgeDistribution|put\(|transaction\(/
    .test(stripComments(read('src/device-auth/event-authorization.ts'))), false)
check('  nor does the provider or the gate',
  /adoptCentralBadgeRange|configureBadgeDistribution|db\.config\.put|db\.transaction/
    .test(stripComments(read('src/components/device-auth/device-event-authorization-provider.tsx')) +
      stripComments(read('src/components/event-access/event-access-gate.tsx'))), false)
check('  the runtime only READS local state',
  [...stripComments(read('src/device-auth/event-authorization-runtime.ts'))
    .matchAll(/db\.\w+\.(\w+)\(/g)].map((match) => match[1]), ['get'])

/* ------------------------------------- 10-20. the provider lifecycle */

console.log('\n=== 10-20, 47-51. THE AUTHORIZATION PROVIDER ===')
const provider = stripComments(
  read('src/components/device-auth/device-event-authorization-provider.tsx'))
const runtimeSource = stripComments(read('src/device-auth/event-authorization-runtime.ts'))
check('11. ONE session check lives in the online path',
  [...runtimeSource.matchAll(/checkSession\(\)/g)].length, 1)
/**
 * Phase D1 added one more caller: the pre-migration recheck, which must see
 * a live session before rewriting the device identity. The authorization
 * runtime still reaches the endpoint only through an injected source, which
 * is what keeps its local path provably offline.
 */
check('  the endpoint has exactly two other callers, both deliberate',
  walk(join(root, 'src'))
    .filter((file) => /getDeviceSession\(\)/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/src/`, '')).sort(),
  ['components/device-auth/device-enrollment-panel.tsx',
   'device-auth/identity-convergence.ts'])
check('3. an authenticated answer is PREFERRED over the cached lease',
  /status === 'authenticated'[\s\S]{0,400}grantFromDeviceSession/.test(runtimeSource), true)
check('  and replaces the cached lease with the fresh one',
  /status === 'authenticated'[\s\S]{0,200}acceptLease/.test(runtimeSource), true)
check('4, 12, 50. no answer falls back to the VERIFIED cached lease',
  [/readVerifiedLease/.test(runtimeSource), /cached\.status === 'valid'/.test(runtimeSource)],
  [true, true])
check('5, 14, 49. ONLY a definitive rejection revokes',
  /status === 'unauthenticated'[\s\S]{0,120}revokeLease/.test(runtimeSource), true)
check('  and that is the only revoke in the runtime',
  [...runtimeSource.matchAll(/revokeLease\(\)/g)].length, 1)
check('13, 19. a reconnect re-checks, through the network status',
  [/useNetworkStatus/.test(provider), /\[settle, sessionAttempt, network\]/.test(provider)],
  [true, true])
check('17, 20, 51. stale resolutions cannot resurrect access',
  [/sequence/.test(provider), /sequence\.current !== ticket/.test(provider)], [true, true])
check('  and the guard is a sequence, not a timing assumption',
  /setTimeout[\s\S]{0,80}sequence|Date\.now\(\)[\s\S]{0,40}sequence/.test(provider), false)
check('  it covers BOTH paths, since they share one settle',
  [/void settle\(resolveFromServer\)/.test(provider),
   /void settle\(\(\) => resolveFromCachedLease\(\)\)/.test(provider)], [true, true])
check('16-18. ONE expiry timer, armed from the SIGNED exp',
  [/settled\?\.grant\?\.expiresAt/.test(provider),
   [...provider.matchAll(/setTimeout\(/g)].length], [true, 1])
check('17. no polling or heartbeat anywhere',
  /setInterval|heartbeat|poll/i.test(provider + runtimeSource), false)
check('22. the normalised grant is never persisted',
  /db\.config\.put|localStorage|sessionStorage|saveCentral/.test(provider), false)
check('26. a central device is never auto-bound from an event route',
  /saveCentralDeviceEnrollment/.test(provider), false)

/* ----------------------------------------------- the router policy */

console.log('\n=== THE LEASE EXPIRY TIMER IS LOCAL ONLY ===')
/**
 * The requirement, proven by COUNTING requests rather than by reading the
 * timer callback.
 *
 * An expiry timer fires because a local clock passed a number. If that
 * caused a session check it would fail pointlessly on an offline desk and
 * quietly become a heartbeat on an online one — so the count must not move.
 *
 * This is a real regression guard: the two triggers once shared a counter,
 * and the expiry timer re-ran the online path and issued a
 * `GET /api/device-auth` nobody had asked for.
 */
const runtime = await jiti.import(`${root}/src/device-auth/event-authorization-runtime.ts`)
const sharedModule = await jiti.import(`${root}/src/shared/device-offline-authorization.ts`)

const LEASE_CLAIMS = {
  v: 1, t: 'device-offline', deviceId: DEVICE_ID, eventId: EVENT_ID,
  eventSlug: 'navaratri-2026', attributes: ['registration'],
  activeBadgeRange: RANGE, iat: 1_000, exp: 2_000,
}

/** A controlled clock, network and session spy. Nothing real is reached. */
const makeSources = ({
  leaseValidUntil = 2_000,
  session = { status: 'unreachable' },
  // The clock the ONLINE path sees when it falls back to the cached lease;
  // the LOCAL path is always given an explicit instant.
  now: defaultNow = new Date(1_500 * 1000),
} = {}) => {
  const calls = { checkSession: 0, acceptLease: 0, revokeLease: 0, readVerifiedLease: 0 }

  return {
    calls,
    sources: {
      checkSession: async () => { calls.checkSession += 1; return session },
      acceptLease: async () => { calls.acceptLease += 1; return { status: 'cached' } },
      revokeLease: async () => { calls.revokeLease += 1 },
      readVerifiedLease: async (now = defaultNow) => {
        calls.readVerifiedLease += 1
        const nowSeconds = Math.floor(now.getTime() / 1000)
        // The REAL clock rule decides, not the fake.
        const failure = sharedModule.checkOfflineClaimsClock(
          { ...LEASE_CLAIMS, exp: leaseValidUntil }, nowSeconds)
        if (failure === 'expired') return { status: 'expired', claims: LEASE_CLAIMS }
        if (failure !== null) return { status: 'invalid' }
        return { status: 'valid', claims: { ...LEASE_CLAIMS, exp: leaseValidUntil }, receivedAt: 'T' }
      },
      readLocalFacts: async () => ({ config: CONFIG, enrollment: ENROLLMENT }),
    },
  }
}

const BEFORE_EXPIRY = new Date(1_500 * 1000)
const AT_EXPIRY = new Date(2_000 * 1000)
const AFTER_EXPIRY = new Date(2_001 * 1000)

console.log('  -- a short-lived lease authorizes while it is valid --')
const live = makeSources()
const beforeSettlement = await runtime.resolveFromCachedLease(live.sources, BEFORE_EXPIRY)
check('a verified lease grants device-offline authority',
  [beforeSettlement.grant.source, beforeSettlement.grant.expiresAt], ['device-offline', 2_000])
check('  and registration is authorized from it',
  authorize('registration', { grant: beforeSettlement.grant }).outcome, 'authorized')
check('  reaching it cost ZERO session checks', live.calls.checkSession, 0)

console.log('  -- 1-5, 8. at expiry: authority ends, nothing is requested --')
const expiring = makeSources()
const atExpiry = await runtime.resolveFromCachedLease(expiring.sources, AT_EXPIRY)
check('1, 8. authority disappears AT exp, not after a grace period',
  atExpiry.grant, null)
check('  and one second later too',
  (await runtime.resolveFromCachedLease(makeSources().sources, AFTER_EXPIRY)).grant, null)
check('2, 3. the expiry path made NO session check and NO request',
  [expiring.calls.checkSession, expiring.calls.acceptLease], [0, 0])
check('4. no lease refresh was attempted', expiring.calls.acceptLease, 0)
check('5. and nothing was revoked or retried',
  [expiring.calls.revokeLease, expiring.calls.readVerifiedLease], [0, 1])
check('6. with Operator locked, registration falls back to the gate',
  authorize('registration', { grant: atExpiry.grant }),
  { outcome: 'unavailable', gap: 'no-grant' })
check('  which is a FALLBACK, never a hard block',
  authorize('registration', { grant: atExpiry.grant }).outcome === 'blocked', false)

console.log('  -- it holds even when the browser reports ONLINE at that instant --')
const onlineAtExpiry = makeSources({
  session: { status: 'authenticated', context: sessionContext, offlineAuthorization: { configured: false } },
})
const settledLocally = await runtime.resolveFromCachedLease(onlineAtExpiry.sources, AT_EXPIRY)
check('the local path ignores connectivity entirely',
  [settledLocally.grant, onlineAtExpiry.calls.checkSession], [null, 0])
check('  it cannot reach the session source at all',
  /checkSession/.test(
    (() => {
      const source = stripComments(read('src/device-auth/event-authorization-runtime.ts'))
      return source.slice(source.indexOf('export const resolveFromCachedLease'))
    })()), false)

console.log('  -- but the ONLINE path does exactly one check --')
const refreshed = makeSources({
  session: { status: 'authenticated', context: sessionContext, offlineAuthorization: { configured: false } },
})
const online2 = await runtime.resolveFromServer(refreshed.sources)
check('an explicit refresh / reconnect performs ONE session GET',
  refreshed.calls.checkSession, 1)
check('  and takes the live context as the authority',
  [online2.grant.source, online2.deviceName], ['device-online', 'Claim Test Desk 2'])
const revoking = makeSources({ session: { status: 'unauthenticated' } })
await runtime.resolveFromServer(revoking.sources)
check('  a definitive rejection revokes, in one check',
  [revoking.calls.checkSession, revoking.calls.revokeLease], [1, 1])
const unreachable = makeSources({ session: { status: 'unreachable' } })
const fallback = await runtime.resolveFromServer(unreachable.sources)
check('  an unreachable server keeps the verified lease and revokes nothing',
  [unreachable.calls.revokeLease, fallback.grant.source], [0, 'device-offline'])

console.log('  -- the provider wires the two triggers APART --')
const providerSource = stripComments(
  read('src/components/device-auth/device-event-authorization-provider.tsx'))
// Bounded to the effect: the refresh callback below it legitimately bumps
// the session counter, and an unbounded slice would read that as the timer.
const expiryEffect = providerSource.slice(
  providerSource.indexOf('const expiresAt'), providerSource.indexOf('const refresh'))
check('the expiry effect resolves LOCALLY',
  /resolveFromCachedLease/.test(expiryEffect), true)
check('  and never through the server path',
  /resolveFromServer|getDeviceSession|fetch\(/.test(expiryEffect), false)
check('  nor by bumping the counter the online effect watches',
  /setSessionAttempt/.test(expiryEffect), false)
check('the online effect is the only thing sessionAttempt drives',
  /\[settle, sessionAttempt, network\]/.test(providerSource), true)
check('  and only an explicit refresh bumps it',
  [...providerSource.matchAll(/setSessionAttempt\(/g)].length, 1)
check('exactly one timer exists', [...providerSource.matchAll(/setTimeout\(/g)].length, 1)
check('  and no polling of any kind', /setInterval/.test(providerSource), false)

console.log('\n=== 13-14, 44, 57. ROUTE POLICY ===')
const { renderRoute, setOperatorAccess, setDeviceGrant, clearDeviceGrant, hrefsIn } =
  await import('./route-render.mjs')
const MARKER = '__REGISTRATION_FORM__'
const DEVICE_STATE = { config: CONFIG, enrollment: ENROLLMENT, deviceName: 'Claim Test Desk 2' }
/** The badge page's own gates read the config hook, exactly as in production. */
const renderBadge = () => renderRoute('/badge-registration', CONFIG).html

setOperatorAccess('locked', 'new-device')
clearDeviceGrant()
check('44. with no device authority, Operator Access is requested',
  [renderBadge().includes('Operator Access'), renderBadge().includes(MARKER)], [true, false])
check('  and there is exactly ONE operator form',
  (renderBadge().match(/id="operator-gate/g) ?? []).length, 1)

setDeviceGrant(grant(), DEVICE_STATE)
check('43. an ONLINE device opens registration with Operator locked',
  [renderBadge().includes(MARKER), renderBadge().includes('id="operator-gate')], [true, false])
check('  and the banner says it was verified online',
  renderBadge().includes('Verified online'), true)
check('42. so does a VERIFIED OFFLINE lease, with Operator still locked',
  (() => {
    setDeviceGrant(grant({ source: 'device-offline', expiresAt: 4102444800 }), DEVICE_STATE)
    return [renderBadge().includes(MARKER), renderBadge().includes('Offline device access'),
            renderBadge().includes('id="operator-gate')]
  })(), [true, true, false])
check('  home opens too', renderRoute('/', CONFIG).html.includes('Event Operations'), true)

check('14. /device-registration stays OPERATOR-ONLY even with device authority',
  [renderRoute('/device-registration', CONFIG).html.includes('id="operator-gate'),
   renderRoute('/device-registration', CONFIG).html.includes('Device Readiness')], [true, false])
setOperatorAccess('unlocked')
check('  and opens once Operator Access is unlocked',
  [renderRoute('/device-registration', CONFIG).html.includes('id="operator-gate'),
   renderRoute('/device-registration', CONFIG).html.length > 500], [false, true])

console.log('  -- 45. a hard conflict blocks even with Operator unlocked --')
setOperatorAccess('unlocked')
setDeviceGrant(grant(), { ...DEVICE_STATE, config: { ...CONFIG, badgeStart: 401, badgeEnd: 500 } })
const blocked = renderBadge()
check('registration is BLOCKED', blocked.includes('Badge registration blocked'), true)
check('  the form never renders', blocked.includes(MARKER), false)
check('  both ranges are shown', [blocked.includes('#501'), blocked.includes('#401')], [true, true])
check('  and NO override is offered',
  /Continue anyway|Use Operator Access|Override|Force|operator-gate/i.test(blocked), false)
check('  home is unaffected by a badge conflict',
  renderRoute('/', CONFIG).html.includes('Event Operations'), true)

console.log('  -- 57. the router is otherwise unchanged --')
clearDeviceGrant()
setOperatorAccess('unlocked')
check('/admin is its own realm',
  renderRoute('/admin').html.includes('id="operator-gate'), false)
check('/device-login is its own realm',
  renderRoute('/device-login').html.includes('id="operator-gate'), false)
check('  and is not inside the event shell',
  /<EventAppGate>[\s\S]*deviceLogin/.test(stripComments(read('src/components/app-router.tsx'))), false)
check('home still links only to real destinations',
  [...new Set(hrefsIn(renderRoute('/', CONFIG).html))].sort(),
  ['/admin', '/badge-registration', '/device-login', '/device-registration'])
check('the service worker still denylists /api',
  /navigateFallbackDenylist: \[\/\^\\\/api\\\/\/\]/.test(read('vite.config.ts')), true)
check('  and no API route is swallowed by the SPA fallback',
  JSON.parse(read('vercel.json')).rewrites
    .filter((rule) => rule.source.startsWith('/api') || /\/api\//.test(rule.destination)), [])

/* ------------------------------------------------- 30-39. the sync realm */

console.log('\n=== 22-26, 30-39. SYNC: OPERATOR OR LIVE DEVICE ===')
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
const syncDeviceAuth = await syncJiti.import(`${root}/server/sync/device-authorization.ts`)
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
const deviceCookie = () =>
  `__Host-navaratri_device_session=${deviceSession.createDeviceSessionToken(SECRET, {
    deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion: 3,
  })}`
const syncRequest = (cookie) =>
  new Request('https://desk.example.test/api/sync-registration', {
    method: 'POST', headers: cookie === null ? {} : { cookie },
  })

seedCentral()
const authorized = await syncDeviceAuth.authorizeSyncByDevice(syncRequest(deviceCookie()))
check('23, 32. a live device session authorizes sync',
  [authorized.ok, authorized.authorization.deviceId,
   authorized.authorization.activeBadgeRange], [true, DEVICE_ID, { rangeStart: 501, rangeEnd: 600 }])
check('  no cookie is unauthorized',
  await syncDeviceAuth.authorizeSyncByDevice(syncRequest(null)),
  { ok: false, reason: 'unauthorized' })
check('  a garbage cookie is unauthorized',
  (await syncDeviceAuth.authorizeSyncByDevice(
    syncRequest('__Host-navaratri_device_session=garbage'))).reason, 'unauthorized')
for (const [label, options] of [
  ['a disabled device', { device: { enabled: false } }],
  ['an inactive event', { event: { active: false } }],
  ['an unprovisioned device', { device: { passwordHash: null } }],
]) {
  seedCentral(options)
  check(`38. ${label} is refused server-side`,
    (await syncDeviceAuth.authorizeSyncByDevice(syncRequest(deviceCookie()))).reason, 'unauthorized')
}
seedCentral()
fakeDb.state.devices.get(DEVICE_ID).sessionVersion = 9
check('  a reset session version is refused',
  (await syncDeviceAuth.authorizeSyncByDevice(syncRequest(deviceCookie()))).reason, 'unauthorized')
seedCentral({ attributes: ['prizes'] })
check('32. a prizes-only device may not sync registrations',
  (await syncDeviceAuth.authorizeSyncByDevice(syncRequest(deviceCookie()))).reason,
  'device-not-permitted')
seedCentral({ range: null })
check('  nor one with no central badge assignment',
  (await syncDeviceAuth.authorizeSyncByDevice(syncRequest(deviceCookie()))).reason,
  'device-not-permitted')

console.log('  -- 33-34. the badge must be inside the current central range --')
const AUTH = { deviceId: DEVICE_ID, eventId: EVENT_ID, activeBadgeRange: { rangeStart: 501, rangeEnd: 600 } }
check('33. a badge inside the range passes',
  [501, 550, 600].map((badge) => syncDeviceAuth.isBadgeWithinDeviceRange(AUTH, badge)),
  [true, true, true])
check('  one outside it does not',
  [500, 601, 1].map((badge) => syncDeviceAuth.isBadgeWithinDeviceRange(AUTH, badge)),
  [false, false, false])
check('34. a held registration has no badge and is not range-checked',
  syncDeviceAuth.isBadgeWithinDeviceRange(AUTH, undefined), true)
const syncSource = stripComments(read('api/sync-registration.ts'))
check('  and the endpoint only range-checks a COMPLETED device sync',
  /deviceAuthorization !== null &&\s*payload\.status === 'completed'/.test(syncSource), true)
check('  refusing with a typed outcome and writing nothing',
  [/device-badge-range-mismatch/.test(syncSource),
   syncSource.indexOf('device-badge-range-mismatch') < syncSource.indexOf('syncRegistration(')],
  [true, true])
check('  which the client treats as attention, never a retry loop',
  /device-badge-range-mismatch/.test(read('src/sync/retry-policy.ts')), true)
check('  and the wire contract knows it',
  /device-badge-range-mismatch/.test(read('src/shared/sync-contract.ts')), true)

console.log('  -- 33, 38. the REAL endpoint refuses an out-of-range badge --')
/**
 * Run for real, because a source grep cannot prove a refusal. These values
 * are disposable fixtures: the fake database stands in for Postgres and the
 * request never reaches Google — which is itself the point, since the
 * refusal must happen BEFORE any remote work.
 */
const ORIGIN = 'https://desk.example.test'
Object.assign(process.env, {
  SYNC_WRITE_ENABLED: 'true',
  SYNC_ALLOWED_VERCEL_ENV: 'development',
  VERCEL_ENV: 'development',
  SYNC_ALLOWED_ORIGIN: ORIGIN,
  GOOGLE_SHEETS_SPREADSHEET_ID: 'disposable-sheet-id',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'nobody@example.test',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-real-key',
})
delete process.env.EVENT_OPERATOR_ACCESS_CODE
delete process.env.EVENT_SESSION_SECRET

const syncEndpoint = await syncJiti.import(`${root}/api/sync-registration.ts`)
const snapshot = (badgeNumber) => ({
  registrationId: 'f1a7c4e2-0000-4000-8000-000000000001',
  operation: 'upsert',
  outboxId: 'registration:f1a7c4e2-0000-4000-8000-000000000001',
  payload: {
    id: 'f1a7c4e2-0000-4000-8000-000000000001',
    status: 'completed', name: 'Attendee', normalizedName: 'attendee',
    phone: '9000000001', age: 20, gender: 'female', amount: 20,
    paymentStatus: 'confirmed', paymentMethod: 'cash', badgeNumber,
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    completedAt: '2026-10-02T00:00:00.000Z',
  },
})
/** Surfaces the validator's own message when a fixture is wrong. */
const postSync = async (body, cookie) => {
  const response = await syncEndpoint.POST(new Request(`${ORIGIN}/api/sync-registration`, {
    method: 'POST',
    headers: {
      origin: ORIGIN, 'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

seedCentral()
const outOfRange = await postSync(snapshot(401), deviceCookie())
check('33. a badge OUTSIDE the device range is refused',
  [outOfRange.status, outOfRange.body.outcome], [403, 'device-badge-range-mismatch'])
check('  nothing remote was attempted',
  /spreadsheet|google/i.test(JSON.stringify(outOfRange.body)), false)
check('  and the row is identified so the outbox can retain it',
  outOfRange.body.registrationId, 'f1a7c4e2-0000-4000-8000-000000000001')
check('  a badge just past the end is refused too',
  (await postSync(snapshot(601), deviceCookie())).body.outcome, 'device-badge-range-mismatch')

seedCentral({ device: { enabled: false } })
check('38. a device DISABLED while it was offline cannot sync on reconnect',
  (await postSync(snapshot(501), deviceCookie())).status, 401)
seedCentral({ attributes: ['prizes'] })
check('  nor one that lost Registration',
  (await postSync(snapshot(501), deviceCookie())).status, 401)
seedCentral()
check('  nor an anonymous caller', (await postSync(snapshot(501), null)).status, 401)

console.log('  -- 22, 35-36. the operator path is untouched and independent --')
check('22, 36. operator is tried FIRST',
  syncSource.indexOf('operatorAuthorized') < syncSource.indexOf('authorizeSyncByDevice('), true)
check('  and the device realm is consulted only when it fails',
  /if \(!operatorAuthorized\) \{[\s\S]{0,200}authorizeSyncByDevice/.test(syncSource), true)
check('35. a valid operator session is never range-checked',
  /deviceAuthorization !== null/.test(syncSource), true)
check('  and never reaches the central database',
  /if \(!operatorAuthorized\)[\s\S]{0,400}getDatabase|loadDeviceSessionContext/.test(
    syncSource.slice(0, syncSource.indexOf('if (!operatorAuthorized)'))), false)
check('  and both realms answer with the SAME generic 401',
  (syncSource.match(/failure\('unauthorized', 'Operator session required\.', 401\)/g) ?? []).length,
  1)

console.log('\n=== 27, 37. THE OFFLINE LEASE IS NEVER A CREDENTIAL ===')
for (const file of readdirSync(join(root, 'api')).filter((entry) => entry.endsWith('.ts'))) {
  check(`api/${file} never accepts the lease`,
    /verifyOfflineAuthorization|offline-lease|X-Device-Lease|\bBearer\b/
      .test(stripComments(read(`api/${file}`))), false)
}
check('37. no client module puts a lease in a request',
  walk(join(root, 'src'))
    .filter((file) => /\bBearer\b|X-Device-Lease|document\.cookie/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  the module that makes requests cannot read the lease',
  /central-offline-authorization|offline-lease|centralDeviceOfflineAuthorization/
    .test(stripComments(read('src/device-auth/device-api.ts'))), false)
check('  nor can the server sync path',
  /offline-lease|verifyOfflineAuthorization|device-offline/
    .test(stripComments(read('server/sync/device-authorization.ts'))), false)

console.log('\n=== 28, 41. REGISTRATION STAYS OFFLINE-FIRST ===')
check('28, 41. issuance never consults device authorization',
  /getDeviceSession|event-authorization|offline-lease|fetch\(|\/api\//
    .test(stripComments(read('src/db/registrations.ts'))), false)
check('  nor does the registration form',
  /getDeviceSession|authorizeEventModule/
    .test(stripComments(read('src/components/registration/registration-form.tsx'))), false)
check('  nextBadge is still the local allocator',
  /nextBadge/.test(read('src/db/registrations.ts')), true)
check('  and the allocator semantics were not touched',
  /badge-range-exhausted/.test(read('src/db/registrations.ts')), true)

console.log('\n=== 29-30, 60-63. NOTHING ELSE MOVED ===')
check('29, 60. Operator Access is intact',
  ['operator-login', 'operator-logout', 'operator-session']
    .every((name) => existsSync(join(root, 'api', `${name}.ts`))), true)
check('  its gate and form are reused, never duplicated',
  [existsSync(join(root, 'src/components/operator/operator-access-gate.tsx')),
   walk(join(root, 'src'))
     // Bounded: `React.FC<OperatorAccessFormProps>` is the declaration, not a use.
     .filter((file) => /<OperatorAccessForm[\s/>]/.test(stripComments(readFileSync(file, 'utf8'))))
     .map((file) => file.replace(`${root}/src/`, '')).sort()],
  [true, ['components/operator/operator-access-banner.tsx',
          'components/operator/operator-access-gate.tsx']])
check('  and the trusted-device marker still exists',
  existsSync(join(root, 'src/auth/trusted-device.ts')), true)
check('30, 61. the local Phase 7 identity remains',
  [existsSync(join(root, 'src/pages/device-registration-page.tsx')),
   /registerDevice/.test(read('src/db/device.ts'))], [true, true])
check('63. IndexedDB version unchanged (1)',
  /DATABASE_VERSION = 1/.test(read('src/db/database.ts')), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(read('src/db/database.ts'))?.[1] ?? '')
    .match(/^\s*(\w+):/gm) ?? []).map((entry) => entry.trim().replace(':', '')),
  ['registrations', 'config', 'outbox'])
check('  NO migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('37, 40. the Sheet schema is unchanged',
  [/A1:N/.test(read('server/sync/sheet-contract.ts')),
   /A1:M/.test(read('server/sync/sheet-contract.ts')),
   /[Dd]evice [Ll]ease|permission/.test(read('server/sync/sheet-contract.ts'))],
  [true, true, false])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
check('62. the Function inventory is unchanged at eleven', budget.actual.length, 11)
check('  with one slot of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 1)
check('  and nothing unexpected', budget.problems, [])

console.log('\n=== 19, 23, 55-56. THE UI ===')
const banner = read('src/components/event-access/event-access-banner.tsx')
check('19. an online device shows a verified-online indicator',
  [/Device access/.test(banner), /Verified online/.test(banner)], [true, true])
check('20. offline shows the lease and when it runs out',
  [/Offline device access/.test(banner), /Authorization valid until/.test(banner)], [true, true])
check('  and NEVER calls it Authenticated',
  /Authenticated/.test(stripComments(banner)), false)
check('  it is amber, not destructive',
  [/amber/.test(banner), /destructive/.test(banner)], [true, false])
check('23. the operator banner is kept for the operator source',
  /OperatorAccessBanner/.test(banner), true)
check('56. Device Readiness reports event access read-only',
  [/Event access/.test(read('src/components/device/device-readiness.tsx')),
   /refresh\(\)|acceptOfflineAuthorization|revokeOfflineAuthorization/
     .test(read('src/components/device/device-readiness.tsx'))], [true, false])

console.log('\n=== USER-FACING COPY MATCHES C3B ===')
/**
 * C3A truthfully said a device unlocked nothing. C3B made that false, and
 * copy that contradicts the security model is worse than no copy: an
 * operator who is told Device access does not work will keep typing the
 * operator code, and will not notice when it stops being needed.
 */
const USER_FACING = [
  'src/pages/device-login-page.tsx',
  'src/components/device-auth/offline-authorization-summary.tsx',
  'src/components/device-auth/device-enrollment-panel.tsx',
  'src/components/device-auth/device-identity-summary.tsx',
  'src/components/event-access/event-access-banner.tsx',
  'src/components/event-access/badge-ownership-block.tsx',
]
/** Rendered text only: a comment explaining the history is not a claim. */
const renderedCopy = USER_FACING
  .map((file) => stripComments(read(file)))
  .join('\n')
  .replace(/\s+/g, ' ')

const STALE_C3A_CLAIMS = [
  'Event operations still use Operator Access',
  'signing in here does not unlock them yet',
  'does not unlock them yet',
  'Event operations are unaffected and continue to use Operator Access',
  'event operations continue to use Operator Access',
  'unlocks NOTHING in the event application',
  'A device session unlocks none of them',
]
for (const claim of STALE_C3A_CLAIMS) {
  check(`the stale C3A claim is gone: "${claim.slice(0, 44)}"`,
    renderedCopy.includes(claim), false)
}
check('  and no rendered text still says a device unlocks nothing',
  /unlocks? (nothing|none)/i.test(renderedCopy), false)

check('the Device Sign-In page describes C3B accurately',
  [renderedCopy.includes('Eligible event operations can use Device access'),
   renderedCopy.includes('Operator Access remains available as a transitional fallback')],
  [true, true])
check('the Offline Authorization section describes C3B accurately',
  [renderedCopy.includes(
     'When this signed lease is valid, eligible event operations can continue offline until the time above.'),
   renderedCopy.includes('Device Registration still requires Operator Access')],
  [true, true])
check('  the required ideas are all present in rendered copy',
  ['eligible event operations', 'offline authorization', 'Operator Access',
   'Device Registration still requires Operator Access']
    .filter((needle) => !new RegExp(needle, 'i').test(renderedCopy)), [])

/**
 * The copy must not overstate either way. A device grant is not a blanket
 * unlock — attributes and badge safety still decide — so "eligible" is the
 * load-bearing word and an unqualified promise would be the new lie.
 */
check('no copy promises a device can reach EVERY module',
  /unlocks (all|every)|full access to event|all event operations/i.test(renderedCopy), false)
// Case-sensitive: "Continue to Event Operations" is a navigation label,
// not a claim about what a device may do.
check('  and every Device-access claim is qualified as eligible',
  [...renderedCopy.matchAll(/\b([A-Za-z]+) (?:event|Event) (?:operations|Operations)/g)]
    .map((match) => match[1].toLowerCase())
    .filter((word) => word !== 'eligible' && word !== 'to'), [])
check('the unavailable states no longer claim Operator Access is the only path',
  [renderedCopy.includes('Operator Access remains available for eligible event operations'),
   renderedCopy.includes('Eligible event operations can continue on the signed offline')],
  [true, true])
check('  and the unconfigured-signing state is honest about online access',
  renderedCopy.includes('An online device can still use Device access'), true)

console.log('\n=== 66. DOCUMENTATION ===')
const deviceDoc = read('docs/DEVICE_AUTH.md')
for (const needle of ['device-online', 'device-offline', 'Operator Access',
  'never fall back', '/device-registration', 'Phase D'])
  check(`DEVICE_AUTH.md documents ${needle}`, deviceDoc.includes(needle), true)
check('AGENTS.md records the C3B rules',
  [/device-authorized event operations|Device Authorized Event Operations/i.test(read('AGENTS.md')),
   /device-badge-range-mismatch/.test(read('AGENTS.md'))], [true, true])
check('README describes the two sources',
  [/device-online/.test(read('README.md')), /device-offline/.test(read('README.md'))], [true, true])
check('the release checklist covers device-authorized operations',
  /device-authorized|Device access/i.test(read('docs/PRODUCTION_RELEASE_CHECKLIST.md')), true)
check('release:check guards the phase',
  /device-event-authorization/.test(read('scripts/release-check.mjs')), true)

const manifest = JSON.parse(read('package.json'))
check('verify:9cc3b is registered',
  manifest.scripts['verify:9cc3b'], 'node scripts/verification/phase-9cc3b.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9cc3b'), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /jwt|jose|redux|zustand|jotai|react-query|tanstack|swr/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
