import type { AttendeeField, Gender } from '@/components/registration/types'

export const PHONE_LENGTH = 10

export const MAX_AGE = 120

const PHONE_PATTERN = /^\d{10}$/

const DIGITS_PATTERN = /^\d+$/

export const ATTENDEE_FIELD_MESSAGES: Record<AttendeeField, string> = {
  phone: 'Enter a 10-digit phone number.',
  name: "Enter the attendee's name.",
  age: 'Enter an age from 0 to 120.',
  gender: 'Select a gender.',
}

/**
 * The +91 prefix is a visual prefix, so the stored value is exactly 10 digits.
 */
export const isPhoneValid = (phone: string): boolean => {
  return PHONE_PATTERN.test(phone)
}

export const isNameValid = (name: string): boolean => {
  return name.trim() !== ''
}

/**
 * Digits only, representing an integer from 0 through 120 inclusive.
 */
export const isAgeValid = (age: string): boolean => {
  return DIGITS_PATTERN.test(age) && Number(age) <= MAX_AGE
}

/**
 * Also narrows the UI selection type to the domain gender, so a validated
 * attendee can be handed to the database layer without a cast.
 */
export const isGenderValid = (
  gender: Gender,
): gender is Exclude<Gender, ''> => {
  return gender !== ''
}

/**
 * Checked in operator entry order so Next always points at the first field
 * that blocks progression.
 */
export const getFirstInvalidAttendeeField = (
  phone: string,
  name: string,
  age: string,
  gender: Gender,
): AttendeeField | null => {
  if (!isPhoneValid(phone)) {
    return 'phone'
  }

  if (!isNameValid(name)) {
    return 'name'
  }

  if (!isAgeValid(age)) {
    return 'age'
  }

  if (!isGenderValid(gender)) {
    return 'gender'
  }

  return null
}
