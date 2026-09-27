/**
 * Phase 8A verification — application shell, routing, Home, the device gates,
 * deep-link/API safety and state preservation across routes.
 *
 * Run with:  pnpm verify:8a
 *
 * Routes are rendered for real with react-dom/server through the actual
 * AppRouter, so route resolution and the gates are exercised rather than
 * grepped. Requires `pnpm build` first for the service-worker assertions.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hrefsIn, renderRoute } from './route-render.mjs'

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
/** Guards must scan CODE; a comment describing the guarantee is not a breach. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const CONFIGURED = { id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', deviceId: '11111111-2222-4333-8444-555555555555',
  deviceName: 'Registration Desk A', badgeStart: 1, badgeEnd: 250, nextBadge: 5,
  deviceConfiguredAt: '2026-09-27T06:00:00.000Z', updatedAt: 'T1' }
const UNCONFIGURED = { ...CONFIGURED, deviceId: undefined, deviceName: undefined, badgeEnd: undefined }
const FORM = '__REGISTRATION_FORM__'

console.log('=== 1-10. ROUTING ===')
const home = renderRoute('/', CONFIGURED)
check('`/` renders Home', [home.error ?? null, home.html.includes('Event Operations')], [null, true])
check('  Home does not render the badge workflow', home.html.includes(FORM), false)
const badge = renderRoute('/badge-registration', CONFIGURED)
check('`/badge-registration` resolves Badge Registration', badge.html.includes(FORM), true)
const deviceRoute = renderRoute('/device-registration', CONFIGURED)
check('`/device-registration` resolves Device Registration', deviceRoute.html.includes('Device Registration'), true)
check('  and not the badge workflow', deviceRoute.html.includes(FORM), false)
const unknown = renderRoute('/definitely-not-a-route', CONFIGURED)
check('unknown route renders Not Found', unknown.html.includes('Page not found'), true)
check('  NEVER silently renders Badge Registration', unknown.html.includes(FORM), false)
check('  offers Back to Home', [unknown.html.includes('Back to Home'), hrefsIn(unknown.html)], [true, ['/']])

const homeHrefs = hrefsIn(home.html)
check('Home badge card routes correctly', homeHrefs.includes('/badge-registration'), true)
check('Home device card routes correctly', homeHrefs.includes('/device-registration'), true)
// Home links to the two built modules plus the subtle Admin link. What must
// never appear is a link behind a Coming soon card.
check('Home links only to real destinations', homeHrefs.sort(),
  ['/admin', '/badge-registration', '/device-registration'])
check('coming-soon cards do NOT navigate',
  homeHrefs.filter((href) => /dandiya|prize/i.test(href)), [])
check('  Admin is a subtle link, not a module card',
  /<a[^>]*href="\/admin"[^>]*>\s*Admin\s*<\/a>/.test(home.html), true)
check('  they are marked and inert',
  [(home.html.match(/Coming soon/g) ?? []).length, home.html.includes('aria-disabled="true"')], [2, true])
check('  no fake module routes exist',
  [existsSync(join(root, 'src/pages/dandiya-page.tsx')), existsSync(join(root, 'src/pages/prizes-page.tsx'))], [false, false])
const homeUnconfigured = renderRoute('/', UNCONFIGURED)
check('Home shows static device status only',
  [homeUnconfigured.html.includes('Device not registered'),
   /remaining|Pending sync|Next badge/i.test(home.html)], [true, false])

const pageSources = ['src/pages/home-page.tsx', 'src/pages/badge-registration-page.tsx',
  'src/pages/device-registration-page.tsx', 'src/pages/not-found-page.tsx',
  'src/components/app-router.tsx', 'src/App.tsx', 'src/components/device/device-registered-gate.tsx']
  .map((f) => stripComments(read(f))).join('\n')
check('internal navigation never forces a document reload',
  /window\.location\.href|location\.assign|location\.replace|<a\s+href=/.test(pageSources), false)
check('  navigation goes through the router', /from 'wouter'/.test(pageSources), true)
check('router uses real pathnames, not hash URLs', /hashLocation|useHashLocation|href="#/.test(pageSources), false)

console.log('\n=== 10. API IS NEVER SWALLOWED BY THE SPA REWRITE ===')
const vercelConfig = JSON.parse(read('vercel.json'))
const rewriteSources = vercelConfig.rewrites.map((r) => r.source)
check('rewrites are explicit, not a catch-all', rewriteSources.sort(),
  ['/admin', '/badge-registration', '/device-registration'])
check('  no wildcard or regex source', rewriteSources.some((s) => /[*:()]/.test(s)), false)
for (const api of ['/api/operator-login', '/api/operator-session', '/api/operator-logout', '/api/sync-registration'])
  check(`  ${api} is not matched`, rewriteSources.includes(api), false)
check('  every rewrite destination is the SPA shell',
  vercelConfig.rewrites.every((r) => r.destination === '/index.html'), true)
check('  no redirects or headers were introduced', [vercelConfig.redirects, vercelConfig.headers], [undefined, undefined])
for (const fn of ['api/operator-login.ts', 'api/operator-session.ts', 'api/operator-logout.ts', 'api/sync-registration.ts'])
  check(`  ${fn} still exists as a Function`, existsSync(join(root, fn)), true)

console.log('\n=== 11-17. AUTH + DEEP LINK ===')
const appSource = read('src/App.tsx')
check('OperatorAccessGate wraps the whole router',
  appSource.indexOf('<OperatorAccessGate>') < appSource.indexOf('<AppRouter />'), true)
const gateSource = read('src/components/operator/operator-access-gate.tsx')
check('the access gate renders in place, it never navigates',
  /useLocation|navigate|setLocation|redirect|window\.location/.test(stripComments(gateSource)), false)
check('  so a deep link survives unlocking', /return <>\{children\}<\/>/.test(gateSource), true)
const accessSource = read('src/auth/operator-access.ts')
check('unlocking does not send the operator Home',
  /ROUTES\.home|navigate\(|setLocation\(/.test(stripComments(accessSource)), false)
check('trusted offline path unchanged', /isBrowserOffline\(\)/.test(accessSource), true)
check('Lock Device is auth only',
  /IndexedDB|db\.|registrations|outbox/.test(stripComments(read('src/components/operator/lock-device-button.tsx'))), false)
check('  and clears only the marker + cookie',
  /clearTrustedDevice\(\)[\s\S]{0,200}setOperatorAccess/.test(accessSource), true)

console.log('\n=== 18-26. DEVICE GATES ===')
check('configured `/badge-registration` renders registration', badge.html.includes(FORM), true)
const badgeUnconfigured = renderRoute('/badge-registration', UNCONFIGURED)
check('unconfigured `/badge-registration` does NOT render the form', badgeUnconfigured.html.includes(FORM), false)
check('  shows "This device is not registered"', badgeUnconfigured.html.includes('This device is not registered'), true)
check('  offers Register This Device', badgeUnconfigured.html.includes('Register This Device'), true)
check('  the CTA targets /device-registration', hrefsIn(badgeUnconfigured.html), ['/device-registration'])
for (const status of ['loading', 'failed']) {
  const gated = renderRoute('/badge-registration', null, status)
  check(`  ${status} config also fails closed`, gated.html.includes(FORM), false)
}
check('registered `/device-registration` does NOT show the form again',
  [deviceRoute.html.includes('Register Device'), deviceRoute.html.includes('device-name')], [false, false])
check('  and never asks about badges',
  [deviceRoute.html.includes('device-badge-start'), deviceRoute.html.includes('Configure Badge Distribution'),
   deviceRoute.html.includes('physical badges')], [false, false, false])
check('  shows identity and device id',
  [deviceRoute.html.includes('Registration Desk A'),
   deviceRoute.html.includes('11111111-2222-4333-8444-555555555555')], [true, true])
check('  offers Device Readiness', deviceRoute.html.includes('Open Device Readiness'), true)
check('  offers NO mutation control',
  /Edit Range|Reset|Change Device ID|Delete Registration|Clear Storage/i.test(deviceRoute.html), false)
const deviceUnconfigured = renderRoute('/device-registration', UNCONFIGURED)
check('unregistered `/device-registration` asks only for a device name',
  [deviceUnconfigured.html.includes('Register Device'), deviceUnconfigured.html.includes('device-name')], [true, true])
check('  and asks NOTHING about badges',
  [deviceUnconfigured.html.includes('device-badge-start'), deviceUnconfigured.html.includes('device-badge-end'),
   deviceUnconfigured.html.includes('physical badges')], [false, false, false])
const identityWriters = spawnSync('grep', ['-rl', 'registerDevice', join(root, 'src')], { encoding: 'utf8' })
  .stdout.trim().split('\n').map((f) => f.replace(`${root}/src/`, '')).sort()
check('device identity has exactly ONE writer', identityWriters,
  ['components/device/device-registration-form.tsx', 'db/device.ts'])
const badgeWriters = spawnSync('grep', ['-rl', 'configureBadgeDistribution', join(root, 'src')], { encoding: 'utf8' })
  .stdout.trim().split('\n').map((f) => f.replace(`${root}/src/`, '')).sort()
check('badge range has exactly ONE writer', badgeWriters,
  ['components/device/badge-distribution-form.tsx', 'db/device.ts'])
check('  the one-time + existing-data guards are untouched',
  ['already-registered', 'already-configured', 'existing-data'].every((o) => read('src/db/device.ts').includes(o)), true)

console.log('\n=== 27-34. STATE PRESERVATION ACROSS ROUTES ===')
const first = renderRoute('/device-registration', CONFIGURED).html
renderRoute('/', CONFIGURED)
renderRoute('/badge-registration', CONFIGURED)
const second = renderRoute('/device-registration', CONFIGURED).html
check('device identity and range survive route changes', second, first)
check('  no page writes to the database',
  /holdRegistration|issueBadge|db\.(config|registrations|outbox)\.(put|add|delete)/.test(pageSources), false)
check('  routing creates no second storage namespace',
  /new Dexie|indexedDB\.open|new NavaratriDatabase/.test(pageSources), false)
const dbSource = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION\s*=\s*1\b/.test(dbSource), true)
const storesBlock = /\.stores\(\{([\s\S]*?)\}\)/.exec(dbSource)?.[1] ?? ''
check('  exactly three stores, no new index',
  (storesBlock.match(/^\s*(\w+):/gm) ?? []).map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  no route field added to the schema', /route|path|page/.test(storesBlock), false)

console.log('\n=== 6. APP HIERARCHY ===')
/**
 * Phase 9B moved the event shell out of App.tsx into EventAppGate, so that
 * `/admin` can render outside Operator Access. The guarantees are unchanged:
 * one gate, one sync processor, mounted once for every event route.
 */
