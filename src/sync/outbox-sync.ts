import {
  acknowledgeSnapshot,
  listPendingOutboxItems,
  markAttemptStarted,
  readOutboxItem,
  recordSnapshotFailure,
  toSnapshotRef,
  type OutboxSnapshotRef,
} from '@/db/outbox'
import type { OutboxItem } from '@/db/types'
import {
  parseSyncRegistrationRequest,
  parseSyncRegistrationResponse,
  type OutboxSyncErrorCode,
  type SyncRegistrationRequest,
  type SyncSuccessResponse,
} from '@/shared/sync-contract'
import { notifyOutboxChanged } from '@/sync/outbox-events'
import {
  getNextRetryAtMs,
  isAttentionError,
  isGlobalFailure,
  isSnapshotDue,
} from '@/sync/retry-policy'
import { setSyncStatus } from '@/sync/sync-status-store'

const SYNC_ENDPOINT = '/api/sync-registration'

/** A hung request must never freeze synchronization forever. */
const FETCH_TIMEOUT_MS = 15_000

/**
 * Cross-tab exclusion. Phase 5A requires single-flight per browser, not merely
 * per tab.
 */
const SYNC_LOCK_NAME = 'navaratri-2026-outbox-sync'

/**
 * How long to wait before looking again when ANOTHER TAB holds the sync lock.
 *
 * This is not a retry: nothing was attempted and no attempt metadata changed.
 * It exists so a second visible tab eventually notices that the first one
 * drained the queue, without the two spinning against each other.
 */
const LOCK_RECHECK_DELAY_MS = 1_000

export interface OutboxSyncOptions {
  /**
   * Manual retry ignores backoff and the attention hold — that is the point of
   * the operator asking. It does NOT ignore a browser that reports offline:
   * there is nothing to retry into, and burning an attempt would only push the
   * row further down its backoff.
   */
  manual?: boolean
}

/**
 * `navigator.onLine` is a weak signal when it says "online" — it cannot know
 * whether the endpoint is reachable. It is a reliable signal when it says
 * OFFLINE, so it is used only in that direction: to skip work that is certain
 * to fail.
 */
