#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY concurrency proof for the dandiya ISSUANCE writer.
 *
 * WHAT IT PROVES, AND WHY NOTHING ELSE CAN.
 *
 * A pair issued on ONE badge is issued ON THAT BADGE, so until that loan
 * closes the badge takes part in NO new loan. No unique index can hold that:
 * the offending badge is a HOLDER row of the new loan while the anchor is the
 * LOAN row of the old one, and an index compares columns of one row of one
 * table.
 *
 * THE DANGEROUS STATE is a loan that is still OPEN, anchored on a badge whose
 * OWN stick is already resolved, with only the guest's stick still out:
 *
 *   dandiya_loans.accountability_badge_number = #B   closed_at IS NULL
 *   holder #B                                        resolved
 *   holder NULL (the guest)                          unresolved
 *
 * In that state `UNIQUE(event_id, badge_number) WHERE resolved_at IS NULL`
 * does NOT protect anything — #B holds no unresolved stick — so the rule
 * rests entirely on the issuance transaction: it opens by locking the event
 * row, and its loan insert carries the anchor check as its own `WHERE`.
 *
 * AN EARLIER REVISION READ THE ANCHORS FIRST and decided in application code.
 * That is a TOCTOU hole: a process can pause for any length of time between
 * the read and the write, and in that window the dangerous state above can
 * come into existence. This script reproduces exactly that schedule, and the
 * thing it proves is that a writer which BEGAN BEFORE the anchor committed
 * still observes it AFTER waiting on the serialization point.
 *
 * The stand-in database in `scripts/verification/` cannot: it is
 * single-threaded, so a scripted writer has always already committed.
 * `verify:d3` pins the statement ORDER and the structure; only this script,
 * against a real database with genuinely concurrent transactions, proves the
 * EFFECT.
 *
 * It calls the REAL `openDandiyaLoan`. Its `db.batch` is one HTTP request and
 * therefore one Postgres transaction on its own connection, so it genuinely
 * overlaps with the transaction this script holds open.
 *
 * Usage, with `VERCEL_ENV` supplied explicitly because `vercel dev` does not
 * expose it to this project:
 *
 *   export DATABASE_URL=<development branch>
 *   export ALLOW_DANDIYA_DB_SMOKE_WRITES=true
 *   env VERCEL_ENV=development node scripts/dandiya-issuance-concurrency-smoke.mjs --confirm
 *   env VERCEL_ENV=development node scripts/dandiya-issuance-concurrency-smoke.mjs --cleanup --confirm
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
 * under pair codes prefixed `SMOKE-D33B-`, with badge fixtures from #9951 up,
 * clear of the prize fixtures at #9001-#9030 and of the resolution smoke's at
 * #9901. It reads one existing event and one existing device to satisfy the
 * foreign keys and NEVER creates, modifies or deletes an event, a device, an
 * attribute, a badge assignment, a prize award or any registration. Cleanup
 * removes only rows whose pair code carries that prefix, in this event.
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

const PAIR_PREFIX = 'SMOKE-D33B-'
const FIRST_FIXTURE_BADGE = 9951
/**
 * HOW LONG THE ANCHORING TRANSACTION HOLDS THE EVENT LOCK.
 *
 * This is NOT a correctness assumption. It is how the dangerous schedule is
 * FORCED: the writer must still be waiting on the event row when the anchor
 * commits, which is the one interleaving a sequential run can never produce.
 * The assertions below are about what the writer OBSERVES, never about
 * elapsed time — except one, which checks that it really did wait.
 */
const HOLD_SECONDS = Number(process.env.DANDIYA_SMOKE_HOLD_SECONDS ?? '3')

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
const { openDandiyaLoan } = await jiti.import(`${root}/server/dandiya/loans.ts`)

console.log('Navaratri dandiya ISSUANCE concurrency smoke — DEVELOPMENT')
console.log(`  event lock held for: ${String(HOLD_SECONDS)}s`)
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
const nextBadge = () => fixtureBadge++

