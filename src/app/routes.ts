/**
 * Every application route, in one place.
 *
 * These are real pathnames on the single production origin. Routing is
 * presentation only: it never creates a second storage namespace, so
 * IndexedDB, the trusted-device marker, the operator session cookie and the
 * service worker all continue to belong to that one origin whatever the
 * pathname says.
 */
export const ROUTES = {
  home: '/',
  badgeRegistration: '/badge-registration',
  deviceRegistration: '/device-registration',
  /** The admin control plane. Its own security realm, not an event module. */
  admin: '/admin',
} as const

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES]

/**
 * Exactly the event-application routes, as one pattern.
 *
 * The event shell — Operator Access, the database gate, StorageManager and
 * SyncManager — mounts against this single route rather than per page, so
 * moving between Home, Badge Registration and Device Registration never
 * remounts the sync processor.
 *
 * `/admin` is deliberately absent: it is a different security realm and must
 * not require Operator Access. Unknown paths are absent too, so Not Found is
 * reachable without unlocking anything.
 */
export const EVENT_ROUTE_PATTERN =
  /^\/(?:badge-registration|device-registration)?$/