const isBrowserOffline = (): boolean => {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** In-tab single flight: one cycle at a time, everyone else awaits it. */
let activeCycle: Promise<void> | null = null

let retryTimer: ReturnType<typeof setTimeout> | undefined

let lastSuccessAt: string | undefined

const buildRequest = (item: OutboxItem): SyncRegistrationRequest => {
  return {
    outboxId: item.id,
    registrationId: item.registrationId,
    operation: item.operation,
    payload: item.payload,
  }
}

type AttemptOutcome =
  | { kind: 'success'; response: SyncSuccessResponse }
  | { kind: 'failure'; code: OutboxSyncErrorCode; message: string }

/**
 * Maps an HTTP status to a code when the body could not be understood, so an
 * error page or a proxy response still fails closed with a sensible policy.
 */
const classifyStatus = (status: number): OutboxSyncErrorCode => {
  if (status === 400) {
    return 'invalid-request'
  }

  if (status === 403) {
    return 'forbidden-origin'
  }

  /**
   * 503 is deliberately NOT mapped to `sync-not-configured`. A platform or proxy
   * returns 503 for a plain temporary outage, usually with an HTML body, and
   * calling that a configuration fault would park a perfectly retryable row on
   * the attention list until a human noticed it.
   *
   * `sync-not-configured` is reachable only from a VALIDATED failure body that
   * actually says so.
   */
  if (status === 429 || status >= 500) {
    return 'sync-failed'
  }

  return 'unexpected-http'
}

const postSnapshot = async (
  request: SyncRegistrationRequest,
): Promise<AttemptOutcome> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, FETCH_TIMEOUT_MS)

  try {
    const httpResponse = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store',
      signal: controller.signal,
    })

    let body: unknown

    try {
      body = await httpResponse.json()
    } catch {
      return {
        kind: 'failure',
        code: httpResponse.ok ? 'invalid-response' : classifyStatus(httpResponse.status),
        message: 'The sync service returned an unreadable response.',
      }
    }

    const parsed = parseSyncRegistrationResponse(body)

    if (!parsed.ok) {
      return {
        kind: 'failure',
        code: 'invalid-response',
        message: 'The sync service returned an unexpected response.',
      }
    }

    const response = parsed.response

    if (!response.ok) {
      /**
       * These fields are optional, because the server may reject before it has
       * parsed the body at all — `forbidden-origin` and `sync-not-configured`
       * legitimately arrive without them. But a PRESENT field that names a
       * different snapshot means the response does not belong to this request.
       */
      if (
        (response.registrationId !== undefined &&
          response.registrationId !== request.registrationId) ||
        (response.payloadUpdatedAt !== undefined &&
          response.payloadUpdatedAt !== request.payload.updatedAt)
      ) {
        return {
          kind: 'failure',
          code: 'invalid-response',
          message: 'The sync service replied about a different snapshot.',
        }
      }

      return {
        kind: 'failure',
        code: response.outcome,
        message: response.message,
      }
    }

    /**
     * A success body only counts when the transport agreed. Acknowledgement
     * DELETES durable local data, so a non-2xx carrying `ok: true` — a cached
     * error page, a proxy rewriting the body, a half-deployed function — must
     * never retire an outbox row.
     */
    if (!httpResponse.ok) {
      return {
        kind: 'failure',
        code: 'unexpected-http',
        message: 'The sync service reported success with an error status.',
      }
    }

    /**
     * The echo must match what was actually sent. Without both checks the
     * client cannot know WHICH snapshot was acknowledged, and acknowledging the
     * wrong one would delete unsynchronized work.
     */
    if (
      response.registrationId !== request.registrationId ||
      response.payloadUpdatedAt !== request.payload.updatedAt
    ) {
      return {
        kind: 'failure',
        code: 'invalid-response',
        message: 'The sync service acknowledged a different snapshot.',
      }
    }

    return { kind: 'success', response }
  } catch (error: unknown) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'

    return {
      kind: 'failure',
      code: aborted ? 'timeout' : 'network-error',
      message: aborted
        ? 'The sync service did not respond in time.'
        : 'Could not reach the sync service.',
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Derives status from the real queue. Never from a separate counter that could drift. */
const refreshStatusFromQueue = async (
  items?: readonly OutboxItem[],
): Promise<OutboxItem[]> => {
  const pending = items === undefined ? await listPendingOutboxItems() : [...items]

  const attentionCount = pending.filter(
    (item) =>
      item.lastErrorCode !== undefined && isAttentionError(item.lastErrorCode),
  ).length

  const nextRetryAtMs = getNextRetryAtMs(pending, Date.now())

  setSyncStatus({
    pendingCount: pending.length,
    attentionCount,
    lastSuccessAt,
    nextRetryAt:
      nextRetryAtMs === undefined
        ? undefined
        : new Date(nextRetryAtMs).toISOString(),
  })

  return pending
}

const clearRetryTimer = (): void => {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
}

/**
 * One timeout for the earliest due row, rather than a polling loop. Recomputed
 * whenever the queue or connectivity changes.
 */
const scheduleNextRetry = (items: readonly OutboxItem[]): void => {
  clearRetryTimer()

  if (items.length === 0) {
    return
  }

  /**
   * An offline browser has nothing to retry into. Every queued row is due the
   * moment it fails, so arming a timer here would fire immediately, skip at the
   * offline guard, and re-arm — a zero-delay spin for as long as the desk is
   * offline. The `online` event is the wake-up instead.
   */
  if (isBrowserOffline()) {
    return
  }

  const nowMs = Date.now()
  const dueAtMs = getNextRetryAtMs(items, nowMs)

  if (dueAtMs === undefined) {
    // Only attention rows remain; they wait for a manual retry, not a clock.
    return
  }

  const delay = Math.max(dueAtMs - nowMs, 0)

  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void requestOutboxSync()
  }, delay)
}

/** A restrained fixed re-check while another tab owns the lock. Never a retry. */
const scheduleLockRecheck = (items: readonly OutboxItem[]): void => {
  clearRetryTimer()

  if (items.length === 0 || isBrowserOffline()) {
    return
  }

  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void requestOutboxSync()
  }, LOCK_RECHECK_DELAY_MS)
}

/**
 * How a cycle ended, which decides what to schedule next.
 *
 * The two skip results are NOT failures: no request was made, no attempt was
 * counted and no outbox row was touched.
 */
type CycleResult = 'processed' | 'offline' | 'lock-unavailable'

const scheduleAfterCycle = (
  result: CycleResult,
  pending: readonly OutboxItem[],
): void => {
  if (result === 'lock-unavailable') {
    scheduleLockRecheck(pending)

    return
  }

  // 'offline' needs no case of its own: scheduleNextRetry clears the timer and
  // declines to arm a new one while the browser reports offline.
  scheduleNextRetry(pending)
}

type CycleStep = 'continue' | 'stop'

const processSnapshot = async (
  ref: OutboxSnapshotRef,
  item: OutboxItem,
): Promise<CycleStep> => {
  const request = buildRequest(item)

  /**
   * Local data is validated before it is sent. A malformed persisted snapshot
   * is kept and flagged rather than posted, so one corrupt row cannot look like
   * a server bug — and other valid rows still get their turn.
   */
  const localCheck = parseSyncRegistrationRequest(request)

  if (!localCheck.ok) {
    await recordSnapshotFailure(
      ref,
      'invalid-request',
      'This registration cannot be synchronized as stored.',
    )

    return 'continue'
  }

  const attempt = await markAttemptStarted(ref)

  if (attempt.outcome !== 'started') {
    // Replaced or removed between listing and sending; the newer snapshot is
    // handled as its own state.
    return 'continue'
  }

  setSyncStatus({ phase: 'syncing' })

  const outcome = await postSnapshot(request)

  if (outcome.kind === 'success') {
    const result = await acknowledgeSnapshot(ref)

    if (result === 'deleted') {
      lastSuccessAt = new Date().toISOString()
    }

    // 'superseded' means a newer local snapshot arrived while this request was
    // in flight. It is kept deliberately and synced on its own.
    return 'continue'
  }

  await recordSnapshotFailure(ref, outcome.code, outcome.message)

  return isGlobalFailure(outcome.code) ? 'stop' : 'continue'
}

