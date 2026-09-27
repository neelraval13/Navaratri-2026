#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY behavioural database smoke test.
 *
 * `db:check` proves the constraints EXIST. This proves they actually REJECT
 * bad writes — an exclusion constraint with the right name but the wrong
 * predicate would pass the first and fail this one.
 *
 * It WRITES to the database, so it is gated behind a second explicit
 * acknowledgement and must only ever be pointed at a disposable Development
 * branch. NEVER run it against Production.
 *
 * Usage:
 *   export DATABASE_URL=<development branch>
 *   export ALLOW_DB_SMOKE_WRITES=true
 *   pnpm db:smoke
 *   unset DATABASE_URL ALLOW_DB_SMOKE_WRITES
 */
import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'

// --- safety interlocks, both BEFORE any connection or write ----------------

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl === undefined || databaseUrl === '') {
  // The value is a credential and is never printed.
  console.error('DATABASE_URL is not set. Set it for this environment and try again.')
  process.exit(1)
}

/**
 * Exactly `true`. No trimming, no case folding. A connection string alone
 * never implies consent to write — this second switch is what distinguishes a
 * disposable branch from Production, and only a human can set it.
 */
if (process.env.ALLOW_DB_SMOKE_WRITES !== 'true') {
  console.error(
    'Refusing to run: this test WRITES to the database.\n' +
      'Set ALLOW_DB_SMOKE_WRITES=true (exactly) and point DATABASE_URL at a\n' +
      'disposable Development branch. Never run this against Production.',
  )
  process.exit(1)
}

// --- reporting --------------------------------------------------------------

/** Belt and braces: nothing resembling a connection string ever reaches stdout. */
const CREDENTIAL_PATTERN = new RegExp(`postgres(ql)?${':'}//[^\\s]*@`, 'gi')
const redact = (value) => String(value ?? '').replace(CREDENTIAL_PATTERN, '[redacted]')

let fails = 0
const pass = (label, detail = '') => {
  console.log(`ok   ${label.padEnd(56)} ${detail}`)
}
const fail = (label, detail) => {
  fails++
  console.log(`FAIL ${label}\n     ${redact(detail)}`)
}

const errorCode = (error) => error?.code ?? error?.sourceError?.code ?? null
const errorConstraint = (error) =>
  error?.constraint ?? error?.sourceError?.constraint ?? null

/**
 * An expected rejection is a PASS. It must be the RIGHT rejection: the wrong
 * constraint firing would hide the fact that the intended one is missing.
 */
const expectRejection = async (label, run, expected) => {
  try {
    await run()
    fail(label, 'the write was ACCEPTED — the database did not reject it')

    return false
  } catch (error) {
    const code = errorCode(error)
    const constraint = errorConstraint(error)
    const message = redact(error?.message)
    const named = constraint === expected.constraint || message.includes(expected.constraint)

    if (named && code === expected.code) {
      pass(label, `rejected by ${expected.constraint} (${code})`)

      return true
    }

    if (named) {
      pass(label, `rejected by ${expected.constraint} (SQLSTATE ${String(code)})`)

      return true
    }

    fail(label, `rejected, but by something else: ${String(code)} ${String(constraint)} — ${message}`)

    return false
  }
}

const expectSuccess = async (label, run) => {
  try {
    await run()
    pass(label)

    return true
  } catch (error) {
    fail(label, `${String(errorCode(error))} ${String(errorConstraint(error))} — ${redact(error?.message)}`)

    return false
  }
}

// --- disposable identifiers, unique per run --------------------------------

const sql = neon(databaseUrl)

/** Every id is generated up front so cleanup can target exact rows even when
 *  an expected rejection unexpectedly succeeded and left one behind. */
const run = randomUUID().slice(0, 8)
const tag = `zz-smoke-${run}`

const eventA = randomUUID()
const eventB = randomUUID()
const deviceA = randomUUID()
const deviceB = randomUUID()
const deviceC = randomUUID()

const eventIds = [eventA, eventB]
const deviceIds = [deviceA, deviceB, deviceC]
/** Includes ids for writes that SHOULD be rejected, so cleanup covers them. */
const assignmentIds = {
  aFirst: randomUUID(),
  bOverlap: randomUUID(),
  bValid: randomUUID(),
  aSecondActive: randomUUID(),
  crossEvent: randomUUID(),
  aAfterRelease: randomUUID(),
}
const allAssignmentIds = Object.values(assignmentIds)

const insertEvent = (id, suffix) => sql`
  INSERT INTO events (id, slug, name, timezone)
  VALUES (${id}, ${`${tag}-${suffix}`}, ${`ZZ SMOKE ${run} Event ${suffix.toUpperCase()}`}, 'Asia/Kolkata')
`
const insertDevice = (id, eventId, suffix) => sql`
  INSERT INTO devices (id, event_id, name)
  VALUES (${id}, ${eventId}, ${`ZZ SMOKE ${run} Device ${suffix.toUpperCase()}`})
`
const insertAssignment = (id, eventId, deviceId, start, end) => sql`
  INSERT INTO badge_assignments (id, event_id, device_id, range_start, range_end)
  VALUES (${id}, ${eventId}, ${deviceId}, ${start}, ${end})
`

