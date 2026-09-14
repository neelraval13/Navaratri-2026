import { db } from '@/db/database'
import {
  EVENT_CONFIG_ID,
  isCompletedRegistration,
  isHeldRegistration,
  type CompletedRegistration,
  type HeldRegistration,
  type OutboxItem,
} from '@/db/types'
import { normalizeName } from '@/lib/name'
import type { Gender, PaymentMethod } from '@/types/registration'

export interface HoldRegistrationInput {
  /**
   * The existing registration id when re-holding a resumed record, otherwise
   * null. A resumed registration keeps its id for its whole life.
   */
  registrationId: string | null
  /** Raw 10 digits. Never +91, never display spacing. */
  phone: string
  /** The human-facing name exactly as the operator entered it. */
  name: string
  age: number
  gender: Gender
  /**
   * The method to store, or null to keep whatever the existing record already
   * has — and to store nothing at all for a brand-new hold. This is how a
   * Step 1 hold avoids persisting UPI just because the hidden Step 2 state
   * defaults to it.
   */
  paymentMethod: PaymentMethod | null
}

export type HoldRegistrationResult =
  | { outcome: 'created'; registration: HeldRegistration }
  | { outcome: 'updated'; registration: HeldRegistration }
  | { outcome: 'held-conflict'; registration: HeldRegistration }
  | { outcome: 'completed-conflict'; registration: CompletedRegistration }
  | { outcome: 'missing-config' }

/**
 * One pending outbox row per registration.
 *
 * Repeated local edits before a sync overwrite the same row with the latest
 * snapshot instead of piling up stale ones.
 */
export const buildPendingOutboxId = (registrationId: string): string => {
  return `registration:${registrationId}`
}

/**
 * Creates or updates a held registration and enqueues it for future
 * synchronization, atomically.
 *
 * A hold NEVER consumes a badge: `nextBadge` is not read for ownership and
 * never written, and the record carries no `badgeNumber` and no `completedAt`.
 *
 * Identity conflicts are re-checked against the compound index inside the same
 * transaction, so a stale UI lookup cannot let a duplicate through. They are
 * reported as typed outcomes rather than thrown, since they are normal product
 * states; only unexpected database failures reject.
 *
 * The caller must have validated the attendee fields first.
 */
export const holdRegistration = async (
  input: HoldRegistrationInput,
): Promise<HoldRegistrationResult> => {
  const name = input.name.trim()
  const normalizedName = normalizeName(input.name)

  return await db.transaction(
    'rw',
    db.registrations,
    db.config,
    db.outbox,
    async (): Promise<HoldRegistrationResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)

      if (config === undefined) {
        return { outcome: 'missing-config' }
      }

      const existing =
        input.registrationId === null
          ? undefined
          : await db.registrations.get(input.registrationId)

      // A completed registration must never be downgraded back to held.
      if (existing !== undefined && isCompletedRegistration(existing)) {
        return { outcome: 'completed-conflict', registration: existing }
      }

      const sameIdentity = await db.registrations
        .where('[phone+normalizedName]')
        .equals([input.phone, normalizedName])
        .toArray()

      // The record being edited is not a conflict with itself.
      const conflicts = sameIdentity.filter(
        (registration) => registration.id !== input.registrationId,
      )

      // Completed always wins, even against a held record found first.
      const completedConflict = conflicts.find(isCompletedRegistration)

      if (completedConflict !== undefined) {
        return {
          outcome: 'completed-conflict',
          registration: completedConflict,
        }
      }

      const heldConflict = conflicts.find(isHeldRegistration)

      if (heldConflict !== undefined) {
        return { outcome: 'held-conflict', registration: heldConflict }
      }

      const now = new Date().toISOString()
      const paymentMethod = input.paymentMethod ?? existing?.paymentMethod

      const registration: HeldRegistration = {
        id: input.registrationId ?? crypto.randomUUID(),
        name,
        normalizedName,
        phone: input.phone,
        age: input.age,
        gender: input.gender,
        amount: config.amount,
        status: 'held',
        paymentStatus: 'pending',
        ...(paymentMethod === undefined ? {} : { paymentMethod }),
        // The time of the CURRENT hold, refreshed every time it is held again.
        heldAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      await db.registrations.put(registration)

      const outboxItem: OutboxItem = {
        id: buildPendingOutboxId(registration.id),
        registrationId: registration.id,
        operation: 'upsert',
        payload: registration,
        createdAt: now,
        attemptCount: 0,
      }

      // Same transaction as the registration write, so the queue can never
      // drift from the record. lastAttemptAt and lastError are reset by
      // omission.
      await db.outbox.put(outboxItem)

      return existing === undefined
        ? { outcome: 'created', registration }
        : { outcome: 'updated', registration }
    },
  )
}
