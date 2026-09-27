#!/usr/bin/env node
/**
 * READ-ONLY database check.
 *
 * It verifies that `DATABASE_URL` is set, that the database answers, and that
 * the Phase 9A tables and guarantees are present after a migration has been
 * run by a human.
 *
 * It NEVER creates a table, seeds a row, runs a migration, updates or deletes
 * anything. Every statement below is a SELECT.
 *
 * Usage:  pnpm db:check
 */
import { neon } from '@neondatabase/serverless'

const EXPECTED_TABLES = [
  'badge_assignments',
  'device_attributes',
  'devices',
  'events',
]

const EXPECTED_GUARANTEES = [
  ['badge_assignments_active_ranges_no_overlap', 'active badge ranges cannot overlap'],
  ['badge_assignments_one_active_per_device', 'one active assignment per device'],
  ['badge_assignments_device_event_fk', 'a badge range cannot cross events'],
  ['devices_event_id_login_name_key', 'login name unique within an event'],
  ['devices_session_version_positive', 'session version cannot drop below 1'],
]

/**
 * Column METADATA only — never a credential value. This reads
 * `information_schema`, so no `password_hash` is ever selected, printed or
 * logged.
 */
const EXPECTED_COLUMNS = [
  ['devices', 'password_hash', 'YES', 'device password hash (nullable = not provisioned)'],
  ['devices', 'session_version', 'NO', 'device session version'],
]

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl === undefined || databaseUrl === '') {
  // The value is never printed, because it is a credential.
  console.error('DATABASE_URL is not set. Set it for this environment and try again.')
  process.exit(1)
}

const sql = neon(databaseUrl)

try {
  const [now] = await sql`SELECT now() AS server_time, current_database() AS database`
  console.log(`Connected to "${now.database}" at ${String(now.server_time)}\n`)

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `
  const present = new Set(tables.map((row) => row.table_name))

  let missing = 0

  for (const table of EXPECTED_TABLES) {
    const ok = present.has(table)
    if (!ok) missing++
    console.log(`${ok ? 'PASS' : 'FAIL'}  table ${table}`)
  }

  const constraints = await sql`
    SELECT conname AS name FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
  `
  const indexes = await sql`
    SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
  `
  const guarantees = new Set([
    ...constraints.map((row) => row.name),
    ...indexes.map((row) => row.name),
  ])

  for (const [name, description] of EXPECTED_GUARANTEES) {
    const ok = guarantees.has(name)
    if (!ok) missing++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${description}`)
  }

  const columns = await sql`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `

  for (const [table, column, nullable, description] of EXPECTED_COLUMNS) {
    const found = columns.find(
      (row) => row.table_name === table && row.column_name === column,
    )
    const ok = found !== undefined && found.is_nullable === nullable
    if (!ok) missing++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${description}`)
  }

  const unexpected = [...present].filter(
    (table) => !EXPECTED_TABLES.includes(table) && table !== '__drizzle_migrations',
  )

  if (unexpected.length > 0) {
    console.log(`\nNote: other tables present: ${unexpected.join(', ')}`)
  }

  console.log(
    missing === 0
      ? '\nAll expected tables and guarantees are present.'
      : `\n${String(missing)} missing. Has \`pnpm db:migrate\` been run against this database?`,
  )

  process.exit(missing === 0 ? 0 : 1)
} catch (error) {
  // Never echo the connection string, and never a driver object that might
  // carry it.
  console.error(
    `Database check failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
  )
  process.exit(1)
}
