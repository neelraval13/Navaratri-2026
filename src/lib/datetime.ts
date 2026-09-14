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