console.log(`Development constraint smoke test — run ${run}\n`)

try {
  console.log('--- 1-2. FIXTURES ---')
  await expectSuccess('create Event A and Event B', async () => {
    await insertEvent(eventA, 'a')
    await insertEvent(eventB, 'b')
  })
  await expectSuccess('create Device A/B (Event A) and Device C (Event B)', async () => {
    await insertDevice(deviceA, eventA, 'a')
    await insertDevice(deviceB, eventA, 'b')
    await insertDevice(deviceC, eventB, 'c')
  })

  console.log('\n--- 3-7. THE GUARANTEES ---')
  await expectSuccess('Device A / Event A / #001-#200 is accepted', () =>
    insertAssignment(assignmentIds.aFirst, eventA, deviceA, 1, 200),
  )

  await expectRejection(
    'OVERLAP in the same event (#150-#300) is rejected',
    () => insertAssignment(assignmentIds.bOverlap, eventA, deviceB, 150, 300),
    { constraint: 'badge_assignments_active_ranges_no_overlap', code: '23P01' },
  )

  await expectSuccess('adjacent non-overlapping #201-#300 is accepted', () =>
    insertAssignment(assignmentIds.bValid, eventA, deviceB, 201, 300),
  )

  await expectRejection(
    'a SECOND active range for Device A is rejected',
    () => insertAssignment(assignmentIds.aSecondActive, eventA, deviceA, 301, 400),
    { constraint: 'badge_assignments_one_active_per_device', code: '23505' },
  )

  await expectRejection(
    'a device from Event B claimed under Event A is rejected',
    () => insertAssignment(assignmentIds.crossEvent, eventA, deviceC, 501, 600),
    { constraint: 'badge_assignments_device_event_fk', code: '23503' },
  )

  console.log('\n--- 8-10. RELEASE AND REASSIGNMENT ---')
  await expectSuccess("release Device A's assignment", async () => {
    const updated = await sql`
      UPDATE badge_assignments SET released_at = now()
      WHERE id = ${assignmentIds.aFirst} AND released_at IS NULL
      RETURNING id
    `
    if (updated.length !== 1) {
      throw new Error('the assignment was not released')
    }
  })

  await expectSuccess('after release, Device A takes a new active range', () =>
    insertAssignment(assignmentIds.aAfterRelease, eventA, deviceA, 301, 400),
  )

  const history = await sql`
    SELECT released_at IS NOT NULL AS released FROM badge_assignments
    WHERE id = ${assignmentIds.aFirst}
  `
  if (history.length === 1 && history[0].released === true) {
    pass('released history is retained, not deleted')
  } else {
    fail('released history is retained, not deleted', 'the released row is missing')
  }

  const active = await sql`
    SELECT count(*)::int AS n FROM badge_assignments
    WHERE event_id = ${eventA} AND released_at IS NULL
  `
  if (active[0].n === 2) {
    pass('exactly two active ranges remain in Event A', '#201-#300 and #301-#400')
  } else {
    fail('exactly two active ranges remain in Event A', `found ${String(active[0].n)}`)
  }
} catch (error) {
  fail('unexpected failure', `${String(errorCode(error))} — ${redact(error?.message)}`)
} finally {
  console.log('\n--- CLEANUP ---')

  /**
   * Only ids this run generated, in dependency order. Never a name pattern,
   * never a TRUNCATE, and never a row that existed beforehand. The rejected
   * writes are included because one of them may unexpectedly have landed.
   */
  const remove = async (label, statement) => {
    try {
      await statement()
    } catch (error) {
      fail(`cleanup: ${label}`, redact(error?.message))
    }
  }

  await remove('badge assignments', () =>
    sql`DELETE FROM badge_assignments WHERE id = ANY(${allAssignmentIds}::uuid[])`)
  await remove('device attributes', () =>
    sql`DELETE FROM device_attributes WHERE device_id = ANY(${deviceIds}::uuid[])`)
  await remove('devices', () =>
    sql`DELETE FROM devices WHERE id = ANY(${deviceIds}::uuid[])`)
  await remove('events', () =>
    sql`DELETE FROM events WHERE id = ANY(${eventIds}::uuid[])`)

  try {
    const [left] = await sql`
      SELECT
        (SELECT count(*) FROM badge_assignments WHERE id = ANY(${allAssignmentIds}::uuid[]))::int AS assignments,
        (SELECT count(*) FROM device_attributes WHERE device_id = ANY(${deviceIds}::uuid[]))::int AS attributes,
        (SELECT count(*) FROM devices WHERE id = ANY(${deviceIds}::uuid[]))::int AS devices,
        (SELECT count(*) FROM events WHERE id = ANY(${eventIds}::uuid[]))::int AS events
    `
    const total = left.assignments + left.attributes + left.devices + left.events

    if (total === 0) {
      pass('every row from this run has been removed')
    } else {
      fail(
        'every row from this run has been removed',
        `left behind — assignments ${String(left.assignments)}, attributes ${String(left.attributes)}, devices ${String(left.devices)}, events ${String(left.events)} (run ${run})`,
      )
    }
  } catch (error) {
    fail('cleanup verification', redact(error?.message))
  }
}

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${String(fails)} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
