#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY concurrency proof for the dandiya resolution writer.
 *
 * WHAT IT PROVES, AND WHY NOTHING ELSE CAN.
 *
 * Two desks resolving DIFFERENT sticks of one pair write different holder
 * rows, so they never conflict with each other. Compare-and-set alone
 * therefore does not serialise them: under READ COMMITTED each statement
 * takes a fresh snapshot and cannot see the other transaction's uncommitted
 * write, so both would see a stick still out, both would decline to close the
 * loan, and both would commit — every stick resolved and the loan open for
 * the rest of the event.
 *
 * `resolveDandiyaHolders` closes that by taking `SELECT ... FOR UPDATE` on
 * the owning loan as the FIRST statement of the same transaction. That is a
 * claim about PostgreSQL's visibility rules, and the stand-in database in
 * `scripts/verification/` cannot test it: it is single-threaded and its batch
 * applies statements against live state, so it shows the correct post-lock
 * behaviour whether or not the lock is there. `verify:d3` pins the lock's
 * PRESENCE and POSITION; only this script, against a real database with
 * genuinely concurrent transactions, proves the EFFECT.
 *
 * It calls the REAL writer. Each `db.batch` is one HTTP request and therefore
 * one Postgres transaction on its own connection, so two issued together
 * overlap for real.
 *
 * Usage, with `VERCEL_ENV` supplied explicitly because `vercel dev` does not
 * expose it to this project:
 *
 *   export DATABASE_URL=<development branch>
 *   export ALLOW_DANDIYA_DB_SMOKE_WRITES=true
 *   env VERCEL_ENV=development node scripts/dandiya-concurrency-smoke.mjs --confirm
 *   env VERCEL_ENV=development node scripts/dandiya-concurrency-smoke.mjs --cleanup --confirm
 *   unset DATABASE_URL ALLOW_DANDIYA_DB_SMOKE_WRITES
 *
 * IT WRITES, so four independent things must agree first, and every one of
 * them is checked BEFORE a connection is opened:
 *
 *   1. `--confirm` on the command line
 *   2. `ALLOW_DANDIYA_DB_SMOKE_WRITES` exactly `true`
 *   3. `VERCEL_ENV` exactly `development`
 *   4. `SYNC_ALLOWED_VERCEL_ENV`, when set at all, exactly `development`
 *
 * A production deployment sets `SYNC_ALLOWED_VERCEL_ENV=production` and
 * `VERCEL_ENV=production`, so a production connection string pasted into the
 * environment is still refused. NEVER run this against Production.
 *
 * IT CREATES ONLY ITS OWN ROWS: `dandiya_loans` and `dandiya_loan_holders`
 * under pair codes prefixed `SMOKE-D31-`, with badge fixtures from #9901 up,
 * clear of the prize fixtures at #9001-#9030. It reads one existing event and
 * one existing device to satisfy the foreign keys and NEVER creates, modifies
 * or deletes an event, a device, an attribute, a badge assignment, a prize
 * award or any registration. Cleanup removes only rows whose pair code
 * carries that prefix, in this event.
 */
import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { createJiti } from 'jiti'

const root = resolvePath(import.meta.dirname, '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)

const CONFIRMED = has('--confirm')
const CLEANUP_ONLY = has('--cleanup')
/** Each case is run several times: a missing lock loses a narrow race. */
const ROUNDS = Number(process.env.DANDIYA_SMOKE_ROUNDS ?? '5')

const PAIR_PREFIX = 'SMOKE-D31-'
const FIRST_FIXTURE_BADGE = 9901

const fail = (message) => {
  console.error(`REFUSED  ${message}`)
  process.exit(1)
}

// --- the interlocks, all BEFORE any connection or write -------------------

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl === undefined || databaseUrl === '') {
  // The value is a credential and is never printed.
  fail('DATABASE_URL is not set. Set it for this environment and try again.')
}

if (!CONFIRMED) {
  fail(
    'This test WRITES to the database. Re-run with --confirm, pointing\n' +
      '         DATABASE_URL at a disposable Development branch.',
  )
}

/** Exactly `true`. No trimming, no case folding. */
if (process.env.ALLOW_DANDIYA_DB_SMOKE_WRITES !== 'true') {
  fail('ALLOW_DANDIYA_DB_SMOKE_WRITES is not exactly "true".')
}

