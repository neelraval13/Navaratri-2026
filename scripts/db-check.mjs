#!/usr/bin/env node
/**
 * READ-ONLY database check.
 *
 * It verifies that `DATABASE_URL` is set, that the database answers, and that
 * every migrated table and guarantee is present after a human has run
 * `pnpm db:migrate` — Phase 9A's central tables, Phase 9C-A's credential
 * columns, and Phase P1's prize ledger as Phase P1.1 left it.
 *
 * ONE CHECK PROVES AN ABSENCE. `0004_repeat_prize_awards.sql` removed P1's
 * `UNIQUE(event_id, badge_number)` because repeat prizes became the event
 * rule, so a database that still carries it — or any replacement uniqueness
 * over the badge number — would refuse a second legitimate award. That is a
 * product failure a volunteer meets at the table, so it is checked here.
 *
 * It NEVER creates a table, seeds a row, runs a migration, updates or deletes
 * anything. Every statement below is a SELECT against the Postgres catalog or
 * `information_schema`. Proving that a constraint REJECTS a bad write needs a
 * write, which is `pnpm db:smoke`'s separate, explicitly gated job.
 *
 * Usage:  pnpm db:check
 */
import { neon } from '@neondatabase/serverless'

const EXPECTED_TABLES = [
  'badge_assignments',
  'device_attributes',
  'devices',
  'events',
  // Phase P1's prize ledger. A table added by a migration must be named here,
  // or `db:check` would report a healthy database that is missing it.
  'prize_awards',
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

/**
 * THE PRIZE LEDGER'S EXACT COLUMN SET, checked as a SET rather than as six
 * presence tests.
 *
 * Equality is the point. Postgres holds no attendee PII, and the way that
 * would be lost is a column being ADDED — an `attendee_name` for the
 * convenience of one screen. A presence check cannot see that; an exact set
 * can, and it still proves every expected column is there and NOT NULL.
 */
const PRIZE_COLUMNS = [
  'awarded_at',
  'awarded_by_device_id',
  'badge_number',
  'event_id',
  'id',
  'prize_name',
]

/**
 * The prize guarantees, verified by DEFINITION rather than by name alone.
 *
 * A name proves only that something with that name exists. These are the
 * constraints the ledger's integrity rests on, so each one's rendered
 * definition — from `pg_get_constraintdef`, which states the kind, the
 * columns and any reference — must contain every fragment below.
 *
 * Fragments are matched against the definition lowercased, unquoted and with
 * whitespace collapsed, so a cosmetic difference in how Postgres renders an
 * expression cannot fail a correct database.
 *
 * `prize_awards_event_id_badge_number_key` is deliberately NOT here. It is
 * checked for being GONE instead — see the uniqueness check below.
 */
const EXPECTED_PRIZE_CONSTRAINTS = [
  [
    'prize_awards_badge_number_positive',
    'prize badge number positive',
    ['check', 'badge_number > 0'],
  ],
  [
    'prize_awards_prize_name_not_empty',
    'prize name non-empty',
    ['check', 'btrim(prize_name)', '> 0'],
  ],
  [
    'prize_awards_prize_name_max_length',
    'prize name length bounded',
    ['check', 'length(prize_name) <= 80'],
  ],
  [
    'prize_awards_event_id_events_id_fk',
    'prize award belongs to an event',
    ['foreign key (event_id)', 'references events(id)'],
  ],
  [
    'prize_awards_awarded_by_device_id_devices_id_fk',
    'prize awarding device is a registered device',
    ['foreign key (awarded_by_device_id)', 'references devices(id)'],
  ],
  [
    'prize_awards_device_event_fk',
    'prize awarding device belongs to the same event',
    ['foreign key (awarded_by_device_id, event_id)', 'references devices(id, event_id)'],
  ],
]

/** The prize ledger's read paths: history by event, and by awarding device. */
const EXPECTED_PRIZE_INDEXES = [
  ['prize_awards_event_id_idx', 'prize history indexed by event', 'event_id'],
  [
    'prize_awards_awarded_by_device_id_idx',
    'prize history indexed by awarding device',
    'awarded_by_device_id',
  ],
]

/** Lowercase, unquoted, single-spaced — so matching is about meaning. */
const normalize = (definition) =>
  definition.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim()

/**
 * Is this catalog row about `prize_awards`?
 *
 * `conrelid::regclass` renders unqualified when `public` is on the search
 * path and qualified when it is not, so both spellings are accepted rather
 * than letting a connection setting decide whether the check runs.
 */
const isPrizeRelation = (relation) =>
  normalize(String(relation)).replace(/^public\./, '') === 'prize_awards'

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

  /**
   * `pg_get_constraintdef` renders the whole constraint — kind, columns and
   * any reference — which is what lets the prize checks below verify SHAPE
   * and not merely that a name is taken.
   */
  const constraints = await sql`
    SELECT conname AS name,
           conrelid::regclass::text AS relation,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
  `
  const indexes = await sql`
    SELECT indexname AS name, tablename AS relation, indexdef AS definition
    FROM pg_indexes WHERE schemaname = 'public'
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

  /**
   * THE PRIZE LEDGER. Reported separately so the guarantees the product rule
   * depends on are visible in the output, rather than folded into a count.
   *
   * Every check below is a lookup in `pg_constraint`, `pg_indexes` or
   * `information_schema.columns`. No row is created, updated or deleted.
   */
  if (!present.has('prize_awards')) {
    /**
     * Say what was NOT checked. Reporting ten more failures for one absent
     * table would bury the single thing that needs doing, but silently
     * checking nothing would read as though the ledger were fine.
     */
    console.log(
      'SKIP  prize ledger guarantees — the table is absent, so none were checked',
    )
  } else {
    /**
     * REPEATED AWARDS MUST BE POSSIBLE — the P1.1 product rule, checked as an
     * ABSENCE because that is the only way to check it without writing a row.
     *
     * Anything that makes the badge number unique within the event refuses a
     * second legitimate prize, so all three shapes are looked for: a UNIQUE
     * constraint, a PRIMARY KEY, and a bare unique INDEX, which enforces
     * uniqueness with no constraint to find. The primary key on `id` names no
     * badge number and is therefore not matched.
     *
     * Named by COLUMN rather than by the old constraint's name: a replacement
     * on `(event_id, badge_number, prize_name)` would be a different name and
     * the same broken rule.
     */
    const uniqueness = [
      ...constraints
        .filter(
          (row) =>
            isPrizeRelation(row.relation) &&
            /^(unique|primary key)/.test(normalize(row.definition)),
        )
        .map((row) => ({ name: row.name, definition: normalize(row.definition) })),
      ...indexes
        .filter(
          (row) =>
            isPrizeRelation(row.relation) &&
            normalize(row.definition).includes('create unique index'),
        )
        .map((row) => ({ name: row.name, definition: normalize(row.definition) })),
    ].filter((entry) => entry.definition.includes('badge_number'))

    const repeatsAllowed = uniqueness.length === 0

    if (!repeatsAllowed) missing++

    console.log(
      `${repeatsAllowed ? 'PASS' : 'FAIL'}  repeated prize awards are allowed`,
    )

    if (!repeatsAllowed) {
      console.log(
        `        the badge number is still unique: ${uniqueness
          .map((entry) => entry.name)
          .join(', ')}`,
      )
      console.log('        has 0004_repeat_prize_awards.sql been migrated here?')
    }

    const definitionOf = new Map(
      constraints.map((row) => [row.name, normalize(row.definition)]),
    )

    for (const [name, description, fragments] of EXPECTED_PRIZE_CONSTRAINTS) {
      const definition = definitionOf.get(name)
      const absent =
        definition === undefined
          ? ['constraint is missing']
          : fragments.filter((fragment) => !definition.includes(fragment))
      const ok = absent.length === 0

      if (!ok) missing++

      console.log(`${ok ? 'PASS' : 'FAIL'}  ${description}`)

      if (!ok) {
        // What is EXPECTED and absent, never the stored data — a constraint
        // definition is schema metadata and carries no attendee value.
        console.log(
          definition === undefined
            ? `        ${name} is missing`
            : `        ${name} does not say: ${absent.join('; ')}`,
        )
      }
    }

    const indexDefinitionOf = new Map(
      indexes.map((row) => [row.name, normalize(row.definition)]),
    )

    for (const [name, description, column] of EXPECTED_PRIZE_INDEXES) {
      const definition = indexDefinitionOf.get(name)
      const ok = definition !== undefined && definition.includes(`(${column})`)

      if (!ok) missing++

      console.log(`${ok ? 'PASS' : 'FAIL'}  ${description}`)
    }

    const prizeColumns = columns
      .filter((row) => row.table_name === 'prize_awards')
      .map((row) => row.column_name)
      .sort()
    const added = prizeColumns.filter((column) => !PRIZE_COLUMNS.includes(column))
    // An unexpected column is already reported as unexpected; naming it twice
    // would make one problem look like two.
    const nullable = columns
      .filter(
        (row) =>
          row.table_name === 'prize_awards' &&
          row.is_nullable !== 'NO' &&
          !added.includes(row.column_name),
      )
      .map((row) => row.column_name)
      .sort()
    const absent = PRIZE_COLUMNS.filter((column) => !prizeColumns.includes(column))
    const columnsOk = added.length === 0 && absent.length === 0 && nullable.length === 0

    if (!columnsOk) missing++

    console.log(
      `${columnsOk ? 'PASS' : 'FAIL'}  prize ledger holds exactly its ${String(PRIZE_COLUMNS.length)} columns, all NOT NULL`,
    )

    if (!columnsOk) {
      if (absent.length > 0) console.log(`        missing: ${absent.join(', ')}`)
      // An ADDED column is the privacy regression this check exists to catch.
      if (added.length > 0) console.log(`        unexpected: ${added.join(', ')}`)
      if (nullable.length > 0) console.log(`        nullable: ${nullable.join(', ')}`)
    }
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
