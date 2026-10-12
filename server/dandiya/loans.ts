import { randomUUID } from 'node:crypto'

import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { getDatabase } from '../db/client.js'
import { dandiyaLoanHolders, dandiyaLoans, devices, events } from '../db/schema.js'
import {
  mapDandiyaViolation,
  PUBLIC_DANDIYA_CONFLICT,
  type DandiyaViolation,
} from './conflicts.js'
import type { DandiyaIssuance } from './requests.js'
import type {
  DandiyaConflict,
  DandiyaHolderResolution,
} from '../../src/shared/dandiya-contract.js'

/**
 * The ONLY module that reads or writes `dandiya_loans` and
 * `dandiya_loan_holders`.
 *
 * One writer, deliberately, for the same reason badge assignments and prize
 * awards have one: everything that is true about how a loan opens, how a
 * stick resolves and how a loan closes is true in exactly one place. A second
 * writer is a second place for somebody to decide they know better than the
 * two partial unique indexes.
 *
 * It stores the OPERATIONAL LEDGER and nothing else — event, pair code, two
 * badge numbers, two slots, devices and timestamps. No attendee name, phone,
 * age, gender, WhatsApp link or payment detail is written here or could be:
 * the tables have no column for any.
 *
 * It holds no HTTP or authorization concern. Who may issue a pair is the
 * endpoint's question, answered against a live device session before this is
 * reached.
 */

/** A loan exactly as Postgres holds it, with its two holders. */
export interface DandiyaLoanRow {
  id: string
  pairCode: string
  /** ISO 8601 UTC. */
  issuedAt: string
  issuedByDeviceId: string
  closedAt: string | null
  closedByDeviceId: string | null
  outcome: string | null
  pairReleasedAt: string | null
  /** Ten digits, and only for a fully badgeless loan. */
  contactPhone: string | null
  /**
   * THE BADGE ACCOUNTABLE FOR THE WHOLE LOAN, and only for a MIXED one — one
   * badge and one guest. `null` for two badges and for two guests.
   */
  accountabilityBadgeNumber: number | null
  holders: {
    /** `null` is a guest with no badge. Never a synthetic number. */
    badgeNumber: number | null
    slot: number
    resolution: string | null
    resolvedAt: string | null
    resolvedByDeviceId: string | null
  }[]
}

/** Device ids to names, for display. A device, never a person. */
export type DandiyaDeviceNames = Map<string, string>

export interface DandiyaLedger {
  loans: DandiyaLoanRow[]
  deviceNames: DandiyaDeviceNames
}

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString()

/**
 * THE HALF-OPEN INSTANT WINDOW of the day whose history is wanted.
 *
 * A pair of TIMESTAMPS, computed from an event-local day key before this
 * module is reached. Deliberately not a date string and deliberately not a
 * day key: this file compares `issued_at` against two instants and never
 * interprets a calendar, so the database session's timezone cannot decide
 * which day a loan belongs to.
 */
export interface DandiyaHistoryWindow {
  start: Date
  /** Exclusive. `23:59:59.999` is a value, not a boundary. */
  end: Date
}

/**
 * THE LEDGER THIS DESK NEEDS, as three small reads composed in memory.
 *
 * Deliberately not one query. A loan has TWO holders and may name THREE
 * devices — the issuer, the closer and each holder's resolver — so a single
 * statement would need a one-to-many join and the same table joined several
 * times, and the result would have to be regrouped in code anyway. Three flat
 * reads of an event's own rows are simpler to read, simpler to stand in for,
 * and cheaper to reason about.
 *
 * IT IS NOT THE WHOLE HISTORY. Five disjunctions, one per thing the board
 * owes the desk, and not one more:
 *
 *   closed_at IS NULL            every open loan — Active, and the carryover
 *   pair_released_at IS NULL     every quarantined pair — Issues
 *   issued_at IN selected day    the day the operator chose — History
 *   issued_at IN today           `today.issued`
 *   closed_at IN today           `today.fullyReturned` and the two losses
 *
 * The first two are bounded by the event's physical stock rather than by its
 * length: a pair is either out, missing a stick, or back in the box. The last
 * three are bounded by a day each.
 *
 * TODAY IS ALWAYS READ, even when the operator is looking at an earlier day,
 * because the counters above the tabs are about tonight either way — and a
 * pair issued AND cleanly returned today is neither open, nor quarantined,
 * nor in the selected day's window, so scoping to the selected day alone
 * would have quietly stopped counting it.
 *
 * An event that ran for a week would otherwise send every loan it ever made
 * to a tablet in order to render one day.
 *
 * `issued_at` IS COMPARED TO TIMESTAMPS, never through `DATE(issued_at)`,
 * which would be evaluated in the session's timezone and would group the
 * ninety minutes either side of IST midnight into the wrong day — the exact
 * window a late dandiya evening lives in.
 *
 * The device NAME is read fresh rather than copied into the ledger, so a
 * renamed desk does not leave history naming a desk that no longer exists.
 *
 * ORDERING IS APPLIED BY THE COMPOSER, not here, because it is part of the
 * response CONTRACT — which keeps the contract testable without a database
 * that implements ORDER BY.
 */