if (process.env.VERCEL_ENV !== 'development') {
  fail(
    'VERCEL_ENV is not exactly "development". This script never runs\n' +
      '         against Preview or Production.',
  )
}

const allowedEnv = process.env.SYNC_ALLOWED_VERCEL_ENV

if (allowedEnv !== undefined && allowedEnv !== 'development') {
  fail(
    'SYNC_ALLOWED_VERCEL_ENV names a non-development environment, so this\n' +
      '         configuration is not a disposable Development one.',
  )
}

// --- reporting -------------------------------------------------------------

/** Belt and braces: nothing resembling a connection string reaches stdout. */
const CREDENTIAL_PATTERN = new RegExp(`postgres(ql)?${':'}//[^\\s]*@`, 'gi')
const redact = (value) => String(value ?? '').replace(CREDENTIAL_PATTERN, '[redacted]')

let fails = 0
const ok = (label, detail = '') => {
  console.log(`ok   ${label.padEnd(58)} ${detail}`)
}
const bad = (label, detail) => {
  fails++
  console.log(`FAIL ${label}\n     ${redact(detail)}`)
}
const expect = (label, actual, wanted) => {
  const got = JSON.stringify(actual)
  const want = JSON.stringify(wanted)

  if (got === want) {
    ok(label, got)
  } else {
    bad(label, `got  ${got}\n     want ${want}`)
  }
}

// --- the real writer, against the real lazy client ------------------------

const sql = neon(databaseUrl)
const jiti = createJiti(import.meta.url, { interopDefault: true })
const { resolveDandiyaHolders } = await jiti.import(
  `${root}/server/dandiya/loans.ts`,
)

console.log('Navaratri dandiya concurrency smoke — DEVELOPMENT')
console.log(`  rounds per case: ${String(ROUNDS)}`)
console.log(`  fixture pair codes: ${PAIR_PREFIX}*`)

// --- its own rows, and only its own --------------------------------------

const deleteOwnRows = async (eventId) => {
  const holders = await sql`
    delete from dandiya_loan_holders
    where event_id = ${eventId}
      and loan_id in (
        select id from dandiya_loans
        where event_id = ${eventId} and pair_code like ${`${PAIR_PREFIX}%`}
      )
    returning id`
  const loans = await sql`
    delete from dandiya_loans
    where event_id = ${eventId} and pair_code like ${`${PAIR_PREFIX}%`}
    returning id`

  return { holders: holders.length, loans: loans.length }
}

/**
 * ONE EXISTING EVENT AND ONE EXISTING DEVICE, read-only, to satisfy the
 * foreign keys. Nothing central is created: provisioning a device is Admin's
 * job and a smoke test has no business doing it.
 */
const [event] = await sql`
  select id, slug from events where active = true order by created_at limit 1`

if (event === undefined) {
  fail('No active event exists in this database. Create one in Admin first.')
}

const [device] = await sql`
  select id from devices where event_id = ${event.id} order by created_at limit 1`

if (device === undefined) {
  fail(`No device exists for event ${event.slug}. Create one in Admin first.`)
}

console.log(`  event: ${event.slug}`)

if (CLEANUP_ONLY) {
  const removed = await deleteOwnRows(event.id)

  console.log(
    `\nCleanup removed ${String(removed.loans)} fixture loan(s) and ` +
      `${String(removed.holders)} holder row(s).`,
  )
  process.exit(0)
}

await deleteOwnRows(event.id)

let fixtureBadge = FIRST_FIXTURE_BADGE

/** A disposable loan with two sticks OUT, written directly. */
const seedLoan = async (label) => {
  const loanId = randomUUID()
  const pairCode = `${PAIR_PREFIX}${label}`
  const first = fixtureBadge++
  const second = fixtureBadge++

  await sql`
    insert into dandiya_loans (id, event_id, pair_code, issued_by_device_id)
    values (${loanId}, ${event.id}, ${pairCode}, ${device.id})`

  for (const [slot, badgeNumber] of [[1, first], [2, second]]) {
    await sql`
      insert into dandiya_loan_holders (id, loan_id, event_id, badge_number, slot)
      values (${randomUUID()}, ${loanId}, ${event.id}, ${badgeNumber}, ${slot})`
  }

  return { loanId, pairCode, badges: [first, second] }
}

