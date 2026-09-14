/**
 * Comparison form used for duplicate detection.
 *
 * The rules are exactly: trim leading and trailing whitespace, collapse
 * repeated internal whitespace to a single space, lowercase. No fuzzy
 * matching, no phonetic matching, no punctuation stripping, no spelling
 * correction.
 *
 * "Rahul Sharma", " rahul   sharma " and "RAHUL SHARMA" all normalize to
 * "rahul sharma".
 *
 * The human-facing name the operator typed is never modified.
 */
export const normalizeName = (name: string): string => {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}
