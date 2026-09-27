import {
  BADGE_RANGE_REQUIRED_ATTRIBUTE,
  parseAttributeSet,
  type DeviceAttribute,
} from '../../src/shared/device-attributes.js'
import { checkPasswordPair } from '../../src/shared/device-password.js'

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

const MAX_NAME_LENGTH = 120
const MAX_SLUG_LENGTH = 64
const MAX_TIMEZONE_LENGTH = 64
const MAX_LOGIN_NAME_LENGTH = 64

/** Lowercase, URL-safe, hyphen-separated. No leading, trailing or doubled hyphen. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Same shape as a slug: it becomes a username in Phase 9C. */
const LOGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const readTrimmedString = (value: unknown): string | null => {
  return typeof value === 'string' ? value.trim() : null
}

/**
 * A real IANA zone, checked by asking the platform rather than by keeping a
 * list that would drift. `Intl` throws on an unknown identifier.
 */
const isIanaTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value })

    return true
  } catch {
    return false
  }
}

const isIsoTimestamp = (value: string): boolean => {
  return !Number.isNaN(Date.parse(value))
}

export interface CreateEventInput {
  name: string
  slug: string
  timezone: string
  startsAt: Date | null
  endsAt: Date | null
}

export const parseCreateEventInput = (
  body: unknown,
): ValidationResult<CreateEventInput> => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const name = readTrimmedString(body.name)

  if (name === null || name === '' || name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `Enter an event name of 1-${String(MAX_NAME_LENGTH)} characters.` }
  }

  const slug = readTrimmedString(body.slug)

  if (slug === null || !SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_LENGTH) {
    return {
      ok: false,
      message: 'Slug must be lowercase letters, numbers and single hyphens, e.g. navaratri-2026.',
    }
  }

  const timezone = readTrimmedString(body.timezone)

  if (
    timezone === null ||
    timezone === '' ||
    timezone.length > MAX_TIMEZONE_LENGTH ||
    !isIanaTimezone(timezone)
  ) {
    return { ok: false, message: 'Enter a valid IANA timezone, e.g. Asia/Kolkata.' }
  }

  const parseOptionalDate = (
    value: unknown,
    label: string,
  ): ValidationResult<Date | null> => {
    if (value === undefined || value === null || value === '') {
      return { ok: true, value: null }
    }

    if (typeof value !== 'string' || !isIsoTimestamp(value)) {
      return { ok: false, message: `${label} must be a valid timestamp.` }
    }

    return { ok: true, value: new Date(value) }
  }

  const startsAt = parseOptionalDate(body.startsAt, 'Start')

  if (!startsAt.ok) {
    return startsAt
  }

  const endsAt = parseOptionalDate(body.endsAt, 'End')

  if (!endsAt.ok) {
    return endsAt
  }

  if (
    startsAt.value !== null &&
    endsAt.value !== null &&
    endsAt.value < startsAt.value
  ) {
    return { ok: false, message: 'The end time must not be before the start time.' }
  }

  return {
    ok: true,
    value: { name, slug, timezone, startsAt: startsAt.value, endsAt: endsAt.value },
  }
}

export interface CreateDeviceInput {
  name: string
  loginName: string | null
  enabled: boolean
  attributes: DeviceAttribute[]
  /** The plaintext to hash, or `null` to create the device unprovisioned. */
  password: string | null
}

export type CredentialBlock = 'device-has-no-login-name' | 'password-mismatch'

/**
 * The shared credential rules for Create Device and Set Password.
 *
 * `password` absent, null or empty means NO CREDENTIALS — a device may be
 * created as inventory and provisioned later. Once a password is supplied it
 * must match its confirmation and satisfy the length policy.
 *
 * A device cannot hold credentials without a login name: the pair is what a
 * future device login will present. A login name is never generated to make
 * the request succeed.
 */
export const parseCredentialInput = (
  body: Record<string, unknown>,
  context: { hasLoginName: boolean; required: boolean },
): ValidationResult<string | null> => {
  const result = checkPasswordPair({
    password: body.password,
    confirmPassword: body.confirmPassword,
    hasLoginName: context.hasLoginName,
    required: context.required,
  })

  return result.ok ? { ok: true, value: result.password } : result
}

export const parseCreateDeviceInput = (
  body: unknown,
): ValidationResult<CreateDeviceInput> => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const name = readTrimmedString(body.name)

  if (name === null || name === '' || name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `Enter a device name of 1-${String(MAX_NAME_LENGTH)} characters.` }
  }

  const loginName = parseLoginName(body.loginName)

  if (!loginName.ok) {
    return loginName
  }

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { ok: false, message: 'enabled must be a boolean.' }
  }

  const attributes = parseAttributeSet(body.attributes ?? [])

  if (!attributes.ok) {
    return { ok: false, message: attributes.message }
  }

  const password = parseCredentialInput(body, {
    hasLoginName: loginName.value !== null,
    required: false,
  })

  if (!password.ok) {
    return password
  }

  return {
    ok: true,
    value: {
      name,
      loginName: loginName.value,
      enabled: body.enabled ?? true,
      attributes: attributes.attributes,
      password: password.value,
    },
  }
}

/** Optional in the database, so an absent or blank value becomes null. */
export const parseLoginName = (value: unknown): ValidationResult<string | null> => {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null }
  }

  const loginName = readTrimmedString(value)

  if (
    loginName === null ||
    loginName === '' ||
    loginName.length > MAX_LOGIN_NAME_LENGTH ||
    !LOGIN_NAME_PATTERN.test(loginName)
  ) {
    return {
      ok: false,
      message: 'Login name must be lowercase letters, numbers and single hyphens, e.g. desk-a.',
    }
  }

  return { ok: true, value: loginName }
}

