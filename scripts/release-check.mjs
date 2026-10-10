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
  'EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64',
  'EVENT_ADMIN_ACCESS_CODE',
  'EVENT_ADMIN_SESSION_SECRET',
  'EVENT_DEVICE_SESSION_SECRET',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'SYNC_ALLOWED_ORIGIN',
  'SYNC_WRITE_ENABLED',
  'SYNC_ALLOWED_VERCEL_ENV',
]

const CLIENT_NAMES = [
  'VITE_UPI_ID',
  'VITE_UPI_PAYEE_NAME',
  // Intentionally public: the VERIFICATION half of the offline lease key.
  'VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64',
]

const REQUIRED_FILES = [
  '.env.example',
  'AGENTS.md',
  'README.md',
  'package.json',
  'vite.config.ts',
  'api/sync-registration.ts',
  'server/sync/environment.ts',
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
  'src/shared/badge-claim-contract.ts',
  'src/shared/device-offline-authorization.ts',
  'server/device-auth/offline-authorization.ts',
  'src/device-auth/offline-authorization.ts',
  'src/device-auth/offline-lease.ts',
  'src/db/central-offline-authorization.ts',
  'src/device-auth/event-authorization.ts',
  'src/db/device-identity-convergence.ts',
  'src/device-auth/identity-convergence.ts',
  'src/device-auth/device-event-authorization-context.ts',
  'src/components/device-auth/device-event-authorization-provider.tsx',
  'src/components/event-access/event-access-gate.tsx',
  'src/components/event-access/badge-ownership-block.tsx',
  'src/components/event-access/device-access-required.tsx',
  'server/sync/device-authorization.ts',
  'server/badge-assignments/conflicts.ts',
  'server/db/constraints.ts',
  'src/device-auth/device-session-contract.ts',
  'src/db/central-enrollment.ts',
  'src/db/central-badge-range.ts',
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

const ADMIN_COOKIE = '__Host-navaratri_admin_session'
const DEVICE_COOKIE = '__Host-navaratri_device_session'

const adminCookieSource = readText(join(ROOT, 'server/admin-auth/cookies.ts'))
const deviceCookieSource = readText(join(ROOT, 'server/device-auth/cookies.ts'))

if (adminCookieSource === null || deviceCookieSource === null) {
  adminProblems.push('a cookie module could not be read')
} else {
  // The two surviving realms must never share a cookie: one credential
  // satisfying both would make an event device an administrator.
  if (!adminCookieSource.includes(ADMIN_COOKIE)) {
    adminProblems.push('the admin cookie name is missing')
  }

  if (adminCookieSource.includes(DEVICE_COOKIE)) {
    adminProblems.push('the admin cookie module references the device cookie')
  }

  if (deviceCookieSource.includes(ADMIN_COOKIE)) {
    adminProblems.push('the device cookie module references the admin cookie')
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

  for (const foreign of ['navaratri_admin_session']) {
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
   * device auth client and its components ONLY — no event page and no sync
   * module may reach them.
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

/**
 * Phase D2 made the central device the SOLE event authority and retired the
 * local provisioning route, so what this guards changed shape:
 *
 * 1. `/device-registration` is a transition-only redirect — no gate, no page,
 *    no writer, and never inside the event shell
 * 2. `/device-login` is still outside the event shell
 * 3. every event module is wrapped in the device authorization gate
 */
const routerSource = readText(join(ROOT, 'src/components/app-router.tsx'))
const gateSource = readText(join(ROOT, 'src/components/event-app-gate.tsx'))

if (routerSource === null || gateSource === null) {
  deviceRealmProblems.push('the router or event gate could not be read')
} else {
  const router = stripComments(routerSource)

  const deviceRegistrationRoute = /ROUTES\.deviceRegistration\}>([\s\S]*?)<\/Route>/
    .exec(router)?.[1] ?? ''

  if (!/<Redirect to=\{ROUTES\.deviceLogin\} \/>/.test(deviceRegistrationRoute)) {
    deviceRealmProblems.push('/device-registration is not a redirect to Device Sign-In')
  }

  if (/EventAccessGate|EventAppGate|DeviceRegistrationPage/.test(deviceRegistrationRoute)) {
    deviceRealmProblems.push('/device-registration still mounts a page or a gate')
  }

  // Every event module authorizes through the one device gate.
  const shell = /<EventAppGate>([\s\S]*?)<\/EventAppGate>/.exec(router)?.[1] ?? ''

  if (shell === '') {
    deviceRealmProblems.push('the event shell could not be located in the router')
  } else {
    const modules = [...shell.matchAll(/<Route path=\{([^}]*)\}>/g)].map((match) => match[1])
    const gated = [...shell.matchAll(/<EventAccessGate module="/g)]

    if (modules.length !== gated.length) {
      deviceRealmProblems.push(
        `${String(modules.length)} event routes but ${String(gated.length)} device gates`,
      )
    }
  }

  const routerBody = router.slice(router.indexOf('<Switch>'))

  if (/<EventAppGate>[\s\S]*[Dd]eviceLogin/.test(routerBody)) {
    deviceRealmProblems.push('/device-login is nested inside the event shell')
  }
}

addCheck(
  'device-realm',
  'Device auth is a separate realm; /device-registration is a retired redirect',
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

// Device sign-in stays its own realm, outside the event shell.
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

  /**
   * Phase 9C-C2A lets this UI DISPLAY local badge state beside the central
   * assignment, which it must in order to show a range conflict. What it may
   * not do is write it: no component opens the database or calls the Phase 7
   * badge writer. The one adoption write lives in the domain helper, which
   * `release:check` audits separately.
   */
  if (/configureBadgeDistribution\(|registerDevice\(/.test(code)) {
    enrollmentProblems.push(`${rel(path)} calls a device configuration writer`)
  }

  /**
   * Phase 9C-C3B's authorization provider must READ the config row to
   * evaluate badge ownership, so importing the database is no longer the
   * thing to forbid. WRITING is: no device UI may alter local state, and the
   * registrations and outbox tables are none of its business at all.
   */
  if (/db\.config\.(put|update|add|delete)|db\.transaction\(|db\.(registrations|outbox)\./
    .test(code)) {
    enrollmentProblems.push(`${rel(path)} writes to the database directly`)
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
  'device-badge-claim.ts',
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

/**
 * Phase D2 DELETED the operator realm. These three paths must not come back:
 * re-adding one would both reintroduce a second event authority and spend
 * deployment Functions this checkpoint has accounted for.
 */
for (const file of ['operator-login.ts', 'operator-session.ts', 'operator-logout.ts']) {
  if (exists(join(ROOT, 'api', file))) {
    budgetProblems.push(`api/${file} was retired by Phase D2 and must not return`)
  }
}

// --- I. central badge range adoption stays safe and explicit ---------------
/**
 * Central Postgres records which badge numbers a device OWNS. `nextBadge` stays
 * local, because issuing a badge must work with no network. Adoption copies the
 * range once, deliberately, and nothing about it may become automatic.
 */
const adoptionProblems = []
const adoptionSource = readText(join(ROOT, 'src/db/central-badge-range.ts'))
const typesSource = readText(join(ROOT, 'src/db/types.ts'))

if (adoptionSource === null || typesSource === null) {
  adoptionProblems.push('the adoption domain or the config model could not be read')
} else {
  const code = stripComments(adoptionSource)

  // The binding is provenance, never a second allocator or a credential.
  const bindingShape = /export interface CentralBadgeRangeBinding \{([\s\S]*?)\n\}/
    .exec(typesSource)?.[1] ?? ''

  if (bindingShape === '') {
    adoptionProblems.push('CentralBadgeRangeBinding is not declared')
  }

  for (const forbidden of ['nextBadge', 'password', 'token', 'cookie', 'sessionVersion', 'salt']) {
    if (bindingShape.includes(forbidden)) {
      adoptionProblems.push(`CentralBadgeRangeBinding carries ${forbidden}`)
    }
  }

  // C1's rule stands: the enrollment never holds the range.
  const enrollmentShape = /export interface CentralDeviceEnrollment \{([\s\S]*?)\n\}/
    .exec(typesSource)?.[1] ?? ''

  for (const forbidden of ['activeBadgeRange', 'rangeStart', 'rangeEnd', 'badgeStart', 'badgeEnd']) {
    if (enrollmentShape.includes(forbidden)) {
      adoptionProblems.push(`CentralDeviceEnrollment carries ${forbidden}`)
    }
  }

  /**
   * Local identity is never overwritten by a central value.
   *
   * Audited at the point of truth: the object literals that are typed
   * `EventConfig` and handed to `db.config.put`. The binding legitimately
   * holds the central `deviceId` — that is its purpose — but the config row's
   * own `deviceId` and `deviceName` must never be assigned from the session.
   */
  const configLiterals = [...code.matchAll(/:\s*EventConfig\s*=\s*\{([\s\S]*?)\n\s*\}/g)]
    .map((match) => match[1])

  if (configLiterals.length === 0) {
    adoptionProblems.push('no EventConfig write could be located for auditing')
  }

  for (const literal of configLiterals) {
    for (const forbidden of ['deviceId:', 'deviceName:', 'deviceConfiguredAt:']) {
      if (literal.includes(forbidden)) {
        adoptionProblems.push(`adoption writes ${forbidden} onto the config row`)
      }
    }
  }

  // Config-only: registrations and the outbox are read, never written.
  if (/db\.registrations\.(put|add|update|delete|clear)|db\.outbox\./.test(code)) {
    adoptionProblems.push('adoption mutates registrations or the outbox')
  }

  /**
   * ONE TRANSACTION PER WRITER, so a range and its provenance can never land
   * separately. Phase D2.1 added the second writer — the contiguous
   * extension — and each is checked by name rather than by a bare count,
   * which two transactions in one function would also satisfy.
   */
  const RANGE_WRITERS = ['adoptCentralBadgeRange', 'extendLocalBadgeRange']

  if ((code.match(/db\.transaction\(/g) ?? []).length !== RANGE_WRITERS.length) {
    adoptionProblems.push(
      `${String(RANGE_WRITERS.length)} local badge-range transactions expected, found ` +
      String((code.match(/db\.transaction\(/g) ?? []).length),
    )
  }

  for (const writer of RANGE_WRITERS) {
    const body = code.slice(code.indexOf(`export const ${writer} = async`))

    if (body === '' || !/^[\s\S]{0,400}db\.transaction\(/.test(body)) {
      adoptionProblems.push(`${writer} does not open a transaction of its own`)
    }
  }

  /**
   * THE EXTENSION NEVER TOUCHES THE COUNTER. `nextBadge` is the local
   * allocator and its existing value is authoritative: a desk part-way
   * through its range that receives more badges keeps its place, and
   * recomputing from the new batch's start would skip every badge between.
   */
  const extensionBody = code.slice(
    code.indexOf('export const extendLocalBadgeRange = async'),
  )

  if (/nextBadge/.test(extensionBody)) {
    adoptionProblems.push('the range extension reads or writes nextBadge')
  }

  for (const forbidden of ['badgeStart:', 'badgeConfiguredAt:', 'rangeStart:', 'assignedAt:']) {
    if (extensionBody.includes(forbidden)) {
      adoptionProblems.push(`the range extension writes ${forbidden}`)
    }
  }

  // No central write is reachable from the browser's adoption path.
  if (/fetch\(|method: '(POST|PATCH|PUT|DELETE)'/.test(code)) {
    adoptionProblems.push('adoption issues a network request')
  }
}

// Adoption must never be triggered by signing in or by a session refresh.
const enrollmentPanel = readText(
  join(ROOT, 'src/components/device-auth/device-enrollment-panel.tsx'),
)

if (enrollmentPanel === null) {
  adoptionProblems.push('the device enrollment panel could not be read')
} else {
  const code = stripComments(enrollmentPanel)

  if ((code.match(/adoptCentralBadgeRange\(/g) ?? []).length !== 1) {
    adoptionProblems.push('adoption is called from more than one place')
  }

  if (/saved\.outcome === 'saved'[\s\S]{0,400}adoptCentralBadgeRange/.test(code)) {
    adoptionProblems.push('a successful sign-in adopts the central range automatically')
  }

  // Signing out is auth only; adopted badge state is durable local state.
  if (/clearCentralBadgeRange|centralBadgeRangeBinding:\s*undefined/.test(code)) {
    adoptionProblems.push('sign-out or clear removes the adopted badge state')
  }
}

// Range creation has exactly one endpoint; the alternatives never appeared.
for (const name of ['device-badge-assignment.ts', 'device-claim-range.ts', 'device-range.ts']) {
  if (exists(join(ROOT, 'api', name))) {
    adoptionProblems.push(`api/${name} is a second badge-range endpoint`)
  }
}

addCheck(
  'central-badge-adoption',
  'A central badge range is adopted locally only by an explicit operator action',
  adoptionProblems,
)

// --- I2. authenticated online badge-range self-claim ----------------------
/**
 * A device may reserve a badge range centrally while online. Postgres decides
 * OWNERSHIP; the local `nextBadge` remains the allocator, because issuing a
 * badge must work with no network.
 */
const selfClaimProblems = []
const CLAIM_ENDPOINT = 'api/device-badge-claim.ts'
const claimSource = readText(join(ROOT, CLAIM_ENDPOINT))
const reserveSource = readText(join(ROOT, 'server/badge-assignments/reserve.ts'))
const claimRequestSource = readText(join(ROOT, 'server/device-auth/requests.ts'))
const claimFlowSource = readText(join(ROOT, 'src/device-auth/badge-claim.ts'))

if (claimSource === null || reserveSource === null || claimRequestSource === null ||
    claimFlowSource === null) {
  selfClaimProblems.push('the self-claim endpoint, writer, validator or flow could not be read')
} else {
  const endpoint = stripComments(claimSource)
  const validator = stripComments(claimRequestSource)
  const flow = stripComments(claimFlowSource)

  /**
   * The METHOD surface. Phase D2.1 added PATCH for the contiguous refill —
   * the same question asked twice, on one Function rather than two, because
   * every file under `api/` costs a deployment Function. GET, PUT and DELETE
   * have no business here, and nothing else under `api/` touches a range.
   */
  if (/export (async )?function (GET|PUT|DELETE)\(/.test(endpoint)) {
    selfClaimProblems.push(`${CLAIM_ENDPOINT} exports a method other than POST or PATCH`)
  }

  if (!/export async function PATCH\(/.test(endpoint)) {
    selfClaimProblems.push(`${CLAIM_ENDPOINT} does not expose the contiguous refill`)
  }

  // IDENTITY COMES FROM THE COOKIE, never from the body.
  if (!/authorizeDeviceRequest\(/.test(endpoint)) {
    selfClaimProblems.push(`${CLAIM_ENDPOINT} does not authenticate the device session`)
  }

  if (!/authorized\.context/.test(endpoint)) {
    selfClaimProblems.push(`${CLAIM_ENDPOINT} does not take its identity from the session context`)
  }

  for (const field of ['deviceId', 'eventId', 'eventSlug', 'loginName']) {
    // Any read of an identity field off a request-shaped value. The endpoint
    // legitimately WRITES `deviceId:`/`eventId:` when it reserves, from the
    // session context — what it may never do is read one from the caller.
    if (new RegExp(`\\b(body|raw|payload|parsed|json|claim)\\b[^\\n]{0,60}\\.${field}\\b`).test(endpoint) ||
        new RegExp(`${field}[^\\n]{0,40}=[^\\n]{0,40}\\b(body|raw|payload|parsed|json)\\b`).test(endpoint)) {
      selfClaimProblems.push(`${CLAIM_ENDPOINT} reads ${field} from the request body`)
    }

    if (!new RegExp(`'${field}'`).test(validator)) {
      selfClaimProblems.push(`the claim validator does not refuse a ${field} field`)
    }
  }

  // The two server-side preconditions that cannot be delegated to a browser.
  if (!/BADGE_RANGE_REQUIRED_ATTRIBUTE|'registration'/.test(endpoint)) {
    selfClaimProblems.push(`${CLAIM_ENDPOINT} does not require Registration server-side`)
  }

  if (!/physicalStackConfirmed !== true/.test(validator)) {
    selfClaimProblems.push('the claim validator does not require an exact physical confirmation')
  }

  // The confirmation is a mutation guard, never persisted.
  for (const [file, text] of [
    ['server/db/schema.ts', readText(join(ROOT, 'server/db/schema.ts')) ?? ''],
    ['server/badge-assignments/reserve.ts', reserveSource],
  ]) {
    if (/physical_?[sS]tack|physical_confirmed|physicalStackConfirmed/.test(text)) {
      selfClaimProblems.push(`${file} persists the physical-stack confirmation`)
    }
  }

  // ONE central writer, shared with Admin.
  const inserters = [...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'api'))]
    .filter((path) => extname(path) === '.ts')
    .filter((path) => /insert\(badgeAssignments\)/.test(stripComments(readText(path) ?? '')))
    .map((path) => rel(path))

  if (inserters.length !== 1 || inserters[0] !== 'server/badge-assignments/reserve.ts') {
    selfClaimProblems.push(
      `central badge assignments are inserted in ${String(inserters.length)} place(s): ${inserters.join(', ')}`,
    )
  }

  const registrySource = readText(join(ROOT, 'server/admin/registry.ts')) ?? ''

  if (!/reserveBadgeRange\(/.test(stripComments(registrySource))) {
    selfClaimProblems.push('Admin does not use the shared central reservation primitive')
  }

  // Central ownership is a RANGE. There is no central counter.
  for (const name of ['next_badge', 'nextBadge', 'last_issued_badge', 'claimed_count']) {
    if (stripComments(reserveSource).includes(name)) {
      selfClaimProblems.push(`the central reservation primitive carries ${name}`)
    }
  }

  // No attendee data is introduced centrally.
  for (const name of ['attendee', 'normalizedName', 'paymentMethod']) {
    if (stripComments(reserveSource).includes(name) || endpoint.includes(name)) {
      selfClaimProblems.push(`the self-claim path names attendee data (${name})`)
    }
  }

  // A central range is never released, by anyone.
  for (const path of [...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'api')), ...walk(join(ROOT, 'src'))]) {
    if (extname(path) !== '.ts' && extname(path) !== '.tsx') {
      continue
    }

    if (/releaseBadgeRange|releasedAt:\s*new Date|\.set\(\{\s*releasedAt/
      .test(stripComments(readText(path) ?? ''))) {
      selfClaimProblems.push(`${rel(path)} releases a central badge range`)
    }
  }

  // C2A stays the ONLY local badge-range adoption writer.
  if (/db\.config|db\.transaction|badgeStart:|badgeEnd:|nextBadge:/.test(flow)) {
    selfClaimProblems.push('the claim flow writes local badge state directly')
  }

  if (!/adoptCentralBadgeRange\(/.test(flow)) {
    selfClaimProblems.push('the claim flow does not reuse the C2A adoption transaction')
  }

  // The local preflight runs BEFORE the central reservation.
  if (!/checkCentralBadgeRangeClaimable\(/.test(flow)) {
    selfClaimProblems.push('the claim flow does not run the local preflight')
  }

  /**
   * Scanned from the function BODY, not the module: the import list names
   * both helpers before either is called, so comparing positions in the whole
   * file would compare two import lines and always pass.
   */
  const flowBody = flow.slice(flow.indexOf('export const claimCentralBadgeRange'))

  if (flowBody.indexOf('checkCentralBadgeRangeClaimable') === -1 ||
      flowBody.indexOf('claimDeviceBadgeRange(') === -1 ||
      flowBody.indexOf('checkCentralBadgeRangeClaimable') > flowBody.indexOf('claimDeviceBadgeRange(')) {
    selfClaimProblems.push('the claim flow reserves centrally before checking local state')
  }

  if (flowBody.indexOf('claimDeviceBadgeRange(') > flowBody.indexOf('adoptCentralBadgeRange(')) {
    selfClaimProblems.push('the claim flow adopts locally before the central reservation')
  }

  // Online only, and never polled.
  if (/setInterval|setTimeout|navigator\.onLine/.test(flow)) {
    selfClaimProblems.push('the claim flow polls, retries on a timer or guesses connectivity')
  }

  for (const path of walk(join(ROOT, 'src'))) {
    if (!isTextFile(basename(path))) {
      continue
    }

    const text = stripComments(readText(path) ?? '')

    if (/device-badge-claim/.test(text) && rel(path) !== 'src/device-auth/device-api.ts') {
      selfClaimProblems.push(`${rel(path)} names the claim endpoint outside the device client`)
    }

    // A Postgres constraint name is a server detail and never a wire value.
    if (/badge_assignments_|devices_event_id_login_name_key|events_slug_key/.test(text)) {
      selfClaimProblems.push(`${rel(path)} exposes an internal constraint name to the browser`)
    }
  }

  /**
   * The internal-to-public conflict translation must exist in ONE place, and
   * the client must recognise the public spelling by the SHARED definition
   * rather than by a literal it keeps in step by hand.
   */
  const conflictsSource = stripComments(
    readText(join(ROOT, 'server/badge-assignments/conflicts.ts')) ?? '',
  )
  const clientSource = stripComments(readText(join(ROOT, 'src/device-auth/device-api.ts')) ?? '')

  if (!/PUBLIC_BADGE_CLAIM_CONFLICT/.test(conflictsSource)) {
    selfClaimProblems.push('the internal-to-public conflict translation is missing')
  }

  if (!/PUBLIC_BADGE_CLAIM_CONFLICT/.test(endpoint)) {
    selfClaimProblems.push(`${CLAIM_ENDPOINT} does not translate conflicts through the shared map`)
  }

  if (!/isBadgeClaimConflict/.test(clientSource)) {
    selfClaimProblems.push('the claim client does not parse the conflict with the shared guard')
  }

  /**
   * Drizzle rethrows every driver error wrapped, with the real Postgres error
   * on `cause`. A reader that inspects only the top level maps NOTHING in
   * production while passing every test built on a bare error object — which
   * is how an overlapping badge range reached an operator as an unexpected
   * response.
   */
  const constraintReader = stripComments(
    readText(join(ROOT, 'server/db/constraints.ts')) ?? '',
  )

  if (!/\.cause/.test(constraintReader)) {
    selfClaimProblems.push('the constraint reader does not follow the wrapped error cause')
  }
}

addCheck(
  'badge-self-claim',
  'A device may claim a badge range centrally only while authenticated and online',
  selfClaimProblems,
)

// --- I2b. contiguous badge refill -----------------------------------------
/**
 * A desk that runs out of badges receives more and EXTENDS the range it
 * already owns, upward and contiguously. It is not a second range, not a
 * replacement, and not a release: the assignment keeps its identity, so every
 * badge already issued stays owned by the same device and every queued outbox
 * snapshot stays valid.
 *
 * The three things that would make it dangerous, guarded here: a blind write
 * instead of a compare-and-set, a local counter reset, and a central range
 * reinterpreted as an extension when it is something else.
 */
const refillProblems = []
const refillEndpointSource = readText(join(ROOT, CLAIM_ENDPOINT))
const refillWriterSource = readText(join(ROOT, 'server/badge-assignments/reserve.ts'))
const refillValidatorSource = readText(join(ROOT, 'server/device-auth/requests.ts'))
const refillFlowSource = readText(join(ROOT, 'src/device-auth/badge-refill.ts'))
const refillDomainSource = readText(join(ROOT, 'src/db/central-badge-range.ts'))

if (refillEndpointSource === null || refillWriterSource === null ||
    refillValidatorSource === null || refillFlowSource === null ||
    refillDomainSource === null) {
  refillProblems.push('the refill endpoint, writer, validator, flow or domain could not be read')
} else {
  const endpoint = stripComments(refillEndpointSource)
  const writer = stripComments(refillWriterSource)
  const validator = stripComments(refillValidatorSource)
  const flow = stripComments(refillFlowSource)
  const domain = stripComments(refillDomainSource)

  /**
   * THE COMPARE-AND-SET. The expected end is part of the WHERE clause, so two
   * callers racing to extend the same assignment cannot both win. A SELECT
   * followed by a blind UPDATE would pass every single-threaded test and lose
   * a range to the second writer in production.
   */
  const extender = writer.slice(writer.indexOf('export const extendActiveBadgeRange'))

  if (extender === '') {
    refillProblems.push('the central range extender is missing')
  } else {
    if (!/eq\(badgeAssignments\.rangeEnd, input\.expectedRangeEnd\)/.test(extender)) {
      refillProblems.push('the central extension is not guarded by the expected range end')
    }

    if (!/isNull\(badgeAssignments\.releasedAt\)/.test(extender)) {
      refillProblems.push('the central extension can touch a released assignment')
    }

    // ONLY `range_end` moves. Everything else is the assignment's identity.
    const patch = /\.set\(\{([\s\S]*?)\}\)/.exec(extender)?.[1] ?? ''

    if (!/rangeEnd:/.test(patch)) {
      refillProblems.push('the central extension does not set rangeEnd')
    }

    for (const forbidden of ['rangeStart', 'assignedAt', 'deviceId', 'eventId', 'releasedAt']) {
      if (patch.includes(forbidden)) {
        refillProblems.push(`the central extension sets ${forbidden}`)
      }
    }

    // A refill adds to a range; it never creates a second one.
    if (/insert\(badgeAssignments\)/.test(extender)) {
      refillProblems.push('the central extension inserts a second assignment row')
    }
  }

  // The DATABASE remains the authority for cross-device races.
  if (!/mapBadgeReservationConflict\(/.test(extender)) {
    refillProblems.push('the central extension does not translate a constraint violation')
  }

  /**
   * The operator chooses only the new END. `rangeStart` is derived from the
   * current end, and `nextBadge` is local — a field the server could start
   * reading is a field that would eventually be read.
   */
  for (const field of ['deviceId', 'eventId', 'eventSlug', 'loginName', 'rangeStart', 'nextBadge']) {
    if (!new RegExp(`'${field}'`).test(validator)) {
      refillProblems.push(`the refill validator does not refuse a ${field} field`)
    }
  }

  if (!/newRangeEnd <= expectedRangeEnd/.test(validator)) {
    refillProblems.push('the refill validator accepts an end that is not an increase')
  }

  if (!/physicalStackConfirmed !== true/.test(validator)) {
    refillProblems.push('the refill validator does not require an exact physical confirmation')
  }

  // The endpoint still requires Registration from CURRENT central state.
  const patchHandler = endpoint.slice(endpoint.indexOf('export async function PATCH'))

  if (patchHandler === '') {
    refillProblems.push('the refill endpoint does not expose PATCH')
  } else {
    if (!/authorizeDeviceRequest\(request, \{ mutating: true \}\)/.test(patchHandler)) {
      refillProblems.push('the refill endpoint does not authenticate a mutating device request')
    }

    if (!/BADGE_RANGE_REQUIRED_ATTRIBUTE/.test(patchHandler)) {
      refillProblems.push('the refill endpoint does not require Registration server-side')
    }

    if (/nextBadge/.test(patchHandler)) {
      refillProblems.push('the refill endpoint names nextBadge')
    }
  }

  /**
   * THE LOCAL WRITE IS THE DOMAIN'S, and the flow orders the two halves so a
   * failure leaves the least damage: preflight, then central, then local.
   * Reserving first and discovering a local disagreement afterwards would
   * leave a desk owning numbers it cannot issue, and nothing shrinks a
   * central range.
   */
  if (/db\.config\.put|db\.transaction|badgeEnd:|nextBadge:/.test(flow)) {
    refillProblems.push('the refill flow writes local badge state directly')
  }

  const flowBody = flow.slice(flow.indexOf('export const refillCentralBadgeRange'))

  for (const [label, needle] of [
    ['the local preflight', 'planCentralBadgeRangeRefill('],
    ['the central extension', 'refillDeviceBadgeRange('],
    ['the local extension', 'extendLocalBadgeRange('],
  ]) {
    if (flowBody.indexOf(needle) === -1) {
      refillProblems.push(`the refill flow does not run ${label}`)
    }
  }

  if (flowBody.indexOf('planCentralBadgeRangeRefill(') >
      flowBody.indexOf('refillDeviceBadgeRange(')) {
    refillProblems.push('the refill flow extends centrally before checking local state')
  }

  if (flowBody.indexOf('refillDeviceBadgeRange(') > flowBody.indexOf('extendLocalBadgeRange(')) {
    refillProblems.push('the refill flow extends locally before the central extension')
  }

  if (/setInterval|setTimeout|navigator\.onLine/.test(flow)) {
    refillProblems.push('the refill flow polls, retries on a timer or guesses connectivity')
  }

  /**
   * THE SAFE-SUPERSET RULE, which is both the normal post-success check and
   * the recovery check. Every clause is load-bearing, so each is pinned:
   * same start (or badges already issued would belong to numbers this desk no
   * longer owns), same grant, and a STRICT increase so a range is never
   * decreased.
   */
  const superset = domain.slice(
    domain.indexOf('export const checkCentralRangeSuperset'),
    domain.indexOf('export const planCentralBadgeRangeRefill'),
  )

  if (superset === '') {
    refillProblems.push('the safe-superset rule is missing')
  } else {
    for (const [label, pattern] of [
      ['the central device', /binding\.deviceId !== context\.device\.id/],
      ['the central event', /binding\.eventId !== context\.event\.id/],
      ['the range start', /binding\.rangeStart !== central\.rangeStart/],
      ['the grant timestamp', /binding\.assignedAt !== central\.assignedAt/],
      ['a strict increase', /central\.rangeEnd <= config\.badgeEnd/],
    ]) {
      if (!pattern.test(superset)) {
        refillProblems.push(`the safe-superset rule does not check ${label}`)
      }
    }

    if (/nextBadge/.test(superset)) {
      refillProblems.push('the safe-superset rule reads nextBadge')
    }
  }

  // The refill planner asks the CANONICAL ownership check, not a copy.
  if (!/checkBadgeOwnership\(/.test(domain)) {
    refillProblems.push('the refill planner does not reuse the canonical badge-safety check')
  }

  // D2.1 changes no stored contract.
  const dexie = stripComments(readText(join(ROOT, 'src/db/database.ts')) ?? '')

  if (!/DATABASE_VERSION = 1\b/.test(dexie)) {
    refillProblems.push('the refill phase changed the IndexedDB version')
  }

  for (const column of ['range_end', 'refill', 'extended_at']) {
    if (new RegExp(`'${column}'`).test(stripComments(readText(join(ROOT, 'server/db/schema.ts')) ?? ''))
        && column !== 'range_end') {
      refillProblems.push(`the refill phase added a ${column} column`)
    }
  }
}

addCheck(
  'badge-refill',
  'A device extends its own badge range upward, contiguously, and only while online',
  refillProblems,
)

// --- I3. the signed offline authorization lease ---------------------------
/**
 * A server-signed statement of what a device was allowed to do, verified in
 * the browser with the PUBLIC half of a P-256 pair. It authorizes LOCAL
 * decisions until it expires; no endpoint accepts it as a credential.
 */
const offlineProblems = []
const PRIVATE_KEY_NAME = 'EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64'
const offlineIssuer = readText(join(ROOT, 'server/device-auth/offline-authorization.ts'))
const offlineShared = readText(join(ROOT, 'src/shared/device-offline-authorization.ts'))
const offlineVerifier = readText(join(ROOT, 'src/device-auth/offline-authorization.ts'))

if (offlineIssuer === null || offlineShared === null || offlineVerifier === null) {
  offlineProblems.push('the offline authorization issuer, contract or verifier is missing')
} else {
  // The SIGNING key is server-only. Browser code may not even name it.
  for (const path of walk(join(ROOT, 'src'))) {
    if (!isTextFile(basename(path))) {
      continue
    }

    const text = readText(path) ?? ''

    if (text.includes(PRIVATE_KEY_NAME)) {
      offlineProblems.push(`${rel(path)} names the offline signing key`)
    }

    if (/PRIVATE KEY|createPrivateKey|dsaEncoding|node:crypto/.test(stripComments(text))) {
      offlineProblems.push(`${rel(path)} carries private-key or signing material`)
    }
  }

  // Asymmetric, so the browser can verify without being able to sign.
  if (!/ECDSA/.test(offlineVerifier) || !/'verify'/.test(offlineVerifier)) {
    offlineProblems.push('the browser verifier is not an asymmetric verify-only path')
  }

  if (/createHmac|HMAC/.test(stripComments(offlineIssuer))) {
    offlineProblems.push('the offline lease is signed with an HMAC rather than a key pair')
  }

  // WebCrypto accepts only the raw r‖s signature encoding.
  if (!/ieee-p1363/.test(offlineIssuer)) {
    offlineProblems.push('the issuer does not emit the WebCrypto signature encoding')
  }

  // Minimal claims: no credential, no attendee data, no allocator.
  const claimsShape = /export interface DeviceOfflineClaims \{([\s\S]*?)\n\}/
    .exec(offlineShared)?.[1] ?? ''

  if (claimsShape === '') {
    offlineProblems.push('DeviceOfflineClaims is not declared')
  }

  for (const forbidden of [
    'nextBadge', 'password', 'passwordHash', 'token', 'cookie', 'sessionVersion',
    'phone', 'attendee', 'name:', 'age', 'gender', 'payment',
  ]) {
    if (claimsShape.includes(forbidden)) {
      offlineProblems.push(`the offline lease claims carry ${forbidden}`)
    }
  }

  // Offline authority always expires, and never outlives the event.
  if (!/MAX_DEVICE_OFFLINE_LEASE_SECONDS = 24 \* 60 \* 60/.test(offlineShared)) {
    offlineProblems.push('the offline lease has no 24 hour maximum')
  }

  if (!/eventEndsAt/.test(offlineIssuer) || !/Math\.min/.test(offlineIssuer)) {
    offlineProblems.push('the offline lease expiry is not capped by the event end')
  }

  // The lease is never a server credential.
  for (const file of readdirSync(join(ROOT, 'api'))) {
    if (!file.endsWith('.ts')) {
      continue
    }

    const code = stripComments(readText(join(ROOT, 'api', file)) ?? '')

    if (/verifyOfflineAuthorization|offline-lease|Bearer/.test(code)) {
      offlineProblems.push(`api/${file} treats the offline lease as authentication`)
    }
  }

  // Phase 9C-C3A is foundation only: no route may consult it.
  for (const file of [
    'src/components/event-app-gate.tsx',
    'src/components/app-router.tsx',
  ]) {
    const code = stripComments(readText(join(ROOT, file)) ?? '')

    if (/offline-lease|verifyOfflineAuthorization|offlineAuthorization/.test(code)) {
      offlineProblems.push(`${file} authorizes a route from the offline lease`)
    }
  }

  // No heartbeat: the lease refreshes on operations that already happen.
  for (const file of [
    'src/device-auth/offline-lease.ts',
    'src/device-auth/offline-authorization.ts',
    'src/components/device-auth/device-enrollment-panel.tsx',
  ]) {
    const code = stripComments(readText(join(ROOT, file)) ?? '')

    if (/setInterval|setTimeout\(/.test(code)) {
      offlineProblems.push(`${file} polls or revalidates on a timer`)
    }
  }

  // A network failure is not a revocation.
  const panel = stripComments(
    readText(join(ROOT, 'src/components/device-auth/device-enrollment-panel.tsx')) ?? '',
  )

  /**
   * Sliced to the BRANCH, not matched across it: the two cases sit next to
   * each other, so a window-based regex would read the definitive branch's
   * revocation as the unreachable branch's and report the opposite of the
   * truth.
   */
  const unreachableStart = panel.indexOf("session.status === 'unreachable'")
  const definitiveStart = panel.indexOf("session.status === 'unauthenticated'")

  if (unreachableStart === -1 || definitiveStart === -1 || definitiveStart < unreachableStart) {
    offlineProblems.push('the offline revocation branches could not be located')
  } else {
    if (/revokeOfflineAuthorization/.test(panel.slice(unreachableStart, definitiveStart))) {
      offlineProblems.push('an unreachable server clears the offline lease')
    }

    if (!/revokeOfflineAuthorization/.test(panel.slice(definitiveStart))) {
      offlineProblems.push('a definitively rejected session does not clear the offline lease')
    }
  }
}

addCheck(
  'device-offline-authorization',
  'The offline authorization lease is signed, expiring, and never a server credential',
  offlineProblems,
)

// --- I4. device-authorized event operations -------------------------------
/**
 * The central device is the SOLE event authority — live online, or from a
 * verified signed lease offline. Phase D2 removed the operator realm, so
 * there is no fallback left to guard against: what this now proves is that
 * none has come back, and that identity equality never stands in for a
 * grant.
 */
const eventAuthProblems = []
const authDomain = readText(join(ROOT, 'src/device-auth/event-authorization.ts'))
const authProvider = readText(
  join(ROOT, 'src/components/device-auth/device-event-authorization-provider.tsx'),
)
const authRuntime = readText(join(ROOT, 'src/device-auth/event-authorization-runtime.ts'))
const authGate = readText(join(ROOT, 'src/components/event-access/event-access-gate.tsx'))
const blockUi = readText(join(ROOT, 'src/components/event-access/badge-ownership-block.tsx'))
const syncDeviceAuth = readText(join(ROOT, 'server/sync/device-authorization.ts'))
const syncEndpoint = readText(join(ROOT, 'api/sync-registration.ts'))

if (authDomain === null || authProvider === null || authRuntime === null ||
    authGate === null || blockUi === null || syncDeviceAuth === null ||
    syncEndpoint === null) {
  eventAuthProblems.push('the event authorization domain, provider, gate or sync path is missing')
} else {
  const domain = stripComments(authDomain)
  const provider = stripComments(authProvider)
  const runtime = stripComments(authRuntime)
  const gate = stripComments(authGate)
  const sync = stripComments(syncEndpoint)

  // Authority comes from a live session or a VERIFIED lease. Nothing else.
  if (/localStorage|sessionStorage|isRegistered|isTrusted/.test(domain)) {
    eventAuthProblems.push('event authorization reads an unsigned local flag')
  }

  if (!/grantFromDeviceSession/.test(domain) || !/grantFromOfflineClaims/.test(domain)) {
    eventAuthProblems.push('event authorization does not normalise both authority sources')
  }

  if (!/readVerifiedLease/.test(runtime) || !/cached\.status === 'valid'/.test(runtime)) {
    eventAuthProblems.push('a cached lease is used without verifying it')
  }

  /**
   * THE LEASE EXPIRY PATH IS LOCAL ONLY.
   *
   * A timer that fires because a local clock passed a number must not talk
   * to a server: offline it would fail pointlessly, and online it would
   * quietly become the heartbeat this design does not have. The two triggers
   * once shared a counter, and expiry silently issued a session check.
   */
  const localPath = runtime.slice(runtime.indexOf('export const resolveFromCachedLease'))

  if (localPath === '') {
    eventAuthProblems.push('there is no local-only authorization path')
  } else if (/checkSession|getDeviceSession|fetch\(/.test(localPath)) {
    eventAuthProblems.push('the local authorization path performs a session check')
  }

  const expiryEffect = provider.slice(
    provider.indexOf('const expiresAt'), provider.indexOf('const refresh'))

  if (!/resolveFromCachedLease/.test(expiryEffect)) {
    eventAuthProblems.push('the lease expiry timer does not resolve locally')
  }

  if (/resolveFromServer|setSessionAttempt|fetch\(/.test(expiryEffect)) {
    eventAuthProblems.push('the lease expiry timer triggers an online session check')
  }

  // Authority ends AT the signed expiry, never after a grace period.
  const clockRule = stripComments(
    readText(join(ROOT, 'src/shared/device-offline-authorization.ts')) ?? '',
  )

  if (/exp <= nowSeconds - DEVICE_OFFLINE_CLOCK_SKEW_SECONDS/.test(clockRule)) {
    eventAuthProblems.push('an expired lease is treated as valid for a grace period')
  }

  // The enrollment may restrict authority; it may never create it.
  if (/enrollment !== undefined[\s\S]{0,200}outcome: 'authorized'/.test(domain)) {
    eventAuthProblems.push('a central enrollment alone authorizes a module')
  }

  /**
   * THE GATE HAS NO SECOND AUTHORITY. Phase D2 left exactly three branches —
   * checking, blocked, unavailable — and the last one renders a screen that
   * points at Device Sign-In rather than accepting a credential.
   */
  const blockedStart = gate.indexOf("authorization.outcome === 'blocked'")
  const blockElement = gate.indexOf('<BadgeOwnershipBlock')

  if (blockedStart === -1 || blockElement === -1) {
    eventAuthProblems.push('the gate has no blocked branch')
  } else if (gate.slice(blockedStart, blockElement).includes('<')) {
    // The blocked branch returns the block element and NOTHING around it: a
    // wrapper between the branch and the element would be a fallback.
    eventAuthProblems.push('the blocked branch wraps its screen in another component')
  }

  if (/OperatorAccess|operator-access|accessCode|unlock/i.test(gate)) {
    eventAuthProblems.push('the event access gate reaches for an operator credential')
  }

  for (const offer of ['Continue anyway', 'Use Operator Access', 'Override', 'Force']) {
    if (stripComments(blockUi).includes(offer)) {
      eventAuthProblems.push(`the hard-block screen offers "${offer}"`)
    }
  }

  if (/OperatorAccess|accessCode|unlock/i.test(stripComments(blockUi))) {
    eventAuthProblems.push('the hard-block screen offers an operator credential')
  }

  /**
   * IDENTITY EQUALITY IS A REQUIREMENT, NEVER AUTHORITY. The convergence
   * check takes a grant as its FIRST parameter, so it cannot be reached
   * without one, and the gate asks the evaluator rather than comparing ids
   * for itself.
   */
  if (!/export const checkConvergedDeviceIdentity = \(\s*grant: DeviceOperationalGrant,/
    .test(domain)) {
    eventAuthProblems.push('the identity consistency check does not require a grant')
  }

  const authorizeBody = domain.slice(domain.indexOf('export const authorizeEventModule'))

  if (!/checkConvergedDeviceIdentity\(grant, config\)/.test(authorizeBody)) {
    eventAuthProblems.push('module authorization skips the device identity convergence check')
  }

  /**
   * CALLING IT IS NOT ENFORCING IT. The refusal is matched literally and
   * unconditionally — a canary that kept the call but dropped the `if`, and
   * one that narrowed it to a single module, both passed a looser check.
   */
  const CONVERGENCE_REFUSAL =
    "if (identityGap !== null) { return { outcome: 'unavailable', gap: identityGap } }"
  const flatAuthorize = authorizeBody.replace(/\s+/g, ' ')

  if (!flatAuthorize.includes(CONVERGENCE_REFUSAL)) {
    eventAuthProblems.push('an unconverged identity does not unconditionally refuse')
  }

  // Home is gated by it too: a legacy browser must not reach the launcher.
  if (flatAuthorize.indexOf(CONVERGENCE_REFUSAL) >
      flatAuthorize.indexOf("module === 'home'")) {
    eventAuthProblems.push('the convergence refusal runs after the Home short-circuit')
  }

  if (/config\.deviceId ===/.test(gate + provider + runtime)) {
    eventAuthProblems.push('a component compares device ids instead of asking the evaluator')
  }

  // Authorization never repairs badge state.
  if (/adoptCentralBadgeRange|configureBadgeDistribution|db\.config\.put/
    .test(domain + provider + runtime + gate)) {
    eventAuthProblems.push('event authorization writes or adopts badge state')
  }

  // ONE owner of the session check, and no polling anywhere near it.
  const sessionCallers = walk(join(ROOT, 'src'))
    .filter((path) => isTextFile(basename(path)))
    .filter((path) => /getDeviceSession\(\)/.test(stripComments(readText(path) ?? '')))
    .map((path) => rel(path))

  /**
   * Two callers, and only two: the device-login panel, and Phase D1's
   * pre-migration recheck. The authorization runtime reaches the endpoint
   * through an injected source, not a direct call, which is what keeps its
   * local path provably offline.
   */
  const ALLOWED_SESSION_CALLERS = [
    'src/components/device-auth/device-enrollment-panel.tsx',
    'src/device-auth/identity-convergence.ts',
  ]

  if (sessionCallers.sort().join(', ') !== ALLOWED_SESSION_CALLERS.join(', ')) {
    eventAuthProblems.push(
      `the device session is checked from: ${sessionCallers.join(', ') || 'nowhere'}`,
    )
  }

  if ((runtime.match(/checkSession\(\)/g) ?? []).length !== 1) {
    eventAuthProblems.push('the authorization runtime checks the session more than once')
  }

  if (/setInterval/.test(provider + runtime)) {
    eventAuthProblems.push('the authorization provider polls')
  }

  /**
   * SYNC IS DEVICE-ONLY. Checked inside the HANDLER, not the module, so an
   * import line cannot be mistaken for a call.
   */
  const syncBody = sync.slice(sync.indexOf('export async function POST'))

  if (/operator/i.test(syncBody)) {
    eventAuthProblems.push('the sync handler still mentions operator authorization')
  }

  const firstStatement = syncBody.indexOf('authorizeSyncByDevice(request)')

  if (firstStatement === -1) {
    eventAuthProblems.push('sync does not authorize by device session')
  } else if (/readSyncEnvironment|request\.text\(\)|parseSyncRegistrationRequest/
    .test(syncBody.slice(0, firstStatement))) {
    eventAuthProblems.push('sync reads configuration or the body before authenticating')
  }

  /**
   * HISTORICAL PROVENANCE IS NOT A CREDENTIAL. A row queued before this
   * browser converged carries the old local device id, and requiring it to
   * equal the authenticated device would strand exactly the rows the Phase
   * D1 migration creates.
   */
  if (/payload\.deviceId|snapshot\.deviceId|\.deviceId === (?:authorization|device|context)/
    .test(sync + stripComments(syncDeviceAuth))) {
    eventAuthProblems.push('sync compares a payload device id to the authenticated device')
  }

  if (!/registration|BADGE_RANGE_REQUIRED_ATTRIBUTE/.test(stripComments(syncDeviceAuth))) {
    eventAuthProblems.push('device-authorized sync does not require Registration')
  }

  if (!/activeBadgeRange === null/.test(stripComments(syncDeviceAuth))) {
    eventAuthProblems.push('device-authorized sync does not require a central badge range')
  }

  if (!/isBadgeWithinDeviceRange/.test(sync)) {
    eventAuthProblems.push('device-authorized sync does not validate the badge number')
  }

  if (!/device-badge-range-mismatch/.test(sync)) {
    eventAuthProblems.push('sync has no typed outcome for an out-of-range badge')
  }

  // The lease is still never a credential, anywhere.
  if (/offline-lease|verifyOfflineAuthorization|centralDeviceOfflineAuthorization/
    .test(sync + stripComments(syncDeviceAuth))) {
    eventAuthProblems.push('sync accepts the offline lease as authentication')
  }

  // Issuance stays local and offline-first.
  const issuance = stripComments(readText(join(ROOT, 'src/db/registrations.ts')) ?? '')

  if (/getDeviceSession|event-authorization|fetch\(|\/api\//.test(issuance)) {
    eventAuthProblems.push('badge issuance consults device authorization')
  }
}

// --- I5. the local event config row is durable -----------------------------
/**
 * A Development browser lost its device identity, badge range and central
 * badge binding, leaving a row identical to the bootstrap defaults. That is
 * DATA LOSS: `nextBadge` is the offline badge allocator and nothing can
 * safely reconstruct it.
 *
 * The rule is simple and absolute: no write may REPLACE the config row.
 */
const configProblems = []
const bootstrapSource = readText(join(ROOT, 'src/db/bootstrap.ts'))
const upiMerge = readText(join(ROOT, 'src/db/event-config.ts'))

if (bootstrapSource === null || upiMerge === null) {
  configProblems.push('the bootstrap or the UPI merge could not be read')
} else {
  const boot = stripComments(bootstrapSource)

  // CREATE-IF-MISSING, decided by a read inside the same transaction.
  if (!/db\.transaction\([\s\S]{0,240}db\.config\.get\(EVENT_CONFIG_ID\)/.test(boot)) {
    configProblems.push('bootstrap does not read the existing row inside its transaction')
  }

  if (!/existingConfig === undefined[\s\S]{0,240}db\.config\.add\(/.test(boot)) {
    configProblems.push('bootstrap does not create the row only when it is absent')
  }

  /**
   * Only `add` — the create-if-missing path — may build defaults, and Dexie
   * refuses `add` over an existing key. A `put` of freshly built defaults
   * REPLACES whatever is there, which is exactly the data loss this guards
   * against, so it is never exempt however it is spelled.
   */
  // Bounded to the SAME LINE: a multi-line window bleeds into the next
  // statement, and `if (existingConfig === undefined)` sitting below a
  // destructive put would make the put look like it read the row first.
  for (const match of boot.matchAll(/db\.config\.put\(([^\n]*)/g)) {
    if (!/existingConfig|patchedConfig/.test(match[1])) {
      configProblems.push('bootstrap puts a config row it did not read first')
    }
  }

  for (const match of boot.matchAll(/db\.config\.add\(([\s\S]{0,120})/g)) {
    if (!/createDefaultEventConfig/.test(match[1])) {
      configProblems.push('bootstrap adds a row that is not the documented default')
    }
  }

  if (!/patchedConfig === existingConfig/.test(boot)) {
    configProblems.push('bootstrap rewrites the config row even when nothing changed')
  }

  if (!/return \{\s*\.\.\.config,/.test(stripComments(upiMerge))) {
    configProblems.push('the UPI merge rebuilds the config row instead of spreading it')
  }
}

/**
 * Every config write, everywhere, must carry the existing row forward. A
 * literal that does not is how a configured desk becomes a default one.
 */
for (const path of walk(join(ROOT, 'src'))) {
  if (extname(path) !== '.ts' && extname(path) !== '.tsx') {
    continue
  }

  const code = stripComments(readText(path) ?? '')

  for (const match of code.matchAll(/db\.config\.(?:put|add)\(\s*\{([\s\S]{0,120})/g)) {
    if (!match[1].includes('...')) {
      configProblems.push(`${rel(path)} writes a config row without spreading the existing one`)
    }
  }

  for (const match of code.matchAll(/:\s*(?:Event|Registered|BadgeDistribution)\w*Config\s*=\s*\{\s*([\s\S]{0,40})/g)) {
    if (!match[1].includes('...')) {
      configProblems.push(`${rel(path)} builds a config row without the existing one`)
    }
  }

  if (/\.clear\(\)|db\.delete\(\)|deleteDatabase|db\.config\.delete\(/.test(code)) {
    configProblems.push(`${rel(path)} clears or deletes local data`)
  }

  // Recovery magic is forbidden: a reconstructed counter can reissue a badge
  // already taken out of the physical stack.
  if (/nextBadge\s*[:=][^\n]*(Math\.max|\.length|count)/i.test(code)) {
    configProblems.push(`${rel(path)} reconstructs nextBadge from other data`)
  }
}

/**
 * The operator realm was DELETED by Phase D2, and with it the only auth code
 * outside `src/device-auth`. What replaced it must keep the same property:
 * signing a device in or out is auth, and auth never touches the local event
 * store.
 */
if (exists(join(ROOT, 'src/auth'))) {
  configProblems.push('the retired operator auth directory is back')
}

const deviceApiClient = readText(join(ROOT, 'src/device-auth/device-api.ts'))

if (deviceApiClient === null) {
  configProblems.push('the device auth client could not be read')
} else if (/db\.config|db\.registrations|db\.outbox|@\/db\/database/
  .test(stripComments(deviceApiClient))) {
  configProblems.push('the device auth client writes local event data')
}

/**
 * The stand-in database must behave like Dexie on the one call that makes
 * this class of bug visible: `add` refuses an existing key. A fake that
 * overwrites would let a destructive bootstrap pass every test.
 */
const standIn = readText(join(ROOT, 'scripts/verification/fake-db.mjs'))

if (standIn === null) {
  configProblems.push('the stand-in database could not be read')
} else if (!/ConstraintError/.test(standIn)) {
  configProblems.push('the stand-in database lets `add` overwrite an existing row')
}

if (!exists(join(ROOT, 'scripts/verification/config-durability.mjs'))) {
  configProblems.push('the config durability suite is missing')
}

// --- I6. Phase D1 device identity convergence ------------------------------
/**
 * A browser may converge its transitional Phase 7 identity onto the central
 * device. That changes the identity stamped onto every FUTURE attendee
 * record, so it is explicit, online-only, and must never rewrite history.
 */
const convergenceProblems = []
const convergenceDomain = readText(join(ROOT, 'src/db/device-identity-convergence.ts'))
const convergenceFlow = readText(join(ROOT, 'src/device-auth/identity-convergence.ts'))

if (convergenceDomain === null || convergenceFlow === null) {
  convergenceProblems.push('the convergence domain or its online flow is missing')
} else {
  const domain = stripComments(convergenceDomain)
  const flow = stripComments(convergenceFlow)

  // ONE writer, and it touches only the identity fields.
  if (/db\.(registrations|outbox)\.(put|add|update|delete|clear)/.test(domain)) {
    convergenceProblems.push('convergence mutates registrations or the outbox')
  }

  for (const forbidden of [
    'badgeStart:', 'badgeEnd:', 'nextBadge:', 'badgeConfiguredAt:',
    'centralBadgeRangeBinding:', 'centralDeviceEnrollment:',
    'centralDeviceOfflineAuthorization:',
  ]) {
    if (domain.includes(forbidden)) {
      convergenceProblems.push(`convergence writes ${forbidden} onto the config row`)
    }
  }

  // The transaction names only `config`; the other tables are not mutated.
  for (const match of domain.matchAll(/db\.transaction\('rw',([^)]*?),\s*async/g)) {
    if (/registrations|outbox/.test(match[1])) {
      convergenceProblems.push('the convergence transaction names a table it does not mutate')
    }
  }

  if (/randomUUID/.test(domain)) {
    convergenceProblems.push('convergence mints a device id instead of adopting the central one')
  }

  if (/adoptCentralBadgeRange|configureBadgeDistribution/.test(domain)) {
    convergenceProblems.push('convergence adopts a badge range')
  }

  if (/nextBadge[^\n]*(Math\.max|\.length|count)/i.test(domain)) {
    convergenceProblems.push('convergence reconstructs nextBadge')
  }

  // The badge-safety question is C3B's, not a second copy.
  if (!/checkBadgeOwnership/.test(domain) || !/checkEnrollment/.test(domain)) {
    convergenceProblems.push('convergence does not reuse the canonical safety checks')
  }

  // Mentioning the check is not running it: the gate must be the real one.
  if (!/if \(hasLocalBadgeOwnership\(config\)\) \{/.test(domain)) {
    convergenceProblems.push('the badge-safety check is not gated on local badge ownership')
  }

  // ONLINE ONLY, against a freshly verified session.
  if (/offline-lease|verifyOfflineAuthorization|centralDeviceOfflineAuthorization/
    .test(flow + domain)) {
    convergenceProblems.push('a cached offline lease can reach the convergence path')
  }

  if (/operator/i.test(flow + domain)) {
    convergenceProblems.push('Operator Access can reach the convergence path')
  }

  if (!/getDeviceSession\(\)/.test(flow)) {
    convergenceProblems.push('convergence does not re-verify the session before writing')
  }

  if (flow.indexOf('getDeviceSession()') > flow.indexOf('convergeDeviceIdentity(')) {
    convergenceProblems.push('convergence writes before re-verifying the session')
  }

  if (!/convergeDeviceIdentity\(\{ context: session\.context \}\)/.test(flow)) {
    convergenceProblems.push('convergence writes from a stale context rather than the fresh one')
  }

  // The enrollment constrains; it never creates authority.
  if (/saveCentralDeviceEnrollment/.test(domain + flow)) {
    convergenceProblems.push('convergence creates a central enrollment')
  }
}

/** Exactly two modules may assign an identity onto the config row. */
const identityWriters = []
for (const path of walk(join(ROOT, 'src'))) {
  if (extname(path) !== '.ts' && extname(path) !== '.tsx') {
    continue
  }

  const code = stripComments(readText(path) ?? '')
  const literals = [
    ...code.matchAll(/:\s*\w*Config\s*=\s*\{([\s\S]*?)\n\s*\}/g),
    ...code.matchAll(/db\.config\.put\(\{([\s\S]*?)\n\s*\}\)/g),
  ]

  if (literals.some((match) => /^\s{4,}deviceId:/m.test(match[1]))) {
    identityWriters.push(rel(path))
  }
}

/**
 * EXACTLY ONE identity writer since Phase D2. `registerDevice` used to mint a
 * local `crypto.randomUUID()` in `src/db/device.ts`; retiring the local
 * provisioning route removed it, so convergence onto the central device is
 * now the only way a `deviceId` is ever written.
 */
if (identityWriters.sort().join(', ') !== 'src/db/device-identity-convergence.ts') {
  convergenceProblems.push(
    `device identity is written in: ${identityWriters.join(', ') || 'nowhere'}`,
  )
}

/**
 * HISTORY IS NOT REWRITTEN. A pre-convergence outbox row carries the old
 * local device id, and a server rule requiring it to match the current
 * central device would strand exactly the rows this migration creates.
 */
const syncDevice = stripComments(readText(join(ROOT, 'server/sync/device-authorization.ts')) ?? '')
const syncRoute = stripComments(readText(join(ROOT, 'api/sync-registration.ts')) ?? '')

if (/payload\.deviceId|deviceId ===|deviceName ===/.test(syncDevice + syncRoute)) {
  convergenceProblems.push('sync compares the payload device identity to the central device')
}

/**
 * IDENTITY EQUALITY IS A REQUIREMENT, NEVER A CREDENTIAL.
 *
 * Phase D2 made the comparison mandatory before any event module opens, so
 * the domain legitimately contains one. What must stay impossible is the
 * comparison GRANTING anything: it lives in exactly one function, that
 * function cannot be called without a grant, and it can only ever return a
 * gap or `null`.
 */
const authorizationDomain = stripComments(
  readText(join(ROOT, 'src/device-auth/event-authorization.ts')) ?? '',
)

const identityCheck = authorizationDomain.slice(
  authorizationDomain.indexOf('export const checkConvergedDeviceIdentity'),
  authorizationDomain.indexOf('const localRangeOf'),
)

if (identityCheck === '') {
  convergenceProblems.push('there is no device identity consistency check')
} else {
  if (/outcome: 'authorized'|ModuleAuthorization/.test(identityCheck)) {
    convergenceProblems.push('the identity consistency check can authorize a module')
  }

  if (!/IdentityConsistencyGap \| null/.test(identityCheck)) {
    convergenceProblems.push('the identity consistency check returns more than a gap')
  }
}

const equalityUses = (authorizationDomain.match(/config\.deviceId ===/g) ?? []).length
const equalityInsideCheck = (identityCheck.match(/config\.deviceId ===/g) ?? []).length

if (equalityUses !== 1 || equalityInsideCheck !== 1) {
  convergenceProblems.push('device identity is compared outside the one consistency check')
}

if (/isConverged/.test(authorizationDomain)) {
  convergenceProblems.push('event authorization stores convergence as a flag')
}

addCheck(
  'device-identity-convergence',
  'Local device identity converges onto the central one only by explicit, online action',
  convergenceProblems,
)

addCheck(
  'config-durability',
  'The local event config row survives startup, remount and realm transitions',
  configProblems,
)

addCheck(
  'device-event-authorization',
  'Event modules may be authorized by a device, and badge conflicts never fall back',
  eventAuthProblems,
)

if (HOBBY_FUNCTION_LIMIT - apiFiles.length !== 4) {
  budgetProblems.push(
    `headroom is ${String(HOBBY_FUNCTION_LIMIT - apiFiles.length)}; this checkpoint expects exactly 4`,
  )
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

// --- J. the operator authority realm stays retired -------------------------
/**
 * PHASE D2 DELETED OPERATOR ACCESS. The central device is the only event
 * authority, and there is deliberately no second credential to fall back to.
 *
 * Removing a realm is easy; keeping it removed is not. Every guard below
 * describes a way the old one could creep back — an endpoint, a cookie, a
 * localStorage marker read as authority, or a local workflow that mints an
 * identity central has never heard of.
 */
const retirementProblems = []

const RETIRED_ENDPOINTS = ['/api/operator-login', '/api/operator-session', '/api/operator-logout']
const OPERATOR_SESSION_COOKIE = '__Host-navaratri_operator_session'
const TRUSTED_DEVICE_MARKER = 'navaratri-2026.operator-device-unlocked.v1'

for (const directory of ['api', 'server', 'src']) {
  for (const path of walk(join(ROOT, directory))) {
    if (!isTextFile(basename(path))) {
      continue
    }

    const code = stripComments(readText(path) ?? '')

    for (const endpoint of RETIRED_ENDPOINTS) {
      if (code.includes(endpoint)) {
        retirementProblems.push(`${rel(path)} calls the retired ${endpoint}`)
      }
    }

    if (code.includes(OPERATOR_SESSION_COOKIE)) {
      retirementProblems.push(`${rel(path)} reads the retired operator session cookie`)
    }

    /**
     * The old marker may still sit in a browser's localStorage and that is
     * fine — nothing may READ it. It never was authentication; after D2 it
     * is not even a hint.
     */
    if (code.includes(TRUSTED_DEVICE_MARKER)) {
      retirementProblems.push(`${rel(path)} reads the retired trusted-device marker`)
    }

    if (/OperatorAccessGate|OperatorAccessForm|OperatorAccessBanner|useOperatorAccess|unlockOperatorAccess|lockOperatorDevice|reportOperatorSessionRejected/
      .test(code)) {
      retirementProblems.push(`${rel(path)} uses the retired operator access client`)
    }
  }
}

for (const path of ['src/auth', 'server/auth', 'src/components/operator', 'src/hooks/use-operator-access.ts']) {
  if (exists(join(ROOT, path))) {
    retirementProblems.push(`${path} was retired by Phase D2 and must not return`)
  }
}

/**
 * NO LOCAL DEVICE PROVISIONING. Registration ids are legitimately UUIDs, so
 * this is deliberately NOT a blanket ban on `crypto.randomUUID` — it is a
 * ban on one reaching `EventConfig.deviceId`.
 */
for (const path of walk(join(ROOT, 'src'))) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const code = stripComments(readText(path) ?? '')

  if (/deviceId:\s*crypto\.randomUUID\(\)|deviceId:\s*[A-Za-z]*[Uu]uid\(\)/.test(code)) {
    retirementProblems.push(`${rel(path)} mints a local device id`)
  }
}

// The hand-entered Phase 7 range writer may not come back to product UI: a
// range with no central binding is refused by the access gate immediately.
for (const directory of ['src/components', 'src/pages']) {
  for (const path of walk(join(ROOT, directory))) {
    if (!isTextFile(basename(path))) {
      continue
    }

    const code = stripComments(readText(path) ?? '')

    if (/configureBadgeDistribution\(|registerDevice\(/.test(code)) {
      retirementProblems.push(`${rel(path)} runs a local provisioning writer`)
    }
  }
}

// `/device-registration` is transition only. No page file, no writer.
if (exists(join(ROOT, 'src/pages/device-registration-page.tsx'))) {
  retirementProblems.push('src/pages/device-registration-page.tsx was retired by Phase D2')
}

/**
 * D2 IS A REMOVAL PHASE. It changes no stored contract, so these are pinned
 * rather than merely described: the local schema, the central migrations and
 * the Sheet ranges must all be exactly what Phase 7 left behind.
 */
const migrationFiles = readdirSync(join(ROOT, 'drizzle'))
  .filter((file) => file.endsWith('.sql'))
  .sort()

const EXPECTED_MIGRATIONS = [
  '0000_central_foundation.sql',
  '0001_range_guards_and_touch.sql',
  '0002_device_credentials.sql',
]

if (migrationFiles.join(', ') !== EXPECTED_MIGRATIONS.join(', ')) {
  retirementProblems.push(`the migration set changed: ${migrationFiles.join(', ')}`)
}

const sheetContract = readText(join(ROOT, 'server/sync/sheet-contract.ts'))

if (sheetContract === null) {
  retirementProblems.push('the sheet contract could not be read')
} else {
  for (const range of ['A1:N', 'A1:M']) {
    if (!sheetContract.includes(range)) {
      retirementProblems.push(`the sheet contract no longer declares ${range}`)
    }
  }
}

addCheck(
  'operator-realm-retired',
  'Operator Access is gone and the central device is the only event authority',
  retirementProblems,
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
