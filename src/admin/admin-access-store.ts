export type AdminAccessPhase =
  /** Verifying with the server; nothing decided yet. */
  | 'checking'
  /** A valid admin session. */
  | 'authenticated'
  /** No valid session — show the Admin login. */
  | 'locked'
  /** Admin or database configuration is missing on this deployment. */
  | 'unavailable'

export interface AdminAccessState {
  phase: AdminAccessPhase
  /** Only meaningful while `phase` is `unavailable`. */
  reason: 'not-configured' | 'database-unavailable' | 'unreachable' | null
}

/**
 * A SEPARATE realm from device auth, with its own store.
 *
 * An authenticated event device is not an Admin, and an Admin is not an
 * operator. Sharing state between them is exactly the mistake that would make
 * one credential satisfy the other.
 */
let state: AdminAccessState = { phase: 'checking', reason: null }

const listeners = new Set<() => void>()

/** Stable reference while nothing changes, as `useSyncExternalStore` requires. */
export const getAdminAccess = (): AdminAccessState => state

export const subscribeAdminAccess = (listener: () => void): (() => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export const setAdminAccess = (next: AdminAccessState): void => {
  if (next.phase === state.phase && next.reason === state.reason) {
    return
  }

  state = next

  for (const listener of [...listeners]) {
    listener()
  }
}