export const readDandiyaLedger = async (input: {
  eventId: string
  history: DandiyaHistoryWindow
  today: DandiyaHistoryWindow
}): Promise<DandiyaLedger> => {
  const database = getDatabase()
  const { eventId, history, today } = input

  const loanRows = await database
    .select({
      id: dandiyaLoans.id,
      pairCode: dandiyaLoans.pairCode,
      issuedAt: dandiyaLoans.issuedAt,
      issuedByDeviceId: dandiyaLoans.issuedByDeviceId,
      closedAt: dandiyaLoans.closedAt,
      closedByDeviceId: dandiyaLoans.closedByDeviceId,
      outcome: dandiyaLoans.outcome,
      pairReleasedAt: dandiyaLoans.pairReleasedAt,
      contactPhone: dandiyaLoans.contactPhone,
      accountabilityBadgeNumber: dandiyaLoans.accountabilityBadgeNumber,
    })
    .from(dandiyaLoans)
    .where(
      and(
        eq(dandiyaLoans.eventId, eventId),
        or(
          isNull(dandiyaLoans.closedAt),
          isNull(dandiyaLoans.pairReleasedAt),
          and(
            gte(dandiyaLoans.issuedAt, history.start),
            lt(dandiyaLoans.issuedAt, history.end),
          ),
          and(
            gte(dandiyaLoans.issuedAt, today.start),
            lt(dandiyaLoans.issuedAt, today.end),
          ),
          and(
            gte(dandiyaLoans.closedAt, today.start),
            lt(dandiyaLoans.closedAt, today.end),
          ),
        ),
      ),
    )

  const loanIds = loanRows.map((row) => row.id)

  /**
   * HOLDERS FOR THOSE LOANS ONLY. Scoped by loan id as well as by event, so
   * the holder read grows with what was asked for rather than with the
   * event's whole past. An empty set skips the query outright: `IN ()` is a
   * round trip to be told nothing.
   */
  const holderRows =
    loanIds.length === 0
      ? []
      : await database
          .select({
            loanId: dandiyaLoanHolders.loanId,
            badgeNumber: dandiyaLoanHolders.badgeNumber,
            slot: dandiyaLoanHolders.slot,
            resolution: dandiyaLoanHolders.resolution,
            resolvedAt: dandiyaLoanHolders.resolvedAt,
            resolvedByDeviceId: dandiyaLoanHolders.resolvedByDeviceId,
          })
          .from(dandiyaLoanHolders)
          .where(
            and(
              eq(dandiyaLoanHolders.eventId, eventId),
              inArray(dandiyaLoanHolders.loanId, loanIds),
            ),
          )

  const deviceRows = await database
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(eq(devices.eventId, eventId))

  const holdersByLoan = new Map<string, DandiyaLoanRow['holders']>()

  for (const row of holderRows) {
    const existing = holdersByLoan.get(row.loanId) ?? []

    existing.push({
      badgeNumber: row.badgeNumber,
      slot: row.slot,
      resolution: row.resolution,
      resolvedAt: iso(row.resolvedAt),
      resolvedByDeviceId: row.resolvedByDeviceId,
    })
    holdersByLoan.set(row.loanId, existing)
  }

  return {
    loans: loanRows.map((row) => ({
      id: row.id,
      pairCode: row.pairCode,
      issuedAt: row.issuedAt.toISOString(),
      issuedByDeviceId: row.issuedByDeviceId,
      closedAt: iso(row.closedAt),
      closedByDeviceId: row.closedByDeviceId,
      outcome: row.outcome,
      pairReleasedAt: iso(row.pairReleasedAt),
      contactPhone: row.contactPhone,
      accountabilityBadgeNumber: row.accountabilityBadgeNumber,
      // Slot order, so holder 1 is always the first stick.
      holders: (holdersByLoan.get(row.id) ?? []).sort((left, right) => left.slot - right.slot),
    })),
    deviceNames: new Map(deviceRows.map((row) => [row.id, row.name])),
  }
}

