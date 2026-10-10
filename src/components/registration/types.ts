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
 * Outcome of the most recent Hold or Issue Badge attempt, shown above the
 * current step.
 */
export type FormNotice =
  | { kind: 'held'; name: string }
  | {
      kind: 'error'
      message: string
      /**
       * An optional way OUT of the error, as a route.
       *
       * Only one error has one: an exhausted badge range, where the next step
       * is a refill at Device Sign-In rather than anything in this form. It is
       * a link, never a mutation — nothing in the registration workflow writes
       * a badge range.
       */
      action?: { href: string; label: string }
    }
