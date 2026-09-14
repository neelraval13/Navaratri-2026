/**
 * Domain vocabulary shared by the UI and the local database.
 *
 * This module must not depend on UI component files.
 */

export type Gender = 'male' | 'female'

export type PaymentMethod = 'upi' | 'cash'

export type RegistrationStatus = 'held' | 'completed'

export type PaymentStatus = 'pending' | 'confirmed'