/**
 * ONE LOAN, BY ID, WITH ITS HOLDERS — or `null`.
 *
 * For the resolution endpoint, which needs to tell "no such loan on this
 * event" from "that badge is not one of its holders" from "somebody resolved
 * it first". Reading the whole ledger to find one row would also mean the
 * resolution path had to care which DAY the operator was looking at, and a
 * mutation has no business consulting a calendar.
 *
 * IT DECIDES NOTHING. Every authority on the resolution path is a
 * compare-and-set behind the loan's own row lock; this is for the message.
 */
export const readDandiyaLoan = async (input: {
  eventId: string
  loanId: string
}): Promise<DandiyaLoanRow | null> => {
  const database = getDatabase()

  const [loan] = await database
    .select({
      id: dandiyaLoans.id,
      pairCode: dandiyaLoans.pairCode,
      issuedAt: dandiyaLoans.issuedAt,
      issuedByDeviceId: dandiyaLoans.issuedByDeviceId,
      closedAt: dandiyaLoans.closedAt,
      closedByDeviceId: dandiyaLoans.closedByDeviceId,
      outcome: dandiyaLoans.outcome,
      pairReleasedAt: dandiyaLoans.pairReleasedAt,
      contactPhone: dandiyaLoans.contactPhone,
      accountabilityBadgeNumber: dandiyaLoans.accountabilityBadgeNumber,
    })
    .from(dandiyaLoans)
    .where(
      and(eq(dandiyaLoans.id, input.loanId), eq(dandiyaLoans.eventId, input.eventId)),
    )

  if (loan === undefined) {
    return null
  }

  const holders = await database
    .select({
      badgeNumber: dandiyaLoanHolders.badgeNumber,
      slot: dandiyaLoanHolders.slot,
      resolution: dandiyaLoanHolders.resolution,
      resolvedAt: dandiyaLoanHolders.resolvedAt,
      resolvedByDeviceId: dandiyaLoanHolders.resolvedByDeviceId,
    })
    .from(dandiyaLoanHolders)
    .where(
      and(
        eq(dandiyaLoanHolders.loanId, input.loanId),
        eq(dandiyaLoanHolders.eventId, input.eventId),
      ),
    )

  return {
    id: loan.id,
    pairCode: loan.pairCode,
    issuedAt: loan.issuedAt.toISOString(),
    issuedByDeviceId: loan.issuedByDeviceId,
    closedAt: iso(loan.closedAt),
    closedByDeviceId: loan.closedByDeviceId,
    outcome: loan.outcome,
    pairReleasedAt: iso(loan.pairReleasedAt),
    contactPhone: loan.contactPhone,
    accountabilityBadgeNumber: loan.accountabilityBadgeNumber,
    holders: holders
      .map((holder) => ({
        badgeNumber: holder.badgeNumber,
        slot: holder.slot,
        resolution: holder.resolution,
        resolvedAt: iso(holder.resolvedAt),
        resolvedByDeviceId: holder.resolvedByDeviceId,
      }))
      .sort((left, right) => left.slot - right.slot),
  }
}

/**
 * THE ONE PLACE A MODE BECOMES COLUMNS, and the only reason the four
 * impossible loans cannot be written.
 *
 *   two badges          [a, b]            anchor NULL      contact NULL
 *   one badge + guest   [a, null] or      anchor THAT a    contact NULL
 *                       [null, a]
 *   two guests          [null, null]      anchor NULL      contact the number
 *
 * TOTAL over the union, so a fourth mode fails to compile rather than
 * defaulting to something. Deliberately NOT exported: `openDandiyaLoan` takes
 * the MODE, so there is no call site that could assemble these three columns
 * itself and anchor a mixed loan to a badge that is not on it, leave one
 * unanchored, put a number beside a badge, or open a badgeless loan with no
 * contact. The database's exclusivity CHECK is the floor underneath this; the
 * relationship to the holder rows is here, because a CHECK cannot read
 * another table.
 */
