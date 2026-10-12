// Stand-in for server/db/client.ts so the REAL registry code runs without
// Postgres. It never opens a socket and never reads DATABASE_URL.
//
// Statements are lazy descriptors. A batch applies them against a snapshot
// and restores that snapshot if any of them throws, which is how the Neon
// HTTP driver's single-transaction batch behaves — that is precisely the
// property the no-partial-write tests need to observe.

export const state = {
  devices: new Map(),
  attributes: [], // { deviceId, attribute }
  assignments: [], // { id, eventId, deviceId, rangeStart, rangeEnd, assignedAt, releasedAt }
  events: [],
  // { id, eventId, badgeNumber, prizeName, awardedByDeviceId, awardedAt }
  prizeAwards: [],
  // { id, eventId, pairCode, issuedByDeviceId, issuedAt,
  //   closedAt, closedByDeviceId, outcome, pairReleasedAt }
  dandiyaLoans: [],
  // { id, loanId, eventId, badgeNumber, slot,
  //   resolution, resolvedAt, resolvedByDeviceId }
  dandiyaLoanHolders: [],
  /** Statements actually applied, in order. Reset between scenarios. */
  applied: [],
  /** Set to a message to make the NEXT applied write throw. */
  failNextWrite: null,
  /**
   * Called once, immediately before the next applied write.
   *
   * Scripts a CONCURRENT writer committing between a request's check and its
   * own insert — the one interleaving that "SELECT then INSERT" cannot see
   * and that only the database constraint catches.
   */
  beforeNextWrite: null,
}

