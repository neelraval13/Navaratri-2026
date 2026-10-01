#!/usr/bin/env node
/**
 * Read-only release readiness check.
 *
 * Verifies repository-level production assumptions before a human deploys.
 * It NEVER mutates a file, contacts Google or any network, runs git, deploys,
 * reads a real secret value or deletes anything. It only reads and reports.
 *
 * Usage:
 *   node scripts/release-check.mjs [--root <dir>] [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, basename, extname } from 'node:path'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const ROOT = resolve(rootIndex === -1 ? process.cwd() : (args[rootIndex + 1] ?? '.'))
const AS_JSON = args.includes('--json')

/**
 * Built from parts on purpose: writing these literals out would make this file
 * itself match the scan it performs, and an exclusion for the scanner is a
 * blind spot waiting to hide a real key.
 */
const PEM_MARKER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')
const SERVICE_ACCOUNT_TYPE = 'service' + '_account'

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  'coverage',
  '.next',
  'build',
])

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.html',
  '.css', '.yml', '.yaml', '.txt', '.example', '.sh', '.toml',
])

const SUSPICIOUS_CREDENTIAL_FILENAMES = new Set([
  'credentials.json',
  'service-account.json',
  'service-account-key.json',
  'google-service-account.json',
  'gcp-service-account.json',
  'serviceaccount.json',
])

const SERVER_ONLY_NAMES = [
  'DATABASE_URL',
  'EVENT_ADMIN_ACCESS_CODE',
  'EVENT_ADMIN_SESSION_SECRET',
  'EVENT_DEVICE_SESSION_SECRET',
  'EVENT_OPERATOR_ACCESS_CODE',
  'EVENT_SESSION_SECRET',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'SYNC_ALLOWED_ORIGIN',
  'SYNC_WRITE_ENABLED',
  'SYNC_ALLOWED_VERCEL_ENV',
]

const CLIENT_NAMES = ['VITE_UPI_ID', 'VITE_UPI_PAYEE_NAME']

const REQUIRED_FILES = [
  '.env.example',
  'AGENTS.md',
  'README.md',
  'package.json',
  'vite.config.ts',
  'api/sync-registration.ts',
  'api/operator-login.ts',
  'api/operator-session.ts',
  'api/operator-logout.ts',
  'server/sync/environment.ts',
  'server/auth/environment.ts',
  'server/auth/operator-session.ts',
  'server/auth/cookies.ts',
  'server/db/client.ts',
  'server/db/environment.ts',
  'server/db/schema.ts',
  'server/admin-auth/environment.ts',
  'server/admin-auth/session.ts',
  'server/admin-auth/cookies.ts',
  'server/admin/registry.ts',
  'server/device-auth/password.ts',
  'server/device-auth/environment.ts',
  'server/device-auth/session.ts',
  'server/device-auth/cookies.ts',
  'server/device-auth/same-origin.ts',
  'server/device-auth/authenticate.ts',
  'src/shared/device-password.ts',
  'api/device-auth.ts',
  'src/device-auth/device-api.ts',
  'src/device-auth/device-session-contract.ts',
  'src/db/central-enrollment.ts',
  'src/pages/device-login-page.tsx',
  'src/shared/event.ts',
  'tsconfig.server.json',
  'tsconfig.parity.json',
  'scripts/vercel-function-typecheck.mjs',
  'docs/DEVICE_AUTH.md',
  'api/admin-auth.ts',
  'api/admin-device-password.ts',
  'docs/ADMIN.md',
  'drizzle.config.ts',
  'docs/DATABASE.md',
  'scripts/verification/phase-7b.mjs',
  'scripts/verification/prior-phases.mjs',
  'docs/EVENT_DAY_RUNBOOK.md',
  'docs/PRODUCTION_RELEASE_CHECKLIST.md',
  'public/pwa-192x192.png',
  'public/pwa-512x512.png',
  'public/pwa-maskable-512x512.png',
]

/**
 * Local-only files are deliberately outside the repository's control and may
 * legitimately hold real secrets, so they are never read: `.env.local`,
 * `.env.development.local`, `.env.production.local`, `.env.test.local` and any
 * other `*.local` file.
 *
 * A plain `.env` is NOT exempt. It is an ordinary path in the tree, it is
 * exactly where a key gets pasted by accident, and nothing about its name makes
 * it safe. The same goes for `.env.production` and friends.
 */
const isLocalOnlyFile = (name) => name.endsWith('.local')

const isEnvFile = (name) => name === '.env' || name.startsWith('.env.')

const isTextFile = (name) => {
  if (isEnvFile(name)) {
    return true
  }

  return TEXT_EXTENSIONS.has(extname(name).toLowerCase())
}

const walk = (directory, files = []) => {
  let entries

  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const full = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        walk(full, files)
      }

      continue
    }

    if (entry.isFile()) {
      files.push(full)
    }
  }

  return files
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const exists = (path) => {
  try {
    statSync(path)

    return true
  } catch {
    return false
  }
}

const rel = (path) => relative(ROOT, path) || basename(path)

const allFiles = walk(ROOT)
const scannableFiles = allFiles.filter(
  (path) => isTextFile(basename(path)) && !isLocalOnlyFile(basename(path)),
)