const issuanceColumns = (
  issuance: DandiyaIssuance,
): {
  badgeNumbers: readonly [number | null, number | null]
  accountabilityBadgeNumber: number | null
  contactPhone: string | null
} => {
  switch (issuance.mode) {
    case 'two-badges':
      return {
        badgeNumbers: issuance.badgeNumbers,
        accountabilityBadgeNumber: null,
        contactPhone: null,
      }
    case 'one-badge':
      return {
        /** The slot is the stick, so which one holds the badge is carried. */
        badgeNumbers:
          issuance.badgeSlot === 1
            ? [issuance.badgeNumber, null]
            : [null, issuance.badgeNumber],
        /** OUT ON THE BADGE: it answers for the pair until the loan closes. */
        accountabilityBadgeNumber: issuance.badgeNumber,
        contactPhone: null,
      }
    case 'badgeless':
      return {
        badgeNumbers: [null, null],
        accountabilityBadgeNumber: null,
        contactPhone: issuance.contactPhone,
      }
  }
}

/**
 * THE ISSUANCE SERIALISATION POINT: the event row, locked FOR UPDATE.
 *
 * Deliberately COARSE. There is no central row standing for "badge #9005 in
 * this event" to lock instead — the badge lives in the Google Sheet, and a
 * badge-availability table would be a second place that can disagree with the
 * ledger. The event row is the one row every issuance of one event genuinely
 * shares, so it is the truthful place to serialise them.
 *
 * WHAT IT COSTS is that two desks issuing for the same event take turns. An
 * issuance is four statements and no network waits, and different events
 * never block each other. Correctness first; if real measurements ever show
 * contention, that is the time to make it finer.
 *
 * IT IS NOT the D3.1 resolution lock and does not touch it. Resolutions keep
 * locking their own loan row, which is a different question — serialising two
 * desks resolving different sticks of ONE pair.
 */
const lockEventIssuance = (eventId: string) =>
  getDatabase()
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, eventId))
    .for('update')

/**
 * IS ANY REAL BADGE ON THIS PAIR ALREADY ANSWERING FOR AN OPEN LOAN?
 *
 * A pair issued on ONE badge is issued ON THAT BADGE, so until that loan
 * closes the badge takes part in NO new loan — a mixed one or an ordinary
 * two-badge one alike. No index can hold this: the offending badge is a
 * HOLDER row of the new loan while the anchor is the LOAN row of the old one,
 * and a unique index compares columns of one row of one table.
 *
 * So it is a SQL predicate on the insert itself, evaluated by the database
 * inside the locked transaction rather than by this process beforehand.
 *
 * A fully badgeless pair presents no badge, so there is nothing to look for
 * and the condition is simply true — not a sentinel badge number, which would
 * be a value that could one day match a row.
 */
const noOpenAnchorFor = (eventId: string, badges: readonly number[]) =>
  badges.length === 0
    ? sql`true`
    : sql`not exists (select 1 from ${dandiyaLoans}
         where ${dandiyaLoans.eventId} = ${eventId}
           and ${dandiyaLoans.closedAt} is null
           and ${dandiyaLoans.accountabilityBadgeNumber} in ${badges})`

/**
 * THE LOAN INSERT, GUARDED BY ITS OWN `WHERE`.
 *
 * `INSERT ... SELECT ... WHERE <event row> AND <no open anchor>`, so the
 * anchor rule is decided by the same statement that writes. When it does not
 * hold, the select yields no row, the insert writes nothing, and `returning`
 * comes back empty — which is the verdict the caller reads. There is no
 * branch in a batch and none is needed.
 *
 * IT SELECTS FROM `events`, the row the lock above is already holding, which
 * is both the cheapest single-row source available and a second assertion
 * that the event exists.
 *
 * EVERY COLUMN, IN THE TABLE'S OWN ORDER. Drizzle builds the insert's column
 * list from the whole table definition, so the selected fields must match it
 * key for key — and it throws loudly if they ever stop matching, which is the
 * failure mode wanted: a column added to `dandiya_loans` without a decision
 * here fails the suite rather than silently landing in the wrong column.
 */