const stateOf = async (loanId) => {
  const [loan] = await sql`
    select outcome, closed_at, pair_released_at from dandiya_loans where id = ${loanId}`
  const holders = await sql`
    select badge_number, resolution, resolved_at from dandiya_loan_holders
    where loan_id = ${loanId} order by slot`

  return {
    outcome: loan?.outcome ?? null,
    closed: loan?.closed_at !== null && loan?.closed_at !== undefined,
    released: loan?.pair_released_at !== null && loan?.pair_released_at !== undefined,
    resolutions: holders.map((holder) => holder.resolution),
    allResolved: holders.every((holder) => holder.resolved_at !== null),
  }
}

/**
 * THE INVARIANT THE MISSING LOCK BROKE: a loan with every stick resolved must
 * be closed. Asserted on every case, because it is the actual defect and not
 * a property of any one outcome.
 */
const coherent = (state) => !(state.allResolved && !state.closed)

const CASES = [
  {
    label: 'A. both sticks returned concurrently',
    resolutions: ['returned', 'returned'],
    outcome: 'returned',
    released: true,
  },
  {
    label: 'B. one returned, one lost, concurrently',
    resolutions: ['returned', 'lost'],
    outcome: 'partial_loss',
    released: false,
  },
  {
    label: 'C. both sticks lost concurrently',
    resolutions: ['lost', 'lost'],
    outcome: 'lost',
    released: false,
  },
]

for (const testCase of CASES) {
  for (let round = 1; round <= ROUNDS; round++) {
    const loan = await seedLoan(`${testCase.label[0]}${String(round)}`)

    // GENUINELY CONCURRENT: two separate transactions, issued together.
    const results = await Promise.all(
      loan.badges.map((badgeNumber, index) =>
        resolveDandiyaHolders({
          eventId: event.id,
          loanId: loan.loanId,
          badgeNumber,
          resolution: testCase.resolutions[index],
          resolvedByDeviceId: device.id,
        }),
      ),
    )

    const state = await stateOf(loan.loanId)

    expect(
      `${testCase.label} (round ${String(round)})`,
      {
        accepted: results.filter((result) => result.ok).length,
        resolutions: state.resolutions,
        outcome: state.outcome,
        closed: state.closed,
        released: state.released,
        coherent: coherent(state),
      },
      {
        accepted: 2,
        resolutions: testCase.resolutions,
        outcome: testCase.outcome,
        closed: true,
        released: testCase.released,
        coherent: true,
      },
    )
  }
}

/**
 * CASE D. The SAME stick, twice at once. Exactly one resolution may land, the
 * value is immutable, and the loan must not be left incoherent.
 */
for (let round = 1; round <= ROUNDS; round++) {
  const loan = await seedLoan(`D${String(round)}`)
  const [badgeNumber] = loan.badges

  const results = await Promise.all(
    ['returned', 'lost'].map((resolution) =>
      resolveDandiyaHolders({
        eventId: event.id,
        loanId: loan.loanId,
        badgeNumber,
        resolution,
        resolvedByDeviceId: device.id,
      }),
    ),
  )

  const state = await stateOf(loan.loanId)

  expect(
    `D. the same stick twice at once (round ${String(round)})`,
    {
      accepted: results.filter((result) => result.ok).length,
      refused: results
        .filter((result) => result.ok === false)
        .map((result) => result.conflict),
      first: state.resolutions[0],
      secondStillOut: state.resolutions[1] === null,
      // One stick is still out, so the loan must NOT be closed.
      closed: state.closed,
      coherent: coherent(state),
    },
    {
      accepted: 1,
      refused: ['holder-already-resolved'],
      first: state.resolutions[0],
      secondStillOut: true,
      closed: false,
      coherent: true,
    },
  )

  if (state.resolutions[0] !== 'returned' && state.resolutions[0] !== 'lost') {
    bad(
      `D. round ${String(round)}: the surviving resolution is not one of the two`,
      JSON.stringify(state.resolutions),
    )
  }
}

const removed = await deleteOwnRows(event.id)

console.log(
  `\nCleaned up ${String(removed.loans)} fixture loan(s) and ` +
    `${String(removed.holders)} holder row(s).`,
)
console.log(
  fails === 0
    ? 'ALL CONCURRENCY CHECKS PASS'
    : `${String(fails)} FAILURE(S) — the resolution writer is not serialized.`,
)
process.exit(fails === 0 ? 0 : 1)
