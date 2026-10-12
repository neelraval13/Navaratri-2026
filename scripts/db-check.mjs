#!/usr/bin/env node
/**
 * READ-ONLY database check.
 *
 * It verifies that `DATABASE_URL` is set, that the database answers, and that
 * every migrated table and guarantee is present after a human has run
 * `pnpm db:migrate` — Phase 9A's central tables, Phase 9C-A's credential
 * columns, Phase P1's prize ledger as Phase P1.1 left it, and Phase D3's
 * dandiya checkout ledger.
 *
 * ONE CHECK UNDERWRITES ANOTHER, twice over.
 * `dandiya_loans_pair_code_canonical` is why the partial unique index on
 * `(event_id, pair_code)` can be trusted: an index compares bytes, so a
 * stored `d-014` beside an open `D-014` would be two pairs and one set of
 * sticks. And the two release checks are why that index means QUARANTINE: a
 * loss cannot free the pair, and a clean return cannot fail to.
 *
 * TWO GUARANTEES ARE PARTIAL, and the PREDICATE is checked, not just the
 * columns. `UNIQUE(event_id, pair_code)` without
 * `WHERE pair_released_at IS NULL` would forbid a pair from ever going out
 * twice — which is most of what a dandiya evening consists of — so an index
 * that looks right and lost its predicate is exactly the failure worth
 * catching before the event. And the attendee index is partial on
 * `resolved_at`, not on the resolution, because a LOST stick frees its holder
 * exactly as a returned one does.
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
  // Phase D3's dandiya checkout ledger: one loan, two holders.
  'dandiya_loan_holders',
  'dandiya_loans',
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

/**
 * The dandiya guarantees, verified by DEFINITION rather than by name alone.
 *
 * These are what make the product rules true. An application check cannot
 * replace any of them: two desks can each read "that pair is free" and both
 * submit, and only the database decides.
 */