const guardedLoanInsert = (input: {
  loanId: string
  eventId: string
  pairCode: string
  issuedByDeviceId: string
  issuedAt: Date
  contactPhone: string | null
  accountabilityBadgeNumber: number | null
  badges: readonly number[]
}) =>
  getDatabase()
    .insert(dandiyaLoans)
    .select((qb) =>
      qb
        .select({
          id: sql<string>`${input.loanId}::uuid`.as('id'),
          eventId: sql<string>`${input.eventId}::uuid`.as('event_id'),
          pairCode: sql<string>`${input.pairCode}::text`.as('pair_code'),
          issuedByDeviceId: sql<string>`${input.issuedByDeviceId}::uuid`
            .as('issued_by_device_id'),
          issuedAt: sql<Date>`${input.issuedAt}::timestamptz`.as('issued_at'),
          /** A loan is never born closed, and never born released. */
          closedAt: sql<Date | null>`null::timestamptz`.as('closed_at'),
          closedByDeviceId: sql<string | null>`null::uuid`.as('closed_by_device_id'),
          outcome: sql<string | null>`null::text`.as('outcome'),
          pairReleasedAt: sql<Date | null>`null::timestamptz`.as('pair_released_at'),
          contactPhone: sql<string | null>`${input.contactPhone}::text`.as('contact_phone'),
          accountabilityBadgeNumber: sql<number | null>`${input.accountabilityBadgeNumber}::integer`
            .as('accountability_badge_number'),
        })
        .from(events)
        .where(
          and(
            eq(events.id, input.eventId),
            noOpenAnchorFor(input.eventId, input.badges),
          ),
        ),
    )
    .returning({ id: dandiyaLoans.id })

/**
 * ONE HOLDER ROW, CONDITIONAL ON ITS LOAN EXISTING.
 *
 * Selected from `dandiya_loans` by the id the guarded insert above would have
 * written, so within this transaction it yields one row if that insert held
 * and none if it did not. A refused issuance therefore writes NO holder rows
 * either, and the batch commits having changed nothing — rather than failing
 * a foreign key, which would be an error used as ordinary control flow.
 */
const holderInsertForLoan = (input: {
  loanId: string
  eventId: string
  badgeNumber: number | null
  slot: number
}) =>
  getDatabase()
    .insert(dandiyaLoanHolders)
    .select((qb) =>
      qb
        .select({
          id: sql<string>`gen_random_uuid()`.as('id'),
          loanId: sql<string>`${input.loanId}::uuid`.as('loan_id'),
          eventId: sql<string>`${input.eventId}::uuid`.as('event_id'),
          badgeNumber: sql<number | null>`${input.badgeNumber}::integer`.as('badge_number'),
          slot: sql<number>`${input.slot}::smallint`.as('slot'),
          resolution: sql<string | null>`null::text`.as('resolution'),
          resolvedAt: sql<Date | null>`null::timestamptz`.as('resolved_at'),
          resolvedByDeviceId: sql<string | null>`null::uuid`.as('resolved_by_device_id'),
        })
        .from(dandiyaLoans)
        .where(eq(dandiyaLoans.id, input.loanId)),
    )

export type DandiyaIssueOutcome =
  | { ok: true; value: DandiyaLoanRow }
  | { ok: false; conflict: DandiyaConflict; violation: DandiyaViolation }

/**
 * Opens one loan: the loan row and BOTH holder rows, in ONE transaction.
 *
 * `db.batch` is the Neon HTTP driver's single transaction — all three
 * statements commit or none does — which is what makes a holder conflict roll
 * the loan back rather than leaving a pair marked out with one holder.
 *
 * THE ID AND THE TIMESTAMP ARE GENERATED HERE, not defaulted by the database,
 * for one reason each. The id is needed by the two holder statements that
 * travel in the same batch, and a batch cannot read back a generated value.
 * The timestamp is generated once so the loan and both holders share a single
 * instant. The column defaults remain as the database's own floor.
 *
 * NO PRECHECK DECIDES ANYTHING. The caller may have read the ledger for a
 * better message, but two desks can each read "that pair is free" and both
 * arrive here. The partial unique indexes decide, and their violations are
 * translated rather than pre-empted.
 *
 * A PAIR CONFLICT IS DISAMBIGUATED AFTER THE REFUSAL, never before: the index
 * cannot say whether the blocking loan is open or quarantined, so the row is
 * re-read once the database has already said no. That is the same shape the
 * badge-claim recovery uses, and it is not a precheck — the answer has
 * already been decided.
 */
