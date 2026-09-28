/**
 * Phase 9C-B verification — central device authentication and device session.
 *
 * Run with:  pnpm verify:9cb
 *
 * It NEVER connects to Neon. The session signer and the password verifier are
 * exercised for real; the central lookups run against the stand-in database
 * from Phase 9B.
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
const walkSource = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSource(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const jiti = createJiti(import.meta.url, { alias: { '@': `${root}/src` }, interopDefault: true })
const deviceEnv = await jiti.import(`${root}/server/device-auth/environment.ts`)
const deviceSession = await jiti.import(`${root}/server/device-auth/session.ts`)
const deviceCookies = await jiti.import(`${root}/server/device-auth/cookies.ts`)
const deviceOrigin = await jiti.import(`${root}/server/device-auth/same-origin.ts`)
const deviceRequests = await jiti.import(`${root}/server/device-auth/requests.ts`)
const adminSession = await jiti.import(`${root}/server/admin-auth/session.ts`)
const operatorSession = await jiti.import(`${root}/server/auth/operator-session.ts`)

const DEVICE_ID = '11111111-2222-4333-8444-555555555555'
const EVENT_ID = '99999999-2222-4333-8444-555555555555'
const SECRET = 'd'.repeat(48)
const claims = { deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion: 3 }
const token = deviceSession.createDeviceSessionToken(SECRET, claims)

console.log('=== ENVIRONMENT ===')
check('the device secret is its own variable',
  [...deviceEnv.DEVICE_AUTH_ENVIRONMENT_NAMES], ['EVENT_DEVICE_SESSION_SECRET'])
check('  with a 32 character minimum', deviceEnv.MIN_DEVICE_SESSION_SECRET_LENGTH, 32)
check('a 32 character secret is accepted',
  deviceEnv.readDeviceAuthEnvironment({ EVENT_DEVICE_SESSION_SECRET: 'a'.repeat(32) }).ok, true)
check('  31 is refused',
  deviceEnv.readDeviceAuthEnvironment({ EVENT_DEVICE_SESSION_SECRET: 'a'.repeat(31) }),
  { ok: false, reason: 'session-secret-too-short' })
check('  absent is refused',
  deviceEnv.readDeviceAuthEnvironment({}), { ok: false, reason: 'session-secret-missing' })
check('  blank is refused',
  deviceEnv.readDeviceAuthEnvironment({ EVENT_DEVICE_SESSION_SECRET: '' }).ok, false)
check('the value is taken EXACTLY, never trimmed',
  deviceEnv.readDeviceAuthEnvironment({ EVENT_DEVICE_SESSION_SECRET: ` ${'a'.repeat(32)} ` })
    .environment.sessionSecret, ` ${'a'.repeat(32)} `)
check('no message names a value',
  Object.values(deviceEnv.DEVICE_AUTH_LOG_MESSAGES)
    .every((message) => message.startsWith('EVENT_DEVICE_SESSION_SECRET')), true)
check('it does not read the other realms',
  /EVENT_SESSION_SECRET|EVENT_ADMIN/.test(stripComments(read('server/device-auth/environment.ts'))), false)
check('startup does not depend on it',
  [join(root, 'src'), join(root, 'server/db'), join(root, 'server/sync')]
    .flatMap((dir) => walkSource(dir))
    .filter((file) => /EVENT_DEVICE_SESSION_SECRET/.test(readFileSync(file, 'utf8'))), [])

console.log('\n=== 1-8. DEVICE COOKIE ===')
const setCookie = deviceCookies.serializeDeviceSessionCookie(token)
const cleared = deviceCookies.serializeClearedDeviceSessionCookie()

check('the cookie name is exact',
  deviceCookies.DEVICE_SESSION_COOKIE, '__Host-navaratri_device_session')
check('  distinct from Admin and Operator',
  [deviceCookies.DEVICE_SESSION_COOKIE === '__Host-navaratri_admin_session',
   deviceCookies.DEVICE_SESSION_COOKIE === '__Host-navaratri_operator_session'], [false, false])
for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'])
  check(`  ${attribute}`, setCookie.includes(attribute), true)
check('  no Domain', /Domain=/i.test(setCookie), false)
check('  TTL is 14 days',
  [deviceSession.DEVICE_SESSION_TTL_SECONDS, setCookie.includes('Max-Age=1209600')],
  [14 * 24 * 60 * 60, true])
check('the cleared cookie uses the same scope',
  [cleared.includes('__Host-navaratri_device_session='), cleared.includes('Max-Age=0'),
   ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'].every((a) => cleared.includes(a)),
   /Domain=/i.test(cleared)], [true, true, true, false])
check('  and carries no token', cleared.includes(token), false)

console.log('  -- reading the cookie header --')
check('it finds its own cookie among others',
  deviceCookies.readDeviceSessionCookie(
    `__Host-navaratri_admin_session=a; __Host-navaratri_device_session=${token}; other=x`), token)
check('  it never returns another realm\'s cookie',
  deviceCookies.readDeviceSessionCookie('__Host-navaratri_admin_session=admintoken'), undefined)
check('  nor an operator cookie',
  deviceCookies.readDeviceSessionCookie('__Host-navaratri_operator_session=optoken'), undefined)
check('  an absent header is undefined',
  [deviceCookies.readDeviceSessionCookie(null), deviceCookies.readDeviceSessionCookie('')],
  [undefined, undefined])
check('  a name that merely contains it does not match',
  deviceCookies.readDeviceSessionCookie('x__Host-navaratri_device_session=nope'), undefined)

console.log('\n=== 9-19. DEVICE TOKEN ===')
const verify = (value, secret = SECRET, at) =>
  deviceSession.verifyDeviceSessionToken(value, secret, at)

check('a valid token verifies and returns its claims',
  [verify(token) !== null, verify(token).deviceId, verify(token).eventId, verify(token).sv],
  [true, DEVICE_ID, EVENT_ID, 3])
check('  it is typed and versioned', [verify(token).t, verify(token).v], ['device', 1])
check('an expired token is rejected',
  verify(deviceSession.createDeviceSessionToken(SECRET, claims, 1_000), SECRET, 1_000 + 14 * 24 * 60 * 60), null)
check('  one second before expiry it still verifies',
  verify(deviceSession.createDeviceSessionToken(SECRET, claims, 1_000), SECRET, 1_000 + 14 * 24 * 60 * 60 - 1) !== null, true)
check('the wrong secret is rejected', verify(token, 'e'.repeat(48)), null)
check('a tampered payload is rejected', verify(`x${token}`), null)
check('  a tampered signature is rejected',
  verify(`${token.split('.')[0]}.${'A'.repeat(43)}`), null)
check('  a re-signed foreign payload is rejected',
  verify(`${token.split('.')[0]}.${token.split('.')[1].slice(0, -1)}A`), null)

for (const [label, value] of [
  ['undefined', undefined], ['empty', ''], ['not a token', 'nonsense'],
  ['one segment', token.split('.')[0]], ['three segments', `${token}.x`],
  ['non-base64url payload', `not base64!.${token.split('.')[1]}`],
]) check(`  rejected: ${label}`, verify(value), null)

console.log('  -- payload claims are validated --')
const { createHmac } = await import('node:crypto')
/**
 * Signed with the REAL secret and the REAL context, so only the payload claim
 * check can reject these — never the signature.
 */