const checks = []
const addCheck = (id, title, problems) => {
  checks.push({
    id,
    title,
    status: problems.length === 0 ? 'pass' : 'fail',
    problems,
  })
}

// --- A. required files -----------------------------------------------------
addCheck(
  'required-files',
  'Required files are present',
  REQUIRED_FILES.filter((file) => !exists(join(ROOT, file))).map(
    (file) => `missing: ${file}`,
  ),
)

// --- B. .env.example documents every variable NAME --------------------------
const envExample = readText(join(ROOT, '.env.example'))
addCheck(
  'env-example-names',
  '.env.example documents every variable name',
  envExample === null
    ? ['.env.example could not be read']
    : [...CLIENT_NAMES, ...SERVER_ONLY_NAMES]
        .filter((name) => !new RegExp(`^${name}=`, 'm').test(envExample))
        .map((name) => `missing declaration: ${name}=`),
)

// --- C. server secret names are never VITE_ prefixed ------------------------
const vitePrefixProblems = []

for (const path of scannableFiles) {
  const text = readText(path)

  if (text === null) {
    continue
  }

  for (const name of SERVER_ONLY_NAMES) {
    if (text.includes(`VITE_${name}`)) {
      vitePrefixProblems.push(`${rel(path)} references VITE_${name}`)
    }
  }
}

addCheck(
  'no-vite-prefixed-secrets',
  'No server-only variable is VITE_ prefixed',
  vitePrefixProblems,
)

// --- D. the release interlock is documented ---------------------------------
const releaseDocProblems = []

for (const file of ['.env.example', 'README.md', 'AGENTS.md']) {
  const text = readText(join(ROOT, file))

  if (text === null) {
    releaseDocProblems.push(`${file} could not be read`)

    continue
  }

  for (const name of ['SYNC_WRITE_ENABLED', 'SYNC_ALLOWED_VERCEL_ENV']) {
    if (!text.includes(name)) {
      releaseDocProblems.push(`${file} does not document ${name}`)
    }
  }
}

addCheck(
  'release-vars-documented',
  'Release interlock variables are documented',
  releaseDocProblems,
)

// --- E. no service-account JSON in the tree ---------------------------------
const serviceAccountProblems = []

for (const path of allFiles) {
  const name = basename(path).toLowerCase()

  if (SUSPICIOUS_CREDENTIAL_FILENAMES.has(name)) {
    serviceAccountProblems.push(`suspicious credential filename: ${rel(path)}`)

    continue
  }

  if (extname(name) !== '.json' || isLocalOnlyFile(name)) {
    continue
  }

  const text = readText(path)

  if (text === null) {
    continue
  }

  if (new RegExp(`"type"\\s*:\\s*"${SERVICE_ACCOUNT_TYPE}"`).test(text)) {
    serviceAccountProblems.push(`service-account JSON content: ${rel(path)}`)
  }
}

addCheck(
  'no-service-account-json',
  'No service-account JSON file in the repository',
  serviceAccountProblems,
)

// --- F. no ACTUAL PEM private-key block -------------------------------------
/**
 * Documentation legitimately shows the PEM header as a placeholder, e.g.
 * "-----BEGIN ... -----\n...\n-----END ... -----". A real key is distinguished
 * by a long run of base64 immediately after the header, so the check looks for
 * the body rather than the label.
 */
const MIN_KEY_BODY_LENGTH = 100
const pemProblems = []

