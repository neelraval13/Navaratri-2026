/**
 * The wire contract between the browser outbox and the Google Sheets bridge.
 *
 * Framework-free on purpose: no React, no Dexie, no googleapis, no Node or DOM
 * APIs. The Phase 5A server imports it today and the Phase 5B outbox processor
 * will import the same file, so the two can never disagree about the shape.
 */

export const SYNC_OPERATION = 'upsert'

export type SyncOperation = typeof SYNC_OPERATION

export type SyncGender = 'male' | 'female'

export type SyncPaymentMethod = 'upi' | 'cash'

/**
 * One pending outbox row per registration. Defined here so the browser writer
 * and the server validator derive the same id from the same rule.
 */
export const buildPendingOutboxId = (registrationId: string): string => {
  return `registration:${registrationId}`
}

interface SyncAttendeeFields {
  id: string
  name: string
  /** Comparison form. Carried for completeness; never written to the Sheet. */
  normalizedName?: string
  /** Raw 10 digits. Never +91, never display spacing. */
  phone: string
  age: number
  gender: SyncGender
  amount: number
  /** ISO 8601 UTC. */
  createdAt: string
  /** ISO 8601 UTC. The remote staleness key. */
  updatedAt: string
}

export interface SyncHeldPayload extends SyncAttendeeFields {
  status: 'held'
  paymentStatus: 'pending'
  paymentMethod?: SyncPaymentMethod
  /** ISO 8601 UTC. */
  heldAt: string
}

export interface SyncCompletedPayload extends SyncAttendeeFields {
  status: 'completed'
  paymentStatus: 'confirmed'
  paymentMethod: SyncPaymentMethod
  badgeNumber: number
  /** ISO 8601 UTC. */
  completedAt: string
  /** Present only when this registration was resumed from a hold. */
  heldAt?: string
}

export type SyncRegistrationPayload = SyncHeldPayload | SyncCompletedPayload

export interface SyncRegistrationRequest {
  outboxId: string
  registrationId: string
  operation: SyncOperation
  payload: SyncRegistrationPayload
}

/**
 * Outcomes that mean the Sheet is in the state the caller wanted. Phase 5B may
 * retire its outbox row for any of these — after checking `payloadUpdatedAt`.
 */
export type SyncSuccessOutcome =
  | 'synced'
  | 'already-current'
  | 'stale-ignored'
  | 'completed-wins'

export type SyncFailureOutcome =
  | 'invalid-request'
  | 'sync-not-configured'
  | 'forbidden-origin'
  | 'badge-conflict'
  | 'sheet-shape-conflict'
  | 'sync-failed'

export interface SyncSuccessResponse {
  ok: true
  outcome: SyncSuccessOutcome
  registrationId: string
  /**
   * Echoes the `payload.updatedAt` the server actually handled.
   *
   * Phase 5B MUST compare this against the outbox row it holds before deleting
   * it. An older in-flight request can finish after the operator has already
   * held/completed the same registration again, and deleting the newer snapshot
   * because an older one succeeded would silently lose that update.
   */
  payloadUpdatedAt: string
}

export interface SyncFailureResponse {
  ok: false
  outcome: SyncFailureOutcome
  message: string
  registrationId?: string
  payloadUpdatedAt?: string
  badgeNumber?: number
}

export type SyncRegistrationResponse =
  | SyncSuccessResponse
  | SyncFailureResponse

export type ParseResult =
  | { ok: true; request: SyncRegistrationRequest }
  | { ok: false; message: string }

const MIN_AGE = 0

const MAX_AGE = 120

const PHONE_PATTERN = /^\d{10}$/

/**
 * ISO 8601 with an explicit zone, which is what `Date#toISOString` produces.
 */
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim() !== ''
}

