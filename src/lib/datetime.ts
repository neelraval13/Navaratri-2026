/**
 * Event-local display zone. AGENTS.md fixes the event to Asia/Kolkata, and the
 * stored EventConfig carries the same value for later phases.
 */
const EVENT_TIME_ZONE = 'Asia/Kolkata'

/**
 * Renders a precise ISO 8601 UTC timestamp for the operator in event-local
 * time. Returns an empty string for an unusable timestamp so callers can simply
 * omit the detail rather than show "Invalid Date".
 */
export const formatEventDateTime = (isoTimestamp: string): string => {
  const timestamp = new Date(isoTimestamp)

  if (Number.isNaN(timestamp.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: EVENT_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp)
}

/**
 * Renders an event-local DAY KEY (`YYYY-MM-DD`) for a human: `12 Oct 2026`.
 *
 * Formatted in UTC from the key's own parts, which sounds wrong and is the
 * only correct choice: the key is ALREADY event-local, so putting it through
 * a timezone conversion would shift it. `new Date('2026-10-12')` is UTC
 * midnight, and rendering that in a zone behind UTC would show 11 Oct.
 *
 * An unusable key renders as itself, so a heading never reads "Invalid Date".
 */
export const formatEventDate = (dayKey: string): string => {
  const [year, month, day] = dayKey.split('-').map(Number)

  if (year === undefined || month === undefined || day === undefined) {
    return dayKey
  }

  const asUtc = new Date(Date.UTC(year, month - 1, day))

  if (Number.isNaN(asUtc.getTime())) {
    return dayKey
  }

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(asUtc)
}

/**
 * Renders the TIME ONLY of an ISO 8601 UTC timestamp, in event-local time:
 * `9:50 pm`.
 *
 * For a list that is already grouped under a date heading, where repeating
 * the date on every row is noise. The zone is the EVENT's, like every other
 * formatter here — a laptop set to another zone must not make the history
 * read differently.
 *
 * An unusable timestamp yields an empty string, so a row never reads
 * "Invalid Date".
 */
export const formatEventTime = (isoTimestamp: string): string => {
  const timestamp = new Date(isoTimestamp)

  if (Number.isNaN(timestamp.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: EVENT_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp)
}

/**
 * Renders an event-local DAY KEY (`YYYY-MM-DD`) as a full heading:
 * `16 October 2026`.
 *
 * Spelled-out month and no weekday, for a date that is a SECTION HEADING
 * rather than a detail beside a row — it is read once at a glance and should
 * be unambiguous without being abbreviated.
 *
 * Formatted in UTC from the key's own parts, for exactly the reason
 * `formatEventDate` is: the key is ALREADY event-local, so putting it through
 * a second timezone conversion would shift it a day.
 *
 * An unusable key renders as itself, so a heading never reads "Invalid Date".
 */
export const formatEventDateLong = (dayKey: string): string => {
  const [year, month, day] = dayKey.split('-').map(Number)

  if (year === undefined || month === undefined || day === undefined) {
    return dayKey
  }

  const asUtc = new Date(Date.UTC(year, month - 1, day))

  if (Number.isNaN(asUtc.getTime())) {
    return dayKey
  }

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(asUtc)
}
