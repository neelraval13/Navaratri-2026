/**
 * Phase 9C-C3A verification — the signed offline authorization lease.
 *
 * Run with:  pnpm verify:9cc3a
 *
 * It NEVER connects to Neon and makes no HTTP request. The REAL issuer signs
 * with node:crypto and the REAL browser verifier checks with WebCrypto, so
 * the one thing that cannot be assumed — that a Node ECDSA signature is
 * acceptable to `crypto.subtle` — is observed rather than asserted.
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

/** A disposable pair. Generated here, never printed, never written to disk. */
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PRIVATE_B64 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const PUBLIC_B64 = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const OTHER_PRIVATE_B64 = other.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })

process.env.VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64 = PUBLIC_B64

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_DEVICE_ID = '22222222-3333-4444-8555-666666666666'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const LOCAL_DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const RANGE = { rangeStart: 501, rangeEnd: 600, assignedAt: '2026-10-01T00:00:00.000Z' }

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const shared = await jiti.import(`${root}/src/shared/device-offline-authorization.ts`)
const issuer = await jiti.import(`${root}/server/device-auth/offline-authorization.ts`)
const verifier = await jiti.import(`${root}/src/device-auth/offline-authorization.ts`)
const lease = await jiti.import(`${root}/src/device-auth/offline-lease.ts`)
const enrollment = await jiti.import(`${root}/src/db/central-enrollment.ts`)
const store = await jiti.import(`${root}/src/db/central-offline-authorization.ts`)
const { state: dexie } = await import('./fake-db.mjs')

const context = (over = {}) => ({
  device: {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Claim Test Desk 2', loginName: 'claim-test-2',
    attributes: ['registration'], lastSeenAt: null, ...(over.device ?? {}),
  },
  event: { id: EVENT_ID, slug: 'navaratri-2026', name: 'Navaratri 2026', timezone: 'Asia/Kolkata' },
  activeBadgeRange: over.activeBadgeRange === undefined ? RANGE : over.activeBadgeRange,
})

const issue = (over = {}) => issuer.issueDeviceOfflineAuthorization({
  context: over.context ?? context(),
  eventEndsAt: over.eventEndsAt ?? null,
  now: over.now,
  source: over.source ?? { EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64: PRIVATE_B64 },
})

console.log('=== 1-9, 39. THE SERVER ISSUER ===')
const signed = issue()
check('1. an authenticated context yields a signed lease',
  [signed.configured, typeof signed.token, typeof signed.expiresAt],
  [true, 'string', 'string'])

const decoded = shared.decodeOfflineAuthorizationPayload(signed.token.split('.')[0])
check('2. the claims match the context exactly',
  [decoded.deviceId, decoded.eventId, decoded.eventSlug], [DEVICE_ID, EVENT_ID, 'navaratri-2026'])
check('3. registration is preserved', decoded.attributes, ['registration'])
check('  and prizes too',
  shared.decodeOfflineAuthorizationPayload(
    issue({ context: context({ device: { attributes: ['prizes', 'registration'] } }) })
      .token.split('.')[0]).attributes, ['prizes', 'registration'])
check('4. the active range is preserved exactly', decoded.activeBadgeRange, RANGE)
check('5. a null range stays null',
  shared.decodeOfflineAuthorizationPayload(
    issue({ context: context({ activeBadgeRange: null }) }).token.split('.')[0]).activeBadgeRange,
  null)
check('6. iat is set in epoch seconds',
  [Number.isInteger(decoded.iat), Math.abs(decoded.iat - Math.floor(Date.now() / 1000)) < 5],
  [true, true])
check('7. exp is at most 24h after iat',
  decoded.exp - decoded.iat, shared.MAX_DEVICE_OFFLINE_LEASE_SECONDS)
check('  the claims keys are exactly the approved set',
  Object.keys(decoded).sort(),
  ['activeBadgeRange', 'attributes', 'deviceId', 'eventId', 'eventSlug', 'exp', 'iat', 't', 'v'])
check('  and carry no credential, allocator or attendee data',
  /password|hash|salt|token|cookie|sessionVersion|nextBadge|phone|age|gender|payment/i
    .test(JSON.stringify(decoded)), false)
check('  nor this browser\'s LOCAL identity',
  JSON.stringify(decoded).includes(LOCAL_DEVICE_ID), false)

