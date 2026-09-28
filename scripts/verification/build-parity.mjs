/**
 * Build-parity verification — the api/ and server/ typecheck cannot be skipped.
 *
 * Run with:  pnpm verify:parity
 *
 * A local build once passed while Vercel found dozens of TypeScript errors in
 * `api/**` and `server/**`. Two things caused it, and both are asserted here:
 *
 *  1. `@types/node` missing from the compile, which removes `process`,
 *     `Buffer`, `node:*` AND the Web `Request`/`Response`/`URL` types the
 *     Vercel functions are written against.
 *  2. A NON-STRICT compile. Without `strictNullChecks`, a discriminated union
 *     stops narrowing through `if (!result.ok)`, and every `result.response`,
 *     `result.message` and `result.blocked` below it becomes an error.
 *
 * This suite reproduces both degradations against the real source and
 * requires zero errors, so the repository cannot pass locally and fail there.
 *
 * It runs `tsc` and reads files. It contacts nothing.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')

let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { fails++; console.log(`FAIL ${label}\n     got  ${String(JSON.stringify(actual))}\n     want ${String(JSON.stringify(expected))}`) }
  else console.log(`ok   ${label.padEnd(58)} ${String(JSON.stringify(actual)).slice(0, 38)}`)
}

const read = (p) => readFileSync(join(root, p), 'utf8')
const readConfig = (p) =>
  JSON.parse(read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Compiles api/ + server/ under one throwaway configuration.
 *
 * Async so the profiles run concurrently — eight sequential `tsc` passes take
 * minutes, and they are independent.
 */
const compile = async (label, compilerOptions) => {
  const directory = mkdtempSync(join(tmpdir(), 'navaratri-parity-'))
  const configPath = join(directory, 'tsconfig.json')

  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        paths: { '@/*': [join(root, 'src') + '/*'] },
        // The config is written to a temp directory, so every path that
        // TypeScript resolves relative to it has to be absolute.
        typeRoots: [join(root, 'node_modules/@types')],
        skipLibCheck: true,
        noEmit: true,
        ...compilerOptions,
      },
      include: [join(root, 'api'), join(root, 'server'), join(root, 'src/shared')],
    }),
  )

  let output = ''

  try {
    const result = await run('npx', ['tsc', '-p', configPath], { cwd: root })

    output = `${result.stdout}${result.stderr}`
  } catch (error) {
    // A non-zero exit is how tsc reports diagnostics; the output is on the error.
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const lines = output
    .split('\n')
    .filter((line) => line.includes('error TS') && !line.includes('node_modules'))

  rmSync(directory, { recursive: true, force: true })

  return { label, errors: lines }
}

console.log('=== THE DEGRADED COMPILE FINDS NOTHING ===')
const profiles = [
  ['non-strict (the pre-TS6 default)', { strict: false, target: 'es2023', lib: ['ES2023'], types: ['node'] }],
  ['non-strict + CommonJS/Node10', {
    strict: false, target: 'es2022', lib: ['ES2022'], types: ['node'],
    module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0',
    esModuleInterop: true, allowSyntheticDefaultImports: true,
  }],
  ['non-strict + NodeNext', {
    strict: false, target: 'es2023', lib: ['ES2023'], types: ['node'],
    module: 'nodenext', moduleResolution: 'nodenext',
  }],
  ['strict + bundler resolution', {
    strict: true, target: 'es2023', lib: ['ES2023'], types: ['node'],
    module: 'esnext', moduleResolution: 'bundler',
  }],
]

const clean = await Promise.all(profiles.map(([label, options]) => compile(label, options)))

for (const result of clean) {
  check(result.label, result.errors, [])
}

console.log('\n=== THE DEGRADATION IS REAL, NOT A NO-OP ===')
/**
 * Without this, the profiles above could silently stop checking anything and
 * the suite would still pass. A deliberate error must be caught by each.
 */
const canary = join(root, 'server', '__parity-canary.ts')

try {
  writeFileSync(canary, 'export const canary: number = "not a number"\n')

  const planted = await Promise.all(profiles.map(([label, options]) => compile(label, options)))

  for (const result of planted) {
    check(`  ${result.label} catches a planted error`,
      result.errors.some((line) => line.includes('__parity-canary')), true)
  }
} finally {
  rmSync(canary, { force: true })
}

check('the canary left nothing behind', existsSync(canary), false)

console.log('\n=== CONFIGURATION ===')
const serverConfig = readConfig('tsconfig.server.json')
check('the server project covers api/ and server/',
  ['api', 'server'].every((entry) => (serverConfig.include ?? []).includes(entry)), true)
check('  with the Node environment', serverConfig.compilerOptions.types, ['node'])
check('  and strict on', serverConfig.compilerOptions.strict, true)
check('  and Node ESM resolution, so `.js` specifiers stay required',
  [serverConfig.compilerOptions.module, serverConfig.compilerOptions.moduleResolution],
  ['NodeNext', 'NodeNext'])

const parityConfig = readConfig('tsconfig.parity.json')
check('the committed parity profile is DEGRADED on purpose',
  parityConfig.compilerOptions.strict, false)
check('  and still covers api/ and server/',
  ['api', 'server'].every((entry) => (parityConfig.include ?? []).includes(entry)), true)
check('  with typeRoots pinned so a missing @types/node fails loudly',
  parityConfig.compilerOptions.typeRoots, ['./node_modules/@types'])

