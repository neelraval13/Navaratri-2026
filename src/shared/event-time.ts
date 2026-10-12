/**
 * WHICH DAY IS IT, in the event's own timezone.
 *
 * The event runs on India time regardless of where a server or a tablet
 * happens to be, and "today" is a real product concept: the Dandiya desk
 * counts pairs issued and returned today, and its history defaults to today.
 *
 * SHARED, because both sides answer that question. The server computes the
 * counters and the browser filters the history, and two implementations of
 * "which day is this" would disagree for ninety minutes every night — the
 * server in UTC would roll over at 5:30 AM local, which is exactly when a
 * late dandiya evening is still being tidied up.
 *
 * It is a DAY KEY and nothing more. No formatting, no locale, no display:
 * `src/lib/datetime.ts` renders timestamps for humans and
 * `server/sync/sheet-contract.ts` formats the Sheet's own Date and Time
 * columns. Both predate this module and are deliberately left alone — they
 * are Production-live and they answer a different question.
 *
 * MIDNIGHT HERE CHANGES NOTHING OPERATIONAL. It changes which rows a screen
 * labels "today". It never closes a loan, releases a holder or frees a pair:
 * a dandiya pair is returned by a person, never by a clock.
 */

/** AGENTS.md fixes the event to India. */
export const EVENT_TIME_ZONE = 'Asia/Kolkata'

/**
 * `en-CA` renders `YYYY-MM-DD`, which sorts and compares as a string.
 *
 * Built once: constructing an `Intl.DateTimeFormat` is the expensive part,
 * and this is called per row.
 */
const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: EVENT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The event-local calendar day of an ISO 8601 timestamp, as `YYYY-MM-DD`.
 *
 * An unusable timestamp yields an empty string, which matches no day key, so
 * a corrupt value is simply never "today" rather than throwing inside a
 * render or a counter.
 */
export const eventDayKey = (isoTimestamp: string): string => {
  const timestamp = new Date(isoTimestamp)

  if (Number.isNaN(timestamp.getTime())) {
    return ''
  }

  return DAY_FORMATTER.format(timestamp)
}

/** The event-local day that the given instant falls in. Defaults to now. */
export const currentEventDayKey = (now: Date = new Date()): string =>
  eventDayKey(now.toISOString())

/** `YYYY-MM-DD`, and nothing else. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const isEventDayKey = (value: unknown): value is string =>
  typeof value === 'string' && DAY_KEY_PATTERN.test(value)

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * The parts of an instant AS THE EVENT ZONE SEES THEM.
 *
 * `hour12: false` can render midnight as `24` in some engines, so the hour is
 * taken modulo 24 — the date parts are already correct for that instant.
 */
const PART_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: EVENT_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/**
 * How many minutes the event zone is AHEAD of UTC at a given instant.
 *
 * Derived from `EVENT_TIME_ZONE` rather than written down. Asia/Kolkata has
 * been `+05:30` with no daylight saving for decades, but a hardcoded offset
 * would be a second, silent definition of the event's clock — and this one
 * cannot disagree with `eventDayKey`, because both read the same constant.
 */
const offsetMinutesAt = (instant: Date): number => {
  const parts: Record<string, number> = {}

  for (const part of PART_FORMATTER.formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value)
    }
  }

  const asIfUtc = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  )

  return Math.round((asIfUtc - instant.getTime()) / 60_000)
}

/** The instant at which the given event-local day begins. */
const startOfEventDay = (dayKey: string): Date | null => {
  const [year, month, day] = dayKey.split('-').map(Number)

  if (year === undefined || month === undefined || day === undefined) {
    return null
  }

  const localMidnight = Date.UTC(year, month - 1, day, 0, 0, 0)
  /**
   * Treat local midnight as if it were UTC, then subtract the zone's offset.
   * The offset is re-read at the corrected instant in case a transition sits
   * between the two — it never does for this event, and the correction costs
   * one comparison.
   */
  const first = new Date(localMidnight - offsetMinutesAt(new Date(localMidnight)) * 60_000)
  const settled = offsetMinutesAt(first)
  const instant = new Date(localMidnight - settled * 60_000)

  /**
   * ROUND-TRIP OR NOTHING. `2026-02-30` would otherwise roll into March and
   * silently answer for a day that does not exist, and a day key the event
   * zone does not agree with is not a day this application can group by.
   */
  return eventDayKey(instant.toISOString()) === dayKey ? instant : null
}

/** The day after a day key, by pure calendar arithmetic on the key itself. */
export const nextEventDayKey = (dayKey: string): string | null => {
  if (!isEventDayKey(dayKey)) {
    return null
  }

  const [year, month, day] = dayKey.split('-').map(Number)

  if (year === undefined || month === undefined || day === undefined) {
    return null
  }

  const next = new Date(Date.UTC(year, month - 1, day + 1))

  return `${String(next.getUTCFullYear())}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

/** The day before a day key. Same arithmetic, one step back. */
export const previousEventDayKey = (dayKey: string): string | null => {
  if (!isEventDayKey(dayKey)) {
    return null
  }

  const [year, month, day] = dayKey.split('-').map(Number)

  if (year === undefined || month === undefined || day === undefined) {
    return null
  }

  const previous = new Date(Date.UTC(year, month - 1, day - 1))

  return `${String(previous.getUTCFullYear())}-${pad(previous.getUTCMonth() + 1)}-${pad(previous.getUTCDate())}`
}

/**
 * The HALF-OPEN instant window of one event-local day: `[start, end)`.
 *
 * This is what a date becomes before it ever reaches SQL. A query compares
 * `issued_at` against these two timestamps, so the grouping is decided by the
 * EVENT's clock rather than by the database session's timezone — which is
 * exactly what `DATE(issued_at) = '…'` would get wrong, silently, and only
 * for the ninety minutes either side of midnight when it matters most.
 *
 * Half-open on purpose: `23:59:59.999` is a value, not a boundary, and an
 * inclusive end would either lose a millisecond or claim one twice.
 *
 * `null` for anything that is not a real day in this zone.
 */
export const eventDayWindow = (
  dayKey: string,
): { start: Date; end: Date } | null => {
  if (!isEventDayKey(dayKey)) {
    return null
  }

  const next = nextEventDayKey(dayKey)

  if (next === null) {
    return null
  }

  const start = startOfEventDay(dayKey)
  const end = startOfEventDay(next)

  if (start === null || end === null || end.getTime() <= start.getTime()) {
    return null
  }

  return { start, end }
}