const NOW = new Date('2026-10-02T10:00:00.000Z')
const capped = issue({ now: NOW, eventEndsAt: new Date('2026-10-02T16:00:00.000Z') })
const cappedClaims = shared.decodeOfflineAuthorizationPayload(capped.token.split('.')[0])
check('8. the event end caps the expiry below 24h',
  [cappedClaims.exp, cappedClaims.exp - cappedClaims.iat],
  [Math.floor(Date.parse('2026-10-02T16:00:00.000Z') / 1000), 6 * 60 * 60])
check('  a distant event end does not extend past 24h',
  (() => {
    const far = shared.decodeOfflineAuthorizationPayload(
      issue({ now: NOW, eventEndsAt: new Date('2026-12-01T00:00:00.000Z') }).token.split('.')[0])
    return far.exp - far.iat
  })(), shared.MAX_DEVICE_OFFLINE_LEASE_SECONDS)
check('9. an event that already ended yields NO lease',
  issue({ now: NOW, eventEndsAt: new Date('2026-10-01T00:00:00.000Z') }), { configured: false })
check('  nor one ending this very second',
  issue({ now: NOW, eventEndsAt: NOW }), { configured: false })

console.log('\n=== 10-13. UNCONFIGURED SIGNING IS SAFE ===')
const logged = []
const realError = console.error
console.error = (...args) => { logged.push(args.join(' ')) }
check('10. a missing key disables signing',
  issue({ source: {} }), { configured: false })
check('  a malformed key disables signing',
  issue({ source: { EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64: 'bm90LWEta2V5' } }),
  { configured: false })
check('  a WRONG CURVE key is refused rather than signing unusably',
  issuer.readOfflineSigningKey({
    EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64:
      wrongCurve.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }), { ok: false, reason: 'private-key-wrong-curve' })
check('11. no part of the key reaches a log',
  logged.filter((entry) => entry.includes(PRIVATE_B64.slice(0, 24)) || entry.includes('bm90LWEta2V5')), [])
check('  the log names the variable and the problem only',
  logged.every((entry) => entry.includes('EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64')), true)
/**
 * An ABSENT key is a supported configuration, so it is silent: logging it
 * would print on every login and every session check, and a log that cries
 * wolf on a normal deployment is one nobody reads when something is wrong.
 * A key that is present and unusable IS reported.
 */
const quiet = []
console.error = (...args) => { quiet.push(args.join(' ')) }
issue({ source: {} })
issue({ source: {} })
const malformedLogs = quiet.length
issue({ source: { EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64: 'bm90LWEta2V5' } })
console.error = realError
check('  an absent key logs nothing, a broken one does',
  [malformedLogs, quiet.length], [0, 1])
check('12-13. login and session still work with signing unconfigured',
  [/offlineAuthorization: issueDeviceOfflineAuthorization/.test(read('api/device-auth.ts')),
   /configured: false/.test(read('server/device-auth/offline-authorization.ts'))], [true, true])
check('  the envelope degrades to a safe shape, never a fake lease',
  /token/.test(JSON.stringify(issue({ source: {} }))), false)

console.log('\n=== 16-27, 40. NODE SIGNS, WEBCRYPTO VERIFIES ===')
const split = shared.splitOfflineAuthorizationToken(signed.token)
/**
 * Guarded rather than dereferenced. Node's ECDSA default is DER, which is
 * ~70 bytes and which `crypto.subtle.verify` rejects outright — and a suite
 * that CRASHED on that would fail without ever saying the encoding was the
 * problem, on the one property that cannot be reasoned about from source.
 */
check('16-17. the signature is raw P-256 r||s, as WebCrypto requires',
  split === null
    ? `rejected: ${String(shared.fromBase64Url(signed.token.split('.')[1])?.length)} bytes, not 64`
    : split.signature.length,
  64)