const signed = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', SECRET)
    .update(`navaratri-device-session-v1:${encoded}`, 'utf8')
    .digest('base64url')
  return `${encoded}.${signature}`
}
const base = { v: 1, t: 'device', deviceId: DEVICE_ID, eventId: EVENT_ID, sv: 3, iat: 1000, exp: 9_999_999_999 }
check('a correctly signed payload verifies', verify(signed(base)) !== null, true)
check('  a wrong token type is rejected', verify(signed({ ...base, t: 'admin' })), null)
check('  a wrong version is rejected', verify(signed({ ...base, v: 2 })), null)
check('  a malformed deviceId is rejected', verify(signed({ ...base, deviceId: 'not-a-uuid' })), null)
check('  a malformed eventId is rejected', verify(signed({ ...base, eventId: '123' })), null)
check('  a missing deviceId is rejected', verify(signed({ ...base, deviceId: undefined })), null)
check('  a zero session version is rejected', verify(signed({ ...base, sv: 0 })), null)
check('  a negative session version is rejected', verify(signed({ ...base, sv: -1 })), null)
check('  a fractional session version is rejected', verify(signed({ ...base, sv: 1.5 })), null)
check('  a string session version is rejected', verify(signed({ ...base, sv: '3' })), null)
check('  exp before iat is rejected', verify(signed({ ...base, exp: 500 })), null)
check('  an array payload is rejected', verify(signed([1, 2, 3])), null)

console.log('  -- the token carries identifiers, never permissions --')
const decoded = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
check('the payload keys are exactly the intended ones',
  Object.keys(decoded).sort(), ['deviceId', 'eventId', 'exp', 'iat', 'sv', 't', 'v'])
check('  no password, hash, attribute, range or enabled claim',
  /password|hash|salt|scrypt|attribute|registration|prizes|range|badge|enabled|loginName|lastSeen/i
    .test(JSON.stringify(decoded)), false)
check('  and the source never puts them there',
  /attributes|badgeRange|enabled|passwordHash|loginName/
    .test(stripComments(read('server/device-auth/session.ts'))
      .slice(0, stripComments(read('server/device-auth/session.ts')).indexOf('verifyDeviceSessionToken'))), false)

console.log('\n=== 20-24. CROSS-REALM ISOLATION (one shared secret) ===')
const SHARED = 's'.repeat(48)
const sharedDevice = deviceSession.createDeviceSessionToken(SHARED, claims)
const sharedAdmin = adminSession.createAdminSessionToken(SHARED)
const sharedOperator = operatorSession.createOperatorSessionToken(SHARED)

check('a device token verifies in its OWN realm',
  deviceSession.verifyDeviceSessionToken(sharedDevice, SHARED) !== null, true)
check('  an Admin token does NOT',
  deviceSession.verifyDeviceSessionToken(sharedAdmin, SHARED), null)
check('  an operator token does NOT',
  deviceSession.verifyDeviceSessionToken(sharedOperator, SHARED), null)
check('a device token is rejected by the Admin verifier',
  adminSession.verifyAdminSessionToken(sharedDevice, SHARED), false)
check('  and by the operator verifier',
  operatorSession.verifyOperatorSessionToken(sharedDevice, SHARED), false)