const rootConfig = readConfig('tsconfig.json')
check('the ROOT solution file hands naive tools a safe baseline',
  [rootConfig.compilerOptions.strict, rootConfig.compilerOptions.types], [true, ['node']])
check('  it still compiles nothing itself', rootConfig.files, [])
check('  and still points at all three projects',
  rootConfig.references.map((reference) => reference.path).sort(),
  ['./tsconfig.app.json', './tsconfig.node.json', './tsconfig.server.json'])

const appConfig = readConfig('tsconfig.app.json')
check('the browser project keeps its OWN environment',
  appConfig.compilerOptions.types, ['vite/client'])
check('  no Node globals leak into it',
  (appConfig.compilerOptions.types ?? []).includes('node'), false)
check('  and it still covers only src', appConfig.include, ['src'])

console.log('\n=== THE BUILD CANNOT SKIP IT ===')
const manifest = JSON.parse(read('package.json'))
check('build typechecks before bundling', manifest.scripts.build, 'pnpm typecheck && vite build')
check('  typecheck covers every project and the parity profile',
  manifest.scripts.typecheck, 'tsc -b && pnpm typecheck:parity')
check('  and each is separately runnable',
  ['typecheck:client', 'typecheck:server', 'typecheck:parity']
    .map((name) => typeof manifest.scripts[name]), ['string', 'string', 'string'])
check('@types/node is a declared devDependency',
  typeof manifest.devDependencies['@types/node'], 'string')
check('pnpm is pinned exactly',
  /^pnpm@10\.\d+\.\d+$/.test(manifest.packageManager ?? ''), true)
check('TypeScript is not downgraded to hide errors',
  /^[~^]?6\./.test(manifest.devDependencies.typescript), true)

console.log('\n=== TYPES ARE FIXED, NOT SILENCED ===')
const sources = ['api', 'server', 'src'].flatMap((directory) => walk(join(root, directory)))
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
for (const [label, pattern, useStripped] of [
  ['@ts-ignore', /@ts-ignore/, false],
  ['@ts-expect-error', /@ts-expect-error/, false],
  ['@ts-nocheck', /@ts-nocheck/, false],
  ['`as any`', /\bas any\b/, true],
])
  check(`no ${label}`,
    sources.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return pattern.test(useStripped ? stripComments(text) : text)
    }).map((file) => file.replace(`${root}/`, '')), [])

/**
 * `as unknown as` is not banned outright: two sites predate this repair and
 * are genuine library-typing limitations (drizzle's `batch` signature, and
 * the wire contract's post-validation payload narrowing). They are pinned so
 * a NEW one cannot appear unnoticed.
 */
check('`as unknown as` appears only where it already did',
  sources.filter((file) => /\bas unknown as\b/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')).sort(),
  ['server/admin/registry.ts', 'src/shared/sync-contract.ts'])

console.log('\n=== RESULT CONTRACTS NARROW EXPLICITLY ===')
/**
 * `if (!result.ok)` narrows only under strictNullChecks. An explicit
 * comparison against the discriminant narrows everywhere, which is what makes
 * the degraded compiles above come back clean.
 */
const resultUnions = sources
  .filter((file) => /\/(api|server)\//.test(file) || file.includes('/src/shared/'))
  .map((file) => ({ file: file.replace(`${root}/`, ''), code: readFileSync(file, 'utf8') }))
check('no result union is narrowed by bare negation',
  resultUnions.filter((entry) => /if \(!\w+\.(ok|allowed)\)/.test(entry.code))
    .map((entry) => entry.file), [])
check('  the explicit form is used instead',
  resultUnions.filter((entry) => /\.ok === (true|false)/.test(entry.code)).length > 15, true)

console.log('\n=== NOTHING ELSE MOVED ===')
check('no migration was added',
  readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('IndexedDB version unchanged (1)',
  /DATABASE_VERSION = 1/.test(read('src/db/database.ts')), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(read('src/db/database.ts'))?.[1] ?? '')
    .match(/^\s*(\w+):/gm) ?? []).map((m) => m.trim().replace(':', '')),
  ['registrations', 'config', 'outbox'])
check('Sheet ranges unchanged',
  [/A1:N/.test(read('server/sync/sheet-contract.ts')),
   /A1:M/.test(read('server/sync/sheet-contract.ts'))], [true, true])
check('the central enrollment shape is unchanged',
  (/export interface CentralDeviceEnrollment \{([\s\S]*?)\n\}/.exec(read('src/db/types.ts'))?.[1] ?? '')
    .match(/^\s{2}(\w+)[?]?:/gm)?.map((m) => m.trim().replace(/[?:]/g, '')),
  ['deviceId', 'eventId', 'eventSlug', 'deviceName', 'loginName', 'attributes', 'verifiedAt'])
check('  and still carries no badge range or credential',
  /activeBadgeRange|rangeStart|rangeEnd|nextBadge|password|token|sessionVersion/
    .test(/export interface CentralDeviceEnrollment \{([\s\S]*?)\n\}/.exec(read('src/db/types.ts'))?.[1] ?? ''),
  false)
check('no device gate was added to the event routes',
  /Device(Access|Session|Auth)Gate/.test(read('src/components/event-app-gate.tsx')), false)
check('  and the event shell still uses Operator Access',
  /OperatorAccessGate/.test(read('src/components/event-app-gate.tsx')), true)

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