const webKey = await crypto.subtle.importKey(
  'spki', Buffer.from(PUBLIC_B64, 'base64'),
  { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
check('  REAL WebCrypto accepts the REAL Node signature',
  split === null
    ? 'no verifiable signature was produced'
    : await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, webKey, split.signature,
        shared.offlineAuthorizationSignedMessage(split.encodedPayload)),
  true)
check('  and so does the application\'s own verifier',
  (await verifier.verifyOfflineAuthorization(signed.token)).status, 'valid')
check('  the verified claims are the signed ones',
  (await verifier.verifyOfflineAuthorization(signed.token)).claims.activeBadgeRange, RANGE)

const tamperedPayload = (mutate) => {
  const claims = { ...decoded, ...mutate }
  const payload = shared.toBase64Url(shared.encodeUtf8(JSON.stringify(claims)))
  return `${payload}.${signed.token.split('.')[1]}`
}
check('18. a changed payload fails',
  (await verifier.verifyOfflineAuthorization(tamperedPayload({ attributes: ['registration', 'prizes'] }))).status,
  'invalid')
check('  escalating the badge range fails',
  (await verifier.verifyOfflineAuthorization(
    tamperedPayload({ activeBadgeRange: { ...RANGE, rangeEnd: 9999 } }))).status, 'invalid')
check('  extending the expiry fails',
  (await verifier.verifyOfflineAuthorization(tamperedPayload({ exp: decoded.exp + 60 }))).status,
  'invalid')
/**
 * The FIRST character, not the last: 86 base64url characters carry 64 bytes
 * plus four leftover bits that any decoder discards, so flipping the final
 * character can leave the signature bytes identical.
 */
const rawSignature = signed.token.split('.')[1]
check('19. a changed signature fails',
  (await verifier.verifyOfflineAuthorization(
    `${signed.token.split('.')[0]}.${rawSignature.startsWith('A') ? 'B' : 'A'}${rawSignature.slice(1)}`)).status,
  'invalid')
check('  and so does a truncated one',
  (await verifier.verifyOfflineAuthorization(
    `${signed.token.split('.')[0]}.${rawSignature.slice(0, 80)}`)).status, 'invalid')
check('20. a lease signed by a DIFFERENT key fails',
  (await verifier.verifyOfflineAuthorization(
    issue({ source: { EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64: OTHER_PRIVATE_B64 } }).token)).status,
  'invalid')
for (const [label, token] of [
  ['undefined', undefined], ['empty', ''], ['no separator', 'nonsense'],
  ['one segment', signed.token.split('.')[0]], ['three segments', `${signed.token}.x`],
  ['non base64url', `not base64!.${signed.token.split('.')[1]}`],
  ['short signature', `${signed.token.split('.')[0]}.AAAA`],
  ['an object', { token: signed.token }],
]) check(`21. malformed token rejected: ${label}`,
  (await verifier.verifyOfflineAuthorization(token)).status, 'invalid')

/** Correctly SIGNED payloads, so only the claim parser can reject them. */
const { sign } = await import('node:crypto')
const signClaims = (claims) => {
  const payload = shared.toBase64Url(shared.encodeUtf8(JSON.stringify(claims)))
  const signature = sign('sha256', shared.offlineAuthorizationSignedMessage(payload),
    { key: pair.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${payload}.${shared.toBase64Url(new Uint8Array(signature))}`
}
check('22. a wrong version fails even when correctly signed',
  (await verifier.verifyOfflineAuthorization(signClaims({ ...decoded, v: 2 }))).status, 'invalid')
check('23. a wrong type fails',
  (await verifier.verifyOfflineAuthorization(signClaims({ ...decoded, t: 'device-session' }))).status,
  'invalid')
check('24. an UNKNOWN attribute fails closed',
  (await verifier.verifyOfflineAuthorization(
    signClaims({ ...decoded, attributes: ['registration', 'superuser'] }))).status, 'invalid')
check('  and never becomes a granted capability',
  (await verifier.verifyOfflineAuthorization(
    signClaims({ ...decoded, attributes: ['admin'] }))).claims, undefined)
for (const [label, range] of [
  ['a zero start', { rangeStart: 0, rangeEnd: 5, assignedAt: 'A' }],
  ['a reversed range', { rangeStart: 9, rangeEnd: 2, assignedAt: 'A' }],
  ['a fractional range', { rangeStart: 1.5, rangeEnd: 5, assignedAt: 'A' }],
  ['a missing assignedAt', { rangeStart: 1, rangeEnd: 5 }],
]) check(`25. a malformed range fails: ${label}`,
  (await verifier.verifyOfflineAuthorization(
    signClaims({ ...decoded, activeBadgeRange: range }))).status, 'invalid')
check('  an over-long lease is refused even when signed',
  (await verifier.verifyOfflineAuthorization(signClaims({
    ...decoded, exp: decoded.iat + shared.MAX_DEVICE_OFFLINE_LEASE_SECONDS + 1,
  }))).status, 'invalid')

const SEC = 1000
/**
 * Anchored to the REAL clock, not the fixed `NOW` the cap tests use: an
 * expired fixture pinned to a date the machine has not reached yet is not
 * expired, and the test would pass or fail depending on the hour it ran.
 */
const realNowSeconds = Math.floor(Date.now() / SEC)
const expiredToken = signClaims({
  ...decoded, iat: realNowSeconds - 7200, exp: realNowSeconds - 3600,
})
check('26. an expired lease is reported as expired, not valid',
  (await verifier.verifyOfflineAuthorization(expiredToken)).status, 'expired')
check('  and is never extended locally',
  (await verifier.verifyOfflineAuthorization(
    expiredToken, new Date(Date.now() + 86400 * SEC))).status, 'expired')
check('27. an iat beyond the skew window fails',
  (await verifier.verifyOfflineAuthorization(signClaims({
    ...decoded, iat: Math.floor(NOW.getTime() / SEC) + 3600,
    exp: Math.floor(NOW.getTime() / SEC) + 7200,
  }), NOW)).status, 'invalid')
check('  but a small clock difference is tolerated',
  (await verifier.verifyOfflineAuthorization(signClaims({
    ...decoded, iat: Math.floor(NOW.getTime() / SEC) + 60,
    exp: Math.floor(NOW.getTime() / SEC) + 7200,
  }), NOW)).status, 'valid')
check('  the tolerated window is five minutes', shared.DEVICE_OFFLINE_CLOCK_SKEW_SECONDS, 300)

console.log('  -- the base64url codec is self-contained --')
check('it round-trips arbitrary bytes',
  (() => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(Array.from({ length }, (_, i) => (i * 37 + length) % 256))
      const back = shared.fromBase64Url(shared.toBase64Url(bytes))
      if (back === null || back.length !== length || !bytes.every((b, i) => b === back[i])) {
        return `mismatch at ${String(length)}`
      }
    }
    return 'ok'
  })(), 'ok')
check('  it matches Node base64url exactly',
  shared.toBase64Url(new Uint8Array([0, 1, 250, 255, 128, 64])),
  Buffer.from([0, 1, 250, 255, 128, 64]).toString('base64url'))
// Word-bounded: `new ArrayBuffer(...)` is a standard constructor and
// legitimately contains the substring "Buffer".
check('  and depends on no platform-specific global',
  /\bbtoa\b|\batob\b|\bBuffer\b|require\(/
    .test(stripComments(read('src/shared/device-offline-authorization.ts'))), false)

console.log('\n=== 28-31, 41. ONLY VERIFIED LEASES ARE STORED ===')
const CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 501, badgeEnd: 600, nextBadge: 501,
  badgeConfiguredAt: '2026-10-01T00:00:00.000Z',
  deviceId: LOCAL_DEVICE_ID, deviceName: 'claim-test-local-2',
  deviceConfiguredAt: '2026-09-01T00:00:00.000Z',
  centralBadgeRangeBinding: {
    deviceId: DEVICE_ID, eventId: EVENT_ID, rangeStart: 501, rangeEnd: 600,
    assignedAt: RANGE.assignedAt, adoptedAt: '2026-10-01T01:00:00.000Z',
  },
  updatedAt: 'T',
}
const seed = () => {
  dexie.config = structuredClone(CONFIG)
  dexie.registrations = new Map()
  dexie.outbox = new Map()
}
const accept = (over = {}) => lease.acceptOfflineAuthorization({
  context: over.context ?? context(),
  envelope: over.envelope ?? { configured: true, token: signed.token, expiresAt: signed.expiresAt },
  ...(over.expectedBadgeRange === undefined ? {} : { expectedBadgeRange: over.expectedBadgeRange }),
})

seed()
check('28. a verified, consistent lease is stored',
  (await accept()).status, 'cached')
check('  the stored row holds the TOKEN and nothing decoded',
  Object.keys(dexie.config.centralDeviceOfflineAuthorization).sort(), ['receivedAt', 'token'])
check('  no decoded claim became a second source of truth',
  /attributes|rangeStart|exp|registration/
    .test(JSON.stringify(dexie.config.centralDeviceOfflineAuthorization)), false)
check('  and it reads back as valid',
  (await lease.readVerifiedOfflineAuthorization()).status, 'valid')

seed()
seed()
check('29. a tampered lease is NEVER stored',
  [(await accept({ envelope: { configured: true, token: tamperedPayload({ attributes: ['registration', 'prizes'] }), expiresAt: 'x' } })).status,
   dexie.config.centralDeviceOfflineAuthorization], ['invalid', undefined])
seed()
check('  nor one signed by another key',
  [(await accept({ envelope: { configured: true, token: issue({ source: { EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64: OTHER_PRIVATE_B64 } }).token, expiresAt: 'x' } })).status,
   dexie.config.centralDeviceOfflineAuthorization], ['invalid', undefined])
seed()
check('  nor an expired one',
  [(await accept({ envelope: { configured: true, token: expiredToken, expiresAt: 'x' } })).status,
   dexie.config.centralDeviceOfflineAuthorization], ['expired', undefined])
seed()
check('  and an unconfigured envelope stores nothing',
  [(await accept({ envelope: { configured: false } })).status,
   dexie.config.centralDeviceOfflineAuthorization], ['not-configured', undefined])

console.log('  -- 30, 24. the lease must describe the context it arrived with --')
for (const [label, over] of [
  ['another device', { context: context({ device: { id: OTHER_DEVICE_ID } }) }],
  ['more attributes than the session', { context: context({ device: { attributes: ['registration', 'prizes'] } }) }],
  ['fewer attributes than the session', { context: context({ device: { attributes: [] } }) }],
  ['a different range', { context: context({ activeBadgeRange: { ...RANGE, rangeEnd: 700 } }) }],
  ['no range at all', { context: context({ activeBadgeRange: null }) }],
  ['a different assignedAt', { context: context({ activeBadgeRange: { ...RANGE, assignedAt: '2020-01-01T00:00:00.000Z' } }) }],
]) {
  seed()
  check(`30. refused: a lease describing ${label}`, (await accept(over)).status, 'inconsistent')
  check(`    and nothing was stored`, dexie.config.centralDeviceOfflineAuthorization, undefined)
}
seed()
check('  a claim response is checked against the range IT established',
  (await accept({
    context: context({ activeBadgeRange: null }), expectedBadgeRange: RANGE,
  })).status, 'cached')

seed()
await accept()
const firstToken = dexie.config.centralDeviceOfflineAuthorization.token
await new Promise((done) => setTimeout(done, 5))
const second = issue()
await accept({ envelope: { configured: true, token: second.token, expiresAt: second.expiresAt } })
check('31. replacing a lease leaves exactly ONE current token',
  [typeof dexie.config.centralDeviceOfflineAuthorization.token,
   dexie.config.centralDeviceOfflineAuthorization.token === firstToken,
   Object.keys(dexie.config).filter((key) => /[Oo]ffline/.test(key)).length],
  ['string', false, 1])

console.log('\n=== 32-38. LIFECYCLE ===')
seed()
await enrollment.saveCentralDeviceEnrollment(context())
await accept()
const before = {
  badgeStart: dexie.config.badgeStart, badgeEnd: dexie.config.badgeEnd,
  nextBadge: dexie.config.nextBadge, binding: dexie.config.centralBadgeRangeBinding,
  deviceId: dexie.config.deviceId, deviceName: dexie.config.deviceName,
}
await enrollment.clearCentralDeviceEnrollment()
check('32, 35. a successful logout / Clear Central Enrollment drops the lease',
  [dexie.config.centralDeviceEnrollment, dexie.config.centralDeviceOfflineAuthorization],
  [undefined, undefined])
check('33, 36. and preserves every piece of local badge work',
  [dexie.config.badgeStart, dexie.config.badgeEnd, dexie.config.nextBadge,
   dexie.config.centralBadgeRangeBinding, dexie.config.deviceId, dexie.config.deviceName],
  [before.badgeStart, before.badgeEnd, before.nextBadge, before.binding,
   before.deviceId, before.deviceName])
check('  both are dropped in ONE transaction',
  [...stripComments(read('src/db/central-enrollment.ts'))
    .matchAll(/delete next\./g)].length === 2 &&
  [...stripComments(read('src/db/central-enrollment.ts'))
    .matchAll(/db\.transaction\(/g)].length, 2)

const panel = stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
const signOut = panel.slice(panel.indexOf('const signOut'), panel.indexOf('const adopt'))
/**
 * The failure branch ALONE. Matching across it would run straight into the
 * success path's clear and report the opposite of the truth.
 */
const logoutFailure = signOut.slice(
  signOut.indexOf('!endedSession.ok'),
  signOut.indexOf('return', signOut.indexOf('!endedSession.ok')))
check('34. a FAILED logout keeps the lease and the enrollment',
  /clearCentralDeviceEnrollment|revokeOfflineAuthorization|delete /.test(logoutFailure), false)
check('  it returns before anything local is cleared',
  signOut.indexOf('endedSession.ok') < signOut.indexOf('clearCentralDeviceEnrollment'), true)

console.log('  -- 37, 38. revocation versus a bad network --')
const sessionBranches = panel.slice(panel.indexOf("session.status === 'authenticated'"))
const unreachable = sessionBranches.slice(
  sessionBranches.indexOf("session.status === 'unreachable'"),
  sessionBranches.indexOf("session.status === 'unauthenticated'"))
check('37. a DEFINITIVELY rejected session clears the lease',
  /session\.status === 'unauthenticated'[\s\S]{0,200}revokeOfflineAuthorization\(\)/
    .test(sessionBranches), true)
check('38. an unreachable server does NOT',
  /revokeOfflineAuthorization/.test(unreachable), false)
check('  and it re-verifies the cached lease instead',
  /readVerifiedOfflineAuthorization\(\)/.test(unreachable), true)
check('  no other status clears it',
  [...panel.matchAll(/revokeOfflineAuthorization\(\)/g)].length, 1)

seed()
await accept()
const storedToken = dexie.config.centralDeviceOfflineAuthorization.token
await lease.revokeOfflineAuthorization()
check('  revocation removes only the lease',
  [dexie.config.centralDeviceOfflineAuthorization, dexie.config.badgeEnd,
   dexie.config.centralBadgeRangeBinding !== undefined], [undefined, 600, true])

seed()
await store.saveCentralDeviceOfflineAuthorization(expiredToken)
check('39. expired bytes remain non-authoritative',
  (await lease.readVerifiedOfflineAuthorization()).status, 'expired')
seed()
await store.saveCentralDeviceOfflineAuthorization(`${storedToken.split('.')[0]}.${'A'.repeat(86)}`)
check('  and tampered bytes verify as invalid, never valid',
  (await lease.readVerifiedOfflineAuthorization()).status, 'invalid')
seed()
check('  no stored lease at all is "none", never a grant',
  (await lease.readVerifiedOfflineAuthorization()).status, 'none')

console.log('\n=== 40-41. NO SCHEMA CHANGE ===')
const dexieSource = read('src/db/database.ts')
check('40. IndexedDB version unchanged (1)', /DATABASE_VERSION = 1/.test(dexieSource), true)
check('41. stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexieSource)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((entry) => entry.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and this phase did not touch the schema',
  /offline|Offline/.test(dexieSource), false)
check('NO migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('  and no server file stores a lease',
  /centralDeviceOfflineAuthorization/.test(
    walk(join(root, 'server')).map((file) => readFileSync(file, 'utf8')).join('\n')), false)

console.log('\n=== 42-47. THE LEASE IS NEVER A SERVER CREDENTIAL ===')
for (const file of readdirSync(join(root, 'api')).filter((entry) => entry.endsWith('.ts'))) {
  const code = stripComments(read(`api/${file}`))
  check(`api/${file} never verifies a lease as auth`,
    /verifyOfflineAuthorization|offline-lease|\bBearer\b|headers\.get\('authorization'/
      .test(code), false)
}
check('42. the device session endpoint still requires its cookie',
  [/readDeviceSessionCookie/.test(read('api/device-auth.ts')),
   /verifyDeviceSessionToken/.test(read('api/device-auth.ts'))], [true, true])
check('43. the claim endpoint still requires the device session',
  /authorizeDeviceRequest\(request, \{ mutating: true \}\)/.test(read('api/device-badge-claim.ts')), true)
check('44. Admin endpoints are untouched by the lease',
  readdirSync(join(root, 'api')).filter((file) => file.startsWith('admin-'))
    .filter((file) => /offline/i.test(stripComments(read(`api/${file}`)))), [])
/**
 * 9C-C3B gave sync a second realm: a LIVE device session. What C3A
 * established and still holds is that the signed offline lease is accepted
 * by nothing — the server reads current central state instead.
 */
check('45. sync-registration keeps Operator auth and never takes the lease',
  [/operator/i.test(read('api/sync-registration.ts')),
   /offline|verifyOfflineAuthorization/
     .test(stripComments(read('api/sync-registration.ts')))], [true, false])
/**
 * `device-api.ts` is the ONLY module that makes a request. If it cannot see
 * the stored lease, no request can carry it.
 */
check('46-47. the one module that makes requests cannot read the lease',
  /central-offline-authorization|offline-lease|centralDeviceOfflineAuthorization/
    .test(stripComments(read('src/device-auth/device-api.ts'))), false)
check('  and no module puts a lease in a header or a cookie',
  walk(join(root, 'src'))
    .filter((file) => /\bBearer\b|document\.cookie|'authorization':|Authorization':/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  the verifier makes no network call at all',
  /fetch\(|XMLHttpRequest|\/api\//.test(stripComments(read('src/device-auth/offline-authorization.ts'))),
  false)
check('  and the signing key never reaches src/',
  walk(join(root, 'src'))
    .filter((file) => readFileSync(file, 'utf8').includes('EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64'))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  nor any private-key handling',
  walk(join(root, 'src'))
    .filter((file) => /createPrivateKey|dsaEncoding|node:crypto|'sign'/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  the browser key is import-only for verification',
  [/\['verify'\]/.test(read('src/device-auth/offline-authorization.ts')),
   /'sign'/.test(read('src/device-auth/offline-authorization.ts'))], [true, false])

console.log('\n=== 35-38, 48-55. NOTHING ELSE MOVED ===')
/**
 * 9C-C3B made the lease a parallel authority; PHASE D2 made it the only one
 * alongside a live session, by deleting Operator Access. What C3A still has
 * to prove is that the LEASE ITSELF reached no route on its own — the gate
 * consults a normalised grant, never a stored token.
 */
check('35. the event routes are gated by the device authorization gate',
  [/OperatorAccessGate/.test(read('src/components/app-router.tsx')),
   /<EventAccessGate module="/.test(read('src/components/app-router.tsx'))], [false, true])
check('  and no route consults the lease',
  walk(join(root, 'src/components')).concat(walk(join(root, 'src/pages')))
    .filter((file) => !/device-auth|device-readiness/.test(file))
    .filter((file) => /offline-lease|verifyOfflineAuthorization/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  no DeviceAccessGate exists',
  ['src/components/device-auth/device-access-gate.tsx',
   'src/components/device-access-gate.tsx']
    .filter((file) => existsSync(join(root, file))), [])
check('36. Operator Access is gone, and C3A left nothing of it behind',
  ['operator-login', 'operator-logout', 'operator-session']
    .some((name) => existsSync(join(root, 'api', `${name}.ts`))), false)
check('37. the local identity model remains, its retired page does not',
  [existsSync(join(root, 'src/pages/device-registration-page.tsx')),
   /deviceId/.test(read('src/db/device.ts'))], [false, true])
check('38. no heartbeat or polling was added',
  /setInterval|setTimeout\(/.test(
    stripComments(read('src/device-auth/offline-lease.ts')) +
    stripComments(read('src/device-auth/offline-authorization.ts')) + panel), false)
check('  the session is still checked on mount, login and refresh only',
  [...panel.matchAll(/getDeviceSession\(\)/g)].length, 1)

check('48. centralDeviceEnrollment is still exactly its seven fields',
  (/export interface CentralDeviceEnrollment \{([\s\S]*?)\n\}/.exec(read('src/db/types.ts'))?.[1] ?? '')
    .match(/^\s{2}(\w+)[?]?:/gm).map((entry) => entry.trim().replace(/[?:]/g, '')).sort(),
  ['attributes', 'deviceId', 'deviceName', 'eventId', 'eventSlug', 'loginName', 'verifiedAt'])
check('  and gained no authorization field',
  /offline|token|exp|activeBadgeRange/i.test(
    /export interface CentralDeviceEnrollment \{([\s\S]*?)\n\}/.exec(read('src/db/types.ts'))[1]), false)
check('49. centralBadgeRangeBinding is unchanged',
  (/export interface CentralBadgeRangeBinding \{([\s\S]*?)\n\}/.exec(read('src/db/types.ts'))?.[1] ?? '')
    .match(/^\s{2}(\w+)[?]?:/gm).map((entry) => entry.trim().replace(/[?:]/g, '')).sort(),
  ['adoptedAt', 'assignedAt', 'deviceId', 'eventId', 'rangeEnd', 'rangeStart'])
check('54. nextBadge is still local and never signed',
  [/nextBadge/.test(read('src/db/registrations.ts')),
   /nextBadge/.test(stripComments(read('src/shared/device-offline-authorization.ts')))],
  [true, false])
check('55. issuance still makes no central request',
  /fetch\(|\/api\//.test(stripComments(read('src/db/registrations.ts'))), false)

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
// C3A added no Function; Phase D2 removed three.
check('44. the Function inventory is eight', budget.actual.length, 8)
check('  with four slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 4)
check('  and nothing unexpected', budget.problems, [])
check('  no offline-authorization endpoint was added',
  readdirSync(join(root, 'api')).filter((file) => /offline|lease/i.test(file)), [])

console.log('\n=== UI AND DOCS ===')
const summary = read('src/components/device-auth/offline-authorization-summary.tsx')
check('32. the login page has an Offline Authorization section',
  /Offline Authorization/.test(summary), true)
for (const needle of ['Not configured', 'Available offline', 'Offline authorization lease valid',
  'Expired', 'Invalid', 'Unavailable to verify'])
  check(`  state: ${needle}`, summary.includes(needle), true)
check('  offline it is NEVER called Authenticated',
  /Authenticated/.test(stripComments(summary)), false)
check('  and it says the live session was not checked',
  /The live device session was not checked/.test(summary), true)
check('33. it shows the signed facts',
  [/Access/.test(summary), /Central badge assignment/.test(summary),
   /Valid until/.test(summary)], [true, true, true])
check('  from VERIFIED claims only',
  [/claims: DeviceOfflineClaims/.test(summary),
   /decodeOfflineAuthorizationPayload/.test(summary)], [true, false])
/**
 * C3A said a lease unlocked nothing; C3B made that false. Phase D2 then
 * retired the one thing a lease still could not do, so the section now
 * states the scope that remains: eligible operations continue offline, and
 * CHANGING which device this browser is always needs a connection.
 */
check('  and states the real scope of a valid lease',
  [/eligible event operations can continue[\s\S]{0,20}offline/.test(summary),
   /always needs a connection/.test(summary),
   /Operator Access/.test(summary)],
  [true, true, false])
check('34. Device Readiness reports the lease read-only',
  [/Central offline authorization/.test(read('src/components/device/device-readiness.tsx')),
   /readVerifiedOfflineAuthorization/.test(read('src/components/device/device-readiness.tsx'))],
  [true, true])
check('  and never mutates it',
  /acceptOfflineAuthorization|revokeOfflineAuthorization|saveCentralDeviceOfflineAuthorization/
    .test(read('src/components/device/device-readiness.tsx')), false)

const envExample = read('.env.example')
check('45. .env.example documents both key variables',
  [envExample.includes('EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64='),
   envExample.includes('VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64=')], [true, true])
// Assembled, so this suite is not itself a VITE_ reference to the private key.
check('  and never a VITE_ private key',
  envExample.includes(`VITE_${'EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64'}`), false)
check('46. key generation is documented without any key material',
  [/openssl ecparam -name prime256v1/.test(envExample),
   /pkcs8 -topk8 -nocrypt/.test(envExample),
   /-----BEGIN/.test(envExample)], [true, true, false])
const deviceDoc = read('docs/DEVICE_AUTH.md')
for (const needle of ['offline authorization', 'P-256', '24', 'endsAt',
  'never a central API credential', 'Operator Access', '9C-C3B'])
  check(`DEVICE_AUTH.md documents ${needle}`, deviceDoc.includes(needle), true)
/**
 * POPULATED key material, not the word "KEY". The README legitimately shows
 * the SHAPE of the Google service-account variable with a `...` placeholder,
 * and a check that cannot tell a placeholder from a key would either fail on
 * honest documentation or be deleted for being noisy.
 */
const POPULATED_PEM = /-----BEGIN [A-Z ]*KEY-----[\s\\n]*[A-Za-z0-9+/]{40,}/
check('  no document contains populated key material',
  [['.env.example', envExample], ['docs/DEVICE_AUTH.md', deviceDoc],
   ['README.md', read('README.md')], ['AGENTS.md', read('AGENTS.md')]]
    .filter(([, text]) => POPULATED_PEM.test(text)).map(([name]) => name), [])
check('  nor a long base64 blob beside an offline key name',
  [envExample, deviceDoc, read('README.md'), read('AGENTS.md')]
    .filter((text) => /OFFLINE_(PRIVATE|PUBLIC)_KEY_[A-Z0-9_]*=\s*[A-Za-z0-9+/]{32,}/.test(text))
    .length, 0)
check('  and this suite never printed the keys it generated',
  [PRIVATE_B64.length > 0, PUBLIC_B64.length > 0], [true, true])
check('AGENTS.md records the offline lease rules',
  [/offline authorization lease/i.test(read('AGENTS.md')),
   /never a central API credential|never a credential/i.test(read('AGENTS.md'))], [true, true])
check('the release checklist covers the keys',
  /EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64/.test(read('docs/PRODUCTION_RELEASE_CHECKLIST.md')), true)
check('release:check guards the lease',
  /device-offline-authorization/.test(read('scripts/release-check.mjs')), true)

const manifest = JSON.parse(read('package.json'))
check('verify:9cc3a is registered',
  manifest.scripts['verify:9cc3a'], 'node scripts/verification/phase-9cc3a.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9cc3a'), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /jwt|jose|jsonwebtoken|paseto|tweetnacl|elliptic|node-forge|crypto-js/i.test(name)),
  [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
