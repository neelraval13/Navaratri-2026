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
  'src/shared/device-password.ts',
  'api/admin-login.ts',
  'api/admin-device-password.ts',
  'api/admin-session.ts',
  'api/admin-logout.ts',
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

// Phase 9C-A stores credentials; it must NOT enable a device login.
for (const name of ['device-login.ts', 'device-session.ts', 'device-logout.ts']) {
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
  'Device credentials are server-side only and login stays unbuilt',
  credentialProblems,
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