export interface DeviceFieldUpdate {
  name?: string
  loginName?: string | null
  enabled?: boolean
}

export interface DeviceConfigurationInput {
  /** A scope assertion, never a change: a device cannot move between events. */
  eventId: string | null
  fields: DeviceFieldUpdate
  /** `null` means "leave the attribute set alone"; `[]` means "clear it". */
  attributes: DeviceAttribute[] | null
}

/**
 * The COMPLETE Edit Device request: device fields and the exact attribute set
 * in one body, so the whole edit can be validated before anything is written.
 *
 * Splitting this across two requests is what let a rename persist while its
 * attribute change was refused. From the operator's side Save Device is one
 * action, so it is validated and committed as one.
 *
 * `id`, `createdAt` and a renaming of `eventId` are deliberately absent:
 * moving a device between events or rewriting its id would orphan its badge
 * history. `eventId` is accepted only to assert which event the caller
 * believes it is editing, and is verified against the stored row.
 */
export const parseDeviceConfigurationInput = (
  body: unknown,
): ValidationResult<DeviceConfigurationInput> => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  for (const forbidden of ['createdAt', 'created_at', 'event_id']) {
    if (forbidden in body) {
      return { ok: false, message: `${forbidden} cannot be changed.` }
    }
  }

  let eventId: string | null = null

  if (body.eventId !== undefined) {
    const value = readTrimmedString(body.eventId)

    if (value === null || value === '') {
      return { ok: false, message: 'eventId must be a string.' }
    }

    eventId = value
  }

  const fields: DeviceFieldUpdate = {}

  if (body.name !== undefined) {
    const name = readTrimmedString(body.name)

    if (name === null || name === '' || name.length > MAX_NAME_LENGTH) {
      return { ok: false, message: `Enter a device name of 1-${String(MAX_NAME_LENGTH)} characters.` }
    }

    fields.name = name
  }

  if (body.loginName !== undefined) {
    const loginName = parseLoginName(body.loginName)

    if (!loginName.ok) {
      return loginName
    }

    fields.loginName = loginName.value
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return { ok: false, message: 'enabled must be a boolean.' }
    }

    fields.enabled = body.enabled
  }

  let attributes: DeviceAttribute[] | null = null

  if (body.attributes !== undefined) {
    const parsed = parseAttributeSet(body.attributes)

    if (!parsed.ok) {
      return { ok: false, message: parsed.message }
    }

    attributes = parsed.attributes
  }

  if (Object.keys(fields).length === 0 && attributes === null) {
    return { ok: false, message: 'Nothing to update.' }
  }

  return { ok: true, value: { eventId, fields, attributes } }
}

export interface BadgeRangeInput {
  rangeStart: number
  rangeEnd: number
}

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export const parseBadgeRangeInput = (
  body: unknown,
): ValidationResult<BadgeRangeInput> => {
  if (!isRecord(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }

  const { rangeStart, rangeEnd } = body

  if (!isPositiveInteger(rangeStart) || !isPositiveInteger(rangeEnd)) {
    return { ok: false, message: 'Badge numbers must be positive whole numbers.' }
  }

  if (rangeStart > rangeEnd) {
    return { ok: false, message: 'The first badge must not be after the last badge.' }
  }

  return { ok: true, value: { rangeStart, rangeEnd } }
}

export type BadgeAssignmentBlock =
  | 'device-not-found'
  | 'device-event-mismatch'
  | 'device-disabled'
  | 'device-not-registration'
  | 'badge-range-already-assigned'

/**
 * Whether a device may receive its FIRST badge range. Pure, so the rule is
 * testable without a database.
 *
 * These are preconditions, not the guarantee: Postgres remains authoritative
 * for overlap, one-active-per-device and event consistency.
 */
export const checkBadgeAssignmentAllowed = (context: {
  device: { eventId: string; enabled: boolean } | null
  eventId: string
  attributes: readonly string[]
  hasActiveAssignment: boolean
}): BadgeAssignmentBlock | null => {
  if (context.device === null) {
    return 'device-not-found'
  }

  if (context.device.eventId !== context.eventId) {
    return 'device-event-mismatch'
  }

  if (!context.device.enabled) {
    return 'device-disabled'
  }

  /**
   * `registration` is the whole desk workflow, badge issuance included, so it
   * is exactly what authorizes owning a range. A prize desk never hands out
   * numbered badges and must not reserve any.
   */
  if (!context.attributes.includes('registration')) {
    return 'device-not-registration'
  }

  if (context.hasActiveAssignment) {
    return 'badge-range-already-assigned'
  }

  return null
}

/**
 * A device holding an ACTIVE badge range may not lose `registration`.
 *
 * That would leave a device owning a physical badge range with nothing
 * authorizing it to hand those badges out, and releasing a range safely is a
 * reconciliation problem this phase deliberately does not solve.
 */
export const checkAttributeRemovalAllowed = (context: {
  requested: readonly string[]
  hasActiveAssignment: boolean
}): 'registration-required-by-badge-range' | null => {
  if (!context.hasActiveAssignment) {
    return null
  }

  return context.requested.includes(BADGE_RANGE_REQUIRED_ATTRIBUTE)
    ? null
    : 'registration-required-by-badge-range'
}