const EXPECTED_DANDIYA_CONSTRAINTS = [
  [
    'dandiya_loans_pair_code_not_empty',
    'dandiya pair code non-empty',
    ['check', 'btrim(pair_code)', '> 0'],
  ],
  [
    'dandiya_loans_pair_code_max_length',
    'dandiya pair code length bounded',
    ['check', 'length(pair_code) <= 32'],
  ],
  /**
   * CANONICAL PAIR CODES, which is what makes the pair index below mean what
   * it says. Without this, `D-014` and `d-014` would be two pairs and one set
   * of sticks.
   */
  [
    'dandiya_loans_pair_code_canonical',
    'dandiya pair codes are stored canonical (trimmed, uppercase)',
    ['check', 'pair_code = upper(btrim(pair_code))'],
  ],
  [
    'dandiya_loans_close_paired',
    'a dandiya close records its time, its outcome and its device together',
    ['check', 'closed_at is null', 'outcome is null', 'closed_by_device_id is null'],
  ],
  [
    'dandiya_loans_outcome_valid',
    'a dandiya outcome is returned, partial_loss or lost',
    ['check', 'returned', 'partial_loss', 'lost'],
  ],
  /**
   * THE QUARANTINE, IN BOTH DIRECTIONS. A release requires a clean return,
   * and a clean return requires the release — so a loss can never quietly
   * free the physical pair, and a clean return can never quietly keep it.
   */
  [
    'dandiya_loans_release_requires_returned',
    'only a fully returned dandiya loan may release its pair',
    // Postgres parenthesises each side, so the fragments are listed
    // separately rather than assuming they sit next to each other.
    ['check', 'pair_released_at is null', "outcome = 'returned'"],
  ],
  [
    'dandiya_loans_returned_requires_release',
    'a fully returned dandiya loan must release its pair',
    ['check', "outcome is distinct from 'returned'", 'pair_released_at is not null'],
  ],
  [
    'dandiya_loans_event_id_events_id_fk',
    'dandiya loan belongs to an event',
    ['foreign key (event_id)', 'references events(id)'],
  ],
  [
    'dandiya_loans_issued_by_device_id_devices_id_fk',
    'dandiya issuing device is a registered device',
    ['foreign key (issued_by_device_id)', 'references devices(id)'],
  ],
  [
    'dandiya_loans_closed_by_device_id_devices_id_fk',
    'dandiya closing device is a registered device',
    ['foreign key (closed_by_device_id)', 'references devices(id)'],
  ],
  [
    'dandiya_loans_issued_device_event_fk',
    'dandiya issuing device belongs to the same event',
    ['foreign key (issued_by_device_id, event_id)', 'references devices(id, event_id)'],
  ],
  [
    'dandiya_loans_closed_device_event_fk',
    'dandiya closing device belongs to the same event',
    ['foreign key (closed_by_device_id, event_id)', 'references devices(id, event_id)'],
  ],
  /**
   * The key the holder's composite foreign key REFERENCES. Without it that
   * key could not exist, so a holder could belong to a loan from another
   * event — which is why it is verified rather than assumed.
   */
  [
    'dandiya_loans_id_event_id_key',
    'a dandiya loan is identified with its event',
    ['unique (id, event_id)'],
  ],
  [
    'dandiya_loan_holders_loan_event_fk',
    'dandiya holder belongs to the same event as its loan',
    ['foreign key (loan_id, event_id)', 'references dandiya_loans(id, event_id)'],
  ],
  [
    'dandiya_loan_holders_loan_id_dandiya_loans_id_fk',
    'dandiya holder belongs to a real loan',
    ['foreign key (loan_id)', 'references dandiya_loans(id)'],
  ],
  [
    'dandiya_loan_holders_event_id_events_id_fk',
    'dandiya holder belongs to an event',
    ['foreign key (event_id)', 'references events(id)'],
  ],
  [
    'dandiya_loan_holders_resolved_by_device_id_devices_id_fk',
    'dandiya resolving device is a registered device',
    ['foreign key (resolved_by_device_id)', 'references devices(id)'],
  ],
  [
    'dandiya_loan_holders_resolved_device_event_fk',
    'dandiya resolving device belongs to the same event',
    ['foreign key (resolved_by_device_id, event_id)', 'references devices(id, event_id)'],
  ],
  [
    'dandiya_loan_holders_badge_number_positive',
    'dandiya holder badge number positive',
    ['check', 'badge_number > 0'],
  ],
  [
    'dandiya_loan_holders_slot_valid',
    'a dandiya pair has exactly slots 1 and 2',
    ['check', 'slot = any', '1, 2'],
  ],
  [
    'dandiya_loan_holders_resolution_paired',
    'a dandiya stick resolution records its time and its device together',
    ['check', 'resolution is null', 'resolved_at is null', 'resolved_by_device_id is null'],
  ],
  [
    'dandiya_loan_holders_resolution_valid',
    'a dandiya stick is returned or lost, and nothing else',
    ['check', 'returned', 'lost'],
  ],
  [
    'dandiya_loan_holders_loan_id_slot_key',
    'one dandiya holder per slot',
    ['unique (loan_id, slot)'],
  ],
  [
    'dandiya_loan_holders_loan_id_badge_number_key',
    'one attendee cannot hold both sticks of a dandiya pair',
    ['unique (loan_id, badge_number)'],
  ],
]

/**
 * THE TWO PARTIAL UNIQUE INDEXES, with their PREDICATES.
 *
 * Each entry names the fragments its definition must contain. The `where`
 * clause is one of them, and that is the point: without it, a pair could
 * never be issued a second time and an attendee could never receive another
 * pair, which would break the product in the opposite direction from the one
 * these indexes exist to prevent.
 */