for (const path of scannableFiles) {
  const text = readText(path)

  if (text === null || !text.includes(PEM_MARKER)) {
    continue
  }

  let index = text.indexOf(PEM_MARKER)

  while (index !== -1) {
    const after = text
      .slice(index + PEM_MARKER.length, index + PEM_MARKER.length + 2000)
      .replace(/\\n/g, '')
      .replace(/[\s"'`]/g, '')

    const body = /^[A-Za-z0-9+/=]*/.exec(after)?.[0] ?? ''

    if (body.length >= MIN_KEY_BODY_LENGTH) {
      // The path only. The matched content is never printed.
      pemProblems.push(`private-key block: ${rel(path)}`)

      break
    }

    index = text.indexOf(PEM_MARKER, index + PEM_MARKER.length)
  }
}

addCheck('no-private-key-block', 'No private-key block in the repository', pemProblems)

// --- G2. server relative imports are Node-ESM resolvable --------------------
/**
 * Vercel transpiles the function to ESM JavaScript and Node does NOT guess file
 * extensions for relative imports. An extensionless specifier here crashes the
 * deployed function at module load, before the handler ever runs:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/server/sync/environment'
 *
 * Package specifiers are unrestricted; only relative ones need an extension.
 */
const RUNTIME_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.node']

const SPECIFIER_PATTERNS = [
  /(?:^|[\s;}])from\s*(['"])(\.[^'"]*)\1/g, // import/export ... from '...'
  /(?:^|[\s;}])import\s*(['"])(\.[^'"]*)\1/g, // bare side-effect import
  /\bimport\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g, // dynamic import('...')
]

const esmProblems = []

for (const directory of ['api', 'server']) {
  for (const path of walk(join(ROOT, directory))) {
    if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(basename(path))) {
      continue
    }

    const text = readText(path)

    if (text === null) {
      continue
    }

    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0

      let match = pattern.exec(text)

      while (match !== null) {
        const specifier = match[2]

        if (!RUNTIME_EXTENSIONS.some((ext) => specifier.endsWith(ext))) {
          esmProblems.push(`${rel(path)} imports "${specifier}" without a runtime extension`)
        }

        match = pattern.exec(text)
      }
    }
  }
}

addCheck(
  'server-esm-imports',
  'Server relative imports carry a runtime extension',
  esmProblems,
)

// --- G3. the database stays server-side, and migrations stay manual ---------
const databaseProblems = []

for (const path of walk(join(ROOT, 'src'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text === null) {
    continue
  }

  // `server/db` is Node-only: it imports a driver and reads a credential.
  if (/from\s+['"][^'"]*server\/db/.test(text) || text.includes('server/db/')) {
    databaseProblems.push(`${rel(path)} imports server/db from client code`)
  }
}

/**
 * A migration must never run as a side effect of shipping or serving. It is a
 * deliberate operator action, so no lifecycle script may invoke it.
 */
const packageJson = readText(join(ROOT, 'package.json'))

if (packageJson !== null) {
  let scripts = {}

  try {
    scripts = JSON.parse(packageJson).scripts ?? {}
  } catch {
    databaseProblems.push('package.json could not be parsed')
  }

  /**
   * `db:smoke` WRITES rows, so it belongs in the same prohibition as a
   * migration: never a side effect of shipping, serving or verifying.
   */
  const MIGRATION_PATTERN = /drizzle-kit\s+(migrate|push)|db:migrate|db:push|db:smoke|db-constraint-smoke/

  for (const name of ['build', 'start', 'postinstall', 'prepare', 'preview', 'dev', 'vercel-build', 'release:check', 'verify']) {
    const command = scripts[name]

    if (typeof command === 'string' && MIGRATION_PATTERN.test(command)) {
      databaseProblems.push(`the "${name}" script performs a database write`)
    }
  }
}

/**
 * A committed connection string. Local env files are excluded elsewhere, so a
 * hit here is a credential in a tracked file.
 */
const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^\s'"<>]*:[^\s'"<>]*@/

for (const path of scannableFiles) {
  const text = readText(path)

  if (text !== null && POSTGRES_URL_PATTERN.test(text)) {
    // The path only. The matched string is never printed.
    databaseProblems.push(`PostgreSQL connection string with credentials: ${rel(path)}`)
  }
}

if (walk(join(ROOT, 'drizzle')).filter((p) => p.endsWith('.sql')).length === 0) {
  databaseProblems.push('no version-controlled migration files in drizzle/')
}

addCheck(
  'database-boundary',
  'Database stays server-side and migrations stay manual',
  databaseProblems,
)

// --- G4. the admin realm stays distinct and server-side --------------------
const adminProblems = []

const OPERATOR_COOKIE = '__Host-navaratri_operator_session'
const ADMIN_COOKIE = '__Host-navaratri_admin_session'

const adminCookieSource = readText(join(ROOT, 'server/admin-auth/cookies.ts'))
const operatorCookieSource = readText(join(ROOT, 'server/auth/cookies.ts'))

if (adminCookieSource === null || operatorCookieSource === null) {
  adminProblems.push('a cookie module could not be read')
} else {
  // The two realms must never share a cookie: one credential satisfying both
  // would make an unlocked event device an administrator.
  if (!adminCookieSource.includes(ADMIN_COOKIE)) {
    adminProblems.push('the admin cookie name is missing')
  }

  if (adminCookieSource.includes(OPERATOR_COOKIE)) {
    adminProblems.push('the admin cookie module references the operator cookie')
  }

  if (operatorCookieSource.includes(ADMIN_COOKIE)) {
    adminProblems.push('the operator cookie module references the admin cookie')
  }
}

for (const path of walk(join(ROOT, 'src'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text === null) {
    continue
  }

  for (const name of ['EVENT_ADMIN_ACCESS_CODE', 'EVENT_ADMIN_SESSION_SECRET']) {
    if (text.includes(name)) {
      adminProblems.push(`${rel(path)} references ${name} in client code`)
    }
  }

  if (/from\s+['"][^'"]*server\/admin/.test(text)) {
    adminProblems.push(`${rel(path)} imports server/admin from client code`)
  }
}

// The SPA must serve /admin on a direct visit, without a catch-all rewrite.
const vercelConfig = readText(join(ROOT, 'vercel.json'))

if (vercelConfig === null) {
  adminProblems.push('vercel.json could not be read')
} else {
  let rewrites = []

  try {
    rewrites = JSON.parse(vercelConfig).rewrites ?? []
  } catch {
    adminProblems.push('vercel.json could not be parsed')
  }

  if (!rewrites.some((rule) => rule.source === '/admin')) {
    adminProblems.push('vercel.json has no /admin rewrite')
  }

  for (const rule of rewrites) {
    if (typeof rule.source === 'string' && /[*:()]/.test(rule.source)) {
      adminProblems.push(`rewrite "${rule.source}" is a wildcard and could capture /api`)
    }
  }
}

addCheck('admin-realm', 'Admin is a separate server-side realm', adminProblems)

// --- G2. device credentials stay server-side --------------------------------
/**
 * Comments are stripped before these scans: the files that must not persist a
 * password are precisely the ones whose comments EXPLAIN that they do not.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const credentialProblems = []
const HASH_NAMES = ['passwordHash', 'password_hash', 'sessionVersion', 'session_version']

for (const path of walk(join(ROOT, 'src'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path) === null ? null : stripComments(readText(path))

  if (text === null) {
    continue
  }

  for (const name of HASH_NAMES) {
    if (text.includes(name)) {
      credentialProblems.push(`${rel(path)} references ${name} in client code`)
    }
  }

  if (/from\s+['"][^'"]*(server\/device-auth|node:crypto)/.test(text)) {
    credentialProblems.push(`${rel(path)} imports server password code`)
  }

  // A password must never be persisted anywhere on the device.
  if (/(localStorage|sessionStorage|indexedDB)[\s\S]{0,80}password/i.test(text)) {
    credentialProblems.push(`${rel(path)} may persist a password on the device`)
  }

  if (/console\.(log|info|warn|error)\([^)]*password/i.test(text)) {
    credentialProblems.push(`${rel(path)} may log a password`)
  }
}

// Dexie schema: no credential field may join the offline store.
const databaseSource = readText(join(ROOT, 'src/db/database.ts'))

if (databaseSource === null) {
  credentialProblems.push('src/db/database.ts could not be read')
} else if (/password|credential|hash/i.test(stripComments(databaseSource))) {
  credentialProblems.push('src/db/database.ts mentions a credential field')
}

for (const path of walk(join(ROOT, 'server'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text !== null && /console\.(log|info|warn|error)\([^)]*\b(password|passwordHash|salt|derivedKey)\b/i.test(stripComments(text))) {
    credentialProblems.push(`${rel(path)} may log a credential`)
  }
}

// Node's own crypto only: no bcrypt, argon2 or hashing service.
const packageManifest = readText(join(ROOT, 'package.json'))

if (packageManifest === null) {
  credentialProblems.push('package.json could not be read')
} else {
  const manifest = JSON.parse(packageManifest)
  const declared = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })

  for (const name of declared) {
    if (/bcrypt|argon2|scrypt-|pbkdf2|password-hash/i.test(name)) {
      credentialProblems.push(`dependency ${name} replaces Node's built-in crypto`)
    }
  }
}

const passwordSource = readText(join(ROOT, 'server/device-auth/password.ts'))

if (passwordSource === null) {
  credentialProblems.push('server/device-auth/password.ts could not be read')
} else if (!passwordSource.includes("from 'node:crypto'")) {
  credentialProblems.push('server/device-auth/password.ts does not use node:crypto')
}

// Phase 9C-C connects the device realm to the event app. Not yet.
for (const name of ['device-claim-range.ts', 'device-heartbeat.ts', 'device-enroll.ts']) {
  if (exists(join(ROOT, 'api', name))) {
    credentialProblems.push(`api/${name} exists before its phase`)
  }
}

// Migrations stay a deliberate operator action.
if (!exists(join(ROOT, 'drizzle/0002_device_credentials.sql'))) {
  credentialProblems.push('the device-credentials migration is missing')
}

const manifestScripts = packageManifest === null ? {} : JSON.parse(packageManifest).scripts

for (const [name, command] of Object.entries(manifestScripts)) {
  if (name !== 'db:migrate' && typeof command === 'string' && command.includes('drizzle-kit migrate')) {
    credentialProblems.push(`script ${name} runs a migration automatically`)
  }
}

addCheck(
  'device-credentials',
  'Device credentials are server-side only',
  credentialProblems,
)

// --- G3. the device auth realm is separate and not yet wired in ------------
const deviceRealmProblems = []

const deviceCookies = readText(join(ROOT, 'server/device-auth/cookies.ts'))
const deviceSession = readText(join(ROOT, 'server/device-auth/session.ts'))

if (deviceCookies === null || deviceSession === null) {
  deviceRealmProblems.push('the device session modules could not be read')
} else {
  if (!deviceCookies.includes("'__Host-navaratri_device_session'")) {
    deviceRealmProblems.push('the device cookie is not __Host-navaratri_device_session')
  }

  for (const foreign of ['navaratri_admin_session', 'navaratri_operator_session']) {
    if (deviceCookies.includes(foreign)) {
      deviceRealmProblems.push(`server/device-auth/cookies.ts references ${foreign}`)
    }
  }

  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) {
    if (!deviceCookies.includes(attribute)) {
      deviceRealmProblems.push(`the device cookie is missing ${attribute}`)
    }
  }

  if (/Domain=/.test(deviceCookies)) {
    deviceRealmProblems.push('the device cookie sets a Domain')
  }

  if (!deviceSession.includes("'navaratri-device-session-v1:'")) {
    deviceRealmProblems.push('the device signing context is missing or renamed')
  }

  // Comments stripped: this file EXPLAINS the other realms' contexts.
  if (/navaratri-admin-session-v1|admin-auth\/|server\/auth\//.test(stripComments(deviceSession))) {
    deviceRealmProblems.push('server/device-auth/session.ts reuses another realm')
  }
}

// The realms must not import each other's session code.
for (const path of walk(join(ROOT, 'server/device-auth'))) {
  const text = readText(path)

  if (text !== null && /from\s+['"][^'"]*(admin-auth|\.\.\/auth)\//.test(text)) {
    deviceRealmProblems.push(`${rel(path)} imports another realm's auth code`)
  }
}

// Phase 9C-B is server-side only: no device UI, and the event app must not
// call the session endpoint.
for (const path of walk(join(ROOT, 'src'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text === null) {
    continue
  }

  const code = stripComments(text)

  /**
   * Phase 9C-C1 gave the realm a UI. The device endpoints belong to the
   * device auth client and its components ONLY — no event page, no operator
   * gate and no sync module may reach them.
   */
  const isDeviceAuthModule = /\/src\/(device-auth|components\/device-auth|pages\/device-login-page)/
    .test(path)

  if (!isDeviceAuthModule && /\/api\/device-(login|session|logout)/.test(code)) {
    deviceRealmProblems.push(`${rel(path)} calls a device auth endpoint outside the device realm`)
  }

  // A device GATE would make device auth authoritative for a route. Not yet.
  if (/DeviceAccessGate|DeviceSessionGate|DeviceAuthGate/.test(code)) {
    deviceRealmProblems.push(`${rel(path)} defines a device route gate before its phase`)
  }

  if (/navaratri_device_session|document\.cookie/.test(code)) {
    deviceRealmProblems.push(`${rel(path)} reads the device cookie in client code`)
  }
}

// The event routes must still be the ones Operator Access protects.
const routerSource = readText(join(ROOT, 'src/components/app-router.tsx'))
const gateSource = readText(join(ROOT, 'src/components/event-app-gate.tsx'))

if (routerSource === null || gateSource === null) {
  deviceRealmProblems.push('the router or event gate could not be read')
} else {
  if (!gateSource.includes('OperatorAccessGate')) {
    deviceRealmProblems.push('the event shell no longer uses OperatorAccessGate')
  }

  /**
   * A device GATE, not a device route. `/device-login` legitimately appears in
   * the router; what must not exist is a device gate, and nothing
   * device-related may sit INSIDE the event shell.
   */
  if (/Device(Access|Session|Login)Gate/.test(stripComments(gateSource) + stripComments(routerSource))) {
    deviceRealmProblems.push('a device gate component exists')
  }

  if (/Device|device/.test(stripComments(gateSource))) {
    deviceRealmProblems.push('the event shell references device auth')
  }

  const routerBody = stripComments(routerSource).slice(
    stripComments(routerSource).indexOf('<Switch>'),
  )

  if (/<EventAppGate>[\s\S]*[Dd]eviceLogin/.test(routerBody)) {
    deviceRealmProblems.push('/device-login is nested inside the event shell')
  }
}

addCheck(
  'device-realm',
  'Device auth is a separate realm and is not yet wired into the event app',
  deviceRealmProblems,
)

// --- G4. central device enrollment stays a safe, config-only snapshot ------
const enrollmentProblems = []

// The SPA must serve /device-login directly; the API route must stay a Function.
if (vercelConfig !== null) {
  let rewrites = []

  try {
    rewrites = JSON.parse(vercelConfig).rewrites ?? []
  } catch {
    enrollmentProblems.push('vercel.json could not be parsed')
  }

  if (!rewrites.some((rule) => rule.source === '/device-login')) {
    enrollmentProblems.push('vercel.json has no /device-login rewrite')
  }

  for (const rule of rewrites) {
    if (typeof rule.source === 'string' && rule.source.startsWith('/api')) {
      enrollmentProblems.push(`rewrite "${rule.source}" would swallow an API route`)
    }
  }
}

const enrollmentSource = readText(join(ROOT, 'src/db/central-enrollment.ts'))

if (enrollmentSource === null) {
  enrollmentProblems.push('src/db/central-enrollment.ts could not be read')
} else {
  const code = stripComments(enrollmentSource)

  // The central badge range is NOT imported into local state in this phase.
  for (const forbidden of ['activeBadgeRange', 'rangeStart', 'rangeEnd', 'nextBadge',
    'badgeStart', 'badgeEnd', 'configureBadgeDistribution', 'sessionVersion', 'password']) {
    if (code.includes(forbidden)) {
      enrollmentProblems.push(`central enrollment references ${forbidden}`)
    }
  }

  // Config only: the registrations and outbox tables are never opened.
  if (/db\.registrations|db\.outbox/.test(code)) {
    enrollmentProblems.push('central enrollment opens a registration or outbox table')
  }

  if (/localStorage|sessionStorage/.test(code)) {
    enrollmentProblems.push('central enrollment uses browser storage instead of config')
  }
}

// The Dexie schema is untouched: still version 1, still three stores.
const dexieSource = readText(join(ROOT, 'src/db/database.ts'))

if (dexieSource === null) {
  enrollmentProblems.push('src/db/database.ts could not be read')
} else {
  if (!/DATABASE_VERSION = 1/.test(dexieSource)) {
    enrollmentProblems.push('the IndexedDB version is no longer 1')
  }

  const stores = (/\.stores\(\{([\s\S]*?)\}\)/.exec(dexieSource)?.[1] ?? '')
    .match(/^\s*(\w+):/gm)
    ?.map((entry) => entry.trim().replace(':', '')) ?? []

  if (stores.join(',') !== 'registrations,config,outbox') {
    enrollmentProblems.push(`the IndexedDB stores changed: ${stores.join(', ')}`)
  }
}

// The event routes remain Operator-gated, and no device gate wraps them.
if (routerSource !== null) {
  const body = stripComments(routerSource).slice(stripComments(routerSource).indexOf('<Switch>'))

  if (!body.includes('ROUTES.deviceLogin')) {
    enrollmentProblems.push('the router has no /device-login route')
  }

  if (/<EventAppGate>[\s\S]*deviceLogin/.test(body)) {
    enrollmentProblems.push('/device-login is nested inside the event shell')
  }
}

// No self-claim, and no polling heartbeat in the browser.
for (const name of ['device-claim-range.ts', 'device-badge-assignment.ts']) {
  if (exists(join(ROOT, 'api', name))) {
    enrollmentProblems.push(`api/${name} exists before its phase`)
  }
}

for (const path of walk(join(ROOT, 'src/device-auth'))) {
  const text = readText(path)

  if (text !== null && /setInterval/.test(stripComments(text))) {
    enrollmentProblems.push(`${rel(path)} polls on a timer`)
  }
}

for (const path of walk(join(ROOT, 'src/components/device-auth'))) {
  const text = readText(path)

  if (text === null) {
    continue
  }

  const code = stripComments(text)

  if (/setInterval/.test(code)) {
    enrollmentProblems.push(`${rel(path)} polls on a timer`)
  }

  if (/configureBadgeDistribution|nextBadge|badgeStart|badgeEnd/.test(code)) {
    enrollmentProblems.push(`${rel(path)} writes local badge state`)
  }
}

addCheck(
  'device-enrollment',
  'Central device enrollment is a safe, config-only snapshot',
  enrollmentProblems,
)

// --- H. the server/API typecheck cannot be skipped -------------------------
/**
 * A local build once passed while Vercel found dozens of TypeScript errors in
 * `api/**` and `server/**`. These assertions keep the two in step; the actual
 * compiles are `pnpm typecheck`, which `pnpm build` runs first.
 */
const parityProblems = []

const readJson = (relativePath) => {
  const text = readText(join(ROOT, relativePath))

  if (text === null) {
    parityProblems.push(`${relativePath} could not be read`)

    return null
  }

  try {
    // Tolerate the comments these configs carry.
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    parityProblems.push(`${relativePath} is not parseable`)

    return null
  }
}

const serverConfig = readJson('tsconfig.server.json')

if (serverConfig !== null) {
  const include = serverConfig.include ?? []

  for (const required of ['api', 'server']) {
    if (!include.includes(required)) {
      parityProblems.push(`tsconfig.server.json does not cover ${required}/`)
    }
  }

  if (!(serverConfig.compilerOptions?.types ?? []).includes('node')) {
    parityProblems.push('tsconfig.server.json does not declare the Node environment')
  }

  if (serverConfig.compilerOptions?.strict !== true) {
    parityProblems.push('tsconfig.server.json is not strict')
  }
}

// The degraded profile is what proves a weaker compiler finds nothing.
const parityConfig = readJson('tsconfig.parity.json')

if (parityConfig !== null) {
  const include = parityConfig.include ?? []

  for (const required of ['api', 'server']) {
    if (!include.includes(required)) {
      parityProblems.push(`tsconfig.parity.json does not cover ${required}/`)
    }
  }

  if (parityConfig.compilerOptions?.strict !== false) {
    parityProblems.push('tsconfig.parity.json is no longer the DEGRADED profile')
  }
}

/**
 * The root is solution-style, so a references-unaware tool inherits these.
 * Bare `paths` alone is what produced the original mismatch.
 */
const rootConfig = readJson('tsconfig.json')

if (rootConfig !== null) {
  const options = rootConfig.compilerOptions ?? {}

  if (options.strict !== true) {
    parityProblems.push('the root tsconfig hands a non-strict baseline to naive tools')
  }

  if (!(options.types ?? []).includes('node')) {
    parityProblems.push('the root tsconfig hands no Node environment to naive tools')
  }
}

// The browser project keeps its own environment; no Node globals leak in.
const appConfig = readJson('tsconfig.app.json')

if (appConfig !== null && (appConfig.compilerOptions?.types ?? []).includes('node')) {
  parityProblems.push('tsconfig.app.json exposes Node globals to browser code')
}

const manifestText = readText(join(ROOT, 'package.json'))
const scripts = manifestText === null ? {} : (JSON.parse(manifestText).scripts ?? {})

if (!/(^|&&\s*)(pnpm typecheck|tsc -b)/.test(scripts.build ?? '')) {
  parityProblems.push('pnpm build does not typecheck before bundling')
}

for (const name of ['typecheck', 'typecheck:server', 'typecheck:parity']) {
  if (typeof scripts[name] !== 'string') {
    parityProblems.push(`the ${name} script is missing`)
  }
}

if (!(scripts.typecheck ?? '').includes('typecheck:parity')) {
  parityProblems.push('pnpm typecheck does not run the degraded parity compile')
}

if (manifestText !== null) {
  const manifest = JSON.parse(manifestText)

  if (typeof manifest.devDependencies?.['@types/node'] !== 'string') {
    parityProblems.push('@types/node is not a declared devDependency')
  }

  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? '')) {
    parityProblems.push('packageManager is not pinned to an exact pnpm version')
  }
}

// Types are fixed, never silenced.
for (const directory of ['api', 'server', 'src']) {
  for (const path of walk(join(ROOT, directory))) {
    if (!/\.tsx?$/.test(basename(path))) {
      continue
    }

    const text = readText(path)

    if (text === null) {
      continue
    }

    if (/@ts-ignore|@ts-expect-error|@ts-nocheck/.test(text)) {
      parityProblems.push(`${rel(path)} suppresses a TypeScript error`)
    }

    if (/\bas any\b/.test(stripComments(text))) {
      parityProblems.push(`${rel(path)} casts through \`as any\``)
    }
  }
}

addCheck(
  'build-parity',
  'api/ and server/ are typechecked by the build, in strict and degraded modes',
  parityProblems,
)

// --- H2. the platform's own per-function compile is reproduced -------------
/**
 * Vercel compiles each `api/*.ts` entrypoint on its own, against the ROOT
 * tsconfig's `compilerOptions`, after our build has already succeeded. A whole-
 * project `tsc` cannot see what that finds, so the build runs a model of it.
 */
const functionProblems = []

if (!exists(join(ROOT, 'scripts/vercel-function-typecheck.mjs'))) {
  functionProblems.push('the per-function typecheck script is missing')
} else {
  const checker = readText(join(ROOT, 'scripts/vercel-function-typecheck.mjs')) ?? ''

  // It must be a real compile, not a text search pretending to be one.
  for (const [needle, complaint] of [
    ['createProgram', 'does not build a TypeScript Program'],
    ['getSemanticDiagnostics', 'does not collect semantic diagnostics'],
    ['getSyntacticDiagnostics', 'does not collect syntactic diagnostics'],
    ["require('typescript')", 'does not use the installed TypeScript compiler'],
  ]) {
    if (!checker.includes(needle)) {
      functionProblems.push(`the per-function typecheck ${complaint}`)
    }
  }

  if (/fetch\(|https?:\/\//.test(stripComments(checker))) {
    functionProblems.push('the per-function typecheck contacts the network')
  }

  if (/vercel (build|deploy|pull)/.test(checker)) {
    functionProblems.push('the per-function typecheck shells out to the Vercel CLI')
  }
}

if (!(scripts['typecheck'] ?? '').includes('typecheck:vercel-functions')) {
  functionProblems.push('pnpm typecheck does not run the per-function compile')
}

if (typeof scripts['typecheck:vercel-functions'] !== 'string') {
  functionProblems.push('the typecheck:vercel-functions script is missing')
}

/**
 * The root config is what Vercel hands every function. Functions are written
 * against the Web-standard Request/Response, so the Web lib must be there
 * deliberately — `@types/node` alone supplies those types only through a
 * heuristic that can collapse them to `{}`.
 */
if (rootConfig !== null) {
  const lib = rootConfig.compilerOptions?.lib ?? []

  if (!lib.includes('DOM')) {
    functionProblems.push('the root tsconfig gives functions no Web Request environment')
  }
}

// The runtime API stays the Web standard; no migration to VercelRequest.
for (const directory of ['api', 'server']) {
  for (const path of walk(join(ROOT, directory))) {
    if (!/\.ts$/.test(basename(path))) {
      continue
    }

    const text = readText(path)

    if (text === null) {
      continue
    }

    const code = stripComments(text)

    if (/VercelRequest|VercelResponse|@vercel\/node/.test(code)) {
      functionProblems.push(`${rel(path)} migrated away from the Web Request API`)
    }

    // A serverless instance serves concurrent invocations; a process-global
    // credential could be observed by another request.
    if (/google\.options\s*\(/.test(code)) {
      functionProblems.push(`${rel(path)} sets a global google auth default`)
    }

    // Browser-only globals: the fallback environment now contains the DOM lib,
    // so the compiler will no longer catch these.
    if (/\b(window|document|localStorage|sessionStorage|navigator)\s*\./.test(code)) {
      functionProblems.push(`${rel(path)} uses a browser-only global`)
    }
  }
}

// The Sheets client must not use the ambiguous object overload.
const sheetsSource = readText(join(ROOT, 'server/sync/google-sheets.ts'))

if (sheetsSource === null) {
  functionProblems.push('server/sync/google-sheets.ts could not be read')
} else if (/google\.sheets\(\s*\{/.test(stripComments(sheetsSource))) {
  functionProblems.push('server/sync/google-sheets.ts uses the ambiguous google.sheets({…}) overload')
}

addCheck(
  'vercel-function-compile',
  "Vercel's per-function compile is modelled by the build",
  functionProblems,
)

// --- H3. the Hobby deployment Function budget ------------------------------
/**
 * Every file under `api/` becomes a separate deployment Function, and the
 * Hobby plan refuses a deployment with more than twelve. That is enforced
 * AFTER the build succeeds, at "Deploying outputs…", so no build step reports
 * it — a 14-function deployment built cleanly and was then rejected.
 */
const HOBBY_FUNCTION_LIMIT = 12
const EXPECTED_FUNCTIONS = [
  'admin-auth.ts',
  'admin-badge-assignment.ts',
  'admin-device-password.ts',
  'admin-devices.ts',
  'admin-events.ts',
  'device-auth.ts',
  'operator-login.ts',
  'operator-logout.ts',
  'operator-session.ts',
  'sync-registration.ts',
]

const budgetProblems = []
const apiFiles = readdirSync(join(ROOT, 'api'))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort()

if (apiFiles.length > HOBBY_FUNCTION_LIMIT) {
  budgetProblems.push(
    `${String(apiFiles.length)} Functions exceeds the Hobby limit of ${String(HOBBY_FUNCTION_LIMIT)}`,
  )
}

for (const file of apiFiles) {
  if (!EXPECTED_FUNCTIONS.includes(file)) {
    budgetProblems.push(`api/${file} is an unexpected Function and consumes deployment budget`)
  }
}

for (const file of EXPECTED_FUNCTIONS) {
  if (!apiFiles.includes(file)) {
    budgetProblems.push(`api/${file} is expected but missing`)
  }
}

// The six consolidated files must be GONE, not left as wrappers — a wrapper
// under api/ is still a Function.
for (const file of [
  'admin-login.ts', 'admin-session.ts', 'admin-logout.ts',
  'device-login.ts', 'device-session.ts', 'device-logout.ts',
]) {
  if (exists(join(ROOT, 'api', file))) {
    budgetProblems.push(`api/${file} still exists and still costs a Function`)
  }
}

// Nothing under api/ may be a shared helper: helpers belong in server/.
for (const file of apiFiles) {
  const text = readText(join(ROOT, 'api', file))

  if (text !== null && !/export (async )?function (GET|POST|PUT|PATCH|DELETE)\(/.test(text)) {
    budgetProblems.push(`api/${file} exports no HTTP method — a helper here costs a Function`)
  }
}

// The old paths must simply not exist; they are never aliased or rewritten.
if (vercelConfig !== null) {
  let rewrites = []

  try {
    rewrites = JSON.parse(vercelConfig).rewrites ?? []
  } catch {
    budgetProblems.push('vercel.json could not be parsed')
  }

  for (const rule of rewrites) {
    if (/(admin|device)-(login|session|logout)/.test(rule.source ?? '') &&
        (rule.source ?? '').startsWith('/api')) {
      budgetProblems.push(`rewrite "${rule.source}" aliases a removed API path`)
    }

    if (/\/api\//.test(rule.destination ?? '')) {
      budgetProblems.push(`rewrite "${rule.source}" targets an API path`)
    }
  }
}

// Client code must call the consolidated endpoints, and only those.
for (const path of walk(join(ROOT, 'src'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text !== null && /['"`]\/api\/(admin|device)-(login|session|logout)['"`]/.test(text)) {
    budgetProblems.push(`${rel(path)} still calls a removed API path`)
  }
}

// The firewall doc must name the consolidated POST endpoints.
const firewallDoc = readText(join(ROOT, 'docs/VERCEL_FIREWALL.md'))

if (firewallDoc === null) {
  budgetProblems.push('docs/VERCEL_FIREWALL.md could not be read')
} else {
  for (const required of ['/api/admin-auth', '/api/device-auth']) {
    if (!firewallDoc.includes(required)) {
      budgetProblems.push(`docs/VERCEL_FIREWALL.md does not name ${required}`)
    }
  }

  if (/\| `\/api\/(admin|device)-login`/.test(firewallDoc)) {
    budgetProblems.push('docs/VERCEL_FIREWALL.md still rate-limits a removed path')
  }
}

// Operator stays three Functions in this phase; it is the live auth boundary.
for (const file of ['operator-login.ts', 'operator-session.ts', 'operator-logout.ts']) {
  if (!exists(join(ROOT, 'api', file))) {
    budgetProblems.push(`api/${file} was consolidated; Operator Access must stay untouched`)
  }
}

addCheck(
  'function-budget',
  `api/ holds ${String(apiFiles.length)} of ${String(HOBBY_FUNCTION_LIMIT)} Hobby Functions`,
  budgetProblems,
)

// --- G. client code never reads a server-only variable ----------------------
const clientProblems = []
const srcRoot = join(ROOT, 'src')

for (const path of walk(srcRoot)) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text === null) {
    continue
  }

  // A name in a comment or a shared type is fine; READING it is not.
  if (text.includes('process.env')) {
    clientProblems.push(`${rel(path)} reads process.env in client code`)
  }

  for (const name of SERVER_ONLY_NAMES) {
    if (text.includes(`import.meta.env.${name}`)) {
      clientProblems.push(`${rel(path)} reads ${name} in client code`)
    }
  }
}

addCheck(
  'no-server-env-in-client',
  'Client modules never read server environment variables',
  clientProblems,
)

// --- report -----------------------------------------------------------------
const failed = checks.filter((check) => check.status === 'fail')
const ok = failed.length === 0

if (AS_JSON) {
  console.log(JSON.stringify({ ok, root: ROOT, checks }, null, 2))
} else {
  console.log(`Navaratri release check — ${ROOT}\n`)

  for (const check of checks) {
    console.log(`${check.status === 'pass' ? 'PASS' : 'FAIL'}  ${check.title}`)

    for (const problem of check.problems) {
      console.log(`        - ${problem}`)
    }
  }

  console.log(
    ok
      ? '\nAll release checks passed.'
      : `\n${failed.length} check(s) FAILED. Resolve these before deploying.`,
  )
}

process.exit(ok ? 0 : 1)
