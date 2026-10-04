/**
 * Every application route, in one place.
 *
 * These are real pathnames on the single production origin. Routing is
 * presentation only: it never creates a second storage namespace, so
 * IndexedDB, the device session cookie and the service worker all continue
 * to belong to that one origin whatever the pathname says.
 */
export const ROUTES = {
  home: '/',
  badgeRegistration: '/badge-registration',
  /**
   * RETIRED by Phase D2 and kept only so an old bookmark still lands
   * somewhere useful. It redirects to Device Sign-In and owns no workflow:
   * there is no local device registration any more.
   */
  deviceRegistration: '/device-registration',
  /**
   * Central device sign-in, and since Phase D2 the ONLY provisioning path and
   * the only source of event authority.
   */
  deviceLogin: '/device-login',
  /** The admin control plane. Its own security realm, not an event module. */
  admin: '/admin',
} as const

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES]

/**
 * Exactly the event-application routes, as one pattern.
 *
 * The event shell — the database gate, device event authorization,
 * StorageManager and SyncManager — mounts against this single route rather
 * than per page, so moving between Home and Badge Registration never
 * remounts the sync processor.
 *
 * `/admin`, `/device-login` and the retired `/device-registration` are
 * deliberately absent: none of them is an event module, and none may mount
 * the registration workflow or ask for event authority. Unknown paths are
 * absent too, so Not Found is reachable without any of it.
 */
export const EVENT_ROUTE_PATTERN = /^\/(?:badge-registration)?$/