export const openDandiyaLoan = async (input: {
  eventId: string
  pairCode: string
  /** ALREADY DISCRIMINATED BY MODE. The three columns are derived from it. */
  issuance: DandiyaIssuance
  issuedByDeviceId: string
}): Promise<DandiyaIssueOutcome> => {
  const database = getDatabase()
  const loanId = randomUUID()
  const issuedAt = new Date()
  const { badgeNumbers, accountabilityBadgeNumber, contactPhone } = issuanceColumns(
    input.issuance,
  )

  const badges = badgeNumbers.filter(
    (badgeNumber): badgeNumber is number => badgeNumber !== null,
  )

  /**
   * THE WHOLE ISSUANCE IS ONE TRANSACTION, AND IT OPENS BY LOCKING THE EVENT.
   *
   *   1. SELECT the event row FOR UPDATE      <- the serialisation point
   *   2. the GUARDED loan insert, whose own WHERE decides the anchor rule
   *   3. the two holder inserts, each conditional on that loan existing
   *
   * `db.batch` is this driver's single transaction, so all four statements
   * commit together or none does — and because the lock is the FIRST of them,
   * every later statement in this transaction runs with issuance for this
   * event serialised behind it.
   *
   * THERE IS NO PRE-READ, and there must never be one again. An earlier
   * revision read the open anchors in a statement of their own and decided in
   * application code, which is a TOCTOU hole: the process can pause for any
   * length of time after that read — a GC pause, a cold start, a retried
   * request — and in that window another desk can issue a mixed loan on the
   * same badge AND that badge's own stick can be resolved. The holder index
   * then has nothing to catch, because the only unresolved stick left on the
   * other loan belongs to a guest. The decision must be made by the database,
   * inside the transaction that writes.
   */
  const statements = [
    lockEventIssuance(input.eventId),
    guardedLoanInsert({
      loanId,
      eventId: input.eventId,
      pairCode: input.pairCode,
      issuedByDeviceId: input.issuedByDeviceId,
      issuedAt,
      contactPhone,
      accountabilityBadgeNumber,
      badges,
    }),
    ...badgeNumbers.map((badgeNumber, index) =>
      holderInsertForLoan({
        loanId,
        eventId: input.eventId,
        badgeNumber,
        slot: index + 1,
      }),
    ),
  ] as const

  try {
    const results = await database.batch(
      statements as unknown as Parameters<typeof database.batch>[0],
    )
    /**
     * THE GUARD'S VERDICT, read from the statement that made it.
     *
     * The loan insert returns its row only when its own `WHERE` held, so an
     * empty result means a badge on this pair is already answering for an
     * open loan. The holder inserts in the same batch are each conditional on
     * that loan existing, so NOTHING was written — no loan, no holder rows,
     * and no foreign-key error used as control flow.
     */
    const inserted = results[1]

    if (!Array.isArray(inserted) || inserted.length === 0) {
      return {
        ok: false,
        conflict: PUBLIC_DANDIYA_CONFLICT['accountability-already-holding'],
        violation: 'accountability-already-holding',
      }
    }
  } catch (error: unknown) {
    const violation = mapDandiyaViolation(error)

    if (violation === null) {
      throw error
    }

    const conflict =
      violation === 'pair-unavailable'
        ? await describePairConflict(input.eventId, input.pairCode)
        : PUBLIC_DANDIYA_CONFLICT[violation]

    return { ok: false, conflict, violation }
  }

  return {
    ok: true,
    value: {
      id: loanId,
      pairCode: input.pairCode,
      issuedAt: issuedAt.toISOString(),
      issuedByDeviceId: input.issuedByDeviceId,
      closedAt: null,
      closedByDeviceId: null,
      outcome: null,
      pairReleasedAt: null,
      contactPhone,
      accountabilityBadgeNumber,
      holders: badgeNumbers.map((badgeNumber, index) => ({
        badgeNumber,
        slot: index + 1,
        resolution: null,
        resolvedAt: null,
        resolvedByDeviceId: null,
      })),
    },
  }
}

