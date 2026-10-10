/**
 * Phase 9C-C1 verification — Device Login UI and central device enrollment.
 *
 * Run with:  pnpm verify:9cc1
 *
 * It NEVER connects to Neon. The router is rendered for real, the enrollment
 * helpers run against the stand-in Dexie, and the API client is driven with a
 * stubbed `fetch` so the response contract is exercised end to end.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { clearDeviceGrant, renderRoute, setAdminAccess } from './route-render.mjs'

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
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

console.log('=== 1-10. ROUTING ===')
setAdminAccess('locked')
clearDeviceGrant()

const deviceLogin = renderRoute('/device-login')
check('/device-login resolves to the Device Sign-In page',
  [deviceLogin.error ?? null, /Device Sign-In/.test(deviceLogin.html)], [null, true])
/**
 * It never sits behind an event gate. Phase D2 made it the ONLY way in, so
 * gating it on event access would lock the door from the inside.
 */
check('  it is NOT behind the event access gate',
  [/Device access required|Device setup required/.test(deviceLogin.html),
   /__REGISTRATION_FORM__/.test(deviceLogin.html)], [false, false])
check('  nor behind Admin Access',
  [/Admin is a separate sign-in/.test(deviceLogin.html),
   /id="admin-access-code"/.test(deviceLogin.html)], [false, false])
check('  and no operator credential survives anywhere on it',
  /id="operator-access-code"|Unlock this event device/.test(deviceLogin.html), false)

for (const route of ['/', '/badge-registration'])
  check(`${route} demands device access`,
    /Device access required/.test(renderRoute(route).html), true)
check('/device-registration is retired and renders nothing',
  renderRoute('/device-registration').html, '')
check('/admin remains its own realm',
  /Admin Access/.test(renderRoute('/admin').html), true)
check('an unknown path is still Not Found',
  /Page not found/.test(renderRoute('/nope').html), true)

const routerSource = stripComments(read('src/components/app-router.tsx'))
const routerBody = routerSource.slice(routerSource.indexOf('<Switch>'))
check('the route is declared outside EventAppGate',
  routerBody.indexOf('ROUTES.deviceLogin') < routerBody.indexOf('<EventAppGate>'), true)
check('  and is not nested inside it',
  /<EventAppGate>[\s\S]*deviceLogin/.test(routerBody), false)
check('  and no device gate wraps the event routes',
  /Device(Access|Session|Login)Gate/.test(
    routerSource + stripComments(read('src/components/event-app-gate.tsx'))), false)
/**
 * Phase D2 removed Operator Access and retired `/device-registration`, so
 * what C1 asserted about route policy is restated against the policy that
 * replaced it: one device gate per event module, and the retired path
 * dropped out of the event pattern entirely.
 */