/**
 * TRANSACTION A: the anchoring writer, holding the event lock.
 *
 * ONE transaction, in this order:
 *
 *   1. lock the event row — the same row the issuance writer locks
 *   2. insert a MIXED loan anchored on `anchorBadge`
 *   3. insert its two holders — the badge, and a guest with NULL
 *   4. resolve the BADGE holder, leaving the guest's stick out
 *   5. hold the lock with `pg_sleep`, so the writer under test is still
 *      waiting on it when this commits
 *
 * Step 4 is what makes the state dangerous: after it, the holder index has
 * nothing to say about `anchorBadge`. Steps 2-4 are fixture construction
 * written in SQL deliberately — the thing under test is the ISSUANCE writer,
 * so building the state through it would prove nothing about the state.
 *
 * The whole thing becomes visible to anybody else only when it commits, which
 * is the point: the writer under test starts BEFORE that.
 */
const anchoringTransaction = (anchorBadge, label) => {
  const loanId = randomUUID()
  const pairCode = `${PAIR_PREFIX}${label}`
  const resolvedAt = new Date().toISOString()

  return {
    loanId,
    pairCode,
    anchorBadge,
    run: sql.transaction([
      sql`select id from events where id = ${event.id} for update`,
      sql`insert into dandiya_loans
            (id, event_id, pair_code, issued_by_device_id, accountability_badge_number)
          values (${loanId}, ${event.id}, ${pairCode}, ${device.id}, ${anchorBadge})`,
      sql`insert into dandiya_loan_holders (id, loan_id, event_id, badge_number, slot)
          values (${randomUUID()}, ${loanId}, ${event.id}, ${anchorBadge}, 1)`,
      sql`insert into dandiya_loan_holders (id, loan_id, event_id, badge_number, slot)
          values (${randomUUID()}, ${loanId}, ${event.id}, null, 2)`,
      /** THE BADGE HOLDER'S OWN STICK COMES BACK. The guest's stays out. */
      sql`update dandiya_loan_holders
             set resolution = 'returned',
                 resolved_at = ${resolvedAt},
                 resolved_by_device_id = ${device.id}
           where loan_id = ${loanId} and badge_number = ${anchorBadge}`,
      sql`select pg_sleep(${HOLD_SECONDS})`,
    ]),
  }
}

const loansFor = async (pairCode) => {
  const rows = await sql`
    select id from dandiya_loans where event_id = ${event.id} and pair_code = ${pairCode}`

  return rows.length
}

const holdersFor = async (pairCode) => {
  const rows = await sql`
    select h.id from dandiya_loan_holders h
      join dandiya_loans l on l.id = h.loan_id
     where l.event_id = ${event.id} and l.pair_code = ${pairCode}`

  return rows.length
}

const sleep = (ms) => new Promise((done) => {
  setTimeout(done, ms)
})

/**
 * THE SCHEDULE, run once per case.
 *
 * Transaction A is started and NOT awaited. A short pause lets it take the
 * event lock, then the REAL issuance writer is started for `badges`. It must
 * block on that same row. Both are then awaited together.
 */
const race = async ({ label, anchorBadge, badges, newPair }) => {
  const anchoring = anchoringTransaction(anchorBadge, label)
  const running = anchoring.run

  /** Long enough for A to have taken the lock, short enough to be inside it. */
  await sleep(400)

  const startedAt = Date.now()
  const issued = await (async () => {
    try {
      return await openDandiyaLoan({
        eventId: event.id,
        pairCode: `${PAIR_PREFIX}${newPair}`,
        issuance: { mode: 'two-badges', badgeNumbers: badges },
        issuedByDeviceId: device.id,
      })
    } catch (error) {
      return { ok: false, threw: redact(error?.message ?? error) }
    }
  })()
  const waitedMs = Date.now() - startedAt

  await running

  return { issued, waitedMs, anchoring }
}

console.log('\n=== THE STALE-READ SCHEDULE ===')

