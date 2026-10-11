import { formatBadgeNumber } from '@/lib/badge'
import { ATTENDEE_MAX_AGE, type AttendeeGender, type EventAttendee } from '@/shared/attendee-contract'

/**
 * Finding one attendee in a few hundred, as pure functions.
 *
 * THE ONE IMPLEMENTATION, for every module that lists attendees. Phase P1
 * wrote these for the prize desk; Phase A1 added the read-only directory at
 * `/attendees` and moved them here rather than writing a second set. Search
 * semantics, the age window and gender normalisation would otherwise drift
 * between two screens that are supposed to find the same person.
 *
 * PURE on purpose: no React, no fetch, no state. A volunteer is squinting at
 * a tablet while somebody waits, so "does this filter actually find Meera,
 * aged 15" has to be answerable without rendering anything.
 *
 * CLIENT-SIDE, after ONE roster fetch. The event is a few hundred attendees;
 * a query per keystroke would add latency and server complexity to solve a
 * problem of a size this event does not have.
 */

export type AttendeeGenderFilter = 'all' | AttendeeGender

export interface AttendeeFilterState {
  /** Matches a badge number or an attendee name. */
  search: string
  /** Kept as TYPED TEXT, so an empty field stays empty rather than becoming 0. */
  minAge: string
  maxAge: string
  gender: AttendeeGenderFilter
}

export const EMPTY_ATTENDEE_FILTERS: AttendeeFilterState = {
  search: '',
  minAge: '',
  maxAge: '',
  gender: 'all',
}

export const hasActiveAttendeeFilters = (state: AttendeeFilterState): boolean => {
  return (
    state.search.trim() !== '' ||
    state.minAge.trim() !== '' ||
    state.maxAge.trim() !== '' ||
    state.gender !== 'all'
  )
}

export type AgeBoundsResult =
  | { ok: true; min: number | null; max: number | null }
  | { ok: false; message: string }

/**
 * The age window, from two fields either of which may be blank.
 *
 * A blank bound means "no bound", NOT zero: leaving the minimum empty must
 * include the five-year-olds, and treating it as 0 would only work by
 * accident. `min > max` is refused rather than silently swapped — a filter
 * that quietly reinterprets what was typed is a filter nobody can trust when
 * the list comes back empty.
 */
export const parseAgeBounds = (state: {
  minAge: string
  maxAge: string
}): AgeBoundsResult => {
  const read = (raw: string): number | null | 'invalid' => {
    const trimmed = raw.trim()

    if (trimmed === '') {
      return null
    }

    const parsed = Number(trimmed)

    return Number.isInteger(parsed) && parsed >= 0 && parsed <= ATTENDEE_MAX_AGE
      ? parsed
      : 'invalid'
  }

  const min = read(state.minAge)
  const max = read(state.maxAge)

  if (min === 'invalid' || max === 'invalid') {
    return {
      ok: false,
      message: `Enter ages as whole numbers between 0 and ${String(ATTENDEE_MAX_AGE)}.`,
    }
  }

  if (min !== null && max !== null && min > max) {
    return { ok: false, message: 'The minimum age must not be above the maximum.' }
  }

  return { ok: true, min, max }
}

/** Only the digits, so `#042`, `042` and `42` are the same query. */
const digitsOf = (value: string): string => value.replace(/\D/g, '')

/**
 * Does this badge number match what was typed?
 *
 * Both the bare number and the zero-padded display form are searched, because
 * the badge in the operator's hand reads `#042` while the register stores 42.
 */
const badgeMatches = (badgeNumber: number, query: string): boolean => {
  const digits = digitsOf(query)

  if (digits === '') {
    return false
  }

  return (
    String(badgeNumber).includes(digits) ||
    formatBadgeNumber(badgeNumber).slice(1).includes(digits)
  )
}

const textMatches = (value: string, query: string): boolean =>
  value.toLowerCase().includes(query.trim().toLowerCase())

/**
 * The ATTENDEE search: badge number or attendee name, nothing else.
 *
 * Deliberately not a phone number: the prize screen never receives one.
 *
 * It knows nothing about prizes, which is the point. Searching `9005` after
 * #9005 has been given three prizes still finds #9005 — nothing in this file
 * can look at the award history, so nothing here can hide a winner.
 */
export const matchesAttendeeSearch = (
  attendee: EventAttendee,
  search: string,
): boolean => {
  const query = search.trim()

  if (query === '') {
    return true
  }

  return badgeMatches(attendee.badgeNumber, query) || textMatches(attendee.name, query)
}

/**
 * Search, age window and gender COMPOSE: every active filter must pass.
 *
 * Input order is preserved, so the badge-ascending roster stays
 * badge-ascending. An unusable age window filters nothing — the screen
 * reports the problem instead of pretending nobody matched.
 *
 * ALL REGISTERED ATTENDEES ARE FILTERED. The signature is the reason that
 * cannot quietly change: this function is given the roster and the filter
 * state and NOTHING ELSE — no award history, no prize count, no device state
 * — so no filter can be made to exclude a previous winner, or anybody else,
 * without changing what it is handed.
 */
export const filterAttendees = (
  attendees: readonly EventAttendee[],
  state: AttendeeFilterState,
): EventAttendee[] => {
  const bounds = parseAgeBounds(state)

  return attendees.filter((attendee) => {
    if (!matchesAttendeeSearch(attendee, state.search)) {
      return false
    }

    if (state.gender !== 'all' && attendee.gender !== state.gender) {
      return false
    }

    if (bounds.ok === false) {
      return true
    }

    if (bounds.min !== null && attendee.age < bounds.min) {
      return false
    }

    return bounds.max === null || attendee.age <= bounds.max
  })
}
