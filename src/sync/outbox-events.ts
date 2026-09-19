type OutboxChangedListener = () => void

const listeners = new Set<OutboxChangedListener>()

/**
 * Signals that the outbox has a new or updated snapshot.
 *
 * Call this only AFTER the Dexie transaction has committed — a listener that
 * reads the queue from inside the transaction could observe a state that is
 * about to be rolled back.
 */
export const notifyOutboxChanged = (): void => {
  for (const listener of [...listeners]) {
    listener()
  }
}

export const subscribeOutboxChanged = (
  listener: OutboxChangedListener,
): (() => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
