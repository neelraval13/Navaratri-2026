import { db } from '@/db/database'
import { hasBadgeAvailable } from '@/db/event-config'
import {
  EVENT_CONFIG_ID,
  isCompletedRegistration,
  isHeldRegistration,
  type CompletedRegistration,
  type EventConfig,
  type HeldRegistration,
  type OutboxItem,
  type RegistrationRecord,
} from '@/db/types'
import { normalizeName } from '@/lib/name'
import type { Gender, PaymentMethod } from '@/types/registration'

/**
 * An identity conflict with a registration OTHER than the one being written.
 *
 * Completed always wins over held: an issued badge must never be shadowed by a
 * hold. Shared by Hold and Issue Badge so both defend identically.
 */
const findIdentityConflict = (
  sameIdentity: RegistrationRecord[],
  registrationId: string | null,
):
  | { outcome: 'completed-conflict'; registration: CompletedRegistration }
  | { outcome: 'held-conflict'; registration: HeldRegistration }
  | null => {
  const conflicts = sameIdentity.filter(
    (registration) => registration.id !== registrationId,
  )

  const completedConflict = conflicts.find(isCompletedRegistration)

  if (completedConflict !== undefined) {
    return { outcome: 'completed-conflict', registration: completedConflict }
  }

  const heldConflict = conflicts.find(isHeldRegistration)

  if (heldConflict !== undefined) {
    return { outcome: 'held-conflict', registration: heldConflict }
  }

  return null
}

export interface HoldRegistrationInput {
  /**
   * The existing registration id when re-holding a resumed record, otherwise
   * null. A resumed registration keeps its id for its whole life.
   */
  registrationId: string | null
  /** Raw 10 digits. Never +91, never display spacing. */
  phone: string
  /**
   * Human-facing name; persistence trims leading/trailing whitespace while
   * preserving internal spacing.
   */
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
      const identityConflict = findIdentityConflict(
        sameIdentity,
        input.registrationId,
      )

      if (identityConflict !== null) {
        return identityConflict
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

export interface IssueBadgeInput {
  /**
   * The held registration being completed, or null for a brand-new attendee.
   * A resumed registration keeps its id: it is transitioned in place, never
   * duplicated.
   */
  registrationId: string | null
  /** Raw 10 digits. Never +91, never display spacing. */
  phone: string
  /**
   * Human-facing name; persistence trims leading/trailing whitespace while
   * preserving internal spacing.
   */
  name: string
  age: number
  gender: Gender
  /** The method the operator already confirmed in the UI. */
  paymentMethod: PaymentMethod
}

export type IssueBadgeResult =
  | {
      outcome: 'issued'
      registration: CompletedRegistration
      /** The authoritative config value AFTER the increment. */
      nextBadge: number
      /** The stored config row after the increment, for refreshing the UI. */
      config: EventConfig
    }
  | { outcome: 'missing-config' }
  | { outcome: 'missing-active-registration' }
  | { outcome: 'completed-conflict'; registration: CompletedRegistration }
  | { outcome: 'held-conflict'; registration: HeldRegistration }
  | { outcome: 'badge-range-exhausted'; badgeNumber: number; badgeEnd: number }
  | { outcome: 'badge-conflict'; badgeNumber: number; assignedTo: string }

/**
 * Allocates the current physical badge and completes the registration.
 *
 * This is the ONLY thing that consumes a badge. Opening the form, Next, payment
 * selection, payment confirmation, Hold, Resume, Back and Clear all leave
 * `nextBadge` untouched; only a successful transaction here advances it, and it
 * advances exactly once.
 *
 * Everything happens in one transaction: read config, validate the range, load
 * the resumed record, re-check identity conflicts against the compound index,
 * verify the badge number is free, write the completed registration, increment
 * `nextBadge`, and replace the registration's single pending outbox row with the
 * completed snapshot. Any conflict returns before the first write, so a refused
 * issuance mutates nothing at all.
 *
 * `paymentStatus` is constructed here as `confirmed` rather than accepted from
 * the caller. Normal product conflicts are typed outcomes; only unexpected
 * database failures reject.
 */
export const issueBadge = async (
  input: IssueBadgeInput,
): Promise<IssueBadgeResult> => {
  const name = input.name.trim()
  const normalizedName = normalizeName(input.name)

  return await db.transaction(
    'rw',
    db.registrations,
    db.config,
    db.outbox,
    async (): Promise<IssueBadgeResult> => {
      const config = await db.config.get(EVENT_CONFIG_ID)

      if (config === undefined) {
        return { outcome: 'missing-config' }
      }

      const badgeNumber = config.nextBadge

      // Enforced here too, so a stale UI can never push past the range.
      if (!hasBadgeAvailable(config)) {
        return {
          outcome: 'badge-range-exhausted',
          badgeNumber,
          // hasBadgeAvailable is only false when badgeEnd is defined.
          badgeEnd: config.badgeEnd ?? badgeNumber,
        }
      }

      const existing =
        input.registrationId === null
          ? undefined
          : await db.registrations.get(input.registrationId)

      if (input.registrationId !== null) {
        if (existing === undefined) {
          // Never silently recreate a record under a id that no longer exists.
          return { outcome: 'missing-active-registration' }
        }

        if (isCompletedRegistration(existing)) {
          return { outcome: 'completed-conflict', registration: existing }
        }
      }

      const sameIdentity = await db.registrations
        .where('[phone+normalizedName]')
        .equals([input.phone, normalizedName])
        .toArray()

      const identityConflict = findIdentityConflict(
        sameIdentity,
        input.registrationId,
      )

      if (identityConflict !== null) {
        return identityConflict
      }

      // A config that has drifted from the physical badge sequence needs
      // operator attention: never silently skip to the next free number.
      const badgeHolder = await db.registrations
        .where('badgeNumber')
        .equals(badgeNumber)
        .first()

      if (badgeHolder !== undefined) {
        return {
          outcome: 'badge-conflict',
          badgeNumber,
          assignedTo: badgeHolder.name,
        }
      }

      const now = new Date().toISOString()

      const registration: CompletedRegistration = {
        id: input.registrationId ?? crypto.randomUUID(),
        name,
        normalizedName,
        phone: input.phone,
        age: input.age,
        gender: input.gender,
        amount: config.amount,
        status: 'completed',
        paymentStatus: 'confirmed',
        paymentMethod: input.paymentMethod,
        badgeNumber,
        completedAt: now,
        // A resumed hold keeps when it was first created and when it was held.
        ...(existing === undefined ? {} : { heldAt: existing.heldAt }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      // Overwrites the held row in place; no second registration is created.
      await db.registrations.put(registration)

      const updatedConfig: EventConfig = {
        ...config,
        nextBadge: badgeNumber + 1,
        updatedAt: now,
      }

      await db.config.put(updatedConfig)

      const outboxItem: OutboxItem = {
        id: buildPendingOutboxId(registration.id),
        registrationId: registration.id,
        operation: 'upsert',
        payload: registration,
        createdAt: now,
        attemptCount: 0,
      }

      // The same deterministic row a Hold may have written is replaced with the
      // completed snapshot, so exactly one pending row remains.
      await db.outbox.put(outboxItem)

      return {
        outcome: 'issued',
        registration,
        nextBadge: updatedConfig.nextBadge,
        config: updatedConfig,
      }
    },
  )
}
