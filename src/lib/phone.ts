/**
 * Phone numbers are stored as raw digits and displayed as "98765 43210".
 * The +91 prefix is a separate visual element and is never part of the value.
 */
export const formatPhoneNumber = (digits: string): string => {
  if (digits.length <= 5) {
    return digits
  }

  return `${digits.slice(0, 5)} ${digits.slice(5)}`
}
