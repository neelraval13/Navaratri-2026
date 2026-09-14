import type { Gender as DomainGender } from '@/types/registration'

export type { PaymentMethod } from '@/types/registration'

export type RegistrationStep = 'attendee' | 'payment'

/**
 * The attendee form starts with no gender selected, so the UI selection type is
 * the domain gender plus an empty option. Stored records only ever hold a real
 * domain gender.
 */
export type Gender = DomainGender | ''

export type AttendeeField = 'phone' | 'name' | 'age' | 'gender'

export interface BlockedAttendeeField {
  field: AttendeeField
  /**
   * Increments on every blocked Next press so a repeated attempt on the same
   * field still re-triggers the focus and jitter feedback.
   */
  attempt: number
}

/**
 * Outcome of the most recent Hold attempt, shown above the current step.
 */
export type HoldNotice =
  | { kind: 'held'; name: string }
  | { kind: 'error'; message: string }
