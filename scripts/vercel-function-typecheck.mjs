/**
 * Per-function semantic typecheck, modelling `@vercel/node`.
 *
 * Run with:  pnpm typecheck:vercel-functions
 *
 * WHY THIS EXISTS, and why `tsc -b` and `typecheck:parity` are not enough:
 *
 * Vercel does not typecheck this repository the way we do. After the Build
 * Command finishes, it compiles each `api/*.ts` entrypoint SEPARATELY, and its
 * algorithm is:
 *
 *   1. find the nearest `tsconfig.json`
 *   2. read it, then CLEAR `files` and `include`
 *   3. KEEP the root `compilerOptions`
 *   4. apply a ts-node-style `fixConfig` (target/module defaults, drop
 *      `composite`, `incremental`, `declaration*`, `tsBuildInfoFile`)
 *   5. build a LanguageService whose root file list is JUST that entrypoint
 *   6. call `getSemanticDiagnostics()` on it
 *
 * Step 5 is the one that bites. `tsc -p` puts every file of `api/`, `server/`
 * and `src/shared` into ONE program, so a global type contributed by any one
 * file's dependency graph — a third-party `.d.ts` carrying
 * `/// <reference lib="dom" />`, for example — is visible to all of them. Per
 * entrypoint, a function only gets what ITS OWN import graph pulls in. A whole-
 * project compile can therefore be green while half the functions fail.
 *
 * Step 3 is the other one. The root `tsconfig.json` is a solution file that
 * compiles nothing here, but Vercel reads its `compilerOptions` as the real
 * configuration for every function. It is a production compiler input.
 *
 * This script uses the repository's own installed TypeScript compiler API and
 * reports real syntactic + semantic diagnostics. It is NOT a grep, it makes no
 * network request, and it does not shell out to the Vercel CLI — the cloud
 * build runs its own CLI version (59.x at the time of writing, while a local
 * `vercel dev` fetched 60.x), so modelling the documented compilation
 * algorithm is more stable than depending on whichever CLI is current.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = resolve(import.meta.dirname, '..')
const apiDirectory = join(root, 'api')

/**
 * EVERY file under `api/` becomes a separate deployment Function, and the
 * Hobby plan refuses a deployment with more than twelve. That limit is
 * enforced at DEPLOY time, after the build has already succeeded, so nothing
 * in a normal build reports it — a 14-function deployment built cleanly and
 * then failed at "Deploying outputs…".
 *
 * A shared helper therefore never belongs in `api/`; it belongs in `server/`
 * or `src/shared/`, which cost nothing.
 */
export const HOBBY_FUNCTION_LIMIT = 12

/** The inventory this checkpoint expects, so a new file cannot slip in. */
export const EXPECTED_FUNCTIONS = [
  'admin-auth',
  'admin-badge-assignment',
  'admin-device-password',
  'admin-devices',
  'admin-events',
  'device-auth',
  'operator-login',
  'operator-logout',
  'operator-session',
  'sync-registration',
]

/** Every serverless entrypoint, exactly as the platform enumerates them. */
export const functionEntrypoints = () =>
  readdirSync(apiDirectory)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .sort()
    .map((file) => join(apiDirectory, file))

/**
 * The root `tsconfig.json`, read the way Vercel reads it: options kept, file
 * selection discarded.
 */
export const rootFunctionOptions = () => {
  const configPath = join(root, 'tsconfig.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)

  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }

  // `files` and `include` are dropped before parsing, so the parsed result
  // carries the options without the solution file's (empty) file list.
  const { files: _files, include: _include, references: _references, ...rest } = read.config

  const parsed = ts.parseJsonConfigFileContent(rest, ts.sys, root, undefined, configPath)

  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
    )
  }

  return fixConfig(parsed.options)
}

/**
 * The ts-node-style normalisation `@vercel/node` applies. Emit-shaped options
 * are removed because the function compiler only wants diagnostics, and
 * `target`/`module` get defaults only when unset.
 */
const fixConfig = (options) => {
  const fixed = { ...options }

  for (const key of [
    'out', 'outFile', 'composite', 'declarationDir', 'declaration',
    'declarationMap', 'emitDeclarationOnly', 'tsBuildInfoFile', 'incremental',
  ]) {
    delete fixed[key]
  }

  fixed.target ??= ts.ScriptTarget.ES5
  fixed.module ??= ts.ModuleKind.CommonJS
  fixed.noEmit = true

  return fixed
}

/**
 * Compiles ONE entrypoint in its own program, as the platform does.
 *
 * Only source diagnostics are reported. `node_modules` declaration files are
 * skipped for the same reason `skipLibCheck` exists: a dependency's own typing
 * problems are not this repository's build to fail.
 */
const checkEntrypoint = (entrypoint, options) => {
  const program = ts.createProgram({ rootNames: [entrypoint], options })

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ].filter((diagnostic) => {
    const file = diagnostic.file?.fileName ?? ''

    return file === '' || !file.includes('node_modules')
  })

  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')

    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      const where = `${diagnostic.file.fileName.replace(`${root}/`, '')}(${line + 1},${character + 1})`

      return `${where}: error TS${String(diagnostic.code)}: ${message}`
    }

    return `error TS${String(diagnostic.code)}: ${message}`
  })
}