const shellSource = read('src/components/event-app-gate.tsx')
const routerSourceForShell = read('src/components/app-router.tsx')
check('exactly one DatabaseGate', (shellSource.match(/<DatabaseGate>/g) ?? []).length, 1)
check('exactly one SyncManager', (shellSource.match(/<SyncManager \/>/g) ?? []).length, 1)
check('  SyncManager is inside DatabaseGate', shellSource.indexOf('<DatabaseGate>') < shellSource.indexOf('<SyncManager />'), true)
check('  and OUTSIDE the page routes', shellSource.indexOf('<SyncManager />') < shellSource.indexOf('{children}'), true)
check('  the shell mounts once for all event routes',
  (routerSourceForShell.match(/<EventAppGate>/g) ?? []).length, 1)
check('  App.tsx renders only the router', (appSource.match(/<AppRouter \/>/g) ?? []).length, 1)
const featurePageSources = ['src/pages/home-page.tsx', 'src/pages/badge-registration-page.tsx',
  'src/pages/device-registration-page.tsx', 'src/pages/not-found-page.tsx',
  'src/components/app-router.tsx'].map((f) => stripComments(read(f))).join('\n')
check('no feature page mounts its own SyncManager or DatabaseGate',
  /<SyncManager|<DatabaseGate/.test(featurePageSources), false)