check('separation is CRYPTOGRAPHIC, in the signed message',
  /navaratri-device-session-v1:/.test(read('server/device-auth/session.ts')), true)
check('  the device realm imports no other realm',
  walkSource(join(root, 'server/device-auth'))
    .filter((file) => /from\s+['"][^'"]*(admin-auth|\.\.\/auth)\//.test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  and the other realms were not touched',
  [/navaratri-admin-session-v1:/.test(read('server/admin-auth/session.ts')),
   /SIGNING_CONTEXT/.test(read('server/auth/operator-session.ts'))], [true, false])

console.log('\n=== LOGIN INPUT ===')
const login = (over) => deviceRequests.parseDeviceLoginInput({
  eventSlug: 'navaratri-2026', loginName: 'desk-a', password: 'desk-a-passphrase', ...over })

check('a well-formed login parses', login({}).value,
  { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: 'desk-a-passphrase' })
check('  no eventId is ever accepted from the caller',
  'eventId' in (login({ eventId: EVENT_ID }).value ?? {}), false)
for (const [label, over] of [
  ['missing slug', { eventSlug: undefined }], ['uppercase slug', { eventSlug: 'Navaratri' }],
  ['slug with spaces', { eventSlug: 'navaratri 2026' }], ['doubled hyphen', { eventSlug: 'a--b' }],
  ['trailing hyphen', { eventSlug: 'navaratri-' }], ['overlong slug', { eventSlug: 'a'.repeat(65) }],
  ['missing login', { loginName: undefined }], ['underscore login', { loginName: 'desk_a' }],
  ['uppercase login', { loginName: 'Desk-A' }], ['overlong login', { loginName: 'a'.repeat(65) }],
  ['non-string password', { password: 12345678 }], ['missing password', { password: undefined }],
  ['non-object body', undefined],
]) check(`  rejected: ${label}`,
  (over === undefined ? deviceRequests.parseDeviceLoginInput('nope') : login(over)).ok, false)
check('the password is NEVER trimmed',
  login({ password: '  spaced passphrase  ' }).value.password, '  spaced passphrase  ')
check('  and never case folded',
  login({ password: 'MiXeDCase' }).value.password, 'MiXeDCase')
check('  the policy is NOT enforced here (it must look like a wrong password)',
  login({ password: 'short' }).ok, true)

console.log('\n=== 25-39. LOGIN (real registry, fake database) ===')
const dbJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})
const authenticate = await dbJiti.import(`${root}/server/device-auth/authenticate.ts`)
const password = await dbJiti.import(`${root}/server/device-auth/password.ts`)
const fakeDb = await import('./fake-admin-db.mjs')

const PASSPHRASE = 'desk-a-passphrase'
const storedHash = await password.hashDevicePassword(PASSPHRASE)

const seed = async ({ event = {}, device = {}, attributes = ['registration', 'prizes'], range = true } = {}) => {
  fakeDb.reset()
  fakeDb.state.events.push({
    id: EVENT_ID, slug: 'navaratri-2026', name: 'Navaratri 2026',
    timezone: 'Asia/Kolkata', active: true, ...event,
  })
  fakeDb.state.devices.set(DEVICE_ID, {
    id: DEVICE_ID, eventId: EVENT_ID, name: 'Desk A', loginName: 'desk-a',
    passwordHash: storedHash, sessionVersion: 3, enabled: true, lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), ...device,
  })
  for (const attribute of attributes) fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute })
  if (range) {
    fakeDb.state.assignments.push({
      id: 'a1', eventId: EVENT_ID, deviceId: DEVICE_ID, rangeStart: 1, rangeEnd: 200,
      assignedAt: new Date('2026-01-02T00:00:00.000Z'), releasedAt: null,
    })
  }
  fakeDb.state.applied = []
}
const attempt = (over = {}) =>
  authenticate.authenticateDevice({ eventSlug: 'navaratri-2026', loginName: 'desk-a', password: PASSPHRASE, ...over })
const writes = () => fakeDb.state.applied.filter((entry) => !entry.startsWith('select'))

await seed()
const success = await attempt()
check('valid credentials authenticate', success.ok, true)
check('  the right device and event are returned',
  [success.deviceId, success.eventId, success.context.device.id, success.context.event.slug],
  [DEVICE_ID, EVENT_ID, DEVICE_ID, 'navaratri-2026'])
check('  the CURRENT attributes are returned',
  success.context.device.attributes, ['prizes', 'registration'])
check('  the CURRENT badge assignment is returned',
  success.context.activeBadgeRange, { rangeStart: 1, rangeEnd: 200, assignedAt: '2026-01-02T00:00:00.000Z' })
check('  the session version comes from the database', success.sessionVersion, 3)
check('  last_seen_at was written',
  [fakeDb.state.devices.get(DEVICE_ID).lastSeenAt !== null,
   success.context.device.lastSeenAt !== null], [true, true])
check('  and it is the only write', writes(), ['update devices'])

console.log('  -- the safe context --')
check('the context shape is exactly the DTO',
  [Object.keys(success.context).sort(), Object.keys(success.context.device).sort(),
   Object.keys(success.context.event).sort()],
  [['activeBadgeRange', 'device', 'event'],
   ['attributes', 'eventId', 'id', 'lastSeenAt', 'loginName', 'name'],
   ['id', 'name', 'slug', 'timezone']])