check('the event routes are gated by the device, with no operator gate left',
  [/OperatorAccessGate/.test(read('src/components/app-router.tsx')),
   /<EventAccessGate module="/.test(read('src/components/app-router.tsx'))], [false, true])
check('  and /device-registration accepts no grant at all',
  /ROUTES\.deviceRegistration[\s\S]{0,200}EventAccessGate/
    .test(stripComments(read('src/components/app-router.tsx'))), false)
check('  and the event route pattern no longer contains it',
  /\^\\\/\(\?:badge-registration\)\?\$/.test(read('src/app/routes.ts')), true)

const vercel = JSON.parse(read('vercel.json'))
const sources = vercel.rewrites.map((rule) => rule.source)
check('vercel.json rewrites /device-login to the SPA',
  vercel.rewrites.find((rule) => rule.source === '/device-login')?.destination, '/index.html')
check('  the existing rewrites are kept',
  sources.sort(), ['/admin', '/badge-registration', '/device-login', '/device-registration'])
check('  no rewrite is a wildcard that could swallow /api',
  sources.filter((source) => /[*:()]/.test(source)), [])
check('  and none targets /api', sources.filter((source) => source.startsWith('/api')), [])
check('the device API is ONE Function, not a rewrite',
  existsSync(join(root, 'api/device-auth.ts')), true)
check('  the three old Functions are gone, not left as wrappers',
  ['device-login.ts', 'device-session.ts', 'device-logout.ts']
    .filter((file) => existsSync(join(root, 'api', file))), [])
check('  and no rewrite aliases the old paths',
  vercel.rewrites.filter((rule) =>
    /device-(login|session|logout)|admin-(login|session|logout)/.test(rule.source) &&
    rule.source.startsWith('/api')), [])

const serviceWorker = read('dist/sw.js')
check('the service worker still denylists /api',
  /\\\/api\\\//.test(serviceWorker), true)
check('  and there is still exactly one navigation fallback',
  (serviceWorker.match(/createHandlerBoundToURL/g) ?? []).length, 1)
check('  with no new caching strategy',
  /registerRoute\(new RegExp/.test(serviceWorker), false)

console.log('  -- navigation is a LINK, not a button pretending to be one --')
/**
 * Base UI's Button assumes it renders a native `<button>`. Handing it an
 * `<a>` through `render` warns in development; silencing that with
 * `nativeButton={false}` instead stamps `role="button"` onto the anchor, so a
 * screen reader announces a navigation as a button. A link that looks like a
 * button is therefore a real `<a>` carrying `buttonVariants`.
 */
const loginAnchor = /<a\b[^>]*href="\/"[^>]*>/.exec(deviceLogin.html)?.[0] ?? ''
check('Continue to Event Operations is a real anchor',
  [loginAnchor !== '', /Continue to Event Operations/.test(deviceLogin.html)], [true, true])
check('  pointing at Home', /href="\/"/.test(loginAnchor), true)
check('  with NO role override', /role=/.test(loginAnchor), false)
check('  no type attribute on the anchor', /type=/.test(loginAnchor), false)
check('  and no tabindex override, so native focus order stands',
  /tabindex=/i.test(loginAnchor), false)
check('  it still carries the button styling',
  ['inline-flex', 'rounded-4xl', 'h-9', 'focus-visible:ring-ring/50', 'hover:bg-muted']
    .every((token) => loginAnchor.includes(token)), true)

/**
 * The warning is a development-only `console.error` from Base UI, so it can
 * only be prevented structurally: no application component may route a router
 * Link through the Button component.
 */
check('no component renders a Link through Base UI Button',
  walkSource(join(root, 'src'))
    .filter((file) => /render=\{<Link\b/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  nor silences the warning with nativeButton',
  walkSource(join(root, 'src'))
    .filter((file) => /nativeButton/.test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  and no navigation is faked with an onClick location hack',
  walkSource(join(root, 'src'))
    .filter((file) => /onClick[\s\S]{0,120}(window\.location|location\.href|navigate\()/
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
check('button-styled links use the exported variants helper',
  /buttonVariants/.test(read('src/pages/device-login-page.tsx')), true)

console.log('  -- no scratch artifact ships --')
check('scripts/verification holds only durable runners',
  readdirSync(join(root, 'scripts/verification'))
    .filter((file) => /^__|\.bak$|\.tmp$|\.orig$|\.rej$/.test(file)), [])
check('  and the repository has none either',
  ['tsconfig.__probe.json', 'scripts/verification/__r.mjs']
    .filter((file) => existsSync(join(root, file))), [])

console.log('\n=== 11-23. THE LOGIN FORM ===')
const formSource = read('src/components/device-auth/device-login-form.tsx')
const apiSource = read('src/device-auth/device-api.ts')

check('the event slug is supplied by the application',
  [/CURRENT_EVENT_SLUG/.test(apiSource), /eventSlug: CURRENT_EVENT_SLUG/.test(apiSource)], [true, true])
check('  from ONE shared constant',
  read('src/shared/event.ts').includes("CURRENT_EVENT_SLUG = 'navaratri-2026'"), true)
check('  which is not duplicated anywhere else',
  walkSource(join(root, 'src'))
    .filter((file) => !file.endsWith('shared/event.ts'))
    .filter((file) => /'navaratri-2026'/.test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${root}/`, '')), [])
check('  and is never an environment variable',
  /import\.meta\.env[^\n]*EVENT_SLUG/.test(apiSource), false)
check('the form asks for a login name and a password ONLY',
  [/device-login-name/.test(formSource), /device-login-password/.test(formSource),
   /Event ID|Event Slug|eventSlug|Device UUID|deviceId/i.test(stripComments(formSource))],
  [true, true, false])
check('  the password field is masked by default and toggleable',
  [/PasswordField/.test(formSource),
   /type=\{isVisible \? 'text' : 'password'\}/.test(read('src/components/admin/password-field.tsx'))],
  [true, true])
check('  the toggle is an accessible button, never a submit',
  [/type="button"/.test(read('src/components/admin/password-field.tsx')),
   /aria-label=\{isVisible \? `Hide/.test(read('src/components/admin/password-field.tsx')),
   /aria-pressed=\{isVisible\}/.test(read('src/components/admin/password-field.tsx'))], [true, true, true])
check('  the LOGIN NAME is trimmed, the password is NOT',
  [/loginName\.trim\(\)/.test(formSource), /password\.trim\(\)/.test(formSource)], [true, false])
check('  submit is disabled while the request is in flight',
  [/disabled=\{isSubmitting\}/.test(formSource), /isSubmitting \? 'Signing in…'/.test(formSource)], [true, true])
check('  autocomplete is set for a password manager',
  [/autoComplete="username"/.test(formSource), /autoComplete="current-password"/.test(formSource)], [true, true])
check('  errors are announced, not signalled by colour alone',
  [/role="status"/.test(formSource), /aria-live="polite"/.test(formSource),
   /CircleAlert/.test(formSource)], [true, true, true])

console.log('  -- failure messages are safe --')
const jiti = createJiti(import.meta.url, { alias: { '@': `${root}/src` }, interopDefault: true })
const messages = (await jiti.import(`${root}/src/device-auth/device-api.ts`)).DEVICE_MESSAGES
check('a 401 message enumerates nothing',
  [messages.failed, /unknown|not found|no such|exist|configured/i.test(messages.failed)],
  ['Device login failed. Check the login name and password.', false])
check('  disabled is safe', messages.disabled, 'This device is disabled. Ask an administrator to enable it.')
check('  event-inactive is safe', messages.eventInactive, 'This event is not active.')
check('  429 is safe',
  [messages.tooManyAttempts, /ip|address|attempt \d|remaining/i.test(messages.tooManyAttempts)],
  ['Too many login attempts. Wait a moment and try again.', false])
check('  503 is safe', messages.notConfigured, 'Device authentication is not configured right now.')
check('  a network failure is safe',
  messages.unreachable, 'Unable to reach the server. Check the connection and try again.')
check('no server response text is ever rendered',
  /response\.text\(\)|body\.message/.test(stripComments(apiSource)), false)

console.log('\n=== THE API CLIENT ===')
const api = await jiti.import(`${root}/src/device-auth/device-api.ts`)
const calls = []
const stubFetch = (status, body, throws = false) => {
  globalThis.fetch = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body, init })
    if (throws) return Promise.reject(new Error('offline'))
    return Promise.resolve(new Response(body === null ? '' : JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }))
  }
}
const DEVICE_A = 'dddddddd-1111-4111-8111-dddddddddddd'
const DEVICE_B = 'dddddddd-2222-4222-8222-dddddddddddd'
const EVENT_UUID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const safeContext = (deviceId = DEVICE_A, over = {}) => ({
  device: {
    id: deviceId, eventId: EVENT_UUID, name: 'Registration Desk A', loginName: 'desk-a',
    attributes: ['registration', 'prizes'], lastSeenAt: '2026-09-20T10:00:00.000Z', ...over,
  },
  event: { id: EVENT_UUID, slug: 'navaratri-2026', name: 'Navaratri 2026', timezone: 'Asia/Kolkata' },
  activeBadgeRange: { rangeStart: 1, rangeEnd: 200, assignedAt: '2026-09-02T00:00:00.000Z' },
})

calls.length = 0
stubFetch(200, { ok: true, authenticated: true, ...safeContext() })
const loggedIn = await api.loginDevice({ loginName: 'desk-a', password: '  spaced pass  ' })
check('login POSTs to the consolidated endpoint',
  [calls[0].url, calls[0].method], ['/api/device-auth', 'POST'])
check('  with the slug supplied and the password EXACT',
  JSON.parse(calls[0].body),
  { eventSlug: 'navaratri-2026', loginName: 'desk-a', password: '  spaced pass  ' })
check('  same-origin credentials and no caching',
  [calls[0].init.credentials, calls[0].init.cache], ['same-origin', 'no-store'])
check('  and it returns the validated context', [loggedIn.ok, loggedIn.context.device.id], [true, DEVICE_A])

for (const [label, status, body, expected] of [
  ['401', 401, { ok: false }, messages.failed],
  ['403 disabled', 403, { blocked: 'device-disabled' }, messages.disabled],
  ['403 inactive', 403, { blocked: 'event-inactive' }, messages.eventInactive],
  ['429', 429, {}, messages.tooManyAttempts],
  ['503', 503, {}, messages.notConfigured],
  ['500', 500, {}, messages.unexpected],
]) {
  stubFetch(status, body)
  const result = await api.loginDevice({ loginName: 'desk-a', password: 'passphrase' })
  check(`  ${label} maps to a safe message`, [result.ok, result.message], [false, expected])
}
globalThis.fetch = () => Promise.reject(new Error('offline'))
check('  a network failure maps to unreachable',
  (await api.loginDevice({ loginName: 'desk-a', password: 'passphrase' })).message, messages.unreachable)

console.log('  -- the session endpoint --')
stubFetch(200, { authenticated: true, configured: true, ...safeContext() })
check('an authenticated session parses',
  (await api.getDeviceSession()).status, 'authenticated')
stubFetch(200, { authenticated: false, configured: true })
check('  an unauthenticated one does not', (await api.getDeviceSession()).status, 'unauthenticated')
stubFetch(503, { authenticated: false, configured: false })
check('  a 503 is not-configured', (await api.getDeviceSession()).status, 'not-configured')
stubFetch(200, { authenticated: true, configured: false })
check('  configured:false wins over authenticated', (await api.getDeviceSession()).status, 'not-configured')
stubFetch(200, null, true)
check('  offline is UNREACHABLE, never unauthenticated',
  (await api.getDeviceSession()).status, 'unreachable')
calls.length = 0
stubFetch(200, { ok: true })
await api.logoutDevice()
check('logout DELETEs the consolidated endpoint',
  [calls[0].url, calls[0].method], ['/api/device-auth', 'DELETE'])
stubFetch(500, {})
check('  a failed logout reports honestly', (await api.logoutDevice()).ok, false)
globalThis.fetch = () => Promise.reject(new Error('offline'))
check('  and so does an unreachable one', (await api.logoutDevice()).ok, false)

console.log('\n=== 10. RUNTIME RESPONSE VALIDATION ===')
const contract = await jiti.import(`${root}/src/device-auth/device-session-contract.ts`)
const parse = (over) => contract.parseDeviceSessionContext({ ...safeContext(), ...over })

check('a valid context parses', parse({}) !== null, true)
check('  and is projected, not spread',
  Object.keys(parse({ authenticated: true, configured: true, futureField: 'x' })).sort(),
  ['activeBadgeRange', 'device', 'event'])
check('  an UNKNOWN attribute fails the whole response closed',
  parse({ device: { ...safeContext().device, attributes: ['registration', 'dandiya'] } }), null)
check('  free text too',
  parse({ device: { ...safeContext().device, attributes: ['anything'] } }), null)
check('  a non-array attributes field',
  parse({ device: { ...safeContext().device, attributes: 'registration' } }), null)
check('  an empty attribute set is valid',
  parse({ device: { ...safeContext().device, attributes: [] } })?.device.attributes, [])
for (const [label, over] of [
  ['a malformed device id', { device: { ...safeContext().device, id: 'not-a-uuid' } }],
  ['a malformed event id', { event: { ...safeContext().event, id: '123' } }],
  ['a blank device name', { device: { ...safeContext().device, name: '   ' } }],
  ['a blank login name', { device: { ...safeContext().device, loginName: '' } }],
  ['a blank event slug', { event: { ...safeContext().event, slug: '' } }],
  ['a blank timezone', { event: { ...safeContext().event, timezone: '' } }],
  ['a device belonging to another event', { device: { ...safeContext().device, eventId: DEVICE_B } }],
  ['a zero range start', { activeBadgeRange: { rangeStart: 0, rangeEnd: 5, assignedAt: 'x' } }],
  ['a reversed range', { activeBadgeRange: { rangeStart: 9, rangeEnd: 2, assignedAt: 'x' } }],
  ['a fractional range', { activeBadgeRange: { rangeStart: 1.5, rangeEnd: 5, assignedAt: 'x' } }],
  ['a range with no timestamp', { activeBadgeRange: { rangeStart: 1, rangeEnd: 5 } }],
  ['a missing device', { device: undefined }],
  ['a missing event', { event: undefined }],
]) check(`  rejected: ${label}`, parse(over), null)
check('  a null badge range is valid', parse({ activeBadgeRange: null })?.activeBadgeRange, null)
check('  an absent badge range is valid', parse({ activeBadgeRange: undefined })?.activeBadgeRange, null)
check('no validation library was added',
  Object.keys({ ...JSON.parse(read('package.json')).dependencies })
    .filter((name) => /zod|yup|joi|valibot|ajv|superstruct/i.test(name)), [])

console.log('\n=== 24-45. ENROLLMENT STORAGE + LOCAL PRESERVATION ===')
const dbJiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` }, interopDefault: true,
})
const enrollment = await dbJiti.import(`${root}/src/db/central-enrollment.ts`)
const fakeDb = await import('./fake-db.mjs')

/** The real Phase 7 shape, exactly as src/db/types.ts declares it. */
const LOCAL_CONFIG = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, badgeEnd: 250, nextBadge: 47,
  deviceId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', deviceName: 'Local Desk A',
  deviceConfiguredAt: '2026-09-01T00:00:00.000Z',
  badgeConfiguredAt: '2026-09-01T01:00:00.000Z',
  upiId: 'organizer@upi', payeeName: 'Organizer', updatedAt: '2026-09-01T02:00:00.000Z',
}
const LOCAL_FIELDS = ['deviceId', 'deviceName', 'deviceConfiguredAt', 'badgeStart',
  'badgeEnd', 'nextBadge', 'badgeConfiguredAt', 'eventName', 'currency', 'amount',
  'timezone', 'upiId', 'payeeName']
const localSnapshot = (config) =>
  Object.fromEntries(LOCAL_FIELDS.map((field) => [field, config[field]]))
const BASELINE = localSnapshot(LOCAL_CONFIG)

const reset = () => {
  fakeDb.state.config = { ...LOCAL_CONFIG }
  fakeDb.state.registrations = new Map()
  fakeDb.state.outbox = new Map()
}

reset()
const saved = await enrollment.saveCentralDeviceEnrollment(safeContext())
const stored = fakeDb.state.config.centralDeviceEnrollment
check('a verified context is enrolled', saved.outcome, 'saved')
check('  the stored fields are EXACTLY the approved safe set',
  Object.keys(stored).sort(),
  ['attributes', 'deviceId', 'deviceName', 'eventId', 'eventSlug', 'loginName', 'verifiedAt'])
check('  with the central identity',
  [stored.deviceId, stored.eventId, stored.eventSlug, stored.deviceName, stored.loginName],
  [DEVICE_A, EVENT_UUID, 'navaratri-2026', 'Registration Desk A', 'desk-a'])
check('  and the verified attributes', stored.attributes, ['registration', 'prizes'])
check('  verifiedAt is an ISO timestamp', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(stored.verifiedAt), true)

console.log('  -- what must NEVER be stored --')
check('activeBadgeRange is NOT stored',
  /activeBadgeRange|rangeStart|rangeEnd/.test(JSON.stringify(stored)), false)
check('  no password, token, cookie or session version',
  /password|token|cookie|sessionVersion|session_version|salt|scrypt/i.test(JSON.stringify(stored)), false)
check('  nor transport facts', /authenticated|configured/.test(JSON.stringify(stored)), false)
check('  the response is projected field by field, never spread',
  [/const toEnrollment/.test(read('src/db/central-enrollment.ts')),
   /\.\.\.context[,}\s]|\.\.\.context\.device[,}\s]|JSON\.stringify\(context\)|config\.put\(apiResponse/
     .test(stripComments(read('src/db/central-enrollment.ts')))], [true, false])
const enrollmentWithFuture = await (async () => {
  reset()
  await enrollment.saveCentralDeviceEnrollment({
    ...safeContext(),
    device: { ...safeContext().device, sessionVersion: 7, passwordHash: 'scrypt$v1$x' },
  })
  return fakeDb.state.config.centralDeviceEnrollment
})()
check('  an unexpected extra field cannot slip through',
  /sessionVersion|passwordHash|scrypt/.test(JSON.stringify(enrollmentWithFuture)), false)

console.log('  -- local Phase 7 state is preserved exactly --')
reset()
await enrollment.saveCentralDeviceEnrollment(safeContext())
check('every local field survives a save', localSnapshot(fakeDb.state.config), BASELINE)
check('  the local deviceId is NOT the central one',
  [fakeDb.state.config.deviceId, fakeDb.state.config.deviceId === DEVICE_A],
  ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', false])
check('  the local deviceName is NOT the central one',
  [fakeDb.state.config.deviceName, fakeDb.state.config.deviceName === 'Registration Desk A'],
  ['Local Desk A', false])
check('  the badge range is untouched despite a central assignment',
  [fakeDb.state.config.badgeStart, fakeDb.state.config.badgeEnd, fakeDb.state.config.nextBadge],
  [1, 250, 47])
await enrollment.clearCentralDeviceEnrollment()
check('every local field survives a clear', localSnapshot(fakeDb.state.config), BASELINE)
check('  and the enrollment key is gone',
  'centralDeviceEnrollment' in fakeDb.state.config, false)
check('registrations and outbox are never opened',
  [fakeDb.state.registrations.size, fakeDb.state.outbox.size], [0, 0])
check('  the helpers only ever transact on config',
  [...stripComments(read('src/db/central-enrollment.ts'))
    .matchAll(/db\.transaction\('rw',\s*([^,]+),/g)].map((match) => match[1].trim()),
  ['db.config', 'db.config'])
check('  and never call a badge writer',
  /configureBadgeDistribution|registerDevice|nextBadge|badgeStart|badgeEnd/.test(
    stripComments(read('src/db/central-enrollment.ts'))), false)

console.log('  -- same device refreshes, different device is blocked --')
reset()
await enrollment.saveCentralDeviceEnrollment(safeContext())
const firstVerifiedAt = fakeDb.state.config.centralDeviceEnrollment.verifiedAt
await new Promise((done) => setTimeout(done, 5))
const refreshed = await enrollment.saveCentralDeviceEnrollment(
  safeContext(DEVICE_A, { name: 'Renamed Desk A', loginName: 'desk-a2', attributes: ['registration'] }))
check('the SAME device refreshes in place', refreshed.outcome, 'saved')
check('  name, login and attributes update',
  [fakeDb.state.config.centralDeviceEnrollment.deviceName,
   fakeDb.state.config.centralDeviceEnrollment.loginName,
   fakeDb.state.config.centralDeviceEnrollment.attributes],
  ['Renamed Desk A', 'desk-a2', ['registration']])
check('  verifiedAt moves forward',
  fakeDb.state.config.centralDeviceEnrollment.verifiedAt > firstVerifiedAt, true)
check('  and local state is still untouched', localSnapshot(fakeDb.state.config), BASELINE)

reset()
await enrollment.saveCentralDeviceEnrollment(safeContext(DEVICE_A))
const mismatch = await enrollment.saveCentralDeviceEnrollment(safeContext(DEVICE_B, { name: 'Desk B' }))
check('a DIFFERENT central device is refused', mismatch.outcome, 'device-mismatch')
check('  it names both devices',
  [mismatch.enrolled.deviceId, mismatch.attempted.deviceId, mismatch.attempted.deviceName],
  [DEVICE_A, DEVICE_B, 'Desk B'])
check('  and B was NOT persisted over A',
  fakeDb.state.config.centralDeviceEnrollment.deviceId, DEVICE_A)
check('  nothing else changed either', localSnapshot(fakeDb.state.config), BASELINE)

const panelSource = stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
check('a mismatch ends the impostor session',
  /outcome === 'device-mismatch'|saved\.outcome[\s\S]{0,400}logoutDevice\(\)/.test(panelSource), true)
check('  and offers an explicit Clear Central Enrollment',
  /Clear Central Enrollment/.test(panelSource), true)
check('  worded so it cannot be mistaken for clearing event data',
  /does not touch this desk/.test(panelSource), true)

reset()
check('a missing config row is reported, not created',
  await (async () => {
    fakeDb.state.config = null
    return (await enrollment.saveCentralDeviceEnrollment(safeContext())).outcome
  })(), 'missing-config')

console.log('\n=== 46-52. SIGN OUT ===')
check('Sign Out calls the logout endpoint first',
  panelSource.indexOf('logoutDevice()') < panelSource.indexOf('clearCentralDeviceEnrollment()'), true)
check('  a FAILED logout does not clear local enrollment',
  /if \(!endedSession\.ok\) \{[\s\S]{0,400}return\n?\s*\}/.test(panelSource), true)
check('  and does not claim the cookie was removed',
  /device session is still active/.test(panelSource), true)
check('  the password never survives a login',
  /setPassword\(''\)/.test(read('src/components/device-auth/device-login-form.tsx')), true)
check('signing out touches no other realm',
  /adminLogout|operatorLogout|lockDevice|clearTrusted|db\.delete|indexedDB\.deleteDatabase/
    .test(panelSource), false)
check('  and no registration or outbox table is opened',
  /db\.registrations|db\.outbox|\.registrations\.|\.outbox\./.test(panelSource), false)

console.log('\n=== 53-58. THE OFFLINE BOUNDARY ===')
check('an unreachable server NEVER yields an authenticated state',
  /status === 'unreachable'[\s\S]{0,260}phase: 'last-verified'/.test(panelSource), true)
check('  the cached identity is labelled last verified only',
  [/Last verified device/.test(panelSource), /Not verified right now/.test(panelSource)], [true, true])
check('  and says connectivity is required',
  /Internet is required to verify or change the central device/.test(panelSource), true)
check('  the word Authenticated is never shown for a cached identity',
  /'last-verified'[\s\S]{0,900}Authenticated/.test(panelSource), false)
check('authenticated is only ever reached from a server answer',
  [...panelSource.slice(panelSource.indexOf('const DeviceEnrollmentPanel'))
    .matchAll(/phase: 'authenticated'/g)].length, 1)
/**
 * Stated structurally rather than as a character window: Phase D1 added the
 * convergence read between the save and the state, and a fixed-width window
 * would have failed for a reason that has nothing to do with the rule. The
 * rule is that the ONLY authenticated state is constructed INSIDE the branch
 * that a successful save opened.
 */
const savedBranchAt = panelSource.indexOf("if (saved.outcome === 'saved') {")
const savedBranchEndsAt = panelSource.indexOf("if (saved.outcome === 'missing-config') {")
const authenticatedAt = panelSource.indexOf("phase: 'authenticated'", savedBranchAt)
check('  which follows a successful save of a verified context', [
  savedBranchAt > -1,
  savedBranchEndsAt > savedBranchAt,
  authenticatedAt > savedBranchAt,
  authenticatedAt < savedBranchEndsAt,
], [true, true, true, true])
/**
 * Phase D1 added the convergence domain module, which reads the enrollment
 * to decide whether the LOCAL identity may be rewritten. Phase D2 deleted
 * the legacy provisioning page, so that reader is gone again. The remaining
 * one is listed by name rather than waved through, and held to what it is
 * allowed to do immediately below.
 */
check('no cached enrollment unlocks an event route',
  walkSource(join(root, 'src'))
    .filter((file) => !file.includes('device-auth') && !file.endsWith('central-enrollment.ts'))
    .filter((file) => /centralDeviceEnrollment/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')),
  [
    'src/db/device-identity-convergence.ts',
    'src/db/types.ts',
  ])
const convergenceReader = stripComments(read('src/db/device-identity-convergence.ts'))
check('  the convergence reader authorizes nothing',
  /authorizeEventModule|ModuleAuthorization|EventAccessGate|useLocation|navigate|ROUTES/
    .test(convergenceReader), false)
check('    it reads the enrollment to plan a CONFIG write only',
  [/config\.centralDeviceEnrollment/.test(convergenceReader),
    /db\.transaction\('rw', db\.config/.test(convergenceReader)], [true, true])
/**
 * The authorization domain reads it too, through the pure evaluator — and
 * only ever to REFUSE. `checkEnrollment` returns a conflict or `null`; it
 * cannot return an authorization.
 */
const authorizationDomain = stripComments(read('src/device-auth/event-authorization.ts'))
const enrollmentCheck = authorizationDomain.slice(
  authorizationDomain.indexOf('export const checkEnrollment'),
  authorizationDomain.indexOf('export const checkBadgeOwnership'))
check('  the authorization domain reads it only to refuse',
  [/BadgeSafetyConflict \| null/.test(enrollmentCheck),
   /outcome: 'authorized'/.test(enrollmentCheck)], [true, false])
// Phase D2 deleted the operator gate; the device gate replaced it, and it
// reads the enrollment only through the pure evaluator.
check('  and the event access gate never reads it directly',
  /centralDeviceEnrollment/.test(
    read('src/components/event-access/event-access-gate.tsx')), false)

console.log('  -- no heartbeat --')
for (const [label, pattern] of [
  ['setInterval', /setInterval/], ['a polling timer', /poll|heartbeat/i],
  ['a repeating timeout', /setTimeout\([^)]*\)[\s\S]{0,60}setTimeout/],
]) check(`  no ${label} in the device UI`,
  pattern.test(panelSource + stripComments(read('src/device-auth/device-api.ts'))), false)
check('  the session is checked on mount, after login and on refresh only',
  [...panelSource.matchAll(/getDeviceSession\(\)/g)].length, 1)
check('  and the refresh is operator-driven',
  /Refresh Device Status/.test(panelSource), true)

console.log('\n=== 59-64. THE BADGE RANGE BOUNDARY ===')
const summarySource = read('src/components/device-auth/device-identity-summary.tsx')
check('the central range may be DISPLAYED',
  [/Central badge assignment/.test(summarySource), /formatBadgeRange/.test(summarySource)], [true, true])
check('  with explicit wording that local state is unchanged',
  /Central assignment only\. Local badge range has not been changed\./.test(summarySource), true)
check('  and no adoption action',
  /Use this range|Adopt|Apply range|Import range|configureBadgeDistribution/
    .test(stripComments(summarySource)), false)
/**
 * Phase 9C-C2A lets this UI DISPLAY local badge state beside the central
 * assignment — it must, in order to show a range conflict. What it still may
 * not do is WRITE it: no component opens the database or calls a badge writer.
 * The single adoption write lives in the domain helper, audited by verify:9cc2a.
 */
/**
 * 9C-C3B's authorization provider READS the config row to evaluate badge
 * ownership, so importing the database is no longer the thing to forbid.
 * WRITING is — and the registrations and outbox tables are none of its
 * business at all.
 */
check('nothing in the device UI writes a badge range',
  walkSource(join(root, 'src/components/device-auth'))
    .concat(walkSource(join(root, 'src/device-auth')))
    .filter((file) => /configureBadgeDistribution\(|registerDevice\(|db\.config\.(put|update|add|delete)|db\.transaction\(|db\.(registrations|outbox)\./
      .test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), [])
/**
 * Phase 9C-C2B added self-claim. It is exactly ONE endpoint with one name,
 * and C1's rule still holds underneath it: the credential's own lifecycle
 * stays on the single consolidated auth endpoint, and nothing invented a
 * second way in.
 */
check('the self-claim surface is exactly one endpoint',
  ['device-claim-range.ts', 'device-badge-assignment.ts', 'device-enroll.ts',
   'device-badge-claim.ts']
    .filter((file) => existsSync(join(root, 'api', file))), ['device-badge-claim.ts'])
check('  with no second self-claim implementation',
  walkSource(join(root, 'src')).concat(walkSource(join(root, 'server')))
    .filter((file) => /selfClaimRange|adoptCentralRange/
      .test(readFileSync(file, 'utf8'))), [])
check('  the auth endpoint still serves only login, session and logout',
  [...stripComments(read('src/device-auth/device-api.ts'))
    .matchAll(/request\(DEVICE_AUTH_ENDPOINT, \{\s*method: '(POST|GET|DELETE)'/g)]
    .map((match) => match[1]).sort(),
  ['DELETE', 'GET', 'POST'])
/**
 * Phase D2.1 added the contiguous refill as PATCH on the SAME endpoint, so
 * there are now two calls against it and still exactly two endpoints. The
 * methods are named too, because "two calls to one endpoint" would also be
 * satisfied by two POSTs.
 */
check('  and the two badge calls are the only ones not against it',
  [...stripComments(read('src/device-auth/device-api.ts'))
    .matchAll(/request\((\w+)/g)].map((match) => match[1]).filter((name) => name.endsWith('ENDPOINT')),
  ['DEVICE_AUTH_ENDPOINT', 'DEVICE_AUTH_ENDPOINT', 'DEVICE_AUTH_ENDPOINT',
   'DEVICE_BADGE_CLAIM_ENDPOINT', 'DEVICE_BADGE_CLAIM_ENDPOINT'])
check('    one POST to claim, one PATCH to refill',
  [...stripComments(read('src/device-auth/device-api.ts'))
    .matchAll(/request\(DEVICE_BADGE_CLAIM_ENDPOINT, \{\s*method: '(\w+)'/g)]
    .map((match) => match[1]).sort(), ['PATCH', 'POST'])

console.log('\n=== 33-37. NOTHING ELSE CHANGED ===')
const dexie = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION = 1/.test(dexie), true)
check('  exactly three stores',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and .stores() was not touched by this phase',
  /centralDeviceEnrollment|device-auth/.test(dexie), false)
check('the enrollment is non-indexed config metadata',
  /centralDeviceEnrollment\?: CentralDeviceEnrollment/.test(read('src/db/types.ts')), true)

const clientFiles = walkSource(join(root, 'src'))
  .map((file) => ({ file: file.replace(`${root}/`, ''), code: stripComments(readFileSync(file, 'utf8')) }))
check('no client module names the device cookie',
  clientFiles.filter((entry) => /navaratri_device_session/.test(entry.code)).map((entry) => entry.file), [])
check('  nor reads document.cookie',
  clientFiles.filter((entry) => /document\.cookie/.test(entry.code)).map((entry) => entry.file), [])
check('  nor references the device session secret',
  clientFiles.filter((entry) => /EVENT_DEVICE_SESSION_SECRET/.test(entry.code)).map((entry) => entry.file), [])
check('  and no password is persisted anywhere',
  clientFiles.filter((entry) =>
    /(localStorage|sessionStorage|indexedDB|db\.config)[\s\S]{0,80}password/i.test(entry.code))
    .map((entry) => entry.file), [])
check('no credential reaches the built bundle',
  ['navaratri_device_session', 'EVENT_DEVICE_SESSION_SECRET']
    .map((needle) => existsSync(join(root, 'dist')) &&
      readdirSync(join(root, 'dist/assets')).some((file) =>
        readFileSync(join(root, 'dist/assets', file), 'utf8').includes(needle))),
  [false, false])

check('Sheets unchanged',
  [/A1:N/.test(read('server/sync/sheet-contract.ts')), /A1:M/.test(read('server/sync/sheet-contract.ts'))],
  [true, true])
/**
 * 9C-C3B added a device sync realm beside the operator one; PHASE D2 removed
 * the operator one, leaving a live device session as the only authorization.
 * The signed offline lease is still accepted by nothing.
 */
// Comment-stripped: the handler legitimately EXPLAINS that the operator
// realm was removed, and saying so is not using it.
check('sync is device-only and never takes the offline lease',
  [/operator/i.test(stripComments(read('api/sync-registration.ts'))),
   /authorizeSyncByDevice/.test(read('api/sync-registration.ts')),
   /verifyOfflineAuthorization|offline-lease|centralDeviceOfflineAuthorization/
     .test(stripComments(read('api/sync-registration.ts')))], [false, true, false])
check('the Operator realm is gone',
  existsSync(join(root, 'server/auth/operator-session.ts')), false)
check('Admin auth is unchanged',
  /navaratri-admin-session-v1:/.test(read('server/admin-auth/session.ts')), true)
check('badge allocation stays local',
  [/nextBadge/.test(read('src/db/registrations.ts')),
   /device-auth|central/.test(read('src/db/registrations.ts'))], [true, false])
check('NO new migration',
  readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('  and no server file changed for this phase',
  /centralDeviceEnrollment/.test(
    walkSource(join(root, 'server')).map((file) => readFileSync(file, 'utf8')).join('\n')), false)

console.log('\n=== DOCS + SUITE ===')
const deviceDoc = read('docs/DEVICE_AUTH.md')
check('DEVICE_AUTH.md documents the C1 boundary',
  ['/device-login', 'centralDeviceEnrollment', 'Operator Access'].every((n) => deviceDoc.includes(n)), true)
check('  and states the range is not imported',
  /does not copy|not imported|Local badge range has not been changed|9C-C2/.test(deviceDoc), true)
check('AGENTS.md records the enrollment rules',
  /centralDeviceEnrollment/.test(read('AGENTS.md')), true)
const manifest = JSON.parse(read('package.json'))
check('verify:9cc1 is registered',
  manifest.scripts['verify:9cc1'], 'node scripts/verification/phase-9cc1.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9cc1'), true)
check('release:check covers this phase',
  /device-enrollment/.test(read('scripts/release-check.mjs')), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /zod|redux|zustand|jotai|react-query|tanstack|swr|playwright/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
