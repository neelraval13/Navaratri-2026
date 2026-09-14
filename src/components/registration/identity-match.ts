import type {
  CompletedRegistration,
  HeldRegistration,
  RegistrationRecord,
} from '@/db/types'
import { normalizeName } from '@/lib/name'

export type IdentityMatch =
  | { kind: 'unknown' }
  | { kind: 'new' }
  | { kind: 'held'; registration: HeldRegistration }
  | { kind: 'completed'; registration: CompletedRegistration }

export const UNKNOWN_IDENTITY_MATCH: IdentityMatch = { kind: 'unknown' }

const isCompleted = (
  registration: RegistrationRecord,
): registration is CompletedRegistration => {
  return registration.status === 'completed'
}

const isHeld = (
  registration: RegistrationRecord,
): registration is HeldRegistration => {
  return registration.status === 'held'
}

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

  const completedMatch = matches.find(isCompleted)

  if (completedMatch !== undefined) {
    return { kind: 'completed', registration: completedMatch }
  }

  const heldMatch = matches.find(isHeld)

  if (heldMatch !== undefined) {
    return { kind: 'held', registration: heldMatch }
  }

  return { kind: 'new' }
}