check('header carries no device badge state', /nextBadge|badgeStart|DeviceLabel|formatBadgeNumber/.test(
  stripComments(appSource.slice(appSource.indexOf('<header'), appSource.indexOf('</header>')))), false)
check('  app title navigates Home',
  /<Link\s+href=\{ROUTES\.home\}/.test(appSource.slice(appSource.indexOf('<header'), appSource.indexOf('</header>'))), true)

console.log('\n=== 35-45. PWA + SERVER ROUTING ===')
const swText = read('dist/sw.js')
check('production build exists', existsSync(join(root, 'dist/sw.js')), true)
check('navigation fallback to the SPA shell exists', /createHandlerBoundToURL\("index\.html"\)/.test(swText), true)
check('  wired as a NavigationRoute', /NavigationRoute/.test(swText), true)
check('  /api is denylisted from the fallback', /denylist:\[\/\^\\\/api\\\/\/\]/.test(swText), true)
check('  index.html is precached, so routes open offline', /"index\.html"/.test(swText), true)
const viteConfig = read('vite.config.ts')
check('skipWaiting remains false', /skipWaiting:\s*false/.test(viteConfig), true)
check('clientsClaim remains false', /clientsClaim:\s*false/.test(viteConfig), true)
check('  no runtime caching added', /runtimeCaching/.test(viteConfig), false)
check('  only one service worker is generated',
  spawnSync('bash', ['-c', `ls ${JSON.stringify(join(root, 'dist'))}/sw*.js | wc -l`], { encoding: 'utf8' }).stdout.trim(), '1')
check('no API route is cached', /sync-registration|operator-login|operator-session/.test(swText), false)
check('built shell is served for deep links',
  read('dist/index.html').includes('<div id="root">'), true)

console.log('\n=== DEPENDENCIES ===')
const pkg = JSON.parse(read('package.json'))
check('router dependency declared', typeof pkg.dependencies.wouter, 'string')
check('  no framework migration pulled in',
  Object.keys(pkg.dependencies).filter((d) => /^(next|remix|@remix-run|react-router)/.test(d)), [])
check('  no test framework added',
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((d) => /^(vitest|jest|mocha|ava|jasmine|@testing-library)/.test(d)), [])
check('verification scripts registered',
  [pkg.scripts['verify:8a'], pkg.scripts.verify.includes('verify:8a')],
  ['node scripts/verification/phase-8a.mjs', true])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