export const reset = () => {
  state.devices = new Map()
  state.attributes = []
  state.assignments = []
  state.events = []
  state.prizeAwards = []
  state.dandiyaLoans = []
  state.dandiyaLoanHolders = []
  state.applied = []
  state.failNextWrite = null
  state.beforeNextWrite = null
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

const snapshot = () => ({
  devices: new Map([...state.devices].map(([k, v]) => [k, clone(v)])),
  attributes: clone(state.attributes),
  assignments: clone(state.assignments),
  events: clone(state.events),
  prizeAwards: clone(state.prizeAwards),
  dandiyaLoans: clone(state.dandiyaLoans),
  dandiyaLoanHolders: clone(state.dandiyaLoanHolders),
})

const restore = (taken) => {
  state.devices = taken.devices
  state.attributes = taken.attributes
  state.assignments = taken.assignments
  state.events = taken.events
  state.prizeAwards = taken.prizeAwards
  state.dandiyaLoans = taken.dandiyaLoans
  state.dandiyaLoanHolders = taken.dandiyaLoanHolders
}

const rowsOf = (table) => {
  if (table === 'devices') return [...state.devices.values()]
  if (table === 'device_attributes') return state.attributes
  if (table === 'badge_assignments') return state.assignments
  if (table === 'events') return state.events
  if (table === 'prize_awards') return state.prizeAwards
  if (table === 'dandiya_loans') return state.dandiyaLoans
  if (table === 'dandiya_loan_holders') return state.dandiyaLoanHolders
  throw new Error(`unexpected table ${table}`)
}

const isColumn = (value) =>
  typeof value === 'object' && value !== null && value.__column === true

/**
 * Evaluates a descriptor against a SCOPE: one row per table in the query.
 *
 * A condition names its own table, so `eq(devices.eventId, …)` in a query
 * whose FROM is `device_attributes` reads the JOINED device row rather than
 * looking for an `eventId` the attribute row does not have. The fake used to
 * treat a join as a no-op and resolve every column against the base row,
 * which silently answered that query with nothing at all.
 *
 * `value` may itself be a column, which is what a join condition is.
 */
const readScoped = (scope, fallbackTable, descriptor) => {
  const row = scope[descriptor.table] ?? scope[fallbackTable]

  return row === undefined ? undefined : row[descriptor.column]
}

/**
 * COMPARABLE FORM. A timestamp column holds a `Date` and the day window is a
 * pair of `Date`s, so both sides go to epoch milliseconds — comparing a Date
 * to a Date with `<` would coerce, and comparing one to a string would not.
 */
const comparable = (value) =>
  value instanceof Date ? value.getTime() : value

const matchesScope = (scope, fallbackTable, condition) => {
  if (condition === undefined || condition === null) return true

  if (condition.op === 'and') {
    return condition.parts.every((part) => matchesScope(scope, fallbackTable, part))
  }

  if (condition.op === 'or') {
    return condition.parts.some((part) => matchesScope(scope, fallbackTable, part))
  }

  if (condition.op === 'gte' || condition.op === 'lt') {
    const left = comparable(readScoped(scope, fallbackTable, condition))
    const right = comparable(condition.value)

    /**
     * NULL COMPARES TO NOTHING, as SQL has it. `closed_at >= …` on an open
     * loan is unknown rather than false-by-coercion — which matters, because
     * `null >= date` in JavaScript is `false` for the wrong reason and
     * `null < date` would be TRUE and would pull every open loan into the
     * "closed today" clause.
     */
    if (left === null || left === undefined) {
      return false
    }

    return condition.op === 'gte' ? left >= right : left < right
  }

  if (condition.op === 'inArray') {
    return condition.values.includes(readScoped(scope, fallbackTable, condition))
  }

  if (condition.op === 'eq') {
    const left = readScoped(scope, fallbackTable, condition)
    const right = isColumn(condition.value)
      ? readScoped(scope, fallbackTable, condition.value)
      : condition.value

    return left === right
  }

  if (condition.op === 'isNull') {
    const value = readScoped(scope, fallbackTable, condition)

    return value === null || value === undefined
  }

  /**
   * The ISSUANCE GUARD, which is a SQL predicate rather than an operator
   * because it is a correlated `NOT EXISTS` over another row of the loan
   * table. Only its two shapes are understood; anything else throws.
   */
  if (condition.op === 'sql') {
    return matchesIssuanceGuard(condition)
  }

  throw new Error(`unexpected condition ${String(condition.op)}`)
}

/**
 * THE TWO SQL PREDICATES THE DANDIYA WRITER USES, evaluated.
 *
 * `server/dandiya/loans.ts` closes a loan with three mutually exclusive
 * compare-and-sets, each guarded by a scalar subquery over the holder rows:
 *
 *   (select count(*) ... where loan_id = $1 and resolved_at is null) = 0
 *   (select count(*) ... where loan_id = $1 and resolution = 'lost')  = N
 *
 * Those subqueries are the whole reason a concurrent FINAL resolution is
 * safe: Postgres evaluates them INSIDE the transaction, after the holder
 * update above them, so the statement sees what that update produced rather
 * than what the process read a moment earlier. A fake that ignored them, or
 * answered from a stale snapshot, would make the race tests meaningless.
 *
 * Only these two SHAPES are understood. Anything else throws rather than
 * being quietly misread, so a new expression cannot pass a test by being
 * skipped — the same rule `applyExpression` follows.
 */
const flattenSql = (expression) => {
  const text = []
  const columns = []
  const literals = []

  const walk = (node) => {
    node.strings.forEach((chunk, index) => {
      text.push(chunk)

      const value = node.values[index]

      if (value === undefined) return
      if (isSqlExpression(value)) walk(value)
      else if (isColumn(value)) columns.push(value.column)
      else if (typeof value === 'object' && value !== null && value.__table) {
        text.push(String(value.__table))
      } else literals.push(value)
    })
  }

  walk(expression)

  return { text: text.join(''), columns, literals }
}

const matchesHolderCount = (expression) => {
  const { text, columns, literals } = flattenSql(expression)
  const loanId = literals.find((value) => typeof value === 'string')
  const expected = literals.find((value) => typeof value === 'number') ??
    Number(/=\s*(\d+)\s*$/.exec(text)?.[1] ?? Number.NaN)

  if (!/^\(select count\(\*\) from/.test(text.trim()) ||
      loanId === undefined || Number.isNaN(expected)) {
    throw new Error(`unsupported SQL predicate: ${text}`)
  }

  const holders = state.dandiyaLoanHolders.filter((row) => row.loanId === loanId)

  if (columns.includes('resolvedAt') && /is null\)/.test(text)) {
    return holders.filter((row) => (row.resolvedAt ?? null) === null).length === expected
  }

  // `'lost'` is part of the template TEXT, not an interpolated value — it is
  // written inline in the subquery — so the text is where it is looked for.
  if (columns.includes('resolution') && text.includes("'lost'")) {
    return holders.filter((row) => row.resolution === 'lost').length === expected
  }

  throw new Error(`unsupported SQL predicate: ${text}`)
}

/**
 * THE ISSUANCE GUARD, evaluated — the predicate that carries the cross-table
 * accountability rule on the guarded loan insert.
 *
 *   true
 *   not exists (select 1 from dandiya_loans
 *                where event_id = $1 and closed_at is null
 *                  and accountability_badge_number in ($2, $3))
 *
 * `true` is the fully badgeless case: no badge is presented, so there is
 * nothing to look for. The other shape is the real rule, and it is evaluated
 * against LIVE state here for the same reason the holder-count subqueries
 * are: Postgres evaluates it inside the transaction that writes, so a fake
 * answering from a stale snapshot would make these tests meaningless.
 *
 * WHAT THIS FILE STILL CANNOT PROVE is that a transaction which STARTED
 * before another one's anchor committed observes it after waiting on the
 * event lock. It is single-threaded, so a scripted writer has always already
 * committed. That is the whole point of
 * `scripts/dandiya-issuance-concurrency-smoke.mjs`.
 *
 * Only these two SHAPES are understood. Anything else throws rather than
 * being quietly misread.
 */
const matchesIssuanceGuard = (expression) => {
  const { text, columns, literals } = flattenSql(expression)
  const normalised = text.replace(/\s+/g, ' ').trim()

  if (normalised === 'true') {
    return true
  }

  const eventId = literals.find((value) => typeof value === 'string')
  const badges = literals.find((value) => Array.isArray(value))

  if (!/^not exists \(select 1 from dandiya_loans where/.test(normalised) ||
      eventId === undefined || badges === undefined ||
      !columns.includes('eventId') ||
      !columns.includes('closedAt') ||
      !columns.includes('accountabilityBadgeNumber') ||
      !/is null/.test(normalised) || !/ in /.test(normalised)) {
    throw new Error(`unsupported issuance guard: ${normalised}`)
  }

  return !state.dandiyaLoans.some(
    (loan) =>
      loan.eventId === eventId &&
      (loan.closedAt ?? null) === null &&
      badges.includes(loan.accountabilityBadgeNumber ?? null),
  )
}

/** The single-table form, for the update and delete builders. */
const matches = (row, condition) => {
  if (condition === undefined || condition === null) return true
  if (condition.op === 'and') return condition.parts.every((p) => matches(row, p))
  if (condition.op === 'or') return condition.parts.some((p) => matches(row, p))
  if (condition.op === 'eq') return row[condition.column] === condition.value
  if (condition.op === 'inArray') return condition.values.includes(row[condition.column])
  if (condition.op === 'gte' || condition.op === 'lt') {
    const left = comparable(row[condition.column])

    if (left === null || left === undefined) return false

    const right = comparable(condition.value)

    return condition.op === 'gte' ? left >= right : left < right
  }
  if (condition.op === 'isNull') return row[condition.column] === null || row[condition.column] === undefined
  // A scalar subquery over the holder rows — see `matchesHolderCount`.
  if (condition.op === 'sql') return matchesHolderCount(condition)
  throw new Error(`unexpected condition ${String(condition.op)}`)
}

const project = (scope, fallbackTable, columns) => {
  const base = scope[fallbackTable]

  if (columns === undefined) return clone(base)

  const picked = {}

  for (const [alias, descriptor] of Object.entries(columns)) {
    picked[alias] = clone(readScoped(scope, fallbackTable, descriptor))
  }

  return picked
}

const isSqlExpression = (value) =>
  typeof value === 'object' && value !== null && value.op === 'sql'

/**
 * The only SQL expression the registry uses: `${column} + <n>`. Anything else
 * throws rather than being quietly misread, so a new expression cannot pass a
 * test by being ignored.
 */
const applyExpression = (row, expression) => {
  const increment = /^\s*\+\s*(\d+)\s*$/.exec(expression.strings[1] ?? '')
  const column = expression.values[0]?.column

  if (expression.values.length !== 1 || increment === null || column === undefined) {
    throw new Error(`unsupported SQL expression: ${JSON.stringify(expression)}`)
  }

  return (row[column] ?? 0) + Number(increment[1])
}

/**
 * The three guarantees the migrations place on `badge_assignments`, enforced
 * here the way Postgres enforces them: at INSERT time, after any application
 * check the caller may have made.
 *
 * This is what makes a race test mean something. A fake that happily inserts
 * an overlapping row would let "SELECT then INSERT" look safe, which is
 * exactly the mistake the real constraints exist to catch.
 */
const constraintViolation = (name) => {
  /**
   * WRAPPED, exactly as production throws it.
   *
   * Drizzle rethrows every driver error as `DrizzleQueryError`, whose message
   * is `Failed query: …` and whose `cause` holds the real Postgres error. A
   * fake that threw a bare object with a top-level `constraint` let a reader
   * that never looked at `cause` pass every test while mapping nothing in
   * production — which is how an overlapping badge range reached an operator
   * as "The server returned an unexpected response."
   */
  const postgres = new Error(`conflicting key value violates constraint "${name}"`)

  postgres.name = 'NeonDbError'
  postgres.code = name.includes('no_overlap') ? '23P01' : '23505'
  // A unique-index violation names the INDEX, which is what Postgres reports
  // for a partial unique index: there is no constraint object to name.

  postgres.constraint = name

  const wrapped = new Error(
    `Failed query: insert into "badge_assignments" ...\nparams: `,
  )

  wrapped.name = 'DrizzleQueryError'
  wrapped.cause = postgres

  return wrapped
}

const guardBadgeAssignment = (row) => {
  const device = state.devices.get(row.deviceId)

  // The composite foreign key: a range cannot pair an event with a device
  // belonging to a different one.
  if (device === undefined || device.eventId !== row.eventId) {
    throw constraintViolation('badge_assignments_device_event_fk')
  }

  const active = state.assignments.filter((entry) => entry.releasedAt === null ||
    entry.releasedAt === undefined)

  // Partial unique index on (device_id) WHERE released_at IS NULL.
  if (active.some((entry) => entry.deviceId === row.deviceId)) {
    throw constraintViolation('badge_assignments_one_active_per_device')
  }

  // GiST exclusion constraint: active ranges within one event may not overlap.
  if (
    active.some(
      (entry) =>
        entry.eventId === row.eventId &&
        row.rangeStart <= entry.rangeEnd &&
        entry.rangeStart <= row.rangeEnd,
    )
  ) {
    throw constraintViolation('badge_assignments_active_ranges_no_overlap')
  }
}

/**
 * The same guarantees, re-checked after an UPDATE.
 *
 * The GiST exclusion constraint is not an INSERT trigger: extending an active
 * range widens the interval the constraint compares, so Postgres re-evaluates
 * it. A fake that only guarded inserts would let "extend #001-#050 to
 * #001-#100 while another device owns #051-#100" look safe — which is exactly
 * the cross-device race the constraint exists to stop.
 *
 * The row being updated is excluded from the comparison by id: a range always
 * overlaps itself.
 */
const guardBadgeAssignmentUpdate = (row) => {
  if (!(row.rangeStart > 0) || !(row.rangeEnd > 0)) {
    throw constraintViolation(
      row.rangeStart > 0
        ? 'badge_assignments_range_end_positive'
        : 'badge_assignments_range_start_positive',
    )
  }

  if (row.rangeStart > row.rangeEnd) {
    throw constraintViolation('badge_assignments_range_ordered')
  }

  if (row.releasedAt !== null && row.releasedAt !== undefined) {
    return
  }

  const others = state.assignments.filter(
    (entry) =>
      entry.id !== row.id &&
      (entry.releasedAt === null || entry.releasedAt === undefined),
  )

  if (
    others.some(
      (entry) =>
        entry.eventId === row.eventId &&
        row.rangeStart <= entry.rangeEnd &&
        entry.rangeStart <= row.rangeEnd,
    )
  ) {
    throw constraintViolation('badge_assignments_active_ranges_no_overlap')
  }
}

/**
 * The constraints `prize_awards` STILL has after `0004_repeat_prize_awards`.
 *
 * THERE IS NO UNIQUENESS HERE, deliberately. P1's
 * `UNIQUE(event_id, badge_number)` was dropped in 0004 because repeat prizes
 * became the event rule, so a fake that kept enforcing it would fail the very
 * tests that prove a second and third award succeed — and would quietly
 * describe a database nobody has. Do not add one back, by any column set.
 *
 * What remains is modelled faithfully, because those still refuse writes: the
 * same-event composite foreign key, the positive badge number, and both
 * bounds on the prize name.
 */
const guardPrizeAward = (row) => {
  const device = state.devices.get(row.awardedByDeviceId)

  // The composite foreign key: a prize cannot pair an event with a device
  // belonging to a different one.
  if (device === undefined || device.eventId !== row.eventId) {
    throw constraintViolation('prize_awards_device_event_fk')
  }

  if (!(row.badgeNumber > 0)) {
    throw constraintViolation('prize_awards_badge_number_positive')
  }

  if (String(row.prizeName ?? '').trim() === '') {
    throw constraintViolation('prize_awards_prize_name_not_empty')
  }

  if (String(row.prizeName ?? '').length > 80) {
    throw constraintViolation('prize_awards_prize_name_max_length')
  }
}

/**
 * The guarantees `0005_dandiya_checkout.sql` and `0006_dandiya_badgeless_
 * issuance.sql` place on the two dandiya tables, enforced here the way
 * Postgres enforces them: at INSERT time, after any application check the
 * caller may have made.
 *
 * THE TWO UNIQUE INDEXES ARE PARTIAL, and so are these. A fake that treated
 * them as total would refuse the SECOND loan of a pair that has already come
 * back — the reuse an entire dandiya evening consists of — and a fake that
 * ignored them would let "SELECT then INSERT" look safe, which is exactly the
 * mistake the real indexes exist to catch. Both halves are modelled.
 */
const guardDandiyaLoan = (row) => {
  const device = state.devices.get(row.issuedByDeviceId)

  // The composite foreign key: a loan cannot pair an event with a device
  // belonging to a different one.
  if (device === undefined || device.eventId !== row.eventId) {
    throw constraintViolation('dandiya_loans_issued_device_event_fk')
  }

  if (String(row.pairCode ?? '').trim() === '') {
    throw constraintViolation('dandiya_loans_pair_code_not_empty')
  }

  if (String(row.pairCode ?? '').length > 32) {
    throw constraintViolation('dandiya_loans_pair_code_max_length')
  }

  /**
   * CANONICAL, or Postgres refuses it. Modelled because the pair index below
   * only means one-pair-one-loan while every stored code is already trimmed
   * and uppercased — a fake that accepted `d-014` would let a writer that
   * forgot to canonicalise look safe.
   */
  const pairCode = String(row.pairCode ?? '')

  if (pairCode !== pairCode.trim().toUpperCase()) {
    throw constraintViolation('dandiya_loans_pair_code_canonical')
  }

  guardDandiyaLoanState(row)

  /**
   * UNIQUE(event_id, pair_code) WHERE pair_released_at IS NULL — the pair
   * authority. Partial, so a CLEANLY RETURNED pair frees its slot while an
   * open loan and a loan that lost a stick both keep it.
   */
  if (
    (row.pairReleasedAt ?? null) === null &&
    state.dandiyaLoans.some(
      (entry) =>
        entry.id !== row.id &&
        (entry.pairReleasedAt ?? null) === null &&
        entry.eventId === row.eventId &&
        entry.pairCode === row.pairCode,
    )
  ) {
    throw constraintViolation('dandiya_loans_one_unreleased_per_pair')
  }

  /** Exactly ten digits, or absent. */
  const contactPhone = row.contactPhone ?? null

  if (contactPhone !== null && !/^[0-9]{10}$/.test(String(contactPhone))) {
    throw constraintViolation('dandiya_loans_contact_phone_canonical')
  }

  /**
   * UNIQUE(event_id, contact_phone) WHERE closed_at IS NULL — one OPEN
   * badgeless loan per contact number, and NULLS ARE DISTINCT so badge-based
   * loans never participate. Partial on `closed_at`, so the number frees as
   * soon as the loan closes.
   */
  if (
    contactPhone !== null &&
    (row.closedAt ?? null) === null &&
    state.dandiyaLoans.some(
      (entry) =>
        entry.id !== row.id &&
        (entry.closedAt ?? null) === null &&
        entry.eventId === row.eventId &&
        (entry.contactPhone ?? null) === contactPhone,
    )
  ) {
    throw constraintViolation('dandiya_loans_one_open_per_contact')
  }

  /**
   * UNIQUE(event_id, accountability_badge_number) WHERE closed_at IS NULL —
   * one OPEN mixed loan per accountability badge.
   *
   * PARTIAL on `closed_at`, like the contact index and unlike the HOLDER
   * index, and that difference is the whole guarantee: the holder index
   * releases the badge as soon as its own stick is resolved, which is correct
   * for a two-badge pair and would let #100 anchor a second mixed pair while
   * its guest still held a stick. NULLS ARE DISTINCT, so two-badge and fully
   * badgeless loans never participate.
   */
  const anchor = row.accountabilityBadgeNumber ?? null

  if (
    anchor !== null &&
    (row.closedAt ?? null) === null &&
    state.dandiyaLoans.some(
      (entry) =>
        entry.id !== row.id &&
        (entry.closedAt ?? null) === null &&
        entry.eventId === row.eventId &&
        (entry.accountabilityBadgeNumber ?? null) === anchor,
    )
  ) {
    throw constraintViolation('dandiya_loans_one_open_per_accountability_badge')
  }
}

/**
 * The loan's own CHECK constraints, re-evaluated after an UPDATE as well as
 * an INSERT — which is the point. Closing a loan is an update, and these are
 * exactly the rules that stop a loss quietly freeing the physical pair.
 */
const guardDandiyaLoanState = (row) => {
  const closedAt = row.closedAt ?? null
  const closedBy = row.closedByDeviceId ?? null
  const outcome = row.outcome ?? null
  const released = row.pairReleasedAt ?? null

  if ((closedAt === null) !== (outcome === null) || (closedAt === null) !== (closedBy === null)) {
    throw constraintViolation('dandiya_loans_close_paired')
  }

  if (outcome !== null && !['returned', 'partial_loss', 'lost'].includes(outcome)) {
    throw constraintViolation('dandiya_loans_outcome_valid')
  }

  if (released !== null && outcome !== 'returned') {
    throw constraintViolation('dandiya_loans_release_requires_returned')
  }

  if (outcome === 'returned' && released === null) {
    throw constraintViolation('dandiya_loans_returned_requires_release')
  }

  if (closedBy !== null) {
    const closer = state.devices.get(closedBy)

    if (closer === undefined || closer.eventId !== row.eventId) {
      throw constraintViolation('dandiya_loans_closed_device_event_fk')
    }
  }

  /** A real badge, or none. Never a synthetic anchor. */
  const anchor = row.accountabilityBadgeNumber ?? null

  if (anchor !== null && !(Number.isInteger(anchor) && anchor > 0)) {
    throw constraintViolation('dandiya_loans_accountability_badge_positive')
  }

  /**
   * ONE ANCHOR, NEVER TWO. This is what makes a non-null `contact_phone` mean
   * exactly "fully badgeless" and a non-null anchor mean exactly "mixed".
   */
  if (anchor !== null && (row.contactPhone ?? null) !== null) {
    throw constraintViolation('dandiya_loans_accountability_exclusive')
  }
}

const guardDandiyaHolder = (row) => {
  const loan = state.dandiyaLoans.find((entry) => entry.id === row.loanId)

  if (loan === undefined || loan.eventId !== row.eventId) {
    throw constraintViolation('dandiya_loan_holders_loan_event_fk')
  }

  /**
   * `badge_number IS NULL OR > 0`, as 0006 widened it. NULL is a guest with
   * no badge, and the fake must accept it or every badgeless issue would
   * look like a constraint failure that production would not have.
   */
  const badgeNumber = row.badgeNumber ?? null

  if (badgeNumber !== null && !(badgeNumber > 0)) {
    throw constraintViolation('dandiya_loan_holders_badge_number_positive')
  }

  if (row.slot !== 1 && row.slot !== 2) {
    throw constraintViolation('dandiya_loan_holders_slot_valid')
  }

  const siblings = state.dandiyaLoanHolders.filter(
    (entry) => entry.loanId === row.loanId && entry.id !== row.id,
  )

  if (siblings.some((entry) => entry.slot === row.slot)) {
    throw constraintViolation('dandiya_loan_holders_loan_id_slot_key')
  }

  /**
   * UNIQUE(loan_id, badge_number), and NULLS ARE DISTINCT. Two guest sticks
   * on one pair are two anonymous holders, not the same holder twice — which
   * is exactly what Postgres does with NULLs in a unique index, and modelling
   * it any other way would make a two-guest pair impossible here while
   * working in production.
   */
  if (
    badgeNumber !== null &&
    siblings.some((entry) => (entry.badgeNumber ?? null) === badgeNumber)
  ) {
    throw constraintViolation('dandiya_loan_holders_loan_id_badge_number_key')
  }

  guardDandiyaHolderState(row)

  /**
   * UNIQUE(event_id, badge_number) WHERE resolved_at IS NULL — the attendee
   * authority. Partial on `resolved_at` rather than on the resolution, so a
   * LOST stick frees its holder exactly as a returned one does.
   */
  if (
    badgeNumber !== null &&
    (row.resolvedAt ?? null) === null &&
    state.dandiyaLoanHolders.some(
      (entry) =>
        entry.id !== row.id &&
        (entry.resolvedAt ?? null) === null &&
        entry.eventId === row.eventId &&
        (entry.badgeNumber ?? null) === badgeNumber,
    )
  ) {
    throw constraintViolation('dandiya_loan_holders_one_unresolved_per_badge')
  }
}

/** The holder's own CHECKs, on insert and on update alike. */
const guardDandiyaHolderState = (row) => {
  const resolution = row.resolution ?? null
  const resolvedAt = row.resolvedAt ?? null
  const resolvedBy = row.resolvedByDeviceId ?? null

  if (
    (resolution === null) !== (resolvedAt === null) ||
    (resolution === null) !== (resolvedBy === null)
  ) {
    throw constraintViolation('dandiya_loan_holders_resolution_paired')
  }

  if (resolution !== null && !['returned', 'lost'].includes(resolution)) {
    throw constraintViolation('dandiya_loan_holders_resolution_valid')
  }

  if (resolvedBy !== null) {
    const resolver = state.devices.get(resolvedBy)

    if (resolver === undefined || resolver.eventId !== row.eventId) {
      throw constraintViolation('dandiya_loan_holders_resolved_device_event_fk')
    }
  }
}

const guardFailure = () => {
  if (state.beforeNextWrite !== null) {
    const commit = state.beforeNextWrite

    state.beforeNextWrite = null
    commit()
  }

  if (state.failNextWrite !== null) {
    const message = state.failNextWrite

    state.failNextWrite = null
    throw new Error(message)
  }
}

/**
 * A thenable statement. Awaiting it applies it immediately; handing it to
 * batch() applies it inside the batch instead.
 */
const statement = (describe, apply) => {
  const built = {
    describe,
    apply,
    then(resolve, reject) {
      try {
        resolve(built.__run())
      } catch (error) {
        reject(error)
      }

      return undefined
    },
    __run() {
      state.applied.push(describe())

      return apply()
    },
  }

  return built
}

const selectBuilder = (columns) => {
  const query = { columns, table: null, condition: undefined, joins: [] }

  const builder = {
    from(table) {
      query.table = table.__table

      return builder
    },
    /**
     * A REAL inner join: the first matching row of the joined table is bound
     * into the scope, and a base row with no match is dropped — which is what
     * `INNER` means, and is how a prize whose device was deleted would
     * disappear rather than surface a blank name.
     */
    innerJoin(table, condition) {
      query.joins.push({ table: table.__table, condition })

      return builder
    },
    where(condition) {
      query.condition = condition

      return builder
    },
    orderBy() {
      return builder
    },
    /**
     * `SELECT ... FOR UPDATE`, which in this stand-in is a BATCHABLE
     * STATEMENT rather than a plain thenable.
     *
     * That matters for two reasons. It lets the dandiya resolver hand the
     * lock to `batch()` the way it does against the real driver, and it
     * records `lock <table>` in `state.applied`, so a test can assert the
     * lock is the FIRST statement of the transaction.
     *
     * WHAT IT CANNOT DO is reproduce PostgreSQL's visibility rules. This file
     * is single-threaded and its batch applies statements against live state,
     * so a scripted concurrent writer has already committed before the first
     * statement runs — which is exactly the world the real row lock produces.
     * The fake therefore shows the CORRECT post-lock behaviour whether or not
     * the lock is there, and the lock's presence and position are pinned
     * structurally instead. The real thing is proved by
     * `scripts/dandiya-concurrency-smoke.mjs` against a live database.
     */
    for(mode) {
      return statement(
        () => `lock ${String(query.table)} for ${String(mode)}`,
        () => builder.__rows(),
      )
    },
    /**
     * HOW MANY ROWS THIS SELECT YIELDS, without projecting. An INSERT ...
     * SELECT needs the count: its selected fields are expressions rather
     * than columns, so `project` has nothing to read them from.
     */
    __count() {
      let total = 0

      for (const row of rowsOf(query.table)) {
        const scope = { [query.table]: row }
        let joined = true

        for (const join of query.joins) {
          const match = rowsOf(join.table).find((candidate) =>
            matchesScope({ ...scope, [join.table]: candidate }, query.table, join.condition),
          )

          if (match === undefined) {
            joined = false

            break
          }

          scope[join.table] = match
        }

        if (joined && matchesScope(scope, query.table, query.condition)) {
          total += 1
        }
      }

      return total
    },
    __fields: () => columns,
    __rows() {
      const results = []

      for (const row of rowsOf(query.table)) {
        const scope = { [query.table]: row }
        let joined = true

        for (const join of query.joins) {
          const match = rowsOf(join.table).find((candidate) =>
            matchesScope(
              { ...scope, [join.table]: candidate },
              query.table,
              join.condition,
            ),
          )

          if (match === undefined) {
            joined = false

            break
          }

          scope[join.table] = match
        }

        if (!joined || !matchesScope(scope, query.table, query.condition)) {
          continue
        }

        results.push(project(scope, query.table, columns))
      }

      return results
    },
    then(resolve, reject) {
      try {
        state.applied.push(`select ${String(query.table)}`)

        const results = []

        for (const row of rowsOf(query.table)) {
          const scope = { [query.table]: row }
          let joined = true

          for (const join of query.joins) {
            const match = rowsOf(join.table).find((candidate) =>
              matchesScope(
                { ...scope, [join.table]: candidate },
                query.table,
                join.condition,
              ),
            )

            if (match === undefined) {
              joined = false

              break
            }

            scope[join.table] = match
          }

          if (!joined || !matchesScope(scope, query.table, query.condition)) {
            continue
          }

          results.push(project(scope, query.table, columns))
        }

        resolve(results)
      } catch (error) {
        reject(error)
      }

      return undefined
    },
  }

  return builder
}

let nextId = 1

/**
 * ONE SELECTED FIELD OF AN `INSERT ... SELECT`, evaluated to the value it
 * writes.
 *
 * Three shapes, and only three:
 *
 *   ${value}::type        a bound parameter  -> that value
 *   null::type            an explicit null   -> null
 *   gen_random_uuid()     a database default -> undefined, so the stand-in's
 *                                              own default fills it
 *
 * A field reading a COLUMN is refused outright: every value the issuance
 * writer inserts is a constant, and a field that read the scanned row would
 * mean this evaluator was quietly inventing semantics. Anything unrecognised
 * throws, so a new expression cannot pass a test by being skipped.
 */
const evaluateInsertField = (expression) => {
  const { text, columns, literals } = flattenSql(expression)
  const normalised = text.replace(/\s+/g, ' ').trim()

  if (columns.length === 0 && literals.length === 1) {
    return literals[0]
  }

  if (columns.length === 0 && literals.length === 0) {
    if (/^null(::[a-z]+)?$/.test(normalised)) {
      return null
    }

    if (normalised === 'gen_random_uuid()') {
      return undefined
    }
  }

  throw new Error(`unsupported insert field: ${normalised}`)
}

/**
 * The query builder an `INSERT ... SELECT` is handed, standing in for
 * Drizzle's. It can do exactly what the issuance writer asks of it.
 */
const queryBuilder = () => ({
  select: (columns) => selectBuilder(columns),
})

/**
 * ONE ROW APPLIED, with the column defaults the migrations declare and then
 * every guarantee they place on the table.
 *
 * Shared by `.values()` and by the INSERT ... SELECT form the issuance writer
 * uses, so a guarded insert cannot reach the tables through a path with
 * weaker checks than an ordinary one.
 */
const applyInsertRow = (target, payload) => {
  guardFailure()

  const row = { ...payload }

  if (target === 'devices') {
    row.loginName ??= null
    // The column defaults, as the migration declares them.
    row.passwordHash ??= null
    row.sessionVersion ??= 1
    row.enabled ??= true
    row.lastSeenAt ??= null
    row.createdAt ??= new Date('2026-01-01T00:00:00.000Z')
    state.devices.set(row.id, row)
  } else if (target === 'device_attributes') {
    state.attributes.push(row)
  } else if (target === 'badge_assignments') {
    row.id ??= `assignment-${String(nextId++)}`
    row.assignedAt ??= new Date('2026-01-01T00:00:00.000Z')
    row.releasedAt ??= null
    guardBadgeAssignment(row)
    state.assignments.push(row)
  } else if (target === 'prize_awards') {
    row.id ??= `11111111-2222-4333-8444-${String(100000000000 + nextId++)}`
    row.awardedAt ??= new Date('2026-10-10T12:30:00.000Z')
    guardPrizeAward(row)
    state.prizeAwards.push(row)
  } else if (target === 'dandiya_loans') {
    row.id ??= `aaaaaaaa-1111-4111-8111-${String(100000000000 + nextId++)}`
    row.issuedAt ??= new Date('2026-10-11T12:00:00.000Z')
    row.closedAt ??= null
    row.closedByDeviceId ??= null
    row.outcome ??= null
    row.pairReleasedAt ??= null
    row.contactPhone ??= null
    /** A mixed loan's anchor; NULL for the other two modes. */
    row.accountabilityBadgeNumber ??= null
    guardDandiyaLoan(row)
    state.dandiyaLoans.push(row)
  } else if (target === 'dandiya_loan_holders') {
    row.id ??= `bbbbbbbb-1111-4111-8111-${String(100000000000 + nextId++)}`
    /** A guest stick: the column defaults to NULL, as 0006 allows. */
    row.badgeNumber ??= null
    row.resolution ??= null
    row.resolvedAt ??= null
    row.resolvedByDeviceId ??= null
    guardDandiyaHolder(row)
    state.dandiyaLoanHolders.push(row)
  } else if (target === 'events') {
    row.id ??= `event-${String(nextId++)}`
    row.active ??= true
    row.startsAt ??= null
    row.endsAt ??= null
    row.createdAt ??= new Date('2026-01-01T00:00:00.000Z')
    state.events.push(row)
  }

  return clone(row)
}

const insertBuilder = (table) => {
  const target = table.__table

  return {
    values(payload) {
      const built = statement(
        () => `insert ${target}`,
        () => [applyInsertRow(target, payload)],
      )

      /** Drizzle returns the SAME builder, so it stays batchable. */
      built.returning = () => built

      return built
    },
    /**
     * `INSERT ... SELECT`, which is how the issuance writer makes its loan
     * and holder writes CONDITIONAL inside one transaction.
     *
     * The source select decides HOW MANY rows are written — one when its
     * `WHERE` holds, none when it does not — and every selected field is a
     * constant expression, so the row's values come from those expressions
     * rather than from the scanned row. A refusal therefore writes nothing
     * at all, and `returning` comes back empty, which is exactly the verdict
     * the real writer reads.
     */
    select(callback) {
      const source = callback(queryBuilder())

      const built = statement(
        () => `insert ${target} select`,
        () => {
          const produced = source.__count()
          const inserted = []

          for (let index = 0; index < produced; index += 1) {
            const payload = {}

            for (const [field, expression] of Object.entries(source.__fields())) {
              const value = evaluateInsertField(expression)

              if (value !== undefined) {
                payload[field] = value
              }
            }

            inserted.push(applyInsertRow(target, payload))
          }

          return inserted
        },
      )

      built.returning = () => built

      return built
    },
  }
}

const updateBuilder = (table) => {
  const target = table.__table

  return {
    set(patch) {
      let condition

      const built = statement(
        () => `update ${target}`,
        () => {
          guardFailure()

          const changed = []
          /**
           * Only the GUARDED tables need reverting, and the set is explicit
           * rather than universal: `rowsOf` builds a fresh array for
           * `devices`, so a generic restore there would mutate a throwaway
           * and look like a rollback without being one.
           */
          const guards = {
            badge_assignments: guardBadgeAssignmentUpdate,
            /**
             * A CLOSE AND A RESOLUTION ARE UPDATES, so their CHECK
             * constraints have to be re-evaluated here too — including the
             * two that stop a loss quietly freeing the physical pair. A fake
             * that guarded only inserts would let the writer close a
             * `partial_loss` WITH a release and look correct.
             */
            dandiya_loans: guardDandiyaLoanState,
            dandiya_loan_holders: guardDandiyaHolderState,
          }
          const guard = guards[target]
          const restorePoint = guard === undefined ? null : rowsOf(target).map((row) => clone(row))

          try {
            for (const row of rowsOf(target)) {
              if (matches(row, condition)) {
                for (const [key, value] of Object.entries(patch)) {
                  row[key] = isSqlExpression(value) ? applyExpression(row, value) : value
                }

                if (guard !== undefined) {
                  guard(row)
                }

                changed.push(clone(row))
              }
            }
          } catch (error) {
            /**
             * A failed UPDATE in Postgres leaves every row as it was. Without
             * this, a refusal would still have mutated memory and every
             * "nothing was written" assertion would pass for the wrong
             * reason.
             */
            if (restorePoint !== null) {
              if (target === 'badge_assignments') state.assignments = restorePoint
              if (target === 'dandiya_loans') state.dandiyaLoans = restorePoint
              if (target === 'dandiya_loan_holders') state.dandiyaLoanHolders = restorePoint
            }

            throw error
          }

          return changed
        },
      )

      const chain = {
        where(value) {
          condition = value

          return chain
        },
        /**
         * A RETURNING update is awaitable AND batchable.
         *
         * `__run` and `describe` are carried through deliberately: the real
         * Neon HTTP batch returns each statement's rows, and the dandiya
         * return relies on that — its compare-and-set has to say whether it
         * matched a row, from inside the same transaction that releases both
         * holders. A returning chain without `__run` would make that
         * impossible to stand in for.
         */
        returning() {
          return {
            then(resolve, reject) {
              try {
                resolve(built.__run())
              } catch (error) {
                reject(error)
              }

              return undefined
            },
            describe: built.describe,
            __run: () => built.__run(),
          }
        },
        then(resolve, reject) {
          return built.then(resolve, reject)
        },
        describe: built.describe,
        __run: () => built.__run(),
      }

      return chain
    },
  }
}

const deleteBuilder = (table) => {
  const target = table.__table

  return {
    where(condition) {
      return statement(
        () => `delete ${target}`,
        () => {
          guardFailure()

          if (target === 'device_attributes') {
            state.attributes = state.attributes.filter((row) => !matches(row, condition))

            return []
          }

          throw new Error(`unexpected delete on ${target}`)
        },
      )
    },
  }
}

const database = {
  select: (columns) => selectBuilder(columns),
  insert: (table) => insertBuilder(table),
  update: (table) => updateBuilder(table),
  delete: (table) => deleteBuilder(table),
  /** All statements, or none: the Neon HTTP batch is one transaction. */
  async batch(statements) {
    /**
     * A SCRIPTED CONCURRENT WRITER COMMITS FIRST, AND OUTSIDE THIS
     * TRANSACTION.
     *
     * It has to run before the snapshot, because it represents another
     * request that has ALREADY committed — rolling our batch back must not
     * undo it. Firing it inside the first statement instead would snapshot
     * the world before it, and a refused batch would then delete the other
     * desk's row and leave the test observing zero loans where the real
     * database would hold one.
     */
    if (state.beforeNextWrite !== null) {
      const commit = state.beforeNextWrite

      state.beforeNextWrite = null
      commit()
    }

    const taken = snapshot()

    try {
      return statements.map((entry) => entry.__run())
    } catch (error) {
      restore(taken)
      throw error
    }
  },
}

export const getDatabase = () => database
export const isDatabaseConfigured = () => true

export class DatabaseNotConfiguredError extends Error {}

export const schema = {}
