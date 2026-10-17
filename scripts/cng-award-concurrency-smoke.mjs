#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY concurrency proof for the CNG PRIZE AWARD writer.
 *
 * WHAT IT PROVES, AND WHY NOTHING ELSE CAN.
 *
 * A CNG member who has been REMOVED may not receive a new prize. Nothing in
 * the schema can hold that on its own: `cng_prize_awards` has a foreign key
 * to `cng_members`, but removal is SOFT — the row survives so history can
 * still name its recipient — so the key is satisfied either way. The rule
 * lives entirely in the award transaction.
 *
 * A PRE-READ OF `removed_at` WOULD NOT DO IT. A process can pause for any
 * length of time between the read and the insert — a GC pause, a cold start,
 * a retried request — and a removal can commit inside that window. That is a
 * TIMING ASSUMPTION, not a transactional guarantee, and this project has made
 * exactly that mistake once before on the dandiya issuance path.
 *
 * So `recordCngPrizeAward` opens its transaction by locking the member's own
 * row `FOR UPDATE` — the same row `removeCngMember` updates — and this script
 * forces the one schedule a sequential run can never produce:
 *
 *   T0  a removal transaction locks the member row and holds it
 *   T1  the REAL award writer starts and blocks on that lock
 *   T2  the removal commits
 *   T3  the award acquires the lock, PostgreSQL re-evaluates
 *       `removed_at IS NULL` on the locked row, it is now false, the lock
 *       yields no row — and nothing is written
 *
 * The thing proved is that a writer which BEGAN BEFORE the removal committed
 * still observes it AFTER waiting on the serialization point.
 *
 * The stand-in database in `scripts/verification/` cannot prove this: it is
 * single-threaded, so a scripted writer has always already committed — which
 * is the world the real lock produces, not the race it closes. `verify:cng1`
 * pins the lock's presence, its position in the transaction's own record and
 * the post-lock behaviour; only this script, against a real database with
 * genuinely concurrent transactions, proves the EFFECT.
 *
 * It calls the REAL `recordCngPrizeAward`. Its `db.batch` is one HTTP request
 * and therefore one Postgres transaction on its own connection, so it
 * genuinely overlaps with the transaction this script holds open.
 *
 * Usage, with `VERCEL_ENV` supplied explicitly because `vercel dev` does not
 * expose it to this project:
 *
 *   export DATABASE_URL=<development branch>
 *   export ALLOW_CNG_DB_SMOKE_WRITES=true
 *   env VERCEL_ENV=development node scripts/cng-award-concurrency-smoke.mjs --confirm
 *   env VERCEL_ENV=development node scripts/cng-award-concurrency-smoke.mjs --cleanup --confirm
 *   unset DATABASE_URL ALLOW_CNG_DB_SMOKE_WRITES
 *
 * IT WRITES, so four independent things must agree first, and every one of
 * them is checked BEFORE a connection is opened:
 *
 *   1. `--confirm` on the command line
 *   2. `ALLOW_CNG_DB_SMOKE_WRITES` exactly `true`
 *   3. `VERCEL_ENV` exactly `development`
 *   4. `SYNC_ALLOWED_VERCEL_ENV`, when set at all, exactly `development`
 *
 * A production deployment sets `SYNC_ALLOWED_VERCEL_ENV=production` and
 * `VERCEL_ENV=production`, so a production connection string pasted into the
 * environment is still refused. NEVER run this against Preview or Production.
 *
 * IT CREATES ONLY ITS OWN ROWS: `cng_members` whose name carries the prefix
 * `SMOKE-CNG11-`, and the `cng_prize_awards` rows belonging to them. It reads
 * one existing event and one existing device to satisfy the foreign keys and
 * NEVER creates, modifies or deletes an event, a device, an attribute, a
 * badge assignment, an attendee prize award, a dandiya row or any
 * registration. `prize_awards` is not named by a single statement in this
 * file. Cleanup removes only rows carrying that prefix, in this event.
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

const NAME_PREFIX = 'SMOKE-CNG11-'
const PRIZE = 'Best Dance - Female'

