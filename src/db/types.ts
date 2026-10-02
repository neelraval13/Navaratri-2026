import type { DeviceAttribute } from '@/shared/device-attributes'
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
  /**
   * Which device produced this registration state.
   *
   * Snapshotted when the state is WRITTEN, never derived later at send time, so
   * a queued outbox snapshot already carries its own provenance and a later
   * device configuration change can never rewrite history behind the processor.
   *
   * Optional only for legacy compatibility with records written before Phase 7.
   * Every new hold and issue requires both, because both require a configured
   * device.
   */
  deviceId?: string
  deviceName?: string
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
  /**
   * Undefined until Device Setup assigns this desk a range. A CONFIGURED device
   * always has a finite end: Phase 7 permits no open-ended range, because an
   * open range is exactly how two offline desks issue the same physical badge.
   */
  badgeEnd?: number
  nextBadge: number
  /**
   * Stable identity for this browser/device installation, generated once by
   * `crypto.randomUUID()` at Device Setup and never regenerated in normal use.
   *
   * These live on the EXISTING config row: no new store, no new index, and
   * therefore no Dexie version bump.
   */
  deviceId?: string
  /** Operator-supplied label, e.g. `Registration Desk A`. */
  deviceName?: string
  /** ISO 8601 UTC, written when the device itself was registered. */
  deviceConfiguredAt?: string
  /**
   * ISO 8601 UTC, written when this device was assigned a badge range.
   *
   * Absent on a legacy Phase 7 device that was configured before the field
   * existed; its absence must never invalidate that device's badge ownership.
   */
  badgeConfiguredAt?: string
  /** Undefined until the operator supplies the organizer UPI details. */
  upiId?: string
  payeeName?: string
  /**
   * The last CENTRAL device identity this browser successfully verified.
   *
   * Entirely separate from the Phase 7 fields above. `deviceId` and
   * `deviceName` there are this browser's own local identity, used by the
   * offline badge workflow and stamped onto registration provenance; the
   * central values below belong to a row in Postgres. They are never merged,
   * and central values never overwrite local ones — that convergence is a
   * later, deliberate migration.
   */
  centralDeviceEnrollment?: CentralDeviceEnrollment
  /**
   * Provenance for a local badge range that was deliberately adopted from a
   * CENTRAL badge assignment.
   *
   * Separate from `centralDeviceEnrollment` on purpose: that records which
   * central identity this browser verified, this records that the local badge
   * range above came from that identity's assignment rather than from a
   * hand-typed Phase 7 setup. A later reconnect needs to tell those two apart.
   */
  centralBadgeRangeBinding?: CentralBadgeRangeBinding
  /**
   * The signed OFFLINE AUTHORIZATION LEASE this browser last verified.
   *
   * Separate from both records above, because it is the only one of the three
   * that can be trusted without a server: the other two are unsigned local
   * metadata, this is a server signature over what the device was allowed to
   * do and until when.
   */
  centralDeviceOfflineAuthorization?: CentralDeviceOfflineAuthorization
  /** ISO 8601 UTC. */
  updatedAt: string
}

/**
 * The cached offline lease. THE TOKEN IS THE AUTHORITY.
 *
 * No decoded claim is stored beside it — not the attributes, not the badge
 * range, not the expiry. A second unsigned copy of "what this device may do"
 * would be trivially editable and indistinguishable from the signed answer,
 * so every read verifies the signature again with the pinned public key.
 *
 * `receivedAt` is local bookkeeping only. It grants nothing and is never
 * used in place of the signed `exp`.
 */
export interface CentralDeviceOfflineAuthorization {
  /** `<base64url payload>.<base64url P-256 signature>`. */
  token: string
  /** ISO 8601 UTC, when this browser verified and stored it. */
  receivedAt: string
}

/**
 * Why this desk's badge range is the range it is.
 *
 * PROVENANCE, NOT AN ALLOCATOR. `badgeStart`, `badgeEnd` and `nextBadge` above
 * remain the only badge state the issuance transaction reads, and `nextBadge`
 * is never mirrored here — a second copy of the counter is a second thing that
 * can drift from the physical stack.
 *
 * It records enough to reconcile later: which central device and event the
 * range belongs to, the exact range as assigned, when CENTRAL assigned it, and
 * when THIS browser adopted it.
 *
 * Deliberately absent, and none may be added: `nextBadge`, any password or
 * hash, the session token, the cookie, `sessionVersion`.
 */
export interface CentralBadgeRangeBinding {
  /** The central `devices.id` UUID that owns the assignment. */
  deviceId: string
  /** The central `events.id` UUID. */
  eventId: string
  rangeStart: number
  rangeEnd: number
  /** ISO 8601 UTC, from the central assignment. Never re-stamped locally. */
  assignedAt: string
  /** ISO 8601 UTC, when this browser adopted it. */
  adoptedAt: string
}

/**
 * A SAFE snapshot of the central device this browser is bound to.
 *
 * It answers exactly one question: "which central device did this browser
 * last prove it is, and when?"
 *
 * It is NOT permission to operate. Nothing authorizes an event route from
 * this record, and it must never be described as authenticating anything
 * offline — the HttpOnly session cookie remains the only credential, and
 * `GET /api/device-auth` the only way to check it. The offline trust rules
 * are Phase 9C-C3.
 *
 * Deliberately ABSENT, and none may be added here:
 *
 * - the password, its hash, its salt or any derived key
 * - the session token, the cookie, or `sessionVersion`
 * - `activeBadgeRange`, `rangeStart`, `rangeEnd` — the central badge range is
 *   NOT imported into local state in this phase (Phase 9C-C2 owns that), and
 *   writing it here would silently change which physical badges this desk
 *   believes it owns
 *
 * Every field is projected explicitly from the verified server response; the
 * response is never stored wholesale, so a field the server adds later cannot
 * arrive here by accident.
 */
export interface CentralDeviceEnrollment {
  /** The central `devices.id` UUID. Never copied over the local `deviceId`. */
  deviceId: string
  /** The central `events.id` UUID. */
  eventId: string
  eventSlug: string
  /** The central display name. Never copied over the local `deviceName`. */
  deviceName: string
  loginName: string
  /** Verified against the application allow-list before being stored. */
  attributes: DeviceAttribute[]
  /** ISO 8601 UTC, when the SERVER last confirmed this identity. */
  verifiedAt: string
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