/**
 * Is the pair OUT, or QUARANTINED? Asked only after the index has refused.
 *
 * Both states hold the same index slot — `pair_released_at IS NULL` — so the
 * violation alone cannot tell them apart, and the operator's next action
 * differs: wait for a pair to come back, or take this one out of the stock.
 * An unreadable answer degrades to `pair-in-use`, which is the safer thing to
 * say: it describes a pair somebody else has.
 */
const describePairConflict = async (
  eventId: string,
  pairCode: string,
): Promise<DandiyaConflict> => {
  const [blocking] = await getDatabase()
    .select({ closedAt: dandiyaLoans.closedAt })
    .from(dandiyaLoans)
    .where(
      and(
        eq(dandiyaLoans.eventId, eventId),
        eq(dandiyaLoans.pairCode, pairCode),
        isNull(dandiyaLoans.pairReleasedAt),
      ),
    )

  return blocking === undefined || blocking.closedAt === null
    ? 'pair-in-use'
    : 'pair-unavailable'
}

export type DandiyaResolveOutcome =
  | { ok: true; resolvedAt: string; resolvedHolders: number }
  | { ok: false; conflict: DandiyaConflict }

/**
 * How many of this loan's holders are still unresolved, as a SQL fragment.
 *
 * Evaluated by the database INSIDE the transaction, which is the whole point:
 * the close statements below run after the resolution statement in the same
 * batch, so they see the state that statement produced rather than whatever
 * this process read a moment earlier.
 */
const unresolvedHolders = (loanId: string) =>
  sql`(select count(*) from ${dandiyaLoanHolders}
       where ${dandiyaLoanHolders.loanId} = ${loanId}
         and ${dandiyaLoanHolders.resolvedAt} is null)`

/** How many of them ended as lost. The outcome is derived from this number. */
const lostHolders = (loanId: string) =>
  sql`(select count(*) from ${dandiyaLoanHolders}
       where ${dandiyaLoanHolders.loanId} = ${loanId}
         and ${dandiyaLoanHolders.resolution} = 'lost')`

/**
 * Takes the LOAN ROW LOCK, and is the first statement of every resolution.
 *
 * `SELECT ... FOR UPDATE` on the owning loan, scoped to this event and to a
 * loan that is still open. Its rows are never read: the only thing wanted is
 * the row lock, which is what serialises two transactions that otherwise
 * never touch a common row.
 *
 * `closed_at IS NULL` is part of the predicate so an already-closed loan
 * blocks nobody. That is safe because a loan only closes once every holder is
 * resolved, after which no holder compare-and-set can match anything.
 */
const lockOpenLoan = (eventId: string, loanId: string) =>
  getDatabase()
    .select({ id: dandiyaLoans.id })
    .from(dandiyaLoans)
    .where(
      and(
        eq(dandiyaLoans.id, loanId),
        eq(dandiyaLoans.eventId, eventId),
        isNull(dandiyaLoans.closedAt),
      ),
    )
    .for('update')