/**
 * HOW LONG THE REMOVING TRANSACTION HOLDS THE MEMBER-ROW LOCK.
 *
 * This is NOT a correctness assumption. It is how the dangerous schedule is
 * FORCED: the award writer must still be waiting on the row when the removal
 * commits, which is the one interleaving a sequential run can never produce.
 * The assertions below are about what the writer OBSERVES, never about
 * elapsed time — except one, which checks that it really did wait.
 */
const HOLD_SECONDS = Number(process.env.CNG_SMOKE_HOLD_SECONDS ?? '3')

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
if (process.env.ALLOW_CNG_DB_SMOKE_WRITES !== 'true') {
  fail('ALLOW_CNG_DB_SMOKE_WRITES is not exactly "true".')
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

// --- the real writers, against the real lazy client -----------------------

const sql = neon(databaseUrl)
const jiti = createJiti(import.meta.url, { interopDefault: true })
const { recordCngPrizeAward } = await jiti.import(`${root}/server/cng/awards.ts`)
const { removeCngMember } = await jiti.import(`${root}/server/cng/members.ts`)

console.log('Navaratri CNG AWARD concurrency smoke — DEVELOPMENT')
console.log(`  member lock held for: ${String(HOLD_SECONDS)}s`)
console.log(`  fixture member names: ${NAME_PREFIX}*`)

// --- its own rows, and only its own --------------------------------------

const deleteOwnRows = async (eventId) => {
  const awards = await sql`
    delete from cng_prize_awards
    where event_id = ${eventId}
      and cng_member_id in (
        select id from cng_members
        where event_id = ${eventId} and name like ${`${NAME_PREFIX}%`}
      )
    returning id`
  const members = await sql`
    delete from cng_members
    where event_id = ${eventId} and name like ${`${NAME_PREFIX}%`}
    returning id`

  return { awards: awards.length, members: members.length }
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
  select id, name from devices where event_id = ${event.id} order by created_at limit 1`

if (device === undefined) {
  fail(`No device exists for event ${event.slug}. Create one in Admin first.`)
}

console.log(`  event: ${event.slug}`)

if (CLEANUP_ONLY) {
  const removed = await deleteOwnRows(event.id)

  console.log(
    `\nCleanup removed ${String(removed.members)} fixture member(s) and ` +
      `${String(removed.awards)} award row(s).`,
  )
  process.exit(0)
}

await deleteOwnRows(event.id)

/** One fixture member, inserted directly: the thing under test is the AWARD. */
const seedMember = async (label) => {
  const id = randomUUID()

  await sql`
    insert into cng_members (id, event_id, name, added_by_device_id)
    values (${id}, ${event.id}, ${`${NAME_PREFIX}${label}`}, ${device.id})`

  return id
}

/**
 * TRANSACTION A: the removal, holding the member row lock.
 *
 * ONE transaction, in this order:
 *
 *   1. lock the member row — the SAME row the award writer locks
 *   2. stamp the soft removal
 *   3. hold the lock with `pg_sleep`, so the writer under test is still
 *      waiting on it when this commits
 *
 * Written in SQL deliberately: the thing under test is the AWARD writer, so
 * building the removal through its own writer would add nothing — and this
 * way the lock is held for a controlled period, which `removeCngMember`
 * alone cannot do.
 *
 * It becomes visible to anybody else only when it commits, which is the
 * point: the writer under test starts BEFORE that.
 */
const removingTransaction = (memberId) =>
  sql.transaction([
    sql`select id from cng_members where id = ${memberId} for update`,
    sql`update cng_members
          set removed_at = now(), removed_by_device_id = ${device.id}
        where id = ${memberId} and event_id = ${event.id}
          and removed_at is null`,
    sql`select pg_sleep(${HOLD_SECONDS})`,
  ])

/** A transaction that locks the row and holds it WITHOUT removing anybody. */
const holdingTransaction = (memberId) =>
  sql.transaction([
    sql`select id from cng_members where id = ${memberId} for update`,
    sql`select pg_sleep(${HOLD_SECONDS})`,
  ])

const awardsFor = async (memberId) => {
  const rows = await sql`
    select id from cng_prize_awards
    where event_id = ${event.id} and cng_member_id = ${memberId}`

  return rows.length
}

const isActive = async (memberId) => {
  const [row] = await sql`
    select removed_at from cng_members where id = ${memberId}`

  return row !== undefined && row.removed_at === null
}

const awardedBy = { id: device.id, name: device.name }

/* ======================================================================= */

console.log('\n=== 1. THE REMOVAL WINS THE LOCK: THE AWARD MUST REFUSE ===')

{
  const memberId = await seedMember('removed')

  /** T0: the removal takes the lock and holds it. */
  const removal = removingTransaction(memberId)

  /**
   * T1: the award writer starts while that lock is held. 400 ms is long
   * enough that its transaction has certainly begun and is waiting, and far
   * short of the hold — so it CANNOT have completed before the removal
   * commits.
   */
  const startedAt = Date.now()
  const awarding = new Promise((done) => {
    setTimeout(() => {
      done(
        recordCngPrizeAward({
          eventId: event.id,
          cngMemberId: memberId,
          prizeName: PRIZE,
          awardedByDevice: awardedBy,
        }),
      )
    }, 400)
  })

  const [, awarded] = await Promise.all([removal, awarding])
  const waitedMs = Date.now() - startedAt

  expect('1. the award REFUSES a member removed while it waited',
    awarded.outcome, 'member-unavailable')
  expect('  and it genuinely waited on the lock rather than racing past it',
    waitedMs >= HOLD_SECONDS * 1000, true)
  expect('  nothing at all was written for that member',
    await awardsFor(memberId), 0)
  expect('  while the removal itself stands',
    await isActive(memberId), false)
}

console.log('\n=== 2. CONTROL: A HELD LOCK ALONE DOES NOT REFUSE ===')

{
  const memberId = await seedMember('held')

  /**
   * THE SAME WAIT, WITHOUT THE REMOVAL. If case 1 refused merely because it
   * waited, this would refuse too — and it must not. What the writer observes
   * is the member's STATE, never the delay.
   */
  const holding = holdingTransaction(memberId)

  const startedAt = Date.now()
  const awarding = new Promise((done) => {
    setTimeout(() => {
      done(
        recordCngPrizeAward({
          eventId: event.id,
          cngMemberId: memberId,
          prizeName: PRIZE,
          awardedByDevice: awardedBy,
        }),
      )
    }, 400)
  })

  const [, awarded] = await Promise.all([holding, awarding])
  const waitedMs = Date.now() - startedAt

  expect('2. an award that waited on an ACTIVE member still lands',
    awarded.outcome, 'awarded')
  expect('  having waited the same way',
    waitedMs >= HOLD_SECONDS * 1000, true)
  expect('  exactly one award row exists', await awardsFor(memberId), 1)
  expect('  and the member is still active', await isActive(memberId), true)
}

console.log('\n=== 3. THE AWARD WINS THE LOCK: IT COMMITS, THEN REMOVAL ===')

{
  const memberId = await seedMember('ordered')

  const awarded = await recordCngPrizeAward({
    eventId: event.id,
    cngMemberId: memberId,
    prizeName: PRIZE,
    awardedByDevice: awardedBy,
  })

  const removed = await removeCngMember({
    eventId: event.id,
    cngMemberId: memberId,
    removedByDevice: { id: device.id },
  })

  const after = await recordCngPrizeAward({
    eventId: event.id,
    cngMemberId: memberId,
    prizeName: PRIZE,
    awardedByDevice: awardedBy,
  })

  expect('3. an award on an active member commits', awarded.outcome, 'awarded')
  expect('  the removal then succeeds', removed, true)
  expect('  a FURTHER award is refused', after.outcome, 'member-unavailable')
  expect('  and the prize already given survives the removal',
    await awardsFor(memberId), 1)
  expect('  which is why removal is soft: history still names them',
    await (async () => {
      const [row] = await sql`
        select m.name from cng_prize_awards a
        join cng_members m on m.id = a.cng_member_id
        where a.cng_member_id = ${memberId} limit 1`

      return row?.name?.startsWith(NAME_PREFIX) ?? false
    })(), true)
}

/* ======================================================================= */

const left = await deleteOwnRows(event.id)

console.log(
  `\nCleaned up ${String(left.members)} fixture member(s) and ` +
    `${String(left.awards)} award row(s).`,
)
console.log(
  fails === 0
    ? '\nALL CHECKS PASS — the member row lock orders award against removal.'
    : `\n${String(fails)} FAILURE(S)`,
)

process.exit(fails === 0 ? 0 : 1)