const EXPECTED_DANDIYA_INDEXES = [
  [
    'dandiya_loans_one_unreleased_per_pair',
    'one unavailable dandiya loan per pair, and reuse after a clean return',
    ['create unique index', '(event_id, pair_code)', 'where', 'pair_released_at is null'],
  ],
  [
    'dandiya_loan_holders_one_unresolved_per_badge',
    'one unresolved dandiya stick per attendee, whether it came back or not',
    ['create unique index', '(event_id, badge_number)', 'where', 'resolved_at is null'],
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

/**
 * THE DANDIYA LEDGER'S EXACT COLUMN SETS.
 *
 * Checked as SETS for the same reason the prize ledger is: the way the
 * privacy boundary would be lost is a column being ADDED — an
 * `attendee_name` for the convenience of one card — and a presence check
 * cannot see that.
 *
 * The nullable columns are named rather than inferred, and each null MEANS
 * something: a loan is OPEN while its three close columns are null, its pair
 * is QUARANTINED while `pair_released_at` is null, and a holder is STILL
 * HOLDING while its three resolution columns are. Those seven must be
 * nullable, and the rest must not be.
 */
const DANDIYA_LOAN_COLUMNS = {
  table: 'dandiya_loans',
  required: ['event_id', 'id', 'issued_at', 'issued_by_device_id', 'pair_code'],
  nullable: ['closed_at', 'closed_by_device_id', 'outcome', 'pair_released_at'],
}

const DANDIYA_HOLDER_COLUMNS = {
  table: 'dandiya_loan_holders',
  required: ['badge_number', 'event_id', 'id', 'loan_id', 'slot'],
  nullable: ['resolution', 'resolved_at', 'resolved_by_device_id'],
}

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

  /**
   * THE DANDIYA LEDGER. Reported separately so the guarantees the product
   * rules depend on are visible in the output rather than folded into a
   * count.
   *
   * Every check below is a lookup in `pg_constraint`, `pg_indexes` or
   * `information_schema.columns`. No row is created, updated or deleted.
   */
  if (!present.has('dandiya_loans') || !present.has('dandiya_loan_holders')) {
    console.log(
      'SKIP  dandiya ledger guarantees — a table is absent, so none were checked',
    )
  } else {
    const definitionOf = new Map(
      constraints.map((row) => [row.name, normalize(row.definition)]),
    )
    const indexDefinitionOf = new Map(
      indexes.map((row) => [row.name, normalize(row.definition)]),
    )

    for (const [source, expectations] of [
      [definitionOf, EXPECTED_DANDIYA_CONSTRAINTS],
      [indexDefinitionOf, EXPECTED_DANDIYA_INDEXES],
    ]) {
      for (const [name, description, fragments] of expectations) {
        const definition = source.get(name)
        const absent =
          definition === undefined
            ? ['it is missing']
            : fragments.filter((fragment) => !definition.includes(fragment))
        const ok = absent.length === 0

        if (!ok) missing++

        console.log(`${ok ? 'PASS' : 'FAIL'}  ${description}`)

        if (!ok) {
          // What is EXPECTED and absent, never the stored data.
          console.log(
            definition === undefined
              ? `        ${name} is missing`
              : `        ${name} does not say: ${absent.join('; ')}`,
          )
        }
      }
    }

    /**
     * The column sets, compared for EQUALITY, with the nullable columns
     * named: a loan is open while its four closing columns are null, a PAIR
     * is unavailable while `pair_released_at` is null, and a holder is still
     * holding while `resolved_at` is null. An ADDED column is the privacy
     * regression this catches.
     */
    for (const expected of [DANDIYA_LOAN_COLUMNS, DANDIYA_HOLDER_COLUMNS]) {
      const rows = columns.filter((row) => row.table_name === expected.table)
      const names = rows.map((row) => row.column_name).sort()
      const all = [...expected.required, ...expected.nullable].sort()

      const added = names.filter((column) => !all.includes(column))
      const absent = all.filter((column) => !names.includes(column))
      const wrongNullability = rows
        .filter((row) => {
          if (added.includes(row.column_name)) return false

          return expected.nullable.includes(row.column_name)
            ? row.is_nullable !== 'YES'
            : row.is_nullable !== 'NO'
        })
        .map((row) => row.column_name)
        .sort()

      const ok =
        added.length === 0 && absent.length === 0 && wrongNullability.length === 0

      if (!ok) missing++

      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${expected.table} holds exactly its ${String(all.length)} columns`,
      )

      if (!ok) {
        if (absent.length > 0) console.log(`        missing: ${absent.join(', ')}`)
        if (added.length > 0) console.log(`        unexpected: ${added.join(', ')}`)
        if (wrongNullability.length > 0) {
          console.log(`        wrong nullability: ${wrongNullability.join(', ')}`)
        }
      }
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
