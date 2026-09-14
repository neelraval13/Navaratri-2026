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
  /** Human-facing name exactly as the operator entered it. */
  name: string
  /** Normalized form reserved for duplicate detection in a later phase. */
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

export type OutboxOperation = 'upsert'

/**
 * Durable queue of registration states awaiting synchronization.
 *
 * This phase only establishes the table. Nothing enqueues or drains it yet.
 */
export interface OutboxItem {
  id: string
  registrationId: string
  operation: OutboxOperation
  /** The registration state that needs to be synchronized. */
  payload: RegistrationRecord
  /** ISO 8601 UTC. */
  createdAt: string
  attemptCount: number
  /** ISO 8601 UTC. */
  lastAttemptAt?: string
  lastError?: string
}
