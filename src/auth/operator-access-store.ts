import { isDeviceTrusted } from '@/auth/trusted-device'

export type OperatorAccessPhase =
  /** Verifying with the server; nothing decided yet. */
  | 'checking'
  /** Full access: session verified, or a trusted device operating offline. */
  | 'unlocked'
  /** Trusted device whose session the server rejected. The app stays open. */
  | 'expired'
  /** Hard gate. Only ever reached by a device that has NEVER been unlocked. */
  | 'locked'

export type OperatorLockReason =
  | 'new-device'
  | 'offline-first-use'
  | 'not-configured'
  | 'unreachable'

export interface OperatorAccessState {
  phase: OperatorAccessPhase
  /** Only meaningful while `phase` is `locked`. */
  lockReason: OperatorLockReason | null
}

/**
 * A device that has been unlocked before starts usable and verifies in the
 * background, so the desk is never held behind a spinner waiting for a network
 * round trip it may not be able to make.
 */
const initialState = (): OperatorAccessState => {
  return isDeviceTrusted()
    ? { phase: 'unlocked', lockReason: null }
    : { phase: 'checking', lockReason: null }
}

let state: OperatorAccessState = initialState()

const listeners = new Set<() => void>()

/** Stable reference while nothing changes, as `useSyncExternalStore` requires. */
export const getOperatorAccess = (): OperatorAccessState => {
  return state
}

export const subscribeOperatorAccess = (listener: () => void): (() => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export const setOperatorAccess = (next: OperatorAccessState): void => {
  if (next.phase === state.phase && next.lockReason === state.lockReason) {
    return
  }

  state = next

  for (const listener of [...listeners]) {
    listener()
  }
}

/**
 * Called when a protected request came back `unauthorized`.
 *
 * It never escalates to the hard gate: an operator mid-registration must not
 * have the form replaced by a login screen. A device that has been unlocked
 * before moves to `expired`, which keeps the application open and shows a
 * banner instead.
 */
export const reportOperatorSessionRejected = (): void => {
  if (state.phase === 'locked') {
    return
  }

  setOperatorAccess(
    isDeviceTrusted()
      ? { phase: 'expired', lockReason: null }
      : { phase: 'locked', lockReason: 'new-device' },
  )
}