/**
 * Resolves one stick, or every stick still out, and closes the loan if that
 * leaves none unresolved — ALL IN ONE TRANSACTION, behind the loan's own row
 * lock.
 *
 * `slot` picks one stick; omitting it resolves every stick still out, which
 * is what the `return-pair` and `lost-pair` shortcuts are. The SLOT is the
 * identity rather than a badge number, because since Phase D3.3 a stick may
 * belong to a guest who has none. Either way the WHERE clause carries
 * `resolved_at IS NULL`, so:
 *
 *   - a resolution is never overwritten: returned does not become lost and
 *     lost does not become returned, however often the request is repeated
 *   - `return-pair` on a loan with one lost stick resolves only the other and
 *     leaves the loss standing
 *   - two desks resolving the same stick cannot both win; the loser matches
 *     no row and is told
 *
 * THE LOAN ROW LOCK IS TAKEN FIRST, AND THAT IS THE SERIALISATION. Everything
 * below it is a compare-and-set, and compare-and-set alone is NOT enough
 * here, because two desks resolving DIFFERENT sticks of one pair write
 * different holder rows and so never conflict with each other.
 *
 * Under READ COMMITTED — which is what this runs at — every statement takes a
 * fresh snapshot and sees its own transaction's writes but not another's
 * uncommitted ones. Without the lock, two simultaneous FINAL resolutions
 * would each see the other's stick still out, each decline to close, and both
 * commit: every stick resolved and the loan open for the rest of the event.
 * Serialising on the shared loan row is what makes the second transaction
 * observe the first one's committed resolution.
 *
 * THE CLOSE IS THREE MUTUALLY EXCLUSIVE COMPARE-AND-SETS. Each requires
 * `closed_at IS NULL` AND that no holder is unresolved AND a specific number
 * of lost holders, so exactly one can match — and all of them read the
 * holders table AFTER the resolution above them in the same transaction. The
 * lock makes "after" mean after the OTHER desk too, and the compare-and-sets
 * mean the loan still cannot be closed twice or closed early.
 *
 * Only the all-returned close sets `pair_released_at`, which is the physical
 * pair's freedom. The database refuses any other combination.
 */
export const resolveDandiyaHolders = async (input: {
  eventId: string
  loanId: string
  /** One stick by slot, or every stick still out when absent. */
  slot?: number
  resolution: DandiyaHolderResolution
  resolvedByDeviceId: string
}): Promise<DandiyaResolveOutcome> => {
  const database = getDatabase()
  const resolvedAt = new Date()
  const { eventId, loanId, slot, resolution, resolvedByDeviceId } = input

  const closing = {
    closedAt: resolvedAt,
    closedByDeviceId: resolvedByDeviceId,
  }

  /** A close that may run only when nothing is left unresolved. */
  const closeWhen = (lost: number) =>
    and(
      eq(dandiyaLoans.id, loanId),
      eq(dandiyaLoans.eventId, eventId),
      isNull(dandiyaLoans.closedAt),
      sql`${unresolvedHolders(loanId)} = 0`,
      sql`${lostHolders(loanId)} = ${lost}`,
    )

  const [, resolved] = await database.batch([
    /**
     * FIRST, ALWAYS. A holder update or a close query above this line would
     * run unserialised, which is the entire bug this lock exists to close.
     */
    lockOpenLoan(eventId, loanId),
    database
      .update(dandiyaLoanHolders)
      .set({ resolution, resolvedAt, resolvedByDeviceId })
      .where(
        and(
          eq(dandiyaLoanHolders.loanId, loanId),
          eq(dandiyaLoanHolders.eventId, eventId),
          isNull(dandiyaLoanHolders.resolvedAt),
          ...(slot === undefined ? [] : [eq(dandiyaLoanHolders.slot, slot)]),
        ),
      )
      .returning({ slot: dandiyaLoanHolders.slot }),
    /** Both sticks back: the pair is freed in the same breath. */
    database
      .update(dandiyaLoans)
      .set({ ...closing, outcome: 'returned', pairReleasedAt: resolvedAt })
      .where(closeWhen(0)),
    /** One stick gone: the loan closes, the pair stays quarantined. */
    database
      .update(dandiyaLoans)
      .set({ ...closing, outcome: 'partial_loss' })
      .where(closeWhen(1)),
    /** Both gone. */
    database
      .update(dandiyaLoans)
      .set({ ...closing, outcome: 'lost' })
      .where(closeWhen(2)),
  ])

  /**
   * NOTHING MATCHED, so nothing was this caller's to do. Reported as the
   * narrower conflict when one stick was named — that attendee's stick was
   * already resolved — and as the loan-level one for a shortcut, where every
   * stick was already resolved.
   *
   * The close statements still ran, which is deliberate: a loan whose holders
   * are all resolved but which somehow remained open is closed by the next
   * attempt rather than needing a repair.
   */
  if (resolved.length === 0) {
    return {
      ok: false,
      conflict: slot === undefined ? 'loan-already-closed' : 'holder-already-resolved',
    }
  }

  return { ok: true, resolvedAt: resolvedAt.toISOString(), resolvedHolders: resolved.length }
}
