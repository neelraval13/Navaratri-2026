import type { OutboxSyncErrorCode } from '@/shared/sync-contract'
import type { Gender, PaymentMethod } from '@/types/registration'

/**
 * The event configuration is a single deterministic row.
 */
export const EVENT_CONFIG_ID = 'event'

/**
 * Attendee fields shared by every registration, whatever its status.
 */
interface RegistrationAttendee {
  id: string
  /**
   * Human-facing name with leading/trailing whitespace trimmed; internal
   * spacing is preserved. Never the normalized form.
   */
  name: string
  /** Normalized form used for identity and duplicate matching. */
  normalizedName: string
  /** Raw 10-digit Indian number, e.g. `9876543210`. Never +91, spaces or display formatting. */
  phone: string
  age: number
  gender: Gender
  amount: number
  /** ISO 8601 UTC, from `new Date().toISOString()`. */
  createdAt: string
  /** ISO 8601 UTC. */
  updatedAt: string
}

/**
 * A held registration is saved for later WITHOUT consuming a badge.
 *
 * `badgeNumber` and `completedAt` are typed as `never` so the invariant is
 * enforced at compile time rather than by convention.
 */
export interface HeldRegistration extends RegistrationAttendee {
  status: 'held'
  paymentStatus: 'pending'
  /** The operator may have chosen a method before holding. */
  paymentMethod?: PaymentMethod
  /** ISO 8601 UTC. */
  heldAt: string
  badgeNumber?: never
  completedAt?: never
}

/**
 * A completed registration represents a successfully issued physical badge.
 */
export interface CompletedRegistration extends RegistrationAttendee {
  status: 'completed'
  paymentStatus: 'confirmed'
  paymentMethod: PaymentMethod
  badgeNumber: number
  /** ISO 8601 UTC. */
  completedAt: string
  /** Present only when this registration was resumed from a hold. */
  heldAt?: string
}

/**
 * `RegistrationRecord['status']` is exactly `RegistrationStatus`, and
 * `RegistrationRecord['paymentStatus']` is exactly `PaymentStatus`.
 */
export type RegistrationRecord = HeldRegistration | CompletedRegistration

export interface EventConfig {
  id: typeof EVENT_CONFIG_ID
  eventName: string
  currency: string
  amount: number
  /** IANA zone used later to render human-facing Date and Time columns. */
  timezone: string
  badgeStart: number
  /** Undefined until the operator supplies a badge range. */
  badgeEnd?: number
  nextBadge: number
  /** Undefined until the operator supplies the organizer UPI details. */
  upiId?: string
  payeeName?: string
  /** ISO 8601 UTC. */
  updatedAt: string
}

/**
 * Narrowing helpers for the discriminated union. They live beside the model so
 * the database layer never has to import a UI module to tell the two apart.
 */
export const isCompletedRegistration = (
  registration: RegistrationRecord,
): registration is CompletedRegistration => {
  return registration.status === 'completed'
}

export const isHeldRegistration = (
  registration: RegistrationRecord,
): registration is HeldRegistration => {
  return registration.status === 'held'
}

export type OutboxOperation = 'upsert'

/**
 * Durable queue of registration states awaiting synchronization.
 *
 * Holding a registration writes or overwrites that registration's single
 * pending row in the same transaction as the registration itself, so the queue
 * can never drift from the record.
 *
 * The browser processor drains it: a row is deleted only when the server
 * acknowledges the EXACT snapshot the row still holds.
 */
export interface OutboxItem {
  id: string
  registrationId: string
  operation: OutboxOperation
  /** The registration state that needs to be synchronized. */
  payload: RegistrationRecord
  /** ISO 8601 UTC. */
  createdAt: string
  /** Network sync attempts made for the CURRENT snapshot. Reset to 0 by a new one. */
  attemptCount: number
  /** ISO 8601 UTC. */
  lastAttemptAt?: string
  /** Operator-safe summary of the last failure. Never a stack trace. */
  lastError?: string
  /**
   * Machine-readable last failure, used to separate retryable failures from
   * ones needing operator attention.
   *
   * Optional and NON-INDEXED: IndexedDB records may carry extra properties, so
   * this needs no store change, no new index and no version bump.
   */
  lastErrorCode?: OutboxSyncErrorCode
}
