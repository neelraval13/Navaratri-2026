/**
 * What happened when persistence was requested. Every value is non-fatal: the
 * application works identically whichever one comes back.
 */
export type PersistenceOutcome =
  | 'unsupported'
  | 'already-persistent'
  | 'granted'
  | 'denied'
  | 'failed'

/**
 * Asks the browser to make this origin's storage persistent.
 *
 * Persistent storage resists automatic eviction under storage pressure. It is
 * NOT a backup and guarantees nothing: it does not survive Clear Site Data,
 * uninstalling the app, a wiped profile or a dead device, and the browser may
 * decline for its own reasons. Google Sheets remains the central ledger for
 * snapshots that have already been acknowledged; anything still pending in the
 * outbox lives only on this device until it syncs.
 */
const runRequest = async (): Promise<PersistenceOutcome> => {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage

  if (
    storage === undefined ||
    typeof storage.persisted !== 'function' ||
    typeof storage.persist !== 'function'
  ) {
    return 'unsupported'
  }

  try {
    // Asking again when it is already granted would prompt for nothing.
    if (await storage.persisted()) {
      return 'already-persistent'
    }

    return (await storage.persist()) ? 'granted' : 'denied'
  } catch (error: unknown) {
    /**
     * Development only. A desk must never be stopped — or distracted — by a
     * storage hint, so production continues silently. The message is generic
     * and no registration data is involved in it.
     */
    if (import.meta.env.DEV) {
      console.warn('Navaratri: could not request persistent storage.', error)
    }

    return 'failed'
  }
}

let persistencePromise: Promise<PersistenceOutcome> | null = null

/**
 * Requests persistence at most ONCE per application session.
 *
 * The memo is deliberately never cleared, including after a failure. A browser
 * that refused or threw will do so again, and retrying would only spam the API
 * for no benefit. Nothing awaits this: it never blocks startup or registration.
 */
export const requestPersistentStorage = (): Promise<PersistenceOutcome> => {
  persistencePromise ??= runRequest()

  return persistencePromise
}
