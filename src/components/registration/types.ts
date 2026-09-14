export type RegistrationStep = 'attendee' | 'payment'

export type Gender = '' | 'male' | 'female'

export type PaymentMethod = 'upi' | 'cash'

export type AttendeeField = 'phone' | 'name' | 'age' | 'gender'

export interface BlockedAttendeeField {
  field: AttendeeField
  /**
   * Increments on every blocked Next press so a repeated attempt on the same
   * field still re-triggers the focus and jitter feedback.
   */
  attempt: number
}
