/**
 * The one event this deployment represents.
 *
 * Central Postgres is multi-event by design — `events` is a real table and
 * login names are unique per event — but this build serves exactly one, so an
 * operator must never be asked to type a slug into a device login form.
 *
 * It is PUBLIC information: it names the event, authorizes nothing, and is
 * already visible in the database name and in the page. It deliberately is
 * not an environment variable — a `VITE_` value would be bundled anyway, and
 * a server variable cannot reach the browser that needs it.
 *
 * Framework-free so the browser and any future server caller read the same
 * value rather than two copies that can drift.
 */
export const CURRENT_EVENT_SLUG = 'navaratri-2026'