const runCycle = async (manual: boolean): Promise<void> => {
  /**
   * Snapshots attempted in THIS cycle, keyed by row and version. Prevents an
   * endlessly retried row from spinning the loop, while still allowing a NEWER
   * version of the same row to be attempted — which is exactly the
   * Held A -> Completed B case.
   */
  const attempted = new Set<string>()

  let processing = true

  while (processing) {
    processing = false

    const pending = await listPendingOutboxItems()

    for (const listed of pending) {
      // Always re-read: the listed array may already be stale.
      const current = await readOutboxItem(listed.id)

      if (current === undefined) {
        continue
      }

      const key = `${current.id}:${current.payload.updatedAt}`

      if (attempted.has(key)) {
        continue
      }

      if (!isSnapshotDue(current, Date.now(), manual)) {
        continue
      }

      attempted.add(key)

      const step = await processSnapshot(toSnapshotRef(current), current)

      if (step === 'stop') {
        return
      }

      // A newer snapshot may have appeared for an already-visited row, so make
      // another pass rather than trusting the list captured above.
      processing = true
    }
  }
}

/**
 * One guarded cycle: the offline check, the cross-tab lock, and the status and
 * scheduling refresh that must happen however the cycle ends.
 *
 * Status is always re-derived from IndexedDB, including on both skip paths, so
 * a tab that did no work still shows the truth.
 */
const runGuardedCycle = async (manual: boolean): Promise<void> => {
  let result: CycleResult = 'processed'

  try {
    /**
     * Applies to MANUAL retries too. Offline is a connectivity state, not a
     * sync failure: no request, no attempt increment, no failure metadata, and
     * nothing written. The rows stay durable and the `online` event resumes.
     */
    if (isBrowserOffline()) {
      result = 'offline'

      return
    }

    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks

    if (locks === undefined) {
      await runCycle(manual)

      return
    }

    await locks.request(
      SYNC_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          // Another tab owns the cycle; skip rather than duplicate requests.
          result = 'lock-unavailable'

          return
        }

        await runCycle(manual)
      },
    )
  } catch (error: unknown) {
    console.error('Navaratri: outbox sync cycle failed.', error)
  } finally {
    const pending = await refreshStatusFromQueue()

    setSyncStatus({ phase: 'idle' })
    scheduleAfterCycle(result, pending)
  }
}

/**
 * Runs one synchronization cycle.
 *
 * Two layers of single-flight:
 *
 * 1. an in-tab promise, so concurrent callers receive the SAME cycle
 * 2. a Web Lock, so a second TAB skips instead of duplicating requests
 *
 * Where Web Locks is unavailable the in-tab guarantee still holds, but true
 * cross-tab exclusion cannot be guaranteed by the runtime. No lock is invented
 * in IndexedDB and no schema is changed to build one. Chrome, the deployment
 * target, supports Web Locks.
 *
 * Deliberately NOT an async function. An async wrapper would hand every caller
 * a different promise, and — worse — a synchronous early return (the offline
 * skip) would run its own cleanup before `activeCycle` had even been assigned,
 * leaving a resolved promise latched there forever and silently wedging every
 * later sync. The `.finally` below cannot run until this turn completes, and
 * the identity check makes the release safe regardless.
 *
 * Registration never waits on this: it is only ever called in the background.
 */
export const requestOutboxSync = (
  options: OutboxSyncOptions = {},
): Promise<void> => {
  const existing = activeCycle

  if (existing !== null) {
    return existing
  }

  const cycle = runGuardedCycle(options.manual === true).finally(() => {
    if (activeCycle === cycle) {
      activeCycle = null
    }
  })

  activeCycle = cycle

  return cycle
}

/** Re-derives status from the queue without attempting any network work. */
export const refreshSyncStatus = async (): Promise<void> => {
  const pending = await refreshStatusFromQueue()

  setSyncStatus({ phase: activeCycle === null ? 'idle' : 'syncing' })
  scheduleNextRetry(pending)
}

/** Stops the scheduled retry. Used when the manager unmounts. */
export const stopOutboxSyncScheduling = (): void => {
  clearRetryTimer()
}

/**
 * Re-exported so the writer side has one import for "the queue changed".
 */
export { notifyOutboxChanged }