/**
 * The Web API members every handler depends on.
 *
 * Checked directly against the resolved global types, not inferred from
 * whether today's source happens to touch them. `@types/node` declares these
 * as `typeof globalThis extends { onmessage: any } ? {} : undici.X` — a guess
 * about whether a DOM lib is loaded — and when that guess goes wrong the type
 * silently becomes `{}`. The compile then fails with "Property 'headers' does
 * not exist on type 'Request'", which is precisely what the cloud build
 * reported. Asserting the members keeps that collapse detectable even if a
 * handler stops using one of them.
 */
const WEB_API_SURFACE = [
  ['Request', ['headers', 'url', 'text']],
  ['Response', ['status', 'headers', 'json']],
  ['Headers', ['get', 'set', 'append']],
  ['URL', ['origin', 'searchParams']],
]

export const checkWebApiSurface = (entrypoint, options) => {
  const program = ts.createProgram({ rootNames: [entrypoint], options })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entrypoint)
  const problems = []

  for (const [name, members] of WEB_API_SURFACE) {
    const symbol = checker.resolveName(name, source, ts.SymbolFlags.Type, false)

    if (symbol === undefined) {
      problems.push(`global type \`${name}\` is not declared at all`)
      continue
    }

    const present = checker
      .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
      .map((property) => property.name)
    const missing = members.filter((member) => !present.includes(member))

    if (missing.length > 0) {
      problems.push(
        `global type \`${name}\` is missing ${missing.map((m) => `\`${m}\``).join(', ')}` +
          ` (it resolved with ${String(present.length)} members — the Web API surface has collapsed)`,
      )
    }
  }

  return problems
}

/**
 * The deployment Function budget, checked against the real files rather than
 * against route strings.
 */
export const checkFunctionBudget = () => {
  const actual = functionEntrypoints().map((file) =>
    file.replace(`${apiDirectory}/`, '').replace(/\.ts$/, ''),
  )
  const problems = []

  if (actual.length > HOBBY_FUNCTION_LIMIT) {
    problems.push(
      `${String(actual.length)} Functions exceeds the Hobby limit of ${String(HOBBY_FUNCTION_LIMIT)} — the deployment will be refused after the build succeeds`,
    )
  }

  const unexpected = actual.filter((name) => !EXPECTED_FUNCTIONS.includes(name))
  const missing = EXPECTED_FUNCTIONS.filter((name) => !actual.includes(name))

  for (const name of unexpected) {
    problems.push(`api/${name}.ts is a new Function and consumes deployment budget`)
  }

  for (const name of missing) {
    problems.push(`api/${name}.ts is expected but missing`)
  }

  return { actual, problems }
}

/** Checks every entrypoint and returns the failures, keyed by file. */
export const checkAllFunctions = () => {
  const options = rootFunctionOptions()
  const failures = new Map()
  const entrypoints = functionEntrypoints()

  // One probe is enough: every function is compiled with the same options.
  const surface = entrypoints.length === 0
    ? []
    : checkWebApiSurface(entrypoints[0], options)

  if (surface.length > 0) {
    failures.set('<web api environment>', surface)
  }

  for (const entrypoint of entrypoints) {
    const errors = checkEntrypoint(entrypoint, options)

    if (errors.length > 0) {
      failures.set(entrypoint.replace(`${root}/`, ''), errors)
    }
  }

  return failures
}

const isDirectInvocation = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, 'vercel-function-typecheck.mjs')

if (isDirectInvocation) {
  const entrypoints = functionEntrypoints()
  const budget = checkFunctionBudget()

  console.log('Vercel Functions:\n')

  budget.actual.forEach((name, index) => {
    console.log(`${String(index + 1).padStart(2)}  ${name}`)
  })

  console.log(
    `\nTotal: ${String(budget.actual.length)} / ${String(HOBBY_FUNCTION_LIMIT)}` +
      `   Headroom: ${String(HOBBY_FUNCTION_LIMIT - budget.actual.length)}\n`,
  )

  for (const problem of budget.problems) {
    console.log(`BUDGET  ${problem}`)
  }

  console.log(
    `Typecheck — ${String(entrypoints.length)} entrypoints, each compiled alone\n`,
  )

  const failures = checkAllFunctions()

  const surfaceProblems = failures.get('<web api environment>')

  if (surfaceProblems !== undefined) {
    console.log('FAIL  <web api environment>')

    for (const problem of surfaceProblems) {
      console.log(`        ${problem}`)
    }
  } else {
    console.log('PASS  <web api environment>  Request/Response/Headers/URL intact')
  }

  for (const entrypoint of entrypoints) {
    const name = entrypoint.replace(`${root}/`, '')
    const errors = failures.get(name)

    if (errors === undefined) {
      console.log(`PASS  ${name}`)
      continue
    }

    console.log(`FAIL  ${name}`)

    for (const error of errors) {
      console.log(`        ${error}`)
    }
  }

  const total = [...failures.values()].reduce((sum, errors) => sum + errors.length, 0)

  console.log(
    failures.size === 0
      ? '\nEvery function compiles alone under the root configuration.'
      : `\n${String(total)} error(s) across ${String(failures.size)} function(s). Vercel will report these.`,
  )

  process.exit(failures.size === 0 && budget.problems.length === 0 ? 0 : 1)
}

export { dirname }
