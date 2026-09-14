import {
  isCompletedRegistration,
  isHeldRegistration,
  type CompletedRegistration,
  type HeldRegistration,
  type RegistrationRecord,
} from '@/db/types'
import { normalizeName } from '@/lib/name'

export type IdentityMatch =
  | { kind: 'unknown' }
  | { kind: 'new' }
  | { kind: 'held'; registration: HeldRegistration }
  | { kind: 'completed'; registration: CompletedRegistration }

export const UNKNOWN_IDENTITY_MATCH: IdentityMatch = { kind: 'unknown' }

/**
 * Resolves the attendee identity against the registrations already using the
 * same phone number.
 *
 * The compound `[phone+normalizedName]` index remains available, but the phone
 * result set is already in memory, so every name keystroke is matched without
 * another database round trip.
 *
 * That index is not unique in version 1, so corrupt data could hold more than
 * one record for the same identity. A completed match always wins over a held
 * match: an already-issued badge must never be downgraded to "on hold".
 */
export const getIdentityMatch = (
  registrations: RegistrationRecord[],
  name: string,
): IdentityMatch => {
  const normalizedName = normalizeName(name)

  if (normalizedName === '') {
    return UNKNOWN_IDENTITY_MATCH
  }

  const matches = registrations.filter(
    (registration) => registration.normalizedName === normalizedName,
  )

  const completedMatch = matches.find(isCompletedRegistration)

  if (completedMatch !== undefined) {
    return { kind: 'completed', registration: completedMatch }
  }

  const heldMatch = matches.find(isHeldRegistration)

  if (heldMatch !== undefined) {
    return { kind: 'held', registration: heldMatch }
  }

  return { kind: 'new' }
}

/**
 * The registration OTHER than the one being edited that this identity collides
 * with, or null when there is none.
 *
 * `getIdentityMatch` reports a single best match, which is the right thing to
 * SHOW, but it cannot answer this question on its own. If corrupt data holds
 * two held records for one identity and the active record happens to be found
 * first, the other one would go unnoticed and the UI would wrongly allow
 * progression. This inspects every exact match in the same already-loaded phone
 * result set instead, so no extra query is issued.
 *
 * Priority:
 *
 * 1. ANY completed exact match — never excluded, not even the active id, since
 *    an issued badge must never be downgraded
 * 2. ANY held exact match whose id is not the active registration
 * 3. otherwise null — either only the active record matches, or nothing does
 *    because the operator corrected the phone or name
 *
 * Precondition: `registrations` are the records already using the current phone
 * number, exactly as `getIdentityMatch` expects.
 */
export const findOtherRegistrationConflict = (
  registrations: RegistrationRecord[],
  name: string,
  activeRegistrationId: string | null,
): RegistrationRecord | null => {
  const normalizedName = normalizeName(name)

  if (normalizedName === '') {
    return null
  }

  const matches = registrations.filter(
    (registration) => registration.normalizedName === normalizedName,
  )

  const completedConflict = matches.find(isCompletedRegistration)

  if (completedConflict !== undefined) {
    return completedConflict
  }

  // Only the record being edited is excluded; every other held match counts.
  const heldConflict = matches.find(
    (registration) =>
      isHeldRegistration(registration) &&
      registration.id !== activeRegistrationId,
  )

  return heldConflict ?? null
}
