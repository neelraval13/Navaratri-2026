/**
 * Badge numbers are stored internally as numbers and displayed as #001.
 */
export const formatBadgeNumber = (badgeNumber: number): string => {
  return `#${String(badgeNumber).padStart(3, '0')}`
}