check('  no credential or version leaks through it',
  /password|passwordHash|password_hash|sessionVersion|session_version|salt|scrypt\$|enabled|createdAt|updatedAt/
    .test(JSON.stringify(success.context)), false)

console.log('  -- every credential failure is identical --')
const GENERIC = { ok: false, reason: 'invalid-credentials' }
for (const [label, over, seedOptions] of [
  ['a wrong password', { password: 'wrong-passphrase' }, undefined],
  ['an unknown login name', { loginName: 'desk-z' }, undefined],
  ['an unknown event', { eventSlug: 'no-such-event' }, undefined],
  ['a password below the policy', { password: 'short' }, undefined],
  ['a password above the policy', { password: 'a'.repeat(129) }, undefined],
  ['an unprovisioned device', {}, { device: { passwordHash: null } }],
  ['a device with no login name', { loginName: 'desk-a' }, { device: { loginName: null } }],
  ['a DISABLED device with a wrong password', { password: 'wrong-passphrase' }, { device: { enabled: false } }],
  ['an INACTIVE event with a wrong password', { password: 'wrong-passphrase' }, { event: { active: false } }],
]) {
  await seed(seedOptions)
  check(`  ${label}`, await attempt(over), GENERIC)
  check(`    wrote nothing`, writes(), [])
}

await seed()
check('a login name is only ever matched WITHIN its event',
  await authenticate.authenticateDevice({
    eventSlug: 'navaratri-2026', loginName: 'desk-a', password: PASSPHRASE,
  }).then((r) => r.ok), true)
check('  and the lookup is event-scoped in code',
  /eq\(devices\.eventId, eventId\), eq\(devices\.loginName, loginName\)/
    .test(read('server/device-auth/authenticate.ts')), true)
