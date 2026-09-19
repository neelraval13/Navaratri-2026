import type { OutboxSyncErrorCode } from '@/shared/sync-contract'

/**
 * Failures a human must resolve: a code bug, a deployment/config problem, or a
 * ledger conflict. Retrying these on a timer only hammers a broken endpoint, so
 * they stay pending until the operator presses Retry.
 */
const ATTENTION_CODES: readonly OutboxSyncErrorCode[] = [
  'invalid-request',
  'forbidden-origin',
  'sync-not-configured',
  'badge-conflict',
  'sheet-shape-conflict',
]

/**
 * Failures that are almost certainly the same for every queued row, because
 * they describe the deployment or the spreadsheet rather than one registration.
 * Hitting the next row would just produce the identical error.
 */
const GLOBAL_CODES: readonly OutboxSyncErrorCode[] = [
  'forbidden-origin',
  'sync-not-configured',
  'sheet-shape-conflict',
]

/** Restrained, event-friendly backoff. Index = attemptCount. */
const RETRY_DELAYS_MS = [
  5_000, // after attempt 1
  15_000, // after attempt 2
  30_000, // after attempt 3
  60_000, // after attempt 4
] as const

const LONG_RETRY_DELAY_MS = 5 * 60_000

export const isAttentionError = (code: OutboxSyncErrorCode): boolean => {
  return ATTENTION_CODES.includes(code)
}

export const isRetryableError = (code: OutboxSyncErrorCode): boolean => {
  return !isAttentionError(code)
}

/**
 * Whether a failure should end the current cycle rather than move to the next
 * row. Retryable failures also stop the cycle: one outage should not produce N
 * immediate failures for N rows.
 */
export const isGlobalFailure = (code: OutboxSyncErrorCode): boolean => {
  return GLOBAL_CODES.includes(code) || isRetryableError(code)
}

/**
 * How long to wait after `attemptCount` failed attempts for the current
 * snapshot. A new snapshot resets the count, so an edit always gets a fresh
 * immediate attempt.
 */
export const getRetryDelayMs = (attemptCount: number): number => {
  if (attemptCount <= 0) {
    return 0
  }

  return RETRY_DELAYS_MS[attemptCount - 1] ?? LONG_RETRY_DELAY_MS
}

/** The fields retry decisions need. `OutboxItem` satisfies this structurally. */
export interface RetryCandidate {
  attemptCount: number
  lastAttemptAt?: string
  lastErrorCode?: OutboxSyncErrorCode
}

/**
 * Whether a snapshot may be attempted now.
 *
 * A manual retry ignores both backoff and the attention hold — that is the
 * whole point of the operator asking for it.
 */
export const isSnapshotDue = (
  candidate: RetryCandidate,
  nowMs: number,
  manual: boolean,
): boolean => {
  if (manual) {
    return true
  }

  if (
    candidate.lastErrorCode !== undefined &&
    isAttentionError(candidate.lastErrorCode)
  ) {
    return false
  }

  if (candidate.attemptCount <= 0 || candidate.lastAttemptAt === undefined) {
    return true
  }

  const lastAttemptMs = Date.parse(candidate.lastAttemptAt)

  if (Number.isNaN(lastAttemptMs)) {
    return true
  }

  return lastAttemptMs + getRetryDelayMs(candidate.attemptCount) <= nowMs
}

/**
 * When the earliest not-yet-due snapshot becomes eligible, so one timer can be
 * scheduled instead of polling. Attention rows are excluded: they wait for a
 * manual retry, not a clock.
 */
export const getNextRetryAtMs = (
  candidates: readonly RetryCandidate[],
  nowMs: number,
): number | undefined => {
  let earliest: number | undefined

  for (const candidate of candidates) {
    if (
      candidate.lastErrorCode !== undefined &&
      isAttentionError(candidate.lastErrorCode)
    ) {
      continue
    }

    if (isSnapshotDue(candidate, nowMs, false)) {
      return nowMs
    }

    const lastAttemptMs = Date.parse(candidate.lastAttemptAt ?? '')

    if (Number.isNaN(lastAttemptMs)) {
      continue
    }

    const dueAt = lastAttemptMs + getRetryDelayMs(candidate.attemptCount)

    if (earliest === undefined || dueAt < earliest) {
      earliest = dueAt
    }
  }

  return earliest
}