export const isIsoTimestamp = (value: unknown): value is string => {
  return (
    typeof value === 'string' &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

/** Present with any value at all, which after JSON parsing means a real value. */
const isPresent = (payload: Record<string, unknown>, key: string): boolean => {
  return key in payload && payload[key] !== undefined
}

const isPaymentMethod = (value: unknown): value is SyncPaymentMethod => {
  return value === 'upi' || value === 'cash'
}

/**
 * Validates an untrusted request body at runtime.
 *
 * TypeScript says nothing at an HTTP boundary, so every field is checked here.
 * Invalid input is rejected outright and never coerced, repaired or defaulted
 * into something writable — a malformed snapshot must not reach the ledger.
 */
export const parseSyncRegistrationRequest = (body: unknown): ParseResult => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  if (body.operation !== SYNC_OPERATION) {
    return { ok: false, message: `operation must be "${SYNC_OPERATION}".` }
  }

  const registrationId = body.registrationId

  if (!isNonEmptyString(registrationId)) {
    return { ok: false, message: 'registrationId must be a non-empty string.' }
  }

  if (body.outboxId !== buildPendingOutboxId(registrationId)) {
    return {
      ok: false,
      message: 'outboxId must be `registration:${registrationId}`.',
    }
  }

  const payload = body.payload

  if (!isRecord(payload)) {
    return { ok: false, message: 'payload must be a JSON object.' }
  }

  if (payload.id !== registrationId) {
    return { ok: false, message: 'payload.id must equal registrationId.' }
  }

  if (!isNonEmptyString(payload.name)) {
    return { ok: false, message: 'payload.name must be a non-empty string.' }
  }

  if (isPresent(payload, 'normalizedName') && typeof payload.normalizedName !== 'string') {
    return { ok: false, message: 'payload.normalizedName must be a string.' }
  }

  if (typeof payload.phone !== 'string' || !PHONE_PATTERN.test(payload.phone)) {
    return { ok: false, message: 'payload.phone must be exactly 10 digits.' }
  }

  const age = payload.age

  if (
    typeof age !== 'number' ||
    !Number.isInteger(age) ||
    age < MIN_AGE ||
    age > MAX_AGE
  ) {
    return {
      ok: false,
      message: `payload.age must be an integer from ${String(MIN_AGE)} to ${String(MAX_AGE)}.`,
    }
  }

  if (payload.gender !== 'male' && payload.gender !== 'female') {
    return { ok: false, message: 'payload.gender must be "male" or "female".' }
  }

  const amount = payload.amount

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'payload.amount must be a finite number above 0.' }
  }

  if (!isIsoTimestamp(payload.createdAt)) {
    return { ok: false, message: 'payload.createdAt must be an ISO 8601 timestamp.' }
  }

  if (!isIsoTimestamp(payload.updatedAt)) {
    return { ok: false, message: 'payload.updatedAt must be an ISO 8601 timestamp.' }
  }

  if (payload.status === 'held') {
    if (payload.paymentStatus !== 'pending') {
      return {
        ok: false,
        message: 'A held payload must have paymentStatus "pending".',
      }
    }

    if (!isIsoTimestamp(payload.heldAt)) {
      return { ok: false, message: 'payload.heldAt must be an ISO 8601 timestamp.' }
    }

    if (isPresent(payload, 'badgeNumber')) {
      return { ok: false, message: 'A held payload must not carry a badgeNumber.' }
    }

    if (isPresent(payload, 'completedAt')) {
      return { ok: false, message: 'A held payload must not carry a completedAt.' }
    }

    if (isPresent(payload, 'paymentMethod') && !isPaymentMethod(payload.paymentMethod)) {
      return {
        ok: false,
        message: 'payload.paymentMethod must be "upi" or "cash" when present.',
      }
    }

    return {
      ok: true,
      request: {
        outboxId: body.outboxId,
        registrationId,
        operation: SYNC_OPERATION,
        payload: payload as unknown as SyncHeldPayload,
      },
    }
  }

  if (payload.status === 'completed') {
    if (payload.paymentStatus !== 'confirmed') {
      return {
        ok: false,
        message: 'A completed payload must have paymentStatus "confirmed".',
      }
    }

    if (!isPaymentMethod(payload.paymentMethod)) {
      return {
        ok: false,
        message: 'A completed payload must have paymentMethod "upi" or "cash".',
      }
    }

    const badgeNumber = payload.badgeNumber

    if (
      typeof badgeNumber !== 'number' ||
      !Number.isInteger(badgeNumber) ||
      badgeNumber < 1
    ) {
      return {
        ok: false,
        message: 'payload.badgeNumber must be a positive integer.',
      }
    }

    if (!isIsoTimestamp(payload.completedAt)) {
      return {
        ok: false,
        message: 'payload.completedAt must be an ISO 8601 timestamp.',
      }
    }

    if (isPresent(payload, 'heldAt') && !isIsoTimestamp(payload.heldAt)) {
      return {
        ok: false,
        message: 'payload.heldAt must be an ISO 8601 timestamp when present.',
      }
    }

    return {
      ok: true,
      request: {
        outboxId: body.outboxId,
        registrationId,
        operation: SYNC_OPERATION,
        payload: payload as unknown as SyncCompletedPayload,
      },
    }
  }

  return { ok: false, message: 'payload.status must be "held" or "completed".' }
}