check('  never a bare login-name query',
  /where\(eq\(devices\.loginName/.test(stripComments(read('server/device-auth/authenticate.ts'))), false)

console.log('  -- typed blocks come only AFTER the password is proven --')
await seed({ device: { enabled: false } })
check('a disabled device with the CORRECT password is typed',
  await attempt(), { ok: false, blocked: 'device-disabled' })
check('  and still wrote nothing', writes(), [])
await seed({ event: { active: false } })
check('an inactive event with the CORRECT password is typed',
  await attempt(), { ok: false, blocked: 'event-inactive' })
check('the enabled check follows the password check in code',
  (() => {
    const source = stripComments(read('server/device-auth/authenticate.ts'))
    return source.indexOf('passwordMatches') < source.indexOf('!device.enabled')
  })(), true)
check('  and the event check follows it too',
  (() => {
    const source = stripComments(read('server/device-auth/authenticate.ts'))
    return source.indexOf('passwordMatches') < source.indexOf('!event.active')
  })(), true)

console.log('  -- unknown logins still do password work --')
const measure = async (run) => {
  await run()
  const started = Date.now()
  for (let i = 0; i < 4; i++) await run()
  return (Date.now() - started) / 4
}
await seed()
const wrongPassword = await measure(() => attempt({ password: 'wrong-passphrase' }))
const unknownLogin = await measure(() => attempt({ loginName: 'desk-z' }))
check('an unknown login costs comparable work to a wrong password',
  unknownLogin > wrongPassword * 0.5, true)
check('  because a fixed equalizer record is verified',
  /TIMING_EQUALIZER_HASH/.test(read('server/device-auth/authenticate.ts')), true)
check('  and it is a real parseable scrypt record',
  await password.verifyDevicePassword('anything',
    /scrypt\$v1\$[^']+/.exec(read('server/device-auth/authenticate.ts'))[0]), false)

console.log('\n=== 40-53. SESSION RE-AUTHORIZATION ===')
const context = (over = {}) =>
  authenticate.loadDeviceSessionContext({ deviceId: DEVICE_ID, eventId: EVENT_ID, sessionVersion: 3, ...over })

await seed()
check('a current session is authorized', (await context()) !== null, true)
check('  a session version BEHIND the database is not', (await context({ sessionVersion: 2 })) !== null, false)
check('  a session version AHEAD of it is not', (await context({ sessionVersion: 4 })) !== null, false)

await seed()
fakeDb.state.devices.get(DEVICE_ID).sessionVersion = 4
check('an Admin password reset revokes the old cookie', (await context()) !== null, false)
check('  with no logout and no session table',
  /device_sessions|sessionStore|revokedTokens/.test(read('server/device-auth/authenticate.ts')), false)

await seed({ device: { enabled: false } })
check('a device disabled after login is not authorized', (await context()) !== null, false)
await seed({ event: { active: false } })
check('an event deactivated after login is not authorized', (await context()) !== null, false)
await seed({ device: { passwordHash: null } })
check('credentials becoming null is not authorized', (await context()) !== null, false)
await seed()
fakeDb.state.devices.delete(DEVICE_ID)
check('a deleted device is not authorized', (await context()) !== null, false)
await seed()
check('a token naming the wrong event is not authorized',
  (await context({ eventId: DEVICE_ID })) !== null, false)
check('  nor an unknown device', (await context({ deviceId: EVENT_ID })) !== null, false)

console.log('  -- checking a session never writes --')
await seed()
await context()
check('last_seen_at is untouched by a session check',
  [writes(), fakeDb.state.devices.get(DEVICE_ID).lastSeenAt], [[], null])

console.log('  -- live central state, no new cookie --')
await seed()
check('the session starts with both attributes',
  (await context()).device.attributes, ['prizes', 'registration'])
fakeDb.state.attributes = fakeDb.state.attributes.filter((row) => row.attribute !== 'prizes')
check('  removing prizes needs NO new login',
  [(await context()) !== null, (await context()).device.attributes], [true, ['registration']])
fakeDb.state.attributes.push({ deviceId: DEVICE_ID, attribute: 'prizes' })
check('  re-adding it appears immediately',
  (await context()).device.attributes, ['prizes', 'registration'])

await seed({ range: false })
check('a session with no range reports none', (await context()).activeBadgeRange, null)
fakeDb.state.assignments.push({
  id: 'a2', eventId: EVENT_ID, deviceId: DEVICE_ID, rangeStart: 1, rangeEnd: 200,
  assignedAt: new Date('2026-03-01T00:00:00.000Z'), releasedAt: null,
})
check('  a range assigned AFTER login appears',
  (await context()).activeBadgeRange,
  { rangeStart: 1, rangeEnd: 200, assignedAt: '2026-03-01T00:00:00.000Z' })
check('  which the token could not have carried',
  /attributes|badge|range/i.test(JSON.stringify(decoded)), false)

console.log('\n=== ENDPOINTS ===')
const loginRoute = read('api/device-login.ts')
const sessionRoute = read('api/device-session.ts')
const logoutRoute = read('api/device-logout.ts')
/** The handler bodies, so alphabetised imports cannot fake an ordering. */
const loginBody = loginRoute.slice(loginRoute.indexOf('export async function POST'))
const logoutBody = logoutRoute.slice(logoutRoute.indexOf('export async function POST'))

check('all three endpoints exist',
  ['api/device-login.ts', 'api/device-session.ts', 'api/device-logout.ts']
    .map((file) => existsSync(join(root, file))), [true, true, true])
check('login checks same-origin FIRST',
  loginBody.indexOf('isSameOriginDeviceRequest') < loginBody.indexOf('readDeviceBody'), true)
check('  then the body, then configuration, then the input',
  [loginBody.indexOf('readDeviceBody') < loginBody.indexOf('readDeviceAuthEnvironment'),
   loginBody.indexOf('readDeviceAuthEnvironment') < loginBody.indexOf('isDatabaseConfigured'),
   loginBody.indexOf('isDatabaseConfigured') < loginBody.indexOf('parseDeviceLoginInput'),
   loginBody.indexOf('parseDeviceLoginInput') < loginBody.indexOf('authenticateDevice')],
  [true, true, true, true])
check('  one generic 401 body for every credential failure',
  [/Device login failed\./.test(loginRoute),
   (loginRoute.match(/GENERIC_FAILURE/g) ?? []).length], [true, 2])
check('  which names nothing specific',
  /unknown device|password incorrect|not configured'|no such login/i.test(loginRoute), false)
check('  a typed 403 only for disabled or inactive',
  [/device-disabled/.test(loginRoute), /event-inactive/.test(loginRoute),
   /blocked: result\.blocked/.test(loginRoute)], [true, true, true])
check('  the cookie is set only on success',
  [loginBody.indexOf('serializeDeviceSessionCookie') > loginBody.indexOf('ok: true, authenticated: true'),
   (loginBody.match(/serializeDeviceSessionCookie/g) ?? []).length], [true, 1])
check('  the body limit is 4 KiB',
  /MAX_DEVICE_BODY_BYTES = 4 \* 1024/.test(read('server/device-auth/http.ts')), true)
check('  and the submitted body is never logged',
  /console\.[a-z]+\([^)]*(body|password|input\.value)/.test(stripComments(loginRoute)), false)

check('session reads ONLY the device cookie',
  [/readDeviceSessionCookie/.test(sessionRoute),
   /readAdminSessionCookie|readOperatorSessionCookie/.test(sessionRoute)], [true, false])
check('  every invalidation returns the same body',
  (sessionRoute.match(/UNAUTHENTICATED/g) ?? []).length >= 4, true)
check('  which reveals no reason',
  /reason|revoked|disabled|expired|mismatch/.test(
    /const UNAUTHENTICATED = [^\n]*/.exec(sessionRoute)[0]), false)
check('  a supplied invalid cookie is cleared',
  (sessionRoute.match(/serializeClearedDeviceSessionCookie\(\)/g) ?? []).length, 2)
check('  a missing cookie is 200, not 401',
  /token === undefined\) \{\s*return deviceJson\(UNAUTHENTICATED, 200\)/.test(sessionRoute), true)
check('  missing configuration is a safe 503',
  /\{ authenticated: false, configured: false \}, 503/.test(sessionRoute), true)
check('  and it never updates last_seen_at',
  /lastSeenAt|last_seen_at/.test(stripComments(sessionRoute)), false)

check('logout requires same-origin',
  [/isSameOriginDeviceRequest/.test(logoutBody),
   logoutBody.indexOf('isSameOriginDeviceRequest') < logoutBody.indexOf('serializeCleared')], [true, true])
check('  clears only the device cookie',
  [/serializeClearedDeviceSessionCookie/.test(logoutRoute),
   /admin|operator/i.test(stripComments(logoutRoute))], [true, false])
check('  writes nothing',
  /getDatabase|update\(|insert\(|delete\(|indexedDB|localStorage/.test(logoutRoute), false)
check('  and needs no database', /isDatabaseConfigured/.test(logoutRoute), false)

console.log('\n=== RESPONSE HYGIENE ===')
for (const [file, source] of [['device-login', loginRoute], ['device-session', sessionRoute],
  ['device-logout', logoutRoute]])
  check(`${file} names no credential`,
    /passwordHash|password_hash|salt|derivedKey|scrypt\$/.test(stripComments(source)), false)
// `sessionVersion` legitimately travels INTO the signer; it must never travel
// out in a response, which the real-response checks below prove.
check('  the session version only ever goes into the token',
  [...stripComments(loginRoute + sessionRoute).matchAll(/sessionVersion[:,]?/g)].length, 3)
check('  no endpoint spreads a raw device row',
  /\.\.\.device[,}\s]|\.\.\.row/.test(stripComments(loginRoute + sessionRoute)), false)
check('  the context is built by an explicit projection',
  /const toContext/.test(read('server/device-auth/authenticate.ts')), true)
check('password.ts still holds no HTTP or database concern',
  /Request|Response|getDatabase|drizzle|cookie/i.test(stripComments(read('server/device-auth/password.ts'))), false)

console.log('\n=== REAL HTTP RESPONSES ===')
/**
 * The actual handlers, with only their database replaced. Their real Response
 * bodies and Set-Cookie headers are inspected, so response hygiene is
 * observed rather than inferred from the source.
 */
const routeJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../server/db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})
process.env.EVENT_DEVICE_SESSION_SECRET = SECRET
const loginHandler = await routeJiti.import(`${root}/api/device-login.ts`)
const sessionHandler = await routeJiti.import(`${root}/api/device-session.ts`)
const logoutHandler = await routeJiti.import(`${root}/api/device-logout.ts`)

const ORIGIN = 'https://desk.example.test'
const post = (path, body, headers = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const get = (path, cookie) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } })
const settle = async (response) => ({
  status: response.status,
  body: await response.json(),
  cookie: response.headers.get('set-cookie'),
  cacheControl: response.headers.get('cache-control'),
})

await seed()
const loggedIn = await settle(await loginHandler.POST(
  post('/api/device-login', { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: PASSPHRASE })))
check('a real login returns 200 and authenticates',
  [loggedIn.status, loggedIn.body.ok, loggedIn.body.authenticated], [200, true, true])
check('  it sets the device cookie with every attribute',
  [loggedIn.cookie.startsWith('__Host-navaratri_device_session='),
   ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=1209600']
     .every((attribute) => loggedIn.cookie.includes(attribute)),
   /Domain=/i.test(loggedIn.cookie)], [true, true, false])
check('  and is never cached', loggedIn.cacheControl, 'no-store')
check('  the body carries the safe context only',
  Object.keys(loggedIn.body).sort(), ['activeBadgeRange', 'authenticated', 'device', 'event', 'ok'])
check('  with no secret of any kind',
  /password|hash|salt|scrypt|sessionVersion|session_version|enabled/i.test(JSON.stringify(loggedIn.body)), false)

const deviceCookieHeader = `__Host-navaratri_device_session=${loggedIn.cookie.split(';')[0].split('=')[1]}`

const failed = await settle(await loginHandler.POST(
  post('/api/device-login', { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: 'wrong-passphrase' })))
check('a wrong password is a generic 401',
  [failed.status, failed.body], [401, { ok: false, authenticated: false, message: 'Device login failed.' }])
check('  and sets NO cookie', failed.cookie, null)
for (const [label, body] of [
  ['an unknown login', { eventSlug: 'navaratri-2026', loginName: 'desk-z', password: PASSPHRASE }],
  ['an unknown event', { eventSlug: 'no-such-event', loginName: 'desk-a', password: PASSPHRASE }],
]) {
  const other = await settle(await loginHandler.POST(post('/api/device-login', body)))
  check(`  ${label} is byte-identical`,
    [other.status, JSON.stringify(other.body) === JSON.stringify(failed.body), other.cookie],
    [401, true, null])
}

await seed({ device: { enabled: false } })
const blocked = await settle(await loginHandler.POST(
  post('/api/device-login', { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: PASSPHRASE })))
check('a disabled device with the right password is a typed 403',
  [blocked.status, blocked.body.blocked, blocked.cookie],
  [403, 'device-disabled', null])
await seed({ event: { active: false } })
const inactive = await settle(await loginHandler.POST(
  post('/api/device-login', { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: PASSPHRASE })))
check('  an inactive event too', [inactive.status, inactive.body.blocked], [403, 'event-inactive'])

const crossSite = await settle(await loginHandler.POST(
  new Request(`${ORIGIN}/api/device-login`, {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    body: '{}',
  })))
check('a cross-site login is refused before anything else', [crossSite.status, crossSite.cookie], [403, null])
const wrongType = await settle(await loginHandler.POST(
  post('/api/device-login', {}, { 'content-type': 'text/plain' })))
check('  a wrong content type is 415', wrongType.status, 415)
const oversized = await settle(await loginHandler.POST(
  post('/api/device-login', { eventSlug: 'x'.repeat(5000) })))
check('  an oversized body is 413', oversized.status, 413)

console.log('  -- the session endpoint --')
await seed()
const live = await settle(await sessionHandler.GET(get('/api/device-session', deviceCookieHeader)))
check('a valid cookie is authenticated',
  [live.status, live.body.authenticated, live.body.configured], [200, true, true])
check('  it returns the CURRENT attributes and range',
  [live.body.device.attributes, live.body.activeBadgeRange.rangeEnd], [['prizes', 'registration'], 200])
check('  and no secret', /password|hash|salt|scrypt|sessionVersion/i.test(JSON.stringify(live.body)), false)
check('  no cookie is re-issued', live.cookie, null)

const anonymous = await settle(await sessionHandler.GET(get('/api/device-session')))
check('no cookie is 200 unauthenticated, not 401',
  [anonymous.status, anonymous.body], [200, { authenticated: false, configured: true }])
check('  and nothing is cleared', anonymous.cookie, null)

const foreign = await settle(await sessionHandler.GET(
  get('/api/device-session', '__Host-navaratri_admin_session=x; __Host-navaratri_operator_session=y')))
check('an Admin or operator cookie authenticates nothing here',
  [foreign.status, foreign.body.authenticated], [200, false])

fakeDb.state.devices.get(DEVICE_ID).sessionVersion = 4
const revoked = await settle(await sessionHandler.GET(get('/api/device-session', deviceCookieHeader)))
check('a password reset revokes the live cookie',
  [revoked.status, revoked.body], [200, { authenticated: false, configured: true }])
check('  and the stale cookie is cleared',
  [revoked.cookie.includes('__Host-navaratri_device_session='), revoked.cookie.includes('Max-Age=0')],
  [true, true])
check('  revealing no reason', JSON.stringify(revoked.body), '{"authenticated":false,"configured":true}')

const tampered = await settle(await sessionHandler.GET(
  get('/api/device-session', '__Host-navaratri_device_session=garbage')))
check('a garbage cookie looks exactly the same',
  [tampered.status, JSON.stringify(tampered.body)], [200, '{"authenticated":false,"configured":true}'])

console.log('  -- logout --')
const loggedOut = await settle(await logoutHandler.POST(post('/api/device-logout', {})))
check('logout succeeds and clears the device cookie',
  [loggedOut.status, loggedOut.body.ok,
   loggedOut.cookie.includes('__Host-navaratri_device_session='),
   loggedOut.cookie.includes('Max-Age=0')], [200, true, true, true])
check('  it touches no other cookie',
  /admin_session|operator_session/.test(loggedOut.cookie), false)
check('  it sets exactly one cookie', loggedOut.cookie.split('__Host-').length - 1, 1)
await seed()
await logoutHandler.POST(post('/api/device-logout', {}))
check('  and writes nothing', writes(), [])
const crossSiteLogout = await settle(await logoutHandler.POST(
  new Request(`${ORIGIN}/api/device-logout`, {
    method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}',
  })))
check('  a cross-site logout is refused', [crossSiteLogout.status, crossSiteLogout.cookie], [403, null])

console.log('  -- unconfigured device auth --')
delete process.env.EVENT_DEVICE_SESSION_SECRET
const unconfigured = await settle(await sessionHandler.GET(get('/api/device-session', deviceCookieHeader)))
check('a missing secret is a safe 503',
  [unconfigured.status, unconfigured.body], [503, { authenticated: false, configured: false }])
const unconfiguredLogin = await settle(await loginHandler.POST(
  post('/api/device-login', { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: PASSPHRASE })))
check('  and login refuses without authenticating',
  [unconfiguredLogin.status, unconfiguredLogin.body.configured, unconfiguredLogin.cookie],
  [503, false, null])
process.env.EVENT_DEVICE_SESSION_SECRET = SECRET

console.log('\n=== SAME ORIGIN ===')
const request = (origin, url = 'https://example.test/api/device-login') =>
  new Request(url, { headers: origin === null ? {} : { origin }, method: 'POST' })
check('a matching origin is allowed',
  deviceOrigin.isSameOriginDeviceRequest(request('https://example.test')), true)
check('  a different origin is refused',
  deviceOrigin.isSameOriginDeviceRequest(request('https://evil.test')), false)
check('  a missing origin is refused',
  deviceOrigin.isSameOriginDeviceRequest(request(null)), false)
check('  a blank origin is refused',
  deviceOrigin.isSameOriginDeviceRequest(request('')), false)
check('  a malformed origin is refused',
  deviceOrigin.isSameOriginDeviceRequest(request('not-a-url')), false)
check('  a subdomain is refused',
  deviceOrigin.isSameOriginDeviceRequest(request('https://sub.example.test')), false)

console.log('\n=== 27-28. THE EVENT APP IS UNCHANGED ===')
const clientFiles = walkSource(join(root, 'src'))
  .map((file) => ({ file: file.replace(`${root}/`, ''), code: stripComments(readFileSync(file, 'utf8')) }))
/**
 * Phase 9C-C1 gave the realm a UI. The endpoints belong to the device auth
 * client and its own components; no event page, operator gate or sync module
 * may reach them.
 */
check('only the device realm calls a device auth endpoint',
  clientFiles
    .filter((entry) => !/^src\/(device-auth|components\/device-auth|pages\/device-login-page)/
      .test(entry.file))
    .filter((entry) => /\/api\/device-(login|session|logout)/.test(entry.code))
    .map((entry) => entry.file), [])
check('  nor names the device cookie',
  clientFiles.filter((entry) => /navaratri_device_session/.test(entry.code)).map((entry) => entry.file), [])
check('  nor reads the device secret',
  clientFiles.filter((entry) => /EVENT_DEVICE_SESSION_SECRET/.test(entry.code)).map((entry) => entry.file), [])
check('  and no device route GATE exists',
  ['src/components/device-auth/device-access-gate.tsx',
   'src/components/device/device-access-gate.tsx',
   'src/components/device-session-gate.tsx']
    .filter((file) => existsSync(join(root, file))), [])
check('the event shell still uses OperatorAccessGate',
  /OperatorAccessGate/.test(read('src/components/event-app-gate.tsx')), true)
check('  and no device gate was added',
  /Device(Access|Session|Auth)Gate/.test(
    stripComments(read('src/components/event-app-gate.tsx')) +
    stripComments(read('src/components/app-router.tsx'))), false)
check('  the event shell itself names no device auth',
  /[Dd]evice/.test(stripComments(read('src/components/event-app-gate.tsx'))), false)
check('the routes are unchanged',
  ['/', '/badge-registration', '/device-registration', '/admin']
    .every((route) => read('src/app/routes.ts').includes(`'${route}'`)), true)
check('  /device-registration still exists',
  existsSync(join(root, 'src/pages/device-registration-page.tsx')), true)
check('Operator Access still signs the BARE payload (no context)',
  [/createHmac\('sha256', secret\)\.update\(encodedPayload, 'utf8'\)\.digest\(\)/
    .test(read('server/auth/operator-session.ts')),
   /SIGNING_CONTEXT|navaratri-\w+-session-v1/.test(read('server/auth/operator-session.ts'))],
  [true, false])
check('Admin auth is unchanged',
  [/navaratri-admin-session-v1:/.test(read('server/admin-auth/session.ts')),
   /MIN_ADMIN_ACCESS_CODE_LENGTH = 8/.test(read('server/admin-auth/environment.ts'))], [true, true])
check('no Admin endpoint accepts a device cookie',
  readdirSync(join(root, 'api')).filter((file) => file.startsWith('admin-'))
    .filter((file) => /device-auth|DEVICE_SESSION_COOKIE/.test(read(`api/${file}`))), [])
check('  and sync-registration still uses the operator realm',
  [/operator/i.test(read('api/sync-registration.ts')),
   /device-auth/.test(read('api/sync-registration.ts'))], [true, false])

console.log('\n=== 42. NO SCHEMA CHANGE ===')
check('NO new migration',
  readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('  the schema file is untouched by this phase',
  /device_sessions|refresh_token|access_token|CREATE TABLE/i.test(stripComments(read('server/db/schema.ts'))), false)
check('  the device realm adds no table',
  /pgTable|CREATE TABLE/.test(walkSource(join(root, 'server/device-auth'))
    .map((file) => readFileSync(file, 'utf8')).join('\n')), false)

const dexie = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION = 1/.test(dexie), true)
check('  exactly three stores',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and no device session reached it',
  /session|device_session|token|password/i.test(stripComments(dexie)), false)
check('nothing writes central device state into IndexedDB',
  clientFiles.filter((entry) => /loadDeviceSessionContext|authenticateDevice/.test(entry.code)), [])
const sheet = read('server/sync/sheet-contract.ts')
check('Google Sheet ranges unchanged', [/A1:N/.test(sheet), /A1:M/.test(sheet)], [true, true])
check('badge allocation stays local',
  [/nextBadge/.test(read('src/db/registrations.ts')),
   /device-auth|server\/db/.test(read('src/db/registrations.ts'))], [true, false])

console.log('\n=== DOCS + SUITE ===')
const deviceDoc = read('docs/DEVICE_AUTH.md')
for (const needle of ['eventSlug', 'loginName', '__Host-navaratri_device_session', '14 days',
  'session_version', 'no heartbeat', 'Operator Access'])
  check(`DEVICE_AUTH.md documents ${needle}`, deviceDoc.includes(needle), true)
check('  it states device login is not wired into the event app',
  /9C-C|not yet|does not/.test(deviceDoc), true)
check('the firewall doc covers device login',
  [/\/api\/device-login/.test(read('docs/VERCEL_FIREWALL.md')),
   /30/.test(read('docs/VERCEL_FIREWALL.md'))], [true, true])
check('AGENTS.md records the third realm',
  /third independent security realm|Device auth is a third/i.test(read('AGENTS.md')), true)
check('.env.example documents the secret',
  read('.env.example').includes('EVENT_DEVICE_SESSION_SECRET='), true)
// The needle is assembled, so this suite is not itself a VITE_ reference.
check('  and never with a VITE_ prefix',
  read('.env.example').includes(`VITE_${'EVENT_DEVICE_SESSION_SECRET'}`), false)

const manifest = JSON.parse(read('package.json'))
check('verify:9cb is registered',
  manifest.scripts['verify:9cb'], 'node scripts/verification/phase-9cb.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9cb'), true)
check('release:check covers the device realm',
  /device-realm/.test(read('scripts/release-check.mjs')), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /jwt|jose|passport|session|cookie-parser|iron/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