/**
 * CASE 1 — THE HEADLINE. The writer starts while the anchor is still
 * uncommitted, so no read it could possibly make beforehand would see it. It
 * must wait on the event row, observe the anchor once A commits, and refuse.
 */
{
  const anchorBadge = nextBadge()
  const partner = nextBadge()
  const { issued, waitedMs, anchoring } = await race({
    label: 'CASE1-ANCHOR',
    anchorBadge,
    badges: [anchorBadge, partner],
    newPair: 'CASE1-NEW',
  })

  expect(
    '1. a writer that began BEFORE the anchor committed still refuses',
    [issued.ok, issued.conflict ?? null],
    [false, 'accountability-already-holding-pair'],
  )
  expect(
    '  and it really did wait on the event row',
    waitedMs >= (HOLD_SECONDS - 1) * 1000,
    true,
  )
  expect(
    '  and NOTHING was written: no loan, no holder rows',
    [await loansFor(`${PAIR_PREFIX}CASE1-NEW`), await holdersFor(`${PAIR_PREFIX}CASE1-NEW`)],
    [0, 0],
  )
  /** The dangerous state really was dangerous: the holder index was free. */
  const [unresolved] = await sql`
    select count(*)::int as count from dandiya_loan_holders
     where event_id = ${event.id} and badge_number = ${anchorBadge}
       and resolved_at is null`

  expect(
    '  and the holder index had NOTHING to catch it with',
    unresolved?.count ?? -1,
    0,
  )
  expect(
    '  while the anchoring loan is open and anchored on that badge',
    await (async () => {
      const [loan] = await sql`
        select accountability_badge_number as anchor, closed_at
          from dandiya_loans where id = ${anchoring.loanId}`

      return [loan?.anchor ?? null, loan?.closed_at === null]
    })(),
    [anchorBadge, true],
  )
}

/**
 * CASE 2 — THE CONTROL. Identical schedule, but the anchor is a DIFFERENT
 * badge. The writer must still wait on the event row and then SUCCEED, so
 * case 1's refusal is the rule firing rather than the lock refusing
 * everything.
 */
{
  const anchorBadge = nextBadge()
  const first = nextBadge()
  const second = nextBadge()
  const { issued, waitedMs } = await race({
    label: 'CASE2-ANCHOR',
    anchorBadge,
    badges: [first, second],
    newPair: 'CASE2-NEW',
  })

  expect(
    '2. an unrelated anchor does not refuse the pair',
    [issued.ok, issued.conflict ?? null],
    [true, null],
  )
  expect('  and it waited on the same event row', waitedMs >= (HOLD_SECONDS - 1) * 1000, true)
  expect(
    '  and the loan and both holders were written',
    [await loansFor(`${PAIR_PREFIX}CASE2-NEW`), await holdersFor(`${PAIR_PREFIX}CASE2-NEW`)],
    [1, 2],
  )
}

/**
 * CASE 3 — AND THE ANCHOR IS RELEASED BY THE CLOSE. The same badge, but the
 * anchoring loan is closed before the writer runs, so the rule must let it
 * through. Partial on `closed_at` is what makes a historical anchoring stop
 * blocking anybody.
 */
{
  const anchorBadge = nextBadge()
  const partner = nextBadge()
  const anchoring = anchoringTransaction(anchorBadge, 'CASE3-ANCHOR')

  await anchoring.run
  /** Close it the way a loss does: closed, with the pair still quarantined. */
  await sql`
    update dandiya_loan_holders
       set resolution = 'lost', resolved_at = now(), resolved_by_device_id = ${device.id}
     where loan_id = ${anchoring.loanId} and resolved_at is null`
  await sql`
    update dandiya_loans
       set closed_at = now(), closed_by_device_id = ${device.id}, outcome = 'partial_loss'
     where id = ${anchoring.loanId}`

  const issued = await openDandiyaLoan({
    eventId: event.id,
    pairCode: `${PAIR_PREFIX}CASE3-NEW`,
    issuance: { mode: 'two-badges', badgeNumbers: [anchorBadge, partner] },
    issuedByDeviceId: device.id,
  })

  expect(
    '3. a CLOSED anchoring loan no longer blocks that badge',
    [issued.ok, issued.conflict ?? null],
    [true, null],
  )
}

// --- cleanup --------------------------------------------------------------

const removed = await deleteOwnRows(event.id)

console.log(
  `\nRemoved ${String(removed.loans)} fixture loan(s) and ` +
    `${String(removed.holders)} holder row(s).`,
)
console.log(
  fails === 0
    ? 'ISSUANCE SERIALIZATION HOLDS AGAINST A REAL DATABASE'
    : `${String(fails)} FAILURE(S)`,
)
process.exit(fails === 0 ? 0 : 1)
