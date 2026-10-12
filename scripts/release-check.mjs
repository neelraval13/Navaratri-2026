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
  'api/prizes.ts',
  'src/shared/prize-contract.ts',
  'server/prizes/awards.ts',
  'server/prizes/eligibility.ts',
  /**
   * The ONE Badge Register reader. Phase A1 moved it out of `server/prizes/`
   * because the directory needs the same projection, and two readers would be
   * two opinions about which columns an attendee has.
   */
  'server/attendees/register.ts',
  'server/prizes/requests.ts',
  'src/prizes/prize-api.ts',
  'src/prizes/prize-filters.ts',
  'src/pages/prizes-page.tsx',
  // Phase P1.1: the fixed catalog chooser and the previous-prize warning.
  'src/components/prizes/prize-chooser.tsx',
  'src/components/prizes/previous-awards-warning.tsx',
  'src/components/prizes/attendee-card.tsx',
  // Phase A1: the read-only directory, and the shared pieces both modules use.
  'src/shared/attendee-contract.ts',
  'src/attendees/attendee-api.ts',
  'src/attendees/attendee-filters.ts',
  'src/components/attendees/attendee-filters.tsx',
  'src/components/attendees/attendee-card.tsx',
  'src/components/attendees/attendee-directory.tsx',
  'src/pages/attendees-page.tsx',
  'api/attendees.ts',
  // Phase D3: the dandiya checkout desk.
  'api/dandiya.ts',
  'src/shared/dandiya-contract.ts',
  'src/shared/event-time.ts',
  'server/dandiya/loans.ts',
  'server/dandiya/board.ts',
  'server/dandiya/conflicts.ts',
  'server/dandiya/requests.ts',
  'src/dandiya/dandiya-api.ts',
  'src/dandiya/dandiya-filters.ts',
  'src/dandiya/dandiya-contract-parsers.ts',
  'src/components/dandiya/dandiya-desk.tsx',
  'src/components/dandiya/issue-pair-form.tsx',
  'src/components/dandiya/attendee-picker.tsx',
  'src/components/dandiya/active-loan-card.tsx',
  'src/components/dandiya/resolve-pair-dialog.tsx',
  'src/components/dandiya/pair-issues.tsx',
  'src/components/dandiya/loan-history.tsx',
  'src/components/event/event-notice.tsx',
  'src/pages/dandiya-page.tsx',
  'docs/PRIZES.md',
  'scripts/seed-prizes-development.mjs',
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
  // Phase A1. GET only; every other method answers 405 with Allow: GET.
  'attendees.ts',
  // Phase D3. GET the board, POST an issue, PATCH a return.
  'dandiya.ts',
  'device-auth.ts',
  'device-badge-claim.ts',
  // Phase P1. GET lists the eligible roster and the history; POST awards.
  'prizes.ts',
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

  /**
   * `/api/prizes` is authenticated device traffic, not a credential endpoint.
   * A rule on it would throttle a prize desk's ordinary roster reads while
   * protecting nothing a device session does not already protect.
   */
  if (/\*\*Condition — Path\*\* \| `\/api\/prizes`/.test(firewallDoc)) {
    budgetProblems.push('docs/VERCEL_FIREWALL.md rate-limits the authenticated prize endpoint')
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

  /**
   * A central BADGE range is never released, by anyone.
   *
   * RE-SCOPED BY PHASE D3, which introduced a second table with a
   * `released_at` column: a dandiya holder is released on every return, which
   * is the whole point of that column and has nothing to do with badges. The
   * guard therefore looks for a release of a BADGE ASSIGNMENT rather than for
   * the word — an over-broad pattern that fires on unrelated code is a guard
   * somebody eventually deletes.
   */
  for (const path of [...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'api')), ...walk(join(ROOT, 'src'))]) {
    if (extname(path) !== '.ts' && extname(path) !== '.tsx') {
      continue
    }

    const code = stripComments(readText(path) ?? '')
    const releasesBadgeRange =
      /releaseBadgeRange/.test(code) ||
      (/\.update\(badgeAssignments\)/.test(code) &&
        /releasedAt:\s*(new Date|[a-zA-Z])/.test(code))

    if (releasesBadgeRange) {
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

/**
 * RE-SCOPED BY PHASE D3, which spent one slot on `api/dandiya.ts` beside
 * P1's `api/prizes.ts` and A1's `api/attendees.ts`. ELEVEN of twelve, ONE
 * spare. The headroom is pinned rather than merely bounded so it cannot be
 * consumed quietly: the Hobby limit is enforced at DEPLOY time, after the
 * build has already succeeded, so nothing else would report it.
 *
 * At one slot left, the next module that wants a Function has a real decision
 * to make rather than a habit to follow.
 */
if (HOBBY_FUNCTION_LIMIT - apiFiles.length !== 1) {
  budgetProblems.push(
    `headroom is ${String(HOBBY_FUNCTION_LIMIT - apiFiles.length)}; this checkpoint expects exactly 1`,
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
  // Phase P1's prize ledger. Appended, never edited in place: a migration
  // that has run anywhere is history.
  '0003_prize_awards.sql',
  /**
   * Phase P1.1 drops P1's `UNIQUE(event_id, badge_number)` because repeat
   * prizes became the event rule. 0003 was already applied to Development, so
   * this is appended rather than edited into it — a database that has never
   * seen P1 applies 0003 then 0004 and arrives at the same place.
   */
  '0004_repeat_prize_awards.sql',
  /**
   * Phase D3's dandiya ledger. Appended, and 0000-0004 are untouched: a
   * migration that has run anywhere is history.
   */
  '0005_dandiya_checkout.sql',
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

// --- K. the prize ledger holds no attendee PII, and repeats stay legal ------
/**
 * PHASE P1 ADDED A CENTRAL LEDGER AND KEPT THE PRIVACY BOUNDARY. PHASE P1.1
 * MADE REPEAT PRIZES LEGAL.
 *
 * Postgres records which badge received which prize, from which device, when.
 * It records nothing about the person — the Google Sheet answers that, and the
 * response joins the two per request.
 *
 * The guards below describe two kinds of regression. One is the privacy
 * boundary eroding: an attendee column, an attendee field on the insert, a
 * phone number read from the Sheet. The other is ONE-PRIZE-PER-ATTENDEE
 * COMING BACK — as a constraint, as a precheck, as a conflict the API
 * reports, or as an attendee quietly filtered out of the list once they have
 * won something. P1's rule is now a bug, and it would be an easy one to
 * reintroduce while tidying.
 */
const prizeProblems = []

/** Attendee facts that must never become central columns or ledger fields. */
const ATTENDEE_PII_FIELDS = [
  'phone', 'whatsapp', 'wa.me', 'payment', 'paymentMethod', 'amount',
  'normalizedName', 'upi',
]

const schemaSource = readText(join(ROOT, 'server/db/schema.ts'))
const prizeWriter = readText(join(ROOT, 'server/prizes/awards.ts'))
const prizeRoster = readText(join(ROOT, 'server/attendees/register.ts'))
const prizeRequests = readText(join(ROOT, 'server/prizes/requests.ts'))
const prizeEndpoint = readText(join(ROOT, 'api/prizes.ts'))
const prizeContract = readText(join(ROOT, 'src/shared/prize-contract.ts'))
const prizeApi = readText(join(ROOT, 'src/prizes/prize-api.ts'))
const prizeEligibility = readText(join(ROOT, 'server/prizes/eligibility.ts'))
const prizeFilters = readText(join(ROOT, 'src/attendees/attendee-filters.ts'))
const prizeChooser = readText(join(ROOT, 'src/components/prizes/prize-chooser.tsx'))
const prizeDialog = readText(join(ROOT, 'src/components/prizes/award-prize-dialog.tsx'))
const prizeWarning = readText(
  join(ROOT, 'src/components/prizes/previous-awards-warning.tsx'),
)
const prizeMigration0004 = readText(join(ROOT, 'drizzle/0004_repeat_prize_awards.sql'))

if (
  schemaSource === null || prizeWriter === null || prizeRoster === null ||
  prizeRequests === null || prizeEndpoint === null || prizeContract === null ||
  prizeApi === null || prizeEligibility === null || prizeFilters === null ||
  prizeChooser === null || prizeDialog === null || prizeWarning === null ||
  prizeMigration0004 === null
) {
  prizeProblems.push('a prize module is missing')
} else {
  /**
   * THE TABLE DEFINITION ITSELF, sliced from `prizeAwards` to the end of its
   * definition, so a column added later is audited rather than hidden behind
   * the rest of the schema file.
   */
  /**
   * THE PRIZE TABLE BLOCK, and only it.
   *
   * The end was once "the next `export type`", which worked until Phase D3
   * appended two more tables before them — the slice then swallowed the
   * dandiya tables, whose partial unique index over `badge_number` tripped
   * the repeat-prize guard below. A canary would never have found that: the
   * code was correct and the GUARD was wrong, which is the failure mode of
   * auditing by slicing text.
   */
  const tableStart = schemaSource.indexOf('export const prizeAwards = pgTable(')
  const nextDeclaration = ['\nexport const ', '\nexport type ']
    .map((marker) => schemaSource.indexOf(marker, tableStart + 1))
    .filter((index) => index !== -1)
  const tableEnd = nextDeclaration.length === 0 ? -1 : Math.min(...nextDeclaration)
  const table = tableStart === -1
    ? ''
    : stripComments(schemaSource.slice(tableStart, tableEnd === -1 ? undefined : tableEnd))

  if (table === '') {
    prizeProblems.push('server/db/schema.ts does not define prize_awards')
  }

  /**
   * The COLUMN BLOCK only — `pgTable`'s second argument. The constraint list
   * after it legitimately contains `name:` for a foreign-key name and the
   * word `badge_number` in an index name, and auditing those would report a
   * column that does not exist while teaching nobody anything.
   */
  const columnsStart = table.indexOf('{')
  const columns = columnsStart === -1 ? '' : table.slice(columnsStart, table.indexOf('\n  },'))

  if (table !== '' && columns === '') {
    prizeProblems.push('the prize_awards column block could not be read')
  }

  /**
   * PLAIN SUBSTRING, case-insensitively, after renaming the one legitimate
   * "name" away. A word-boundary pattern looked careful and let
   * `attendeeName` straight through, because the `N` is preceded by a letter
   * — which is exactly the shape a column like that would be given.
   */
  const auditedColumns = columns.replace(/prizeName|prize_name/g, 'label').toLowerCase()

  for (const field of [...ATTENDEE_PII_FIELDS, 'name', 'age', 'gender', 'attendee']) {
    if (auditedColumns.includes(field.toLowerCase())) {
      prizeProblems.push(`prize_awards declares an attendee column: ${field}`)
    }
  }

  /**
   * REPEAT PRIZES STAY LEGAL — the inverse of the guard P1 had here.
   *
   * Any uniqueness over the badge number refuses a second legitimate award,
   * whichever columns it is spelled with, so the SHAPE is looked for rather
   * than the old constraint's name: `(event_id, badge_number, prize_name)`
   * would be a new name and the same broken rule. A unique index counts too —
   * it enforces uniqueness with no constraint to find.
   *
   * The primary key on `id` is not uniqueness over an attendee and is not
   * matched: it names no badge number.
   */
  for (const match of table.matchAll(/(unique|uniqueIndex)\(([\s\S]*?)\)\s*\.on\(([^)]*)\)/g)) {
    if (/badgeNumber|badge_number/.test(match[3])) {
      prizeProblems.push(
        'prize_awards is unique over the badge number again, which refuses a repeat prize',
      )
    }
  }

  /**
   * And 0004 must still be exactly what removed it — ONE statement, compared
   * whole with its `--` commentary stripped. An appended statement in the
   * migration that releases the constraint is the least-reviewed place
   * anything could be added to the ledger.
   */
  const removal = prizeMigration0004
    .replace(/^--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (
    removal !==
    'ALTER TABLE "prize_awards" DROP CONSTRAINT "prize_awards_event_id_badge_number_key";'
  ) {
    prizeProblems.push(`0004 is not the single constraint removal it should be: ${removal}`)
  }

  if (!/prize_awards_device_event_fk/.test(table)) {
    prizeProblems.push('prize_awards does not enforce cross-event device integrity')
  }

  // Append-only: no undo, no delete, no edit, so no updated_at to maintain.
  if (/updatedAt|updated_at/.test(table)) {
    prizeProblems.push('prize_awards carries updated_at, which append-only history does not need')
  }

  /**
   * ONE WRITER. A second inserter is a second place for someone to decide
   * they know better than the UNIQUE constraint.
   */
  const prizeTableReaders = []

  for (const directory of ['api', 'server', 'src']) {
    for (const path of walk(join(ROOT, directory))) {
      if (!isTextFile(basename(path))) {
        continue
      }

      const code = stripComments(readText(path) ?? '')

      if (/\bprizeAwards\b/.test(code)) {
        prizeTableReaders.push(rel(path))
      }
    }
  }

  const allowedTableReaders = ['server/db/schema.ts', 'server/prizes/awards.ts']

  for (const path of prizeTableReaders) {
    if (!allowedTableReaders.includes(path)) {
      prizeProblems.push(`${path} reaches the prize_awards table directly`)
    }
  }

  for (const path of allowedTableReaders) {
    if (!prizeTableReaders.includes(path)) {
      prizeProblems.push(`${path} no longer names the prize_awards table`)
    }
  }

  const writer = stripComments(prizeWriter)

  if (!/\.insert\(prizeAwards\)/.test(writer)) {
    prizeProblems.push('server/prizes/awards.ts does not insert through the one writer')
  }

  if (/\.update\(prizeAwards\)|\.delete\(prizeAwards\)/.test(writer)) {
    prizeProblems.push('server/prizes/awards.ts mutates or deletes prize history')
  }

  /**
   * A caller must not be able to date its own award, and the insert must not
   * write an attendee. Case-INSENSITIVE, with the one legitimate `prizeName`
   * renamed away first: a case-sensitive `name:` matched neither `prizeName:`
   * nor `attendeeName:`, so it would have reported nothing either way.
   */
  const inserted = writer
    .slice(writer.indexOf('.values({'), writer.indexOf('.returning()'))
    .replace(/prizeName/g, 'label')
    .toLowerCase()

  for (const field of ['awardedat', 'name', 'age', 'gender', 'phone', 'attendee', 'amount']) {
    if (inserted !== '' && inserted.includes(field)) {
      prizeProblems.push(`the prize insert sets ${field}, which it must not`)
    }
  }

  /**
   * THE CONSTRAINT IS THE AUTHORITY, so the endpoint must not precheck it: a
   * SELECT above the insert would only move the race.
   */
  const endpoint = stripComments(prizeEndpoint)
  const postStart = endpoint.indexOf('export async function POST(')

  if (postStart === -1) {
    prizeProblems.push('api/prizes.ts exports no POST')
  } else {
    const post = endpoint.slice(postStart)

    if (post.includes('readPrizeAwards(')) {
      prizeProblems.push('the award endpoint prechecks the ledger instead of trusting the constraint')
    }

    /**
     * The register confirms the badge BEFORE anything is written — and the
     * confirmation must actually REFUSE. Checking only the order of the two
     * calls let a canary that deleted the refusal through: the roster was
     * still read first, it just no longer decided anything.
     */
    if (post.indexOf('readAttendeeRegister(') === -1 ||
        post.indexOf('readAttendeeRegister(') > post.indexOf('recordPrizeAward(')) {
      prizeProblems.push('the award endpoint writes before confirming the badge is registered')
    }

    if (!post.includes("blocked: 'badge-not-registered'")) {
      prizeProblems.push('the award endpoint does not refuse a badge missing from the register')
    }

    if (!/PRIZE_REQUIRED_ATTRIBUTE/.test(post)) {
      prizeProblems.push('the award endpoint does not require the prizes attribute')
    }
  }

  const methods = [...endpoint.matchAll(/export async function ([A-Z]+)\(/g)]
    .map((match) => match[1])
    .sort()
    .join(',')

  if (methods !== 'GET,POST') {
    prizeProblems.push(`api/prizes.ts exports ${methods} rather than exactly GET,POST`)
  }

  if (/admin-auth|adminSession|readAdminSessionCookie/.test(endpoint)) {
    prizeProblems.push('the prize endpoint reaches into the Admin realm')
  }

  /**
   * A SQLSTATE is diagnostic and belongs in the server log. Matched LINE BY
   * LINE rather than by proximity: this codebase omits semicolons, so a
   * "within the same statement" pattern runs to the end of the file and
   * matches any response anywhere.
   */
  for (const line of endpoint.split('\n')) {
    if (line.includes('SQLSTATE') && !line.includes('console.error')) {
      prizeProblems.push('the prize endpoint moves a SQLSTATE outside the server log')
    }
  }

  // A Postgres constraint name is never a wire value, and never a response.
  if (/constraint/i.test(endpoint)) {
    prizeProblems.push('the prize endpoint names a database constraint')
  }

  /** Every identity, timing and attendee field is refused, not ignored. */
  for (const field of [
    'eventId', 'eventSlug', 'deviceId', 'loginName', 'awardedAt', 'awardedBy',
    'attendee', 'name', 'age', 'gender',
  ]) {
    if (!new RegExp(`'${field}'`).test(prizeRequests)) {
      prizeProblems.push(`a prize award body may still carry ${field}`)
    }
  }

  /**
   * THE ROSTER PROJECTS FOUR FIELDS. The phone column and the WhatsApp link
   * are not merely unstored — they are never read. Phase A1 moved this reader
   * to `server/attendees/register.ts` so the directory shares it; the guard
   * follows the implementation rather than the old path, because a guard
   * pointed at a file nobody uses verifies nothing.
   */
  const roster = stripComments(prizeRoster)

  if (/COLUMNS\.phone|whatsapp/i.test(roster)) {
    prizeProblems.push('server/attendees/register.ts reads the phone or WhatsApp column')
  }

  if (!/\.values\.get\(/.test(roster) || /batchUpdate|addSheet/.test(roster)) {
    prizeProblems.push('server/attendees/register.ts is not strictly read-only on the Sheet')
  }

  for (const field of ['phone', 'whatsapp', 'paymentMethod', 'amount']) {
    if (new RegExp(`${field}\\s*[:?]`, 'i').test(stripComments(prizeContract))) {
      prizeProblems.push(`the shared prize contract declares ${field}`)
    }
  }

  /* ------------------------------------- P1.1: the fixed catalog, and repeats */

  /**
   * THE EIGHT PRIZES, pinned by their exact wire bytes.
   *
   * These strings are an allow-list the server enforces and the value
   * Postgres stores, so a stray dash or a dropped space would refuse every
   * award the chooser offers. Pinned here rather than counted, because a
   * count would pass with eight wrong labels.
   */
  const PRIZE_LABELS = [
    'Best Dance - Boy', 'Best Dance - Girl', 'Best Dance - Male', 'Best Dance - Female',
    'Best Dress - Boy', 'Best Dress - Girl', 'Best Dress - Male', 'Best Dress - Female',
  ]

  const catalogEntries = [...prizeContract.matchAll(/label: '([^']+)'/g)].map((m) => m[1])

  if (catalogEntries.join('|') !== PRIZE_LABELS.join('|')) {
    prizeProblems.push(
      `the prize catalog is not the agreed eight: ${catalogEntries.join(', ')}`,
    )
  }

  /**
   * And it is an ALLOW-LIST, not a length check. P1 took free text; a parser
   * that still accepted any non-empty string would let one desk's `Best
   * Dancee` into the ledger beside another's `Best Dance - Girl`, and nothing
   * downstream could tell them apart.
   */
  const nameParser = stripComments(prizeContract)
    .slice(stripComments(prizeContract).indexOf('export const parsePrizeName'))

  if (!/PRIZE_NAMES\.includes\(/.test(nameParser)) {
    prizeProblems.push('a new prize name is no longer checked against the catalog')
  }

  const labelCeiling = /PRIZE_NAME_MAX_LENGTH = (\d+)/.exec(prizeContract)?.[1] ?? '0'

  for (const label of catalogEntries) {
    if (label.length > Number(labelCeiling)) {
      prizeProblems.push(`the catalog label "${label}" exceeds the stored length limit`)
    }
  }

  // The SERVER reads the same policy, so the chooser and the endpoint cannot
  // disagree about which eight values exist.
  for (const [path, source] of [
    ['server/prizes/requests.ts', prizeRequests],
    ['src/components/prizes/award-prize-dialog.tsx', prizeDialog],
  ]) {
    if (!/parsePrizeName/.test(source)) {
      prizeProblems.push(`${path} no longer validates against the shared prize policy`)
    }
  }

  /**
   * ONE-PRIZE-PER-ATTENDEE MUST NOT COME BACK as a refusal. The conflict, its
   * public name and the 409 that carried it are all gone, and a tidy-up that
   * reinstated any of them would start refusing legitimate repeat awards.
   */
  for (const [path, source] of [
    ['api/prizes.ts', prizeEndpoint],
    ['src/shared/prize-contract.ts', prizeContract],
    ['src/prizes/prize-api.ts', prizeApi],
    ['server/prizes/awards.ts', prizeWriter],
  ]) {
    // CODE, not commentary: these files explain in prose that the conflict was
    // removed, and that explanation is the opposite of a regression.
    if (/already-awarded|alreadyAwarded/.test(stripComments(source))) {
      prizeProblems.push(`${path} still reports an already-awarded conflict`)
    }
  }

  if (/status === 409|=== 409|, 409\)/.test(stripComments(prizeEndpoint) + stripComments(prizeApi))) {
    prizeProblems.push('the prize API still has a 409 conflict path')
  }

  /**
   * NOTHING REMOVES AN ATTENDEE FROM THE LIST. The composer passes the roster
   * through, so the absence of a filter is the property — and it is checked as
   * an absence, because a subtraction is one line to add back.
   */
  const composer = stripComments(prizeEligibility)

  if (!/attendees: \[\.\.\.input\.attendees\]/.test(composer)) {
    prizeProblems.push('server/prizes/eligibility.ts no longer returns the roster unchanged')
  }

  // The two shapes a subtraction takes. `awardedAt` and `awardedBy` are
  // ordinary ledger fields and are not evidence of one.
  if (/\.filter\(|new Set\(/.test(composer)) {
    prizeProblems.push('server/prizes/eligibility.ts filters the attendee list again')
  }

  /**
   * The client filter cannot do it either, and the SIGNATURE is why: it is
   * never handed the award history, so no filter can be made to hide a winner
   * without changing what it is given.
   */
  if (!/export const filterAttendees = \(\s*attendees: readonly EventAttendee\[\],\s*state: AttendeeFilterState,\s*\)/
    .test(prizeFilters)) {
    prizeProblems.push('filterAttendees no longer takes only the roster and the filters')
  }

  /**
   * THE DEMOGRAPHIC SUGGESTION IS NOT AUTHORIZATION. It highlights a button
   * from the attendee's age and gender; the server must never consult it, or
   * an award would start being refused for disagreeing with a hint — and the
   * volunteer at the table knows things the Badge Register does not.
   */
  for (const directory of ['api', 'server']) {
    for (const path of walk(join(ROOT, directory))) {
      if (!isTextFile(basename(path))) {
        continue
      }

      if (/suggestedPrizeDivision|PRIZE_ADULT_AGE/.test(readText(path) ?? '')) {
        prizeProblems.push(`${rel(path)} treats the division suggestion as a rule`)
      }
    }
  }

  // The warning informs. It disables nothing and asks for no override.
  if (/disabled|aria-disabled|approval|override/i.test(stripComments(prizeWarning))) {
    prizeProblems.push('the previous-prize warning disables or gates the award')
  }

  /**
   * And the submit button's own condition proves it: whether a prize may be
   * awarded depends on a request being in flight and a prize being chosen,
   * and on nothing about previous awards.
   */
  const submitGuard = /disabled=\{isSubmitting \|\| !chosen\.ok\}/.test(prizeDialog)

  if (!submitGuard) {
    prizeProblems.push('the award button is gated by something other than the chosen prize')
  }

  /**
   * AND THE CARD NEVER WITHHOLDS THE BUTTON. Every attendee has Give Prize,
   * whatever they have already won, so the only thing that may disable it is
   * a request already in flight. A canary that gated it on the award count
   * was caught by the rendered assertion in `verify:p1`; this is the cheap
   * structural half, in the file that fails before anything is deployed.
   */
  const cardSource = readText(join(ROOT, 'src/components/prizes/attendee-card.tsx')) ?? ''

  if (!/disabled=\{isBusy\}/.test(cardSource)) {
    prizeProblems.push('the attendee card gates Give Prize on something other than the request')
  }

  /** The prize is CHOSEN, never typed: no free-text input is left anywhere. */
  if (/<Input/.test(prizeDialog)) {
    prizeProblems.push('the award dialog still offers a free-text prize field')
  }

  if (!/PRIZE_CATALOG/.test(prizeChooser) || /<Input/.test(prizeChooser)) {
    prizeProblems.push('the prize chooser is not rendered from the shared catalog')
  }

  // The response names ATTENDEES. `eligible` was a subtraction and is gone.
  if (
    !/attendees: PrizeAttendee\[\]/.test(prizeContract) ||
    /eligible/.test(stripComments(prizeContract))
  ) {
    prizeProblems.push('the prize roster response is not the full attendee list')
  }

  /**
   * ONLINE ONLY. No local prize state, no queue, no timer. A prize that
   * survived a failed request is exactly how two offline desks award the same
   * badge.
   */
  for (const directory of ['src/prizes', 'src/components/prizes', 'src/pages/prizes-page.tsx']) {
    const target = join(ROOT, directory)

    if (!exists(target)) {
      prizeProblems.push(`missing: ${directory}`)

      continue
    }

    const paths = statSync(target).isDirectory() ? walk(target) : [target]

    for (const path of paths) {
      const code = stripComments(readText(path) ?? '')

      if (/@\/db\/database|from 'dexie'|outbox|localStorage|sessionStorage/.test(code)) {
        prizeProblems.push(`${rel(path)} keeps prize state locally`)
      }

      if (/setInterval/.test(code)) {
        prizeProblems.push(`${rel(path)} polls on an interval`)
      }

      /**
       * `setTimeout` is allowed in exactly ONE place and for exactly one
       * reason: aborting a request that never answers. Anywhere else, or more
       * than once, it is a retry — and a prize award that retries itself is
       * how two desks award the same badge.
       */
      const timers = [...code.matchAll(/setTimeout\(/g)].length
      const isRequestTimeout = rel(path) === 'src/prizes/prize-api.ts' &&
        timers === 1 && /controller\.abort\(\)/.test(code)

      if (timers > 0 && !isRequestTimeout) {
        prizeProblems.push(`${rel(path)} uses a timer that is not the request timeout`)
      }
    }
  }

  if (/queue|retry|navigator\.onLine/.test(stripComments(prizeApi))) {
    prizeProblems.push('src/prizes/prize-api.ts queues or retries an award')
  }

  /** The prize module changes no stored contract of any earlier phase. */
  const dexieSource = readText(join(ROOT, 'src/db/database.ts'))

  if (dexieSource === null || !/DATABASE_VERSION = 1\b/.test(dexieSource)) {
    prizeProblems.push('the IndexedDB version is no longer pinned at 1')
  }

  for (const path of ['api/sync-registration.ts', 'api/device-auth.ts']) {
    if (/prizes\//.test(readText(join(ROOT, path)) ?? '')) {
      prizeProblems.push(`${path} now depends on the prize module`)
    }
  }
}

addCheck(
  'prize-ledger',
  'The prize ledger holds no attendee PII, and repeat prizes stay possible',
  prizeProblems,
)

// --- K2. the attendee directory reads and changes nothing -----------------
/**
 * PHASE A1 ADDED A SECOND READER OF ATTENDEE DATA, AND NO WRITER.
 *
 * `/attendees` is a read-only directory for a device holding the new
 * `attendees` attribute. Two things could go wrong with it, and both would be
 * quiet:
 *
 *   1. IT COULD GROW A MUTATION. A directory is the obvious place to add
 *      "fix this name", and the moment it can write, a read-only viewer
 *      handed to a volunteer stops being one.
 *   2. IT COULD SHOW MORE THAN IT MAY. The Badge Register holds a phone
 *      number and a WhatsApp link; this module must not read them, and the
 *      same projection serves the prize desk, so a field added for one screen
 *      would appear on both.
 *
 * A third guard is about PERMISSION: the three attributes are independent, so
 * `prizes` must not open the directory and `registration` must not either.
 */
const directoryProblems = []

const attendeeEndpoint = readText(join(ROOT, 'api/attendees.ts'))
const attendeeContract = readText(join(ROOT, 'src/shared/attendee-contract.ts'))
const attendeeRegister = readText(join(ROOT, 'server/attendees/register.ts'))
const attendeeApi = readText(join(ROOT, 'src/attendees/attendee-api.ts'))
const attendeeCard = readText(join(ROOT, 'src/components/attendees/attendee-card.tsx'))
const attendeeDirectory = readText(
  join(ROOT, 'src/components/attendees/attendee-directory.tsx'),
)
const attributeSource = readText(join(ROOT, 'src/shared/device-attributes.ts'))
const authorizationSource = readText(join(ROOT, 'src/device-auth/event-authorization.ts'))

if (
  attendeeEndpoint === null || attendeeContract === null || attendeeRegister === null ||
  attendeeApi === null || attendeeCard === null || attendeeDirectory === null ||
  attributeSource === null || authorizationSource === null
) {
  directoryProblems.push('an attendee directory module is missing')
} else {
  /** The allow-list the Admin form renders and the server validates against. */
  if (!/DEVICE_ATTRIBUTES = \['registration', 'prizes', 'attendees', 'dandiya'\] as const/
    .test(attributeSource)) {
    directoryProblems.push('the device attribute allow-list is not the expected four')
  }

  for (const name of ['DEVICE_ATTRIBUTE_LABELS', 'DEVICE_ATTRIBUTE_DESCRIPTIONS']) {
    const block = attributeSource.slice(attributeSource.indexOf(`const ${name}`))

    if (!block.slice(0, block.indexOf('}')).includes('attendees:')) {
      directoryProblems.push(`${name} has no entry for attendees`)
    }
  }

  /**
   * THE ATTRIBUTES ARE INDEPENDENT. The directory branch must test its own
   * attribute and nothing else — accepting `prizes` there would hand every
   * prize desk a browsable copy of the whole register, which is a separate
   * thing to be trusted with.
   */
  const branch = authorizationSource.slice(
    authorizationSource.indexOf("if (module === 'attendees')"),
  )
  const decision = branch.slice(0, branch.indexOf('}'))

  if (decision === '' || !/grant\.attributes\.includes\('attendees'\)/.test(decision)) {
    directoryProblems.push('the attendees route does not require the attendees attribute')
  }

  /**
   * NO OTHER ATTRIBUTE, named or not.
   *
   * This once listed `'prizes'` and `'registration'`, and a canary that made
   * `dandiya` grant the directory sailed past it — a guard that enumerates
   * today's siblings misses tomorrow's. Every attribute literal except its
   * own is forbidden, so the next capability is covered by construction.
   */
  for (const other of ['registration', 'prizes', 'dandiya']) {
    if (decision.includes(`'${other}'`)) {
      directoryProblems.push(
        `the attendees route accepts another module\u2019s attribute: ${other}`,
      )
    }
  }

  /**
   * THE REFUSAL ITSELF, not a mention of the constant.
   *
   * A canary that neutered the check — `if (false && !device.attributes…)` —
   * sailed past a guard that only looked for the constant's name, which is
   * the same mistake a Phase P1.1 canary found: proving a string appears
   * proves nothing about what is enforced. So the condition, the typed
   * refusal and its status are all required, and the check must come BEFORE
   * the register is read.
   */
  const attendeeGet = stripComments(attendeeEndpoint)
    .slice(stripComments(attendeeEndpoint).indexOf('export async function GET('))

  if (!/if \(!device\.attributes\.includes\(ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE\)\) \{/
    .test(attendeeGet)) {
    directoryProblems.push('GET /api/attendees does not require the attendees attribute')
  }

  if (!attendeeGet.includes("blocked: 'attendees-required'") || !/403/.test(attendeeGet)) {
    directoryProblems.push('GET /api/attendees does not refuse an ungranted device with 403')
  }

  if (attendeeGet.indexOf('ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE') >
      attendeeGet.indexOf('readAttendeeRegister(')) {
    directoryProblems.push('GET /api/attendees reads the register before checking permission')
  }

  if (/PRIZE_REQUIRED_ATTRIBUTE|BADGE_RANGE_REQUIRED_ATTRIBUTE/.test(attendeeEndpoint)) {
    directoryProblems.push('the attendees endpoint consults another module\u2019s attribute')
  }

  /**
   * READ-ONLY, AND STRUCTURALLY SO. `GET` is the only method with a body of
   * work; the other four exist precisely so the refusal is deliberate and
   * testable rather than whatever the platform decides for an unexported one.
   */
  const methods = [...attendeeEndpoint.matchAll(/export (?:async )?function ([A-Z]+)\(/g)]
    .map((match) => match[1])
    .sort()
    .join(',')

  if (methods !== 'DELETE,GET,PATCH,POST,PUT') {
    directoryProblems.push(`api/attendees.ts exports ${methods} rather than GET plus four refusals`)
  }

  const endpointCode = stripComments(attendeeEndpoint)

  for (const [name, start] of [
    ['POST', endpointCode.indexOf('export function POST(')],
    ['PUT', endpointCode.indexOf('export function PUT(')],
    ['PATCH', endpointCode.indexOf('export function PATCH(')],
    ['DELETE', endpointCode.indexOf('export function DELETE(')],
  ]) {
    const body = start === -1 ? '' : endpointCode.slice(start, endpointCode.indexOf('}', start))

    if (!body.includes('methodNotAllowed()')) {
      directoryProblems.push(`api/attendees.ts ${name} does not refuse with 405`)
    }
  }

  if (!/status: 405/.test(endpointCode) || !/allow: 'GET'/.test(endpointCode)) {
    directoryProblems.push('api/attendees.ts does not answer 405 with an Allow header')
  }

  /**
   * It must not be ABLE to write. No database client, no ledger writer, no
   * body reader, no Sheet mutation — a directory that reads a body is a
   * directory somebody is about to let write.
   */
  for (const capability of [
    'getDatabase', 'db.insert', 'db.update', 'db.delete', 'readDeviceBody',
    'batchUpdate', 'prizeAwards', 'recordPrizeAward', 'drizzle',
  ]) {
    if (endpointCode.includes(capability)) {
      directoryProblems.push(`api/attendees.ts can mutate: ${capability}`)
    }
  }

  if (/admin-auth|adminSession|readAdminSessionCookie/.test(endpointCode)) {
    directoryProblems.push('the attendees endpoint reaches into the Admin realm')
  }

  /**
   * AN UNREADABLE REGISTER IS NOT AN EMPTY ONE, and the guard reads the
   * BRANCH rather than the file: a canary that answered a failed read with
   * `{ attendees: [] }` left `register-unavailable` and `503` elsewhere in
   * the file untouched, so a whole-file match passed it.
   *
   * Whoever reads "No attendees have been registered yet" has to be able to
   * believe it.
   */
  const failedRead = attendeeGet.indexOf('register.ok === false')
  const failedReadBranch = failedRead === -1
    ? ''
    : attendeeGet.slice(failedRead, attendeeGet.indexOf('}\n', failedRead))

  if (!/register-unavailable/.test(failedReadBranch) || !/503/.test(failedReadBranch)) {
    directoryProblems.push('api/attendees.ts does not fail closed on an unreadable register')
  }

  if (/attendees: \[\]/.test(failedReadBranch)) {
    directoryProblems.push('api/attendees.ts answers an unreadable register with an empty list')
  }

  // And the interlock failure fails closed the same way.
  if (!/register-unavailable/.test(attendeeGet) || !/503/.test(attendeeGet)) {
    directoryProblems.push('api/attendees.ts has no service-unavailable answer at all')
  }

  if (!attendeeDirectory.includes('No attendees have been registered yet.')) {
    directoryProblems.push('the directory has no empty-register state')
  }

  /**
   * ONE BADGE REGISTER PARSER. A second one is a second opinion about which
   * columns exist, how an age is read and which rows are usable, and the two
   * would drift the first time somebody hand-edited a cell.
   */
  const registerReaders = []

  for (const directory of ['api', 'server', 'src']) {
    for (const path of walk(join(ROOT, directory))) {
      if (!isTextFile(basename(path))) {
        continue
      }

      if (/BADGE_REGISTER_COLUMNS/.test(stripComments(readText(path) ?? ''))) {
        registerReaders.push(rel(path))
      }
    }
  }

  const allowedReaders = [
    'server/attendees/register.ts',
    'server/sync/sheet-contract.ts',
    'server/sync/sync-registration.ts',
    'server/sync/requests.ts',
  ]

  for (const path of registerReaders) {
    if (!allowedReaders.includes(path)) {
      directoryProblems.push(`${path} parses the Badge Register itself`)
    }
  }

  if (!registerReaders.includes('server/attendees/register.ts')) {
    directoryProblems.push('server/attendees/register.ts no longer reads the Badge Register')
  }

  /** And both modules go through it, rather than each through its own. */
  for (const path of ['api/attendees.ts', 'api/prizes.ts']) {
    if (!/readAttendeeRegister/.test(readText(join(ROOT, path)) ?? '')) {
      directoryProblems.push(`${path} does not use the shared Badge Register reader`)
    }
  }

  /** The four fields, and no attendee contact or payment detail anywhere. */
  for (const field of ['phone', 'whatsapp', 'wa.me', 'payment', 'amount', 'upi']) {
    if (stripComments(attendeeContract).toLowerCase().includes(field)) {
      directoryProblems.push(`the shared attendee contract mentions ${field}`)
    }

    if (endpointCode.toLowerCase().includes(field)) {
      directoryProblems.push(`api/attendees.ts mentions ${field}`)
    }
  }

  if (!/badgeNumber: number[\s\S]{0,120}name: string[\s\S]{0,120}age: number[\s\S]{0,120}gender: AttendeeGender/
    .test(attendeeContract)) {
    directoryProblems.push('the shared attendee shape is not the expected four fields')
  }

  /**
   * THE CARD HAS NO ACTION. One prop in, nothing to call: a directory card
   * that took a handler is a directory card one line away from a mutation.
   */
  for (const capability of ['onClick', 'onSubmit', 'Button', 'disabled', '<form']) {
    if (stripComments(attendeeCard).includes(capability)) {
      directoryProblems.push(`the attendee card offers a control: ${capability}`)
    }
  }

  /**
   * ONLINE ONLY. No cache, no queue, no poll, and no stale roster: a
   * directory presenting an old register as current would tell a volunteer
   * somebody is registered who is not.
   */
  for (const target of [
    'src/attendees', 'src/components/attendees', 'src/pages/attendees-page.tsx',
  ]) {
    const resolved = join(ROOT, target)

    if (!exists(resolved)) {
      directoryProblems.push(`missing: ${target}`)

      continue
    }

    for (const path of statSync(resolved).isDirectory() ? walk(resolved) : [resolved]) {
      const code = stripComments(readText(path) ?? '')

      if (/@\/db\/database|from 'dexie'|outbox|localStorage|sessionStorage|caches\./.test(code)) {
        directoryProblems.push(`${rel(path)} keeps attendee state locally`)
      }

      if (/setInterval/.test(code)) {
        directoryProblems.push(`${rel(path)} polls on an interval`)
      }

      if (/method: '(POST|PUT|PATCH|DELETE)'/.test(code)) {
        directoryProblems.push(`${rel(path)} sends a mutation`)
      }

      /**
       * `setTimeout` is allowed in exactly ONE place and for exactly one
       * reason: aborting a request that never answers.
       */
      const timers = [...code.matchAll(/setTimeout\(/g)].length
      const isRequestTimeout = rel(path) === 'src/attendees/attendee-api.ts' &&
        timers === 1 && /controller\.abort\(\)/.test(code)

      if (timers > 0 && !isRequestTimeout) {
        directoryProblems.push(`${rel(path)} uses a timer that is not the request timeout`)
      }
    }
  }

  if (!/ATTENDEE_MESSAGES.offline|Attendees requires an internet connection/
    .test(attendeeDirectory)) {
    directoryProblems.push('the directory does not say it needs connectivity')
  }

  if (!attendeeApi.includes('Attendees requires an internet connection.')) {
    directoryProblems.push('the offline copy is not the agreed sentence')
  }

  /**
   * A1 NEEDED NO MIGRATION, and still does not.
   *
   * RE-SCOPED BY PHASE D3, which legitimately took the next migration number.
   * Counting files cannot express A1's concern any more, so the concern is
   * stated directly: `device_attributes` is already extensible text, so no
   * migration anywhere creates an attendee table or an attendee column.
   */
  const everyMigration = readdirSync(join(ROOT, 'drizzle'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readText(join(ROOT, 'drizzle', file)) ?? '')
    .join('\n')

  if (/CREATE TABLE "attendee/i.test(everyMigration)) {
    directoryProblems.push('a migration created an attendee table, and none is needed')
  }

  for (const column of ['attendee_name', 'attendee_phone', 'whatsapp']) {
    if (everyMigration.includes(column)) {
      directoryProblems.push(`a migration created an attendee column: ${column}`)
    }
  }

  /**
   * AUTHENTICATED DEVICE TRAFFIC GETS NO FIREWALL RULE. A rule on it would
   * throttle a viewer's ordinary reads while protecting nothing: there is no
   * credential to guess at an endpoint that refuses everything without a
   * device session cookie.
   */
  if (/\*\*Condition — Path\*\* \| `\/api\/attendees`/.test(firewallDoc)) {
    directoryProblems.push('docs/VERCEL_FIREWALL.md rate-limits the authenticated directory')
  }
}

addCheck(
  'attendee-directory',
  'The attendee directory reads the one register, changes nothing, and needs its own attribute',
  directoryProblems,
)

// --- K3. the dandiya ledger: no PII, and the database owns uniqueness -----
/**
 * PHASE D3 ADDED A LENDING LEDGER, AND KEPT THE PRIVACY BOUNDARY. PHASE D3.1
 * GAVE EACH STICK ITS OWN ENDING, WHICH ADDED TWO MORE WAYS TO BE WRONG.
 *
 * A physical pair goes out to two attendees. Each stick comes back or is
 * lost, independently; the loan stays open while either is still out, and the
 * pair code is only free to go out again once BOTH came back. Six things
 * could go wrong, and every one of them would be quiet:
 *
 *   1. THE PARTIAL INDEXES COULD LOSE THEIR PREDICATE. `UNIQUE(event_id,
 *      pair_code)` without `WHERE pair_released_at IS NULL` forbids a pair
 *      from ever going out twice — which is most of what an evening consists
 *      of. The opposite mistake, dropping the index, lets two desks hand out
 *      the same pair.
 *   2. THE ATTENDEE INDEX COULD BECOME PARTIAL ON THE WRONG COLUMN. On
 *      `resolution IS NULL` it reads almost identically and means something
 *      else: a lost stick resolves with `resolution = 'lost'`, so the
 *      attendee would leave the index and could be handed a second pair,
 *      while a RETURNED one would too. The predicate has to be `resolved_at`.
 *   3. A LOSS COULD RELEASE THE PAIR. Releasing is `pair_released_at`, and a
 *      pair with one stick missing must stay quarantined for the rest of the
 *      event. Both directions are a database CHECK, because this is the rule
 *      a well-meaning repair would relax first.
 *   4. A RESOLUTION COULD BE OVERWRITTEN. Returned must never become lost and
 *      lost must never become returned, so every holder write is a
 *      compare-and-set on `resolved_at IS NULL`.
 *   5. THE OUTCOME COULD BE DECIDED FROM A PRIOR READ. "Am I the last stick?"
 *      answered by a SELECT leaves two simultaneous resolutions both deciding
 *      "no", and the loan open forever. It is three mutually exclusive
 *      compare-and-sets in the same transaction instead.
 *   6. IT COULD STORE A PERSON. The ledger holds badge NUMBERS, and a name
 *      column added for the convenience of one card would end the property
 *      Postgres has had since Phase 9A.
 *
 * A last guard is about TIME: nothing may resolve a stick or close a loan on
 * a date. Midnight moves a counter and a history filter, and must never
 * return a stick, close a loan or release a pair.
 */
const dandiyaProblems = []

const dandiyaSchema = readText(join(ROOT, 'server/db/schema.ts'))
const dandiyaMigration = readText(join(ROOT, 'drizzle/0005_dandiya_checkout.sql'))
const dandiyaWriter = readText(join(ROOT, 'server/dandiya/loans.ts'))
const dandiyaBoard = readText(join(ROOT, 'server/dandiya/board.ts'))
const dandiyaEndpoint = readText(join(ROOT, 'api/dandiya.ts'))
const dandiyaContract = readText(join(ROOT, 'src/shared/dandiya-contract.ts'))
const dandiyaRequests = readText(join(ROOT, 'server/dandiya/requests.ts'))
const dandiyaApi = readText(join(ROOT, 'src/dandiya/dandiya-api.ts'))

if (
  dandiyaSchema === null || dandiyaMigration === null || dandiyaWriter === null ||
  dandiyaBoard === null || dandiyaEndpoint === null || dandiyaContract === null ||
  dandiyaRequests === null || dandiyaApi === null
) {
  dandiyaProblems.push('a dandiya module is missing')
} else {
  /**
   * THE TWO PARTIAL UNIQUE INDEXES, in the migration, WITH their predicates.
   * Checked in the SQL rather than in the Drizzle source, because the SQL is
   * what a human applies.
   */
  for (const [index, columns, predicate] of [
    ['dandiya_loans_one_unreleased_per_pair', '"event_id","pair_code"', 'pair_released_at'],
    ['dandiya_loan_holders_one_unresolved_per_badge', '"event_id","badge_number"', 'resolved_at'],
  ]) {
    /**
     * SQL ONLY. 0005's own header explains both indexes in prose, and that
     * commentary sits in the first chunk — so matching the raw file found the
     * CREATE TABLE statement and reported the index missing. A guard that
     * reads a file's documentation as its content verifies nothing.
     */
    const statement = dandiyaMigration
      .replace(/^--.*$/gm, '')
      .split('--> statement-breakpoint')
      .find((entry) => entry.includes(index)) ?? ''

    if (!/CREATE UNIQUE INDEX/.test(statement) || !statement.includes(columns)) {
      dandiyaProblems.push(`0005 does not create the unique index ${index}`)
    }

    // The predicate is what makes reuse after a return possible at all.
    if (!new RegExp(`WHERE[^;]*\\b${predicate}\\b[^;]*is null`, 'i').test(statement)) {
      dandiyaProblems.push(`${index} is not PARTIAL, so a returned loan would block the next`)
    }

    /**
     * AND IT IS PARTIAL ON THE RIGHT COLUMN. `resolution IS NULL` is the
     * near-miss that matters: it looks like the same predicate and releases
     * an attendee the moment their stick is marked LOST, which is exactly
     * when their obligation is not discharged by a returned stick.
     */
    if (/\bresolution\b/i.test(statement.slice(statement.search(/WHERE/i)))) {
      dandiyaProblems.push(`${index} is partial on resolution rather than ${predicate}`)
    }
  }

  /** And the schema still declares them as partial, where a change starts. */
  for (const [table, predicate] of [
    ['dandiyaLoans', 'pairReleasedAt'],
    ['dandiyaLoanHolders', 'resolvedAt'],
  ]) {
    const start = dandiyaSchema.indexOf(`export const ${table} = pgTable(`)
    const nextDeclaration = ['\nexport const ', '\nexport type ']
      .map((marker) => dandiyaSchema.indexOf(marker, start + 1))
      .filter((index) => index !== -1)
    const block = start === -1 || nextDeclaration.length === 0
      ? ''
      : dandiyaSchema.slice(start, Math.min(...nextDeclaration))

    if (!new RegExp(`uniqueIndex\\([\\s\\S]*?\\.where\\(sql\`\\$\\{table\\.${predicate}\\} is null\`\\)`)
      .test(block)) {
      dandiyaProblems.push(`${table} no longer declares its partial unique index`)
    }

    /** No attendee column, in either table. */
    const columns = block.slice(block.indexOf('{'), block.indexOf('\n  },'))
      .replace(/pairCode|pair_code/g, 'label')
      .toLowerCase()

    for (const field of [
      'name', 'phone', 'whatsapp', 'wa.me', 'age', 'gender', 'payment', 'amount',
      'attendee', 'normalized', 'upi',
    ]) {
      if (columns.includes(field)) {
        dandiyaProblems.push(`${table} declares an attendee column: ${field}`)
      }
    }
  }

  /**
   * PAIR CODES ARE CANONICAL, AND THAT UNDERWRITES THE PAIR INDEX.
   *
   * The index compares bytes, so a stored `d-014` beside an open `D-014`
   * would be two loans on one set of sticks. Three things therefore have to
   * hold together, and all three are checked: the shared parser uppercases,
   * the database refuses anything else, and the migration carries that check.
   */
  if (!/trimmed\.toUpperCase\(\)/.test(stripComments(dandiyaContract))) {
    dandiyaProblems.push('parsePairCode no longer canonicalises to uppercase')
  }

  if (!/upper\(btrim\(\$\{table\.pairCode\}\)\)/.test(dandiyaSchema)) {
    dandiyaProblems.push('dandiya_loans no longer requires a canonical pair code')
  }

  if (!/dandiya_loans_pair_code_canonical/.test(dandiyaMigration) ||
      !/= upper\(btrim\("dandiya_loans"\."pair_code"\)\)/.test(dandiyaMigration)) {
    dandiyaProblems.push('0005 no longer enforces a canonical pair code')
  }

  /**
   * ONLY A FULLY RETURNED PAIR IS EVER FREED, AND EVERY FULLY RETURNED PAIR
   * IS.
   *
   * This is the quarantine rule, and it is the one a plausible repair would
   * weaken: a pair with a stick missing stays out of circulation for the
   * whole event, however convenient it would be to hand the remaining stick
   * to somebody. Checked in BOTH directions and in BOTH places, because
   * `pair_released_at` is simultaneously the release and the pair index's
   * predicate — so relaxing it would silently let a quarantined pair be
   * issued again, which is a desk handing out one stick.
   */
  for (const [constraint, definition] of [
    ['dandiya_loans_release_requires_returned', /"pair_released_at" is null or/i],
    ['dandiya_loans_returned_requires_release', /"outcome" is distinct from 'returned' or/i],
  ]) {
    const statement = dandiyaMigration
      .replace(/^--.*$/gm, '')
      .split('--> statement-breakpoint')
      .find((entry) => entry.includes(constraint)) ?? ''

    if (statement === '' || !definition.test(statement)) {
      dandiyaProblems.push(`0005 no longer carries ${constraint}`)
    }
  }

  if (!/release_requires_returned/.test(dandiyaSchema) ||
      !/returned_requires_release/.test(dandiyaSchema)) {
    dandiyaProblems.push('the schema no longer pairs a release with a returned outcome')
  }

  /**
   * ONE WRITER. A second inserter is a second place for somebody to decide
   * they know better than the indexes.
   */
  const dandiyaTableReaders = []

  for (const directory of ['api', 'server', 'src']) {
    for (const path of walk(join(ROOT, directory))) {
      if (!isTextFile(basename(path))) {
        continue
      }

      if (/\bdandiyaLoans\b|\bdandiyaLoanHolders\b/.test(stripComments(readText(path) ?? ''))) {
        dandiyaTableReaders.push(rel(path))
      }
    }
  }

  const allowedDandiyaReaders = ['server/db/schema.ts', 'server/dandiya/loans.ts']

  for (const path of dandiyaTableReaders) {
    if (!allowedDandiyaReaders.includes(path)) {
      dandiyaProblems.push(`${path} reaches the dandiya tables directly`)
    }
  }

  for (const path of allowedDandiyaReaders) {
    if (!dandiyaTableReaders.includes(path)) {
      dandiyaProblems.push(`${path} no longer names the dandiya tables`)
    }
  }

  const writer = stripComments(dandiyaWriter)

  /**
   * ONE TRANSACTION EACH. The loan and both holders commit together, or the
   * pair ends up marked out with one holder; the return closes the loan and
   * releases both holders together, or an attendee stays stuck holding a pair
   * that has come back.
   */
  if ((writer.match(/\.batch\(/g) ?? []).length !== 2) {
    dandiyaProblems.push('server/dandiya/loans.ts no longer issues and returns in one batch each')
  }

  if (!/isNull\(dandiyaLoans\.closedAt\)/.test(writer)) {
    dandiyaProblems.push('the close is not a compare-and-set on an open loan')
  }

  /**
   * A RESOLUTION IS FINAL. Without `resolved_at IS NULL` in the holder
   * update, `return-pair` on a loan with one stick already lost would
   * rewrite that loss as a return — the ledger quietly losing the fact that
   * a stick is gone, and the pair silently becoming reusable.
   */
  if (!/isNull\(dandiyaLoanHolders\.resolvedAt\)/.test(writer)) {
    dandiyaProblems.push('a holder resolution can be overwritten')
  }

  /**
   * AND THE LOAN ROW IS LOCKED FIRST, which is what actually serialises two
   * desks resolving DIFFERENT sticks of one pair.
   *
   * Compare-and-set alone cannot: those two transactions write different
   * holder rows and never conflict, and under READ COMMITTED neither close
   * query can see the other's uncommitted resolution — so both would decline
   * to close and both would commit, leaving every stick resolved and the loan
   * open for the rest of the event. The shared loan row is the serialisation
   * point, and the lock has to be the FIRST statement of the same
   * transaction: taken afterwards it protects nothing, and taken in a
   * transaction of its own it is released before the work it was meant to
   * guard.
   */
  const resolveBatch = writer.slice(
    writer.indexOf('await database.batch(['),
    writer.indexOf('\n  ])', writer.indexOf('await database.batch([')),
  )

  if (!/\.for\('update'\)/.test(writer)) {
    dandiyaProblems.push('the resolution writer no longer locks the loan row')
  }

  if (!resolveBatch.includes('lockOpenLoan(eventId, loanId)')) {
    dandiyaProblems.push('the loan row lock is not inside the resolution transaction')
  }

  for (const [statement, label] of [
    ['.update(dandiyaLoanHolders)', 'a holder resolution'],
    ['.update(dandiyaLoans)', 'a loan close'],
  ]) {
    const lock = resolveBatch.indexOf('lockOpenLoan')
    const at = resolveBatch.indexOf(statement)

    if (lock === -1 || at === -1 || lock > at) {
      dandiyaProblems.push(`${label} runs before the loan row lock`)
    }
  }

  /** The lock is a real row lock on the right row, not a near-miss. */
  const lockDefinition = writer.slice(
    writer.indexOf('const lockOpenLoan ='),
    writer.indexOf('export const resolveDandiyaHolders'),
  )

  for (const required of [
    '.for(\'update\')', 'eq(dandiyaLoans.id, loanId)',
    'eq(dandiyaLoans.eventId, eventId)', 'isNull(dandiyaLoans.closedAt)',
  ]) {
    if (!lockDefinition.includes(required)) {
      dandiyaProblems.push(`the loan row lock does not carry ${required}`)
    }
  }

  /** And nothing stands in for it in the application. */
  if (/advisory|pg_advisory|mutex|navigator\.locks|sleep\(/i.test(writer)) {
    dandiyaProblems.push('the dandiya writer substitutes a lock of its own')
  }

  /**
   * THE OUTCOME IS DERIVED INSIDE THE TRANSACTION, by three mutually
   * exclusive compare-and-sets counting the holders AFTER the resolution in
   * the same batch. Each needs its own guard, so none of them may be dropped
   * and none may become unconditional.
   */
  for (const [guard, outcome] of [
    ['closeWhen(0)', "outcome: 'returned'"],
    ['closeWhen(1)', "outcome: 'partial_loss'"],
    ['closeWhen(2)', "outcome: 'lost'"],
  ]) {
    if (!writer.includes(guard) || !writer.includes(outcome)) {
      dandiyaProblems.push(`the writer no longer closes ${outcome} under ${guard}`)
    }
  }

  if (!/unresolvedHolders\(loanId\)\} = 0/.test(writer) ||
      !/lostHolders\(loanId\)\} = \$\{lost\}/.test(writer)) {
    dandiyaProblems.push('a loan can close with a stick still out')
  }

  /**
   * AND ONLY THE ALL-RETURNED CLOSE RELEASES THE PAIR. The database refuses
   * anything else, but a second `pairReleasedAt` in this file would be an
   * attempt at it, and the attempt is the bug.
   */
  const releasing = [...writer.matchAll(/\.set\(\{([^}]*)\}\)/g)]
    .map((match) => match[1])
    .filter((assignment) => assignment.includes('pairReleasedAt'))

  if (releasing.length !== 1 || !/pairReleasedAt: resolvedAt/.test(releasing[0] ?? '')) {
    dandiyaProblems.push('server/dandiya/loans.ts releases a pair on more than one path')
  }

  /** And a loan is never BORN released, which would free the pair at issue. */
  if (!/pairReleasedAt: null/.test(writer)) {
    dandiyaProblems.push('a new dandiya loan does not start with its pair held')
  }

  if (!/\.delete\(/.test(writer) === false) {
    dandiyaProblems.push('server/dandiya/loans.ts deletes ledger rows')
  }

  /** The two mutations must not be able to write an attendee fact. */
  const inserted = writer.slice(writer.indexOf('const statements = ['), writer.indexOf('try {'))
    .replace(/pairCode/g, 'label')
    .toLowerCase()

  for (const field of ['name', 'age', 'gender', 'phone', 'attendee', 'amount']) {
    if (inserted !== '' && inserted.includes(field)) {
      dandiyaProblems.push(`the dandiya insert sets ${field}, which it must not`)
    }
  }

  /**
   * NOTHING CLOSES A LOAN ON A DATE — and this guard is scoped to the paths
   * that could, which is what it always meant.
   *
   * It used to forbid the calendar anywhere in these two files, which was a
   * fine approximation while the board answered for every day at once. Phase
   * D3.2 made history a question ABOUT a day, so the READ path has to resolve
   * one: the whole point is that the server decides the boundaries in event
   * time rather than trusting a browser's idea of them. Widening the guard to
   * the file would now have forced that decision back into the client, which
   * is worse than the thing the guard was protecting against.
   *
   * What must stay true, and is checked below, is that nothing which WRITES
   * knows the date: a pair is issued and returned by a person, never by a
   * clock.
   */
  const bodyBetween = (source, from, to) => {
    const start = source.indexOf(from)

    if (start === -1) {
      return null
    }

    const end = to === null ? source.length : source.indexOf(to, start + 1)

    return source.slice(start, end === -1 ? source.length : end)
  }

  const CALENDAR = /eventDayKey|currentEventDayKey|eventDayWindow|EVENT_TIME_ZONE/
  const endpointSource = stripComments(dandiyaEndpoint)

  for (const [label, source, from, to] of [
    ['openDandiyaLoan', writer, 'export const openDandiyaLoan', '\nexport '],
    ['resolveDandiyaHolders', writer, 'export const resolveDandiyaHolders', '\nexport '],
    ['lockOpenLoan', writer, 'const lockOpenLoan', '\nexport '],
    ['POST', endpointSource, 'export async function POST(', 'export async function PATCH('],
    ['PATCH', endpointSource, 'export async function PATCH(', null],
  ]) {
    const body = bodyBetween(source, from, to)

    if (body === null) {
      dandiyaProblems.push(`the dandiya ${label} path could not be located`)
    } else if (CALENDAR.test(body)) {
      dandiyaProblems.push(`the dandiya ${label} path consults the calendar`)
    }
  }

  /**
   * AND THE READ PATH RESOLVES THE DAY ON THE SERVER. A `historyDate` that
   * reached SQL as a date string, or boundaries computed in the browser,
   * would both put the event's clock in the wrong place.
   */
  if (!/const readHistoryDay/.test(endpointSource) ||
      !/readHistoryDay\(request\)/.test(endpointSource)) {
    dandiyaProblems.push('the dandiya read path no longer resolves the day server-side')
  }

  if (!/eventDayWindow\(/.test(endpointSource)) {
    dandiyaProblems.push('the dandiya endpoint no longer computes event-day boundaries')
  }

  /**
   * HISTORY IS GROUPED BY `issued_at`, AND THE DAY IS A TIMESTAMP RANGE.
   *
   * Two regressions this catches. `DATE(issued_at)` or `::date` would be
   * evaluated in the database session's timezone and would group the ninety
   * minutes either side of IST midnight into the wrong day — the window a
   * dandiya evening actually lives in. And grouping by `closedAt` would move
   * a loan between days as it was resolved, so "what did we hand out last
   * night" could never be answered twice the same way.
   */
  /**
   * Scoped to the RAW SQL this module writes. Matching the whole file caught
   * `new Date()` and `.update(` — a guard loose enough to fire on correct
   * code is a guard somebody deletes.
   */
  const rawSql = [...writer.matchAll(/sql`([^`]*)`/g)].map((match) => match[1]).join('\n')

  if (/\bdate\s*\(|::date|date_trunc/i.test(rawSql)) {
    dandiyaProblems.push('the dandiya reader casts a timestamp to a date in SQL')
  }

  const composer = stripComments(dandiyaBoard)

  if (!/gte\(dandiyaLoans\.issuedAt/.test(writer) ||
      !/lt\(dandiyaLoans\.issuedAt/.test(writer)) {
    dandiyaProblems.push('the day window is not a half-open issuedAt range')
  }

  if (!/eventDayKey\(row\.issuedAt\) === historyDay/.test(composer)) {
    dandiyaProblems.push('a day\u2019s history is no longer selected by issuedAt')
  }

  if (/eventDayKey\((?:row|loan)\.closedAt\) === historyDay/.test(composer)) {
    dandiyaProblems.push('a day\u2019s history is grouped by closedAt')
  }

  /**
   * MIDNIGHT WRITES NOTHING. There is no nightly job, no snapshot table and
   * no daily rollover mutation — the carryover is derived from open loans on
   * every read, which is why nothing has to be reset at 00:00.
   */
  for (const banned of [
    'daily_snapshot', 'dandiya_day', 'rolloverDay', 'closeOutDay',
    'resetDay', 'archiveDay',
  ]) {
    if ((writer + composer + endpointSource).includes(banned)) {
      dandiyaProblems.push(`a daily rollover mutation appeared: ${banned}`)
    }
  }

  /**
   * AND PREVIOUS-DAY OUTSTANDING IS A PROJECTION of the open loans the board
   * already carries, never a stored figure. It also uses the SERVER's day:
   * a tablet with a wrong clock must not be able to under-report sticks
   * nobody has brought back.
   */
  const dandiyaFilters = stripComments(
    readText(join(ROOT, 'src/dandiya/dandiya-filters.ts')) ?? '',
  )

  if (!/outstandingBeforeDay/.test(dandiyaFilters)) {
    dandiyaProblems.push('the previous-day outstanding projection is gone')
  }

  if (/currentEventDayKey\(\)/.test(
    stripComments(readText(join(ROOT, 'src/components/dandiya/carryover-banner.tsx')) ?? ''),
  )) {
    dandiyaProblems.push('the carryover banner reads the browser clock for today')
  }

  if (!/eventDayKey/.test(stripComments(dandiyaBoard))) {
    dandiyaProblems.push('the dandiya board no longer counts today in the event timezone')
  }

  /**
   * THE CONSTRAINTS ARE THE AUTHORITY, so the endpoint must not precheck
   * them: a SELECT above the insert would only move the race.
   */
  const endpoint = stripComments(dandiyaEndpoint)
  const postStart = endpoint.indexOf('export async function POST(')

  if (postStart === -1) {
    dandiyaProblems.push('api/dandiya.ts exports no POST')
  } else {
    const post = endpoint.slice(postStart, endpoint.indexOf('export async function PATCH('))

    if (post.includes('readDandiyaLedger(')) {
      dandiyaProblems.push('the issue endpoint prechecks the ledger instead of trusting the indexes')
    }

    if (post.indexOf('readAttendeeRegister(') === -1 ||
        post.indexOf('readAttendeeRegister(') > post.indexOf('openDandiyaLoan(')) {
      dandiyaProblems.push('the issue endpoint writes before confirming both badges are registered')
    }

    if (!post.includes("blocked: 'badge-not-registered'")) {
      dandiyaProblems.push('the issue endpoint does not refuse a badge missing from the register')
    }
  }

  /**
   * AND THE RESOLUTION ENDPOINT DECIDES NO ENDING.
   *
   * Its ledger read exists for the MESSAGE — which loan, whose stick — and
   * for nothing else. An outcome computed up here, from rows read before the
   * transaction, is the race in person: two volunteers each take a stick back
   * at the same moment, each reads one stick still out, and the loan never
   * closes. The three compare-and-sets in the writer are the only authority.
   */
  const patchStart = endpoint.indexOf('export async function PATCH(')
  const patch = patchStart === -1 ? '' : endpoint.slice(patchStart)

  if (patch === '') {
    dandiyaProblems.push('api/dandiya.ts exports no PATCH')
  }

  for (const decision of ['partial_loss', 'pairReleasedAt', 'outcome:', 'closedAt']) {
    if (patch.includes(decision)) {
      dandiyaProblems.push(`the resolution endpoint decides the loan's ending: ${decision}`)
    }
  }

  if (!/resolveDandiyaHolders\(/.test(patch)) {
    dandiyaProblems.push('the resolution endpoint does not go through the one writer')
  }

  const methods = [...endpoint.matchAll(/export async function ([A-Z]+)\(/g)]
    .map((match) => match[1])
    .sort()
    .join(',')

  if (methods !== 'GET,PATCH,POST') {
    dandiyaProblems.push(`api/dandiya.ts exports ${methods} rather than exactly GET,PATCH,POST`)
  }

  if (!/DANDIYA_REQUIRED_ATTRIBUTE/.test(endpoint)) {
    dandiyaProblems.push('api/dandiya.ts does not require the dandiya attribute')
  }

  if (/PRIZE_REQUIRED_ATTRIBUTE|ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE|BADGE_RANGE_REQUIRED_ATTRIBUTE/
    .test(endpoint)) {
    dandiyaProblems.push('the dandiya endpoint consults another module\u2019s attribute')
  }

  /** And the ROUTE branch accepts its own attribute and nothing else. */
  const dandiyaBranch = stripComments(authorizationSource ?? '')
    .slice(stripComments(authorizationSource ?? '').indexOf("if (module === 'dandiya')"))
  const dandiyaDecision = dandiyaBranch.slice(0, dandiyaBranch.indexOf('}'))

  if (dandiyaDecision === '' ||
      !/grant\.attributes\.includes\('dandiya'\)/.test(dandiyaDecision)) {
    dandiyaProblems.push('the dandiya route does not require the dandiya attribute')
  }

  for (const other of ['registration', 'prizes', 'attendees']) {
    if (dandiyaDecision.includes(`'${other}'`)) {
      dandiyaProblems.push(
        `the dandiya route accepts another module\u2019s attribute: ${other}`,
      )
    }
  }

  if (/admin-auth|adminSession|readAdminSessionCookie/.test(endpoint)) {
    dandiyaProblems.push('the dandiya endpoint reaches into the Admin realm')
  }

  // A Postgres constraint name is never a wire value, and never a response.
  for (const line of endpoint.split('\n')) {
    if (line.includes('SQLSTATE') && !line.includes('console.error')) {
      dandiyaProblems.push('the dandiya endpoint moves a SQLSTATE outside the server log')
    }
  }

  if (/dandiya_loans_|dandiya_loan_holders_/.test(endpoint)) {
    dandiyaProblems.push('the dandiya endpoint names a database constraint')
  }

  /** Every identity, timing and attendee field is refused, not ignored. */
  for (const field of [
    'eventId', 'eventSlug', 'deviceId', 'loginName', 'issuedAt', 'closedAt',
    'closedByDeviceId', 'outcome', 'pairReleasedAt', 'resolvedAt',
    'resolvedByDeviceId', 'attendees', 'name', 'age', 'gender',
  ]) {
    if (!new RegExp(`'${field}'`).test(dandiyaRequests)) {
      dandiyaProblems.push(`a dandiya request body may still carry ${field}`)
    }
  }

  /** It reuses the ONE Badge Register reader rather than parsing the Sheet. */
  if (!/readAttendeeRegister/.test(endpoint)) {
    dandiyaProblems.push('api/dandiya.ts does not use the shared Badge Register reader')
  }

  if (/BADGE_REGISTER_COLUMNS|checkTabShape/.test(endpoint + stripComments(dandiyaBoard))) {
    dandiyaProblems.push('the dandiya module parses the Badge Register itself')
  }

  for (const field of ['phone', 'whatsapp', 'paymentMethod', 'amount']) {
    if (new RegExp(`${field}\\s*[:?]`, 'i').test(stripComments(dandiyaContract))) {
      dandiyaProblems.push(`the shared dandiya contract declares ${field}`)
    }
  }

  /**
   * ONLINE ONLY. No local dandiya state, no queue, no timer. A pair that
   * survived a failed request is how two desks hand out the same sticks.
   */
  for (const directory of [
    'src/dandiya', 'src/components/dandiya', 'src/pages/dandiya-page.tsx',
  ]) {
    const target = join(ROOT, directory)

    if (!exists(target)) {
      dandiyaProblems.push(`missing: ${directory}`)

      continue
    }

    for (const path of statSync(target).isDirectory() ? walk(target) : [target]) {
      const code = stripComments(readText(path) ?? '')

      if (/@\/db\/database|from 'dexie'|outbox|localStorage|sessionStorage|caches\./.test(code)) {
        dandiyaProblems.push(`${rel(path)} keeps dandiya state locally`)
      }

      if (/setInterval/.test(code)) {
        dandiyaProblems.push(`${rel(path)} polls on an interval`)
      }

      /**
       * `setTimeout` is allowed in exactly ONE place and for one reason:
       * aborting a request that never answers. Anywhere else it is a retry,
       * and a retried issue could put one pair out twice.
       */
      const timers = [...code.matchAll(/setTimeout\(/g)].length
      const isRequestTimeout = rel(path) === 'src/dandiya/dandiya-api.ts' &&
        timers === 1 && /controller\.abort\(\)/.test(code)

      if (timers > 0 && !isRequestTimeout) {
        dandiyaProblems.push(`${rel(path)} uses a timer that is not the request timeout`)
      }
    }
  }

  /**
   * A QUARANTINED PAIR BLOCKS, A PERSON'S PAST LOSS DOES NOT.
   *
   * These two warnings look alike on screen and must behave oppositely. A
   * pair with a stick missing cannot physically be handed over, so Issue is
   * unavailable. An attendee who lost a stick earlier is simply somebody the
   * volunteer should know about — refusing them would turn a lending desk
   * into a debt collector, and the operator has no way to override it.
   *
   * Pinned as EXPRESSIONS: the warning copy existing proves nothing about
   * what the button does.
   */
  const issueForm = stripComments(readText(join(ROOT, 'src/components/dandiya/issue-pair-form.tsx')) ?? '')

  if (!/availability\.status === 'available' &&/.test(issueForm)) {
    dandiyaProblems.push('the issue form no longer refuses an unavailable pair')
  }

  const readyExpression = issueForm.slice(
    issueForm.indexOf('const ready ='),
    issueForm.indexOf('\n\n', issueForm.indexOf('const ready =')),
  )

  if (/priorLoss/i.test(readyExpression)) {
    dandiyaProblems.push('a previous loss blocks the attendee from being issued a pair')
  }

  const picker = stripComments(readText(join(ROOT, 'src/components/dandiya/attendee-picker.tsx')) ?? '')

  for (const line of picker.split('\n')) {
    if (/disabled=|aria-disabled/.test(line) && /priorLoss/i.test(line)) {
      dandiyaProblems.push('the attendee picker disables a control on a previous loss')
    }
  }

  /**
   * AND THE ISSUES TAB IS READ-ONLY. Freeing a quarantined pair means
   * somebody physically repaired or replaced it; that is a decision with a
   * person behind it, not a button on the floor beside the warning.
   */
  const issues = stripComments(readText(join(ROOT, 'src/components/dandiya/pair-issues.tsx')) ?? '')

  if (issues === '') {
    dandiyaProblems.push('src/components/dandiya/pair-issues.tsx could not be read')
  }

  for (const control of ['onResolve', 'onIssue', 'Restore', 'Release', 'fetch(', '<Button']) {
    if (issues.includes(control)) {
      dandiyaProblems.push(`the dandiya issues tab offers a mutation: ${control}`)
    }
  }

  if (/queue|retry\(|navigator\.onLine/.test(stripComments(dandiyaApi))) {
    dandiyaProblems.push('src/dandiya/dandiya-api.ts queues or retries a mutation')
  }

  if (!dandiyaApi.includes('Dandiya requires an internet connection.')) {
    dandiyaProblems.push('the offline copy is not the agreed sentence')
  }

  /** D3 changes no stored contract of any earlier phase. */
  const dexieForDandiya = readText(join(ROOT, 'src/db/database.ts'))

  if (dexieForDandiya === null || !/DATABASE_VERSION = 1\b/.test(dexieForDandiya)) {
    dandiyaProblems.push('the IndexedDB version is no longer pinned at 1')
  }

  for (const path of ['api/sync-registration.ts', 'api/device-auth.ts', 'api/prizes.ts']) {
    if (/dandiya\//.test(readText(join(ROOT, path)) ?? '')) {
      dandiyaProblems.push(`${path} now depends on the dandiya module`)
    }
  }

  /**
   * AUTHENTICATED DEVICE TRAFFIC GETS NO FIREWALL RULE. A rule would throttle
   * a desk's ordinary board reads while protecting nothing.
   */
  if (/\*\*Condition — Path\*\* \| `\/api\/dandiya`/.test(firewallDoc)) {
    dandiyaProblems.push('docs/VERCEL_FIREWALL.md rate-limits the authenticated dandiya endpoint')
  }
}

/**
 * THE REAL-DATABASE PROOF EXISTS, AND REFUSES EVERYTHING BUT DEVELOPMENT.
 *
 * The stand-in database cannot test PostgreSQL visibility, so the lock's
 * EFFECT is proved only by a live concurrent run. A missing or ungated script
 * would leave that resting on structure alone — and an ungated one that wrote
 * to Production would be far worse than no script at all.
 */
const dandiyaSmoke = readText(join(ROOT, 'scripts/dandiya-concurrency-smoke.mjs'))

if (dandiyaSmoke === null) {
  dandiyaProblems.push('scripts/dandiya-concurrency-smoke.mjs is missing')
} else {
  for (const interlock of [
    "process.env.ALLOW_DANDIYA_DB_SMOKE_WRITES !== 'true'",
    "process.env.VERCEL_ENV !== 'development'",
    "allowedEnv !== 'development'",
  ]) {
    if (!dandiyaSmoke.includes(interlock)) {
      dandiyaProblems.push(`the dandiya smoke lost an interlock: ${interlock}`)
    }
  }

  if (!dandiyaSmoke.includes('--confirm')) {
    dandiyaProblems.push('the dandiya smoke runs without an explicit confirmation')
  }

  /** It cleans up only its own rows, and touches no central table. */
  if (/delete from (events|devices|device_attributes|badge_assignments|prize_awards)/i
    .test(dandiyaSmoke)) {
    dandiyaProblems.push('the dandiya smoke deletes central state')
  }

  if (!dandiyaSmoke.includes('SMOKE-D31-')) {
    dandiyaProblems.push('the dandiya smoke no longer isolates its fixture pair codes')
  }

  /** And it is never wired into a gate that runs unattended. */
  const manifest = readText(join(ROOT, 'package.json')) ?? ''
  const unattended = ['"verify"', '"release:check"', '"build"', '"lint"']
    .map((name) => {
      const at = manifest.indexOf(name)

      return at === -1 ? '' : manifest.slice(at, manifest.indexOf('\n', at))
    })
    .join('\n')

  if (/dandiya-concurrency-smoke|db:smoke/.test(unattended)) {
    dandiyaProblems.push('a writing smoke test is wired into an unattended gate')
  }
}

addCheck(
  'dandiya-ledger',
  'The dandiya ledger holds no attendee PII, and the database owns one-pair-one-loan',
  dandiyaProblems,
)

// --- L. db:check knows about every migrated table -------------------------
/**
 * A REAL RELEASE-PROCESS GAP, now a durable check.
 *
 * `pnpm db:check` is the only thing that proves a migrated database actually
 * carries what the migrations describe. Phase P1 added `0003_prize_awards.sql`
 * and did not teach `db:check` about it, so the script would have reported a
 * perfectly healthy database that was missing the entire prize ledger — and
 * the operator running it before the event would have believed it.
 *
 * The rule is therefore general: a table a migration creates must be named in
 * `db-check`, whatever phase adds it.
 *
 * It stays READ-ONLY. Proving a constraint REJECTS a write needs a write,
 * which is `db:smoke`'s separate and explicitly gated job.
 */
const dbCheckProblems = []
const dbCheckSource = readText(join(ROOT, 'scripts/db-check.mjs'))

/**
 * One of `db-check`'s expectation ARRAYS, sliced out by name.
 *
 * Membership is checked inside the list that actually drives a check, not
 * anywhere in the file. A whole-file substring match let a canary that
 * deleted `prize_awards` from `EXPECTED_TABLES` straight through, because the
 * name still occurred further down in the code that reads the table — a guard
 * that proves a string is mentioned proves nothing about what is verified.
 *
 * A missing array is reported rather than skipped, so restructuring the
 * script fails loudly instead of quietly disabling this.
 */
const dbCheckList = (source, name) => {
  const start = source.indexOf(`const ${name} = [`)

  if (start === -1) {
    return null
  }

  const end = source.indexOf('\n]', start)

  return end === -1 ? null : source.slice(start, end)
}

if (dbCheckSource === null) {
  dbCheckProblems.push('scripts/db-check.mjs could not be read')
} else {
  const expectedTables = dbCheckList(dbCheckSource, 'EXPECTED_TABLES')

  if (expectedTables === null) {
    dbCheckProblems.push('db:check no longer declares EXPECTED_TABLES')
  }

  const migrationSql = migrationFiles
    .map((file) => readText(join(ROOT, 'drizzle', file)) ?? '')
    .join('\n')

  for (const match of migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)) {
    if (expectedTables !== null && !expectedTables.includes(`'${match[1]}'`)) {
      dbCheckProblems.push(
        `db:check does not know about the migrated table ${match[1]}`,
      )
    }
  }

  /**
   * And for the PRIZE migrations specifically, every guarantee they leave
   * BEHIND. The cross-event integrity and both name bounds live entirely in
   * those constraints, so "the table exists" is not enough.
   *
   * EFFECTIVE, not merely created: 0003 creates seven constraints and 0004
   * drops one of them, so what `db:check` must verify is the difference. A
   * dropped constraint is checked the other way round — for being ABSENT —
   * which is the next assertion down.
   *
   * Scoped to the prize migrations deliberately: the earlier ones predate
   * this rule and `db:check` covers a chosen subset of their constraints,
   * with the badge ones additionally exercised behaviourally by `db:smoke`.
   * Widening this to every historical constraint would be a different,
   * larger decision.
   */
  const prizeMigration = readText(join(ROOT, 'drizzle/0003_prize_awards.sql'))
  const repeatMigration = readText(join(ROOT, 'drizzle/0004_repeat_prize_awards.sql'))

  if (prizeMigration === null || repeatMigration === null) {
    dbCheckProblems.push('a prize migration could not be read')
  } else {
    const removed = [
      ...repeatMigration.matchAll(/DROP CONSTRAINT "([a-z_0-9]+)"/g),
    ].map((match) => match[1])

    if (removed.length === 0) {
      dbCheckProblems.push('no dropped constraint could be read from 0004')
    }

    const created = [
      ...prizeMigration.matchAll(/(?:ADD )?CONSTRAINT "([a-z_0-9]+)"/g),
      ...prizeMigration.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_0-9]+)"/g),
    ].map((match) => match[1]).filter((name) => !removed.includes(name))

    if (created.length === 0) {
      dbCheckProblems.push('no prize constraint or index could be read from 0003')
    }

    const expectedPrize = [
      dbCheckList(dbCheckSource, 'EXPECTED_PRIZE_CONSTRAINTS'),
      dbCheckList(dbCheckSource, 'EXPECTED_PRIZE_INDEXES'),
      dbCheckList(dbCheckSource, 'EXPECTED_GUARANTEES'),
    ]

    if (expectedPrize.some((list) => list === null)) {
      dbCheckProblems.push('db:check no longer declares its prize expectation lists')
    }

    const expectedPrizeText = expectedPrize.filter((list) => list !== null).join('\n')

    for (const name of new Set(created)) {
      if (!expectedPrizeText.includes(name)) {
        dbCheckProblems.push(`db:check does not verify the prize guarantee ${name}`)
      }
    }

    /**
     * A DROPPED CONSTRAINT MUST NOT BE EXPECTED. If `db:check` still demanded
     * P1's `UNIQUE(event_id, badge_number)`, a correctly migrated database
     * would fail the check and the operator's fix would be to put the
     * constraint back — which is the one thing that must not happen.
     */
    for (const name of new Set(removed)) {
      if (expectedPrizeText.includes(name)) {
        dbCheckProblems.push(`db:check still expects the dropped constraint ${name}`)
      }
    }

    /**
     * And it must prove the ABSENCE, visibly. A database that still carries
     * per-attendee uniqueness refuses a second legitimate prize, which a
     * volunteer meets at the table rather than at release time, so `db:check`
     * reports it as its own line and looks for the SHAPE: a replacement on
     * `(event_id, badge_number, prize_name)` would be a different name and
     * the same broken rule.
     */
    if (!/repeated prize awards are allowed/.test(dbCheckSource)) {
      dbCheckProblems.push('db:check does not prove that repeat prize awards are possible')
    }

    for (const shape of ['primary key', 'create unique index', "includes('badge_number')"]) {
      if (!dbCheckSource.includes(shape)) {
        dbCheckProblems.push(`db:check does not look for the uniqueness shape: ${shape}`)
      }
    }

    /**
     * Every prize column too: an ADDED one is the privacy regression, and
     * `db:check` compares the column SET rather than looking for presence.
     *
     * The count is asserted first. A regex that matched nothing would make
     * the loop below pass by never running — which is the shape of a guard
     * that looks careful and checks nothing.
     */
    const declared = [
      ...prizeMigration.matchAll(/^\s*"([a-z_]+)" (?:uuid|integer|text|timestamp)/gm),
    ].map((match) => match[1])

    if (declared.length !== 6) {
      dbCheckProblems.push(
        `expected 6 prize columns in 0003, read ${String(declared.length)}`,
      )
    }

    const prizeColumnList = dbCheckList(dbCheckSource, 'PRIZE_COLUMNS')

    if (prizeColumnList === null) {
      dbCheckProblems.push('db:check no longer declares PRIZE_COLUMNS')
    }

    for (const column of declared) {
      if (prizeColumnList !== null && !prizeColumnList.includes(`'${column}'`)) {
        dbCheckProblems.push(`db:check does not verify the prize column ${column}`)
      }
    }
  }

  /**
   * AND THE DANDIYA MIGRATION'S OWN GUARANTEES. Scoped the same way the prize
   * ones are: every constraint and index 0005 creates must be verified by
   * `db:check`, and both column sets must be declared — because "the tables
   * exist" says nothing about whether a pair can be issued twice.
   */
  const dandiyaMigrationSql = readText(join(ROOT, 'drizzle/0005_dandiya_checkout.sql'))

  if (dandiyaMigrationSql === null) {
    dbCheckProblems.push('drizzle/0005_dandiya_checkout.sql could not be read')
  } else {
    // SQL only: the header names these in prose, which is not a declaration.
    const statements = dandiyaMigrationSql.replace(/^--.*$/gm, '')

    const createdDandiya = [
      ...statements.matchAll(/(?:ADD )?CONSTRAINT "([a-z_0-9]+)"/g),
      ...statements.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_0-9]+)"/g),
    ].map((match) => match[1])

    if (createdDandiya.length === 0) {
      dbCheckProblems.push('no dandiya constraint or index could be read from 0005')
    }

    const expectedDandiya = [
      dbCheckList(dbCheckSource, 'EXPECTED_DANDIYA_CONSTRAINTS'),
      dbCheckList(dbCheckSource, 'EXPECTED_DANDIYA_INDEXES'),
    ]

    if (expectedDandiya.some((list) => list === null)) {
      dbCheckProblems.push('db:check no longer declares its dandiya expectation lists')
    }

    const expectedDandiyaText = expectedDandiya.filter((list) => list !== null).join('\n')

    /**
     * The plain btree indexes are read-path optimisations rather than
     * guarantees, so they are exempt by name — but anything UNIQUE, and every
     * constraint, has to be verified.
     */
    const readPathIndexes = [
      'dandiya_loans_event_id_idx',
      'dandiya_loans_issued_by_device_id_idx',
      'dandiya_loan_holders_loan_id_idx',
      'dandiya_loan_holders_event_id_idx',
    ]

    for (const name of new Set(createdDandiya)) {
      if (!readPathIndexes.includes(name) && !expectedDandiyaText.includes(name)) {
        dbCheckProblems.push(`db:check does not verify the dandiya guarantee ${name}`)
      }
    }

    /**
     * And the PREDICATES, each inside ITS OWN index entry.
     *
     * Joining both expectation lists and searching for the predicate anywhere
     * was not enough: `returned_at is null` also appears in the
     * `dandiya_loans_return_paired` CHECK expectation, so deleting it from
     * the pair INDEX left the guard satisfied by an unrelated entry. A canary
     * found that — searching a haystack proves nothing about the needle's
     * position.
     */
    /**
     * And the CANONICAL check, by its definition. Verified by name alone it
     * could be renamed to anything and still pass, while the index it
     * underwrites would quietly stop meaning one-pair-one-loan.
     */
    const constraintExpectations =
      dbCheckList(dbCheckSource, 'EXPECTED_DANDIYA_CONSTRAINTS') ?? ''

    if (!constraintExpectations.includes('pair_code = upper(btrim(pair_code))')) {
      dbCheckProblems.push('db:check does not verify that pair codes are stored canonical')
    }

    const indexExpectations = dbCheckList(dbCheckSource, 'EXPECTED_DANDIYA_INDEXES') ?? ''

    for (const [index, predicate] of [
      ['dandiya_loans_one_unreleased_per_pair', 'pair_released_at is null'],
      ['dandiya_loan_holders_one_unresolved_per_badge', 'resolved_at is null'],
    ]) {
      const start = indexExpectations.indexOf(`'${index}'`)
      const entry = start === -1
        ? ''
        : indexExpectations.slice(start, indexExpectations.indexOf('],', start))

      if (!entry.includes(predicate) || !entry.includes("'where'")) {
        dbCheckProblems.push(
          `db:check does not verify ${index} is PARTIAL on ${predicate}`,
        )
      }

      /**
       * AND NOT ON `resolution`, the near-miss that would release an attendee
       * the moment their stick was recorded LOST. Scoped to this entry for
       * the same reason the predicate is: the word occurs legitimately in the
       * constraint expectations a few lines above.
       */
      if (/\bresolution is null\b/.test(entry)) {
        dbCheckProblems.push(`db:check expects ${index} to be partial on resolution`)
      }
    }

    /**
     * THE QUARANTINE RULE, BY ITS DEFINITION in both directions. Verified by
     * name alone, either constraint could be rewritten to permit a lost pair
     * to be released — and the pair index's predicate is that same column, so
     * the pair would go back into circulation with a stick missing.
     */
    for (const fragment of [
      "outcome = 'returned'",
      "outcome is distinct from 'returned'",
      'pair_released_at is not null',
    ]) {
      if (!constraintExpectations.includes(fragment)) {
        dbCheckProblems.push(`db:check does not verify the release rule: ${fragment}`)
      }
    }

    /** And that a resolution and a close are each all-or-nothing. */
    for (const name of [
      'dandiya_loans_close_paired',
      'dandiya_loan_holders_resolution_paired',
      'dandiya_loans_outcome_valid',
      'dandiya_loan_holders_resolution_valid',
    ]) {
      if (!constraintExpectations.includes(name)) {
        dbCheckProblems.push(`db:check does not verify ${name}`)
      }
    }

    for (const list of ['DANDIYA_LOAN_COLUMNS', 'DANDIYA_HOLDER_COLUMNS']) {
      if (!dbCheckSource.includes(`const ${list} = {`)) {
        dbCheckProblems.push(`db:check no longer declares ${list}`)
      }
    }

    const declaredDandiya = [
      ...statements.matchAll(/^\s*"([a-z_]+)" (?:uuid|integer|smallint|text|timestamp)/gm),
    ].map((match) => match[1])

    if (declaredDandiya.length !== 17) {
      dbCheckProblems.push(
        `expected 17 dandiya columns in 0005, read ${String(declaredDandiya.length)}`,
      )
    }

    const dandiyaColumnLists = ['DANDIYA_LOAN_COLUMNS', 'DANDIYA_HOLDER_COLUMNS']
      .map((name) => {
        const start = dbCheckSource.indexOf(`const ${name} = {`)

        return start === -1 ? '' : dbCheckSource.slice(start, dbCheckSource.indexOf('\n}', start))
      })
      .join('\n')

    for (const column of new Set(declaredDandiya)) {
      if (!dandiyaColumnLists.includes(`'${column}'`)) {
        dbCheckProblems.push(`db:check does not verify the dandiya column ${column}`)
      }
    }
  }

  // READ-ONLY, and not by convention: no statement may mutate anything.
  const dbCheckCode = stripComments(dbCheckSource)

  for (const statement of [
    'INSERT', 'UPDATE ', 'DELETE', 'CREATE TABLE', 'ALTER ', 'DROP ', 'TRUNCATE',
  ]) {
    if (dbCheckCode.includes(statement)) {
      dbCheckProblems.push(`scripts/db-check.mjs is no longer read-only: ${statement.trim()}`)
    }
  }

  /**
   * And it must not SHELL OUT, which is how it could run a migration without
   * containing one. Naming `pnpm db:migrate` in the closing hint is fine and
   * useful — that is advice to a human, not an invocation.
   */
  for (const escape of ['child_process', 'execSync', 'spawnSync', 'spawn(', 'exec(']) {
    if (dbCheckCode.includes(escape)) {
      dbCheckProblems.push(`scripts/db-check.mjs can run a command: ${escape}`)
    }
  }

  // The connection string is a credential and is never printed.
  if (/console\.(log|error)\([^)]*databaseUrl/.test(dbCheckCode)) {
    dbCheckProblems.push('scripts/db-check.mjs prints the connection string')
  }
}

addCheck(
  'db-check-coverage',
  'pnpm db:check verifies every migrated table, the prize rule and the dandiya guarantees',
  dbCheckProblems,
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
