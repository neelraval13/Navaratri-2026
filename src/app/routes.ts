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
} as const

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES]
