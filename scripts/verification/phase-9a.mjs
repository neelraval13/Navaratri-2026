/**
 * Phase 9A verification — central PostgreSQL foundation.
 *
 * Run with:  pnpm verify:9a
 *
 * Infrastructure only. It asserts the schema, the database-level guarantees,
 * the server/client boundary, the scope boundaries (no attendee data, no
 * central badge counter, no auth tables) and that nothing in the live
 * application depends on the database yet.
 *
 * It NEVER connects to a database. Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { spawnSync } from 'node:child_process'
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
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '')

const jiti = createJiti(import.meta.url, { alias: { '@': `${root}/src` }, interopDefault: true })
const schema = await jiti.import(`${root}/server/db/schema.ts`)
const dbEnv = await jiti.import(`${root}/server/db/environment.ts`)

const migrationFiles = readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).sort()
const migrations = migrationFiles.map((f) => read(`drizzle/${f}`)).join('\n')
const schemaSource = read('server/db/schema.ts')

console.log('=== 1-17. SCHEMA ===')
check('exactly four central tables', Object.keys(schema).filter((k) => typeof schema[k] === 'object' && schema[k] !== null).sort(),
  ['badgeAssignments', 'deviceAttributes', 'devices', 'events'])
for (const t of ['events', 'devices', 'device_attributes', 'badge_assignments'])
  check(`  migration creates ${t}`, new RegExp(`CREATE TABLE "${t}"`).test(migrations), true)

check('events.slug is unique', /CONSTRAINT "events_slug_key" UNIQUE\("slug"\)/.test(migrations), true)
check('  slug / name / timezone non-empty', ['events_slug_not_empty', 'events_name_not_empty', 'events_timezone_not_empty']
  .every((c) => migrations.includes(c)), true)
check('  ends_at >= starts_at when both present', /events_dates_ordered/.test(migrations), true)

check('devices references events', /"devices_event_id_events_id_fk" FOREIGN KEY \("event_id"\) REFERENCES "public"\."events"\("id"\) ON DELETE restrict/.test(migrations), true)
check('devices has NO password / hash / session column',
  /password|hash|session|secret|token/i.test(stripComments(schemaSource).split('deviceAttributes')[0]), false)
check('devices has NO deviceType', /deviceType|device_type/.test(stripComments(schemaSource)), false)
check('login_name is nullable', /"login_name" text,/.test(migrations), true)
check('  and non-empty when present', /devices_login_name_not_empty/.test(migrations), true)
check('(event_id, login_name) is unique',
  /CREATE UNIQUE INDEX "devices_event_id_login_name_key" ON "devices" USING btree \("event_id","login_name"\)/.test(migrations), true)

check('device_attributes references devices, cascading',
  /"device_attributes_device_id_devices_id_fk" FOREIGN KEY \("device_id"\) REFERENCES "public"\."devices"\("id"\) ON DELETE cascade/.test(migrations), true)
check('  attribute is TEXT, not a Postgres enum',
  [/"attribute" text NOT NULL/.test(migrations), /CREATE TYPE|pgEnum/.test(migrations + schemaSource)], [true, false])
check('  (device_id, attribute) is the primary key',
  /PRIMARY KEY\("device_id","attribute"\)/.test(migrations), true)

check('badge_assignments references events', /"badge_assignments_event_id_events_id_fk" FOREIGN KEY \("event_id"\)/.test(migrations), true)
check('badge_assignments references devices', /"badge_assignments_device_id_devices_id_fk" FOREIGN KEY \("device_id"\)/.test(migrations), true)
check('  positive range constraints', ['badge_assignments_range_start_positive', 'badge_assignments_range_end_positive']
  .every((c) => migrations.includes(c)), true)
check('  start <= end constraint', /badge_assignments_range_ordered.*range_start" <= .*range_end/s.test(migrations), true)

console.log('  -- database-enforced guarantees --')
check('active ranges cannot overlap (GiST exclusion)',
  /EXCLUDE USING gist \(\s*"event_id" WITH =,\s*int4range\("range_start", "range_end", '\[\]'\) WITH &&\s*\)/.test(migrations), true)
check('  scoped to active rows only', /EXCLUDE USING gist[\s\S]*?WHERE \("released_at" IS NULL\)/.test(migrations), true)
check('  btree_gist is installed first',
  migrations.indexOf('CREATE EXTENSION IF NOT EXISTS btree_gist') < migrations.indexOf('EXCLUDE USING gist'), true)
check('one active assignment per device',
  /CREATE UNIQUE INDEX "badge_assignments_one_active_per_device" ON "badge_assignments" USING btree \("device_id"\) WHERE .*"released_at" is null/.test(migrations), true)
check('event/device consistency (composite FK)',
  /"badge_assignments_device_event_fk" FOREIGN KEY \("device_id","event_id"\) REFERENCES "public"\."devices"\("id","event_id"\)/.test(migrations), true)
check('  its target key exists on devices',
  /CONSTRAINT "devices_id_event_id_key" UNIQUE\("id","event_id"\)/.test(migrations), true)

console.log('\n=== 18-22. PRIVACY / SCOPE BOUNDARIES ===')
const centralSurface = stripComments(`${schemaSource}\n${migrations}`)
for (const [label, pattern] of [
  ['attendee table', /CREATE TABLE "(attendees|registrations|held_registrations|payments)"/],
  ['attendee PII column', /"(phone|attendee_name|age|gender|normalized_name)"/],
  ['payment column', /"(payment|payment_method|amount|paid)"/],
  ['central next_badge counter', /next_badge|nextBadge/],
  ['auth / session table', /CREATE TABLE "(sessions|device_sessions|credentials|passwords)"/],
  ['password or hash column', /"(password|password_hash|secret|token|session_version)"/],
  ['admin table', /CREATE TABLE "(admins|admin_users|users)"/],
  ['audit / activity table', /CREATE TABLE "(audit_log|activity|events_log)"/],
]) check(`no ${label}`, pattern.test(centralSurface), false)
check('the schema says why attendee data is excluded',
  /no attendee data|NO attendee data/i.test(schemaSource), true)

console.log('\n=== 23-28. SERVER / CLIENT BOUNDARY ===')
const srcFiles = spawnSync('grep', ['-rlE', 'DATABASE_URL', join(root, 'src')], { encoding: 'utf8' }).stdout.trim()
check('DATABASE_URL never appears in src/', srcFiles, '')
// Needle built from parts: writing the literal here would make this file
// itself trip release:check's VITE_-prefix scan.
const VITE_DB_NEEDLE = `VITE_${'DATABASE_URL'}`
check(`no ${VITE_DB_NEEDLE} anywhere`,
  spawnSync('grep', ['-rl', VITE_DB_NEEDLE, join(root, 'src'), join(root, 'server'), join(root, 'api'), join(root, '.env.example')], { encoding: 'utf8' }).stdout.trim(), '')
check('no src/ module imports server/db',
  spawnSync('grep', ['-rl', 'server/db', join(root, 'src')], { encoding: 'utf8' }).stdout.trim(), '')
for (const name of ['DATABASE_URL', 'drizzle-orm', '@neondatabase', 'neon(', 'postgres://', 'postgresql://'])
  check(`  "${name}" absent from the client bundle`,
    spawnSync('grep', ['-rl', name, join(root, 'dist')], { encoding: 'utf8' }).stdout.trim(), '')

const clientSource = read('server/db/client.ts')
check('the client is lazy: no top-level connect',
  /^(?!.*\/\/)(const|let)\s+\w+\s*=\s*(drizzle|neon)\(/m.test(stripComments(clientSource)), false)
check('  it connects only inside getDatabase()',
  stripComments(clientSource).indexOf('getDatabase') < stripComments(clientSource).indexOf('createDatabase(environment.databaseUrl)'), true)
check('  and reads no environment at import',
  /^readDatabaseEnvironment\(\)/m.test(stripComments(clientSource)), false)

check('env reader is injectable for tests', typeof dbEnv.readDatabaseEnvironment, 'function')
check('  missing DATABASE_URL fails closed',
  dbEnv.readDatabaseEnvironment({}).reason, 'database-url-missing')
check('  empty string fails closed',
  dbEnv.readDatabaseEnvironment({ DATABASE_URL: '' }).reason, 'database-url-missing')
check('  a real value is returned EXACTLY, never trimmed',
  dbEnv.readDatabaseEnvironment({ DATABASE_URL: ' postgres://x ' }).databaseUrl, ' postgres://x ')
const thrown = new dbEnv.DatabaseNotConfiguredError('database-url-missing')
check('  the error never contains a URL',
  /postgres|:\/\/|@/.test(thrown.message), false)
check('  no disabled message leaks a value',
  Object.values(dbEnv.DATABASE_DISABLED_MESSAGES).some((m) => /postgres|:\/\/|@/.test(m)), false)

console.log('\n=== 29-35. MIGRATIONS ===')
check('migration files are version controlled', migrationFiles, ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql'])
check('  the journal tracks both', JSON.parse(read('drizzle/meta/_journal.json')).entries.map((e) => e.tag),
  ['0000_central_foundation', '0001_range_guards_and_touch'])
const pkg = JSON.parse(read('package.json'))
check('db scripts exist', [pkg.scripts['db:generate'], pkg.scripts['db:migrate'], pkg.scripts['db:check']],
  ['drizzle-kit generate', 'drizzle-kit migrate', 'node scripts/db-check.mjs'])
const MIGRATION_PATTERN = /drizzle-kit\s+(migrate|push)|db:migrate|db:push/
for (const name of ['build', 'start', 'dev', 'preview', 'postinstall', 'prepare', 'release:check', 'verify'])
  check(`  "${name}" does not migrate`, MIGRATION_PATTERN.test(pkg.scripts[name] ?? ''), false)
check('no migration runs at app startup',
  spawnSync('grep', ['-rlE', 'drizzle-kit|migrate\\(|CREATE TABLE', join(root, 'src'), join(root, 'api')], { encoding: 'utf8' }).stdout.trim(), '')
check('no schema push from a Function',
  /push|sync\(\)|migrate\(/.test(stripComments(clientSource)), false)

const dbCheckSource = stripComments(read('scripts/db-check.mjs'))
check('db:check is READ ONLY',
  /INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE/i.test(dbCheckSource.replace(/EXPECTED_TABLES|information_schema|table_name|table_schema/g, '')), false)
check('  it fails clearly without printing the URL',
  [dbCheckSource.includes('DATABASE_URL is not set'), /console\.(log|error)\([^)]*databaseUrl/.test(dbCheckSource)], [true, false])
// Naming a file or a variable is not connecting; importing a driver or
// calling one is. Assert on that, not on the word.
const releaseCheckSource = stripComments(read('scripts/release-check.mjs'))
check('  release:check imports no database driver',
  /from\s+['"](@neondatabase|drizzle-orm|pg)|require\(['"](@neondatabase|drizzle-orm|pg)/.test(releaseCheckSource), false)
check('  and opens no connection', /neon\(|drizzle\(|new Client\(|\.connect\(/.test(releaseCheckSource), false)
check('  it only ever reads DATABASE_URL as a NAME',
  /process\.env\.DATABASE_URL|process\.env\[/.test(releaseCheckSource), false)

console.log('\n=== DEVELOPMENT CONSTRAINT SMOKE TEST ===')
const smokeSource = read('scripts/db-constraint-smoke.mjs')
const smokeCode = stripComments(smokeSource)
check('db:smoke script is registered', pkg.scripts['db:smoke'], 'node scripts/db-constraint-smoke.mjs')
check('  it is NOT wired into any lifecycle script',
  ['build', 'start', 'dev', 'preview', 'postinstall', 'prepare', 'release:check', 'verify',
   'verify:prior', 'verify:7b', 'verify:8a', 'verify:8b', 'verify:9a']
    .filter((n) => /db:smoke|db-constraint-smoke/.test(pkg.scripts[n] ?? '')), [])

check('it requires DATABASE_URL', /DATABASE_URL is not set/.test(smokeCode), true)
check('  and a SECOND explicit write acknowledgement',
  /ALLOW_DB_SMOKE_WRITES !== 'true'/.test(smokeCode), true)
check('  the acknowledgement is exact: no trim, no case folding',
  /ALLOW_DB_SMOKE_WRITES[^\n]*(toLowerCase|trim|toUpperCase)/.test(smokeCode), false)
check('  both guards precede the driver',
  [smokeCode.indexOf("ALLOW_DB_SMOKE_WRITES") < smokeCode.indexOf('neon(databaseUrl)'),
   smokeCode.indexOf('DATABASE_URL is not set') < smokeCode.indexOf('neon(databaseUrl)')], [true, true])

check('the connection string is never printed',
  /console\.(log|error)\([^)]*databaseUrl/.test(smokeCode), false)
check('  output is redacted as a backstop', /redact\(/.test(smokeCode), true)

check('cleanup runs in a finally path', /\} finally \{/.test(smokeCode), true)
check('  it deletes ONLY by id, never by name pattern',
  (smokeCode.match(/DELETE FROM \w+ WHERE [^`]*/g) ?? []).every((d) => /= ANY\(\$\{/.test(d)), true)
check('  it never truncates', /TRUNCATE/i.test(smokeCode), false)
check('  it never deletes by slug or name', /DELETE FROM[^`]*(slug|name|LIKE)/i.test(smokeCode), false)
check('  rejected-write ids are cleaned up too',
  ['bOverlap', 'aSecondActive', 'crossEvent'].every((k) => smokeCode.includes(k)), true)
check('  and it verifies nothing is left behind',
  /every row from this run has been removed/.test(smokeSource), true)

for (const [label, constraint] of [
  ['non-overlap', 'badge_assignments_active_ranges_no_overlap'],
  ['one active per device', 'badge_assignments_one_active_per_device'],
  ['cross-event', 'badge_assignments_device_event_fk'],
]) check(`  it asserts the ${label} constraint by name`, smokeCode.includes(constraint), true)
check('  the constraints it names all exist in the migrations',
  ['badge_assignments_active_ranges_no_overlap', 'badge_assignments_one_active_per_device',
   'badge_assignments_device_event_fk'].every((c) => migrations.includes(c)), true)

console.log('\n=== 36-43. NOTHING EXISTING CHANGED ===')
const dbSource = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION\s*=\s*1\b/.test(dbSource), true)
check('  exactly three stores', ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dbSource)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
  .map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
const sheet = read('server/sync/sheet-contract.ts')
check('Google Sheet ranges unchanged', [/A1:N/.test(sheet), /A1:M/.test(sheet)], [true, true])
check('  no new Sheet column', /Device ID', 'Device Name'/.test(sheet), true)
check('sync contract unchanged (no db import)', /server\/db|drizzle|neon/.test(read('src/shared/sync-contract.ts')), false)
check('Operator Access unchanged (no db import)', /server\/db|drizzle|neon/.test(read('src/auth/operator-access.ts')), false)
const routes = read('src/app/routes.ts')
check('routing unchanged',
  [/home: '\/'/.test(routes), /badgeRegistration: '\/badge-registration'/.test(routes), /deviceRegistration: '\/device-registration'/.test(routes)],
  [true, true, true])
check('badge allocation is still local',
  [/nextBadge/.test(read('src/db/registrations.ts')), /server\/db|drizzle|neon/.test(read('src/db/registrations.ts'))], [true, false])
check('no API route depends on the database yet',
  spawnSync('grep', ['-rl', 'getDatabase', join(root, 'api')], { encoding: 'utf8' }).stdout.trim(), '')
check('  and the app never imports the db client',
  spawnSync('grep', ['-rl', 'getDatabase', join(root, 'src')], { encoding: 'utf8' }).stdout.trim(), '')

console.log('\n=== DEPENDENCIES + DOCS ===')
check('database stack declared as runtime dependencies',
  [typeof pkg.dependencies['drizzle-orm'], typeof pkg.dependencies['@neondatabase/serverless']], ['string', 'string'])
check('  drizzle-kit is a devDependency only',
  [typeof pkg.devDependencies['drizzle-kit'], pkg.dependencies['drizzle-kit']], ['string', undefined])
check('  no competing database or ORM',
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((d) => /^(prisma|@prisma|firebase|@supabase|redis|ioredis|@upstash|typeorm|sequelize|kysely|mongoose)/.test(d)), [])
check('docs/DATABASE.md exists and covers the boundaries',
  ['no attendee data', 'next_badge', 'Development and Production must never share',
   'Nothing migrates automatically', 'db:check', 'device_sessions', 'Neon']
    .every((phrase) => read('docs/DATABASE.md').toLowerCase().includes(phrase.toLowerCase())), true)
check('DATABASE_URL documented in .env.example', /^DATABASE_URL=/m.test(read('.env.example')), true)
check('  and never VITE_ prefixed there', read('.env.example').includes(VITE_DB_NEEDLE), false)

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
