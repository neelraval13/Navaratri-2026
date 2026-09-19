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
  'server/sync/environment.ts',
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

// --- G. client code never reads a server-only variable ----------------------
const clientProblems = []
const srcRoot = join(ROOT, 'src')

for (const path of walk(srcRoot)) {
  if (!isTextFile(basename(path))) {
    continue
  }

  const text = readText(path)

  if (text === null || !text.includes('process.env')) {
    continue
  }

  // A name in a comment or a shared type is fine; reading process.env is not.
  clientProblems.push(`${rel(path)} reads process.env in client code`)
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
