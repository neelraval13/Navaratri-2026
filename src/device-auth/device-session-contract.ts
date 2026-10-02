import { isDeviceAttribute, type DeviceAttribute } from '@/shared/device-attributes'

/**
 * Runtime validation of the device session response.
 *
 * A TypeScript annotation on a `fetch` result is a claim, not a check. This
 * response decides which central identity a browser binds itself to and which
 * capabilities it displays, so every field is verified at runtime and anything
 * unexpected FAILS CLOSED rather than becoming local state.
 *
 * The attribute allow-list matters most: an unrecognised string arriving from
 * an unexpected response must never be persisted as though it were a granted
 * capability. The list is the application's own — `registration`, `prizes` —
 * and is shared with the server, so the two cannot drift.
 *
 * Framework-free and dependency-free on purpose: a validation library for one
 * response would be a dependency that outlives the reason for it.
 */

export interface DeviceSessionDevice {
  id: string
  eventId: string
  name: string
  loginName: string
  attributes: DeviceAttribute[]
  lastSeenAt: string | null
}

export interface DeviceSessionEvent {
  id: string
  slug: string
  name: string
  timezone: string
}

export interface DeviceBadgeRange {
  rangeStart: number
  rangeEnd: number
  assignedAt: string
}

/**
 * The safe context, exactly as Phase 9C-B returns it.
 *
 * `activeBadgeRange` is carried so the page can DISPLAY it. It is deliberately
 * not part of what gets persisted — see `CentralDeviceEnrollment`.
 */
export interface DeviceSessionContext {
  device: DeviceSessionDevice
  event: DeviceSessionEvent
  activeBadgeRange: DeviceBadgeRange | null
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value)

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** Every entry must be a KNOWN attribute; one unknown rejects the whole set. */
const parseAttributes = (value: unknown): DeviceAttribute[] | null => {
  if (!Array.isArray(value) || !value.every(isDeviceAttribute)) {
    return null
  }

  return [...new Set(value)].sort()
}

/**
 * A badge range that MUST be present, projected field by field.
 *
 * Exported because the self-claim response carries one too, and both answers
 * must be validated by the same rules — a range is what decides which
 * physical badges a desk hands out, so a response that merely looks right is
 * not good enough.
 */
export const parseDeviceBadgeRange = (value: unknown): DeviceBadgeRange | null => {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.rangeStart) ||
    !isPositiveInteger(value.rangeEnd) ||
    value.rangeStart > value.rangeEnd ||
    !isNonEmpty(value.assignedAt)
  ) {
    return null
  }

  return {
    rangeStart: value.rangeStart,
    rangeEnd: value.rangeEnd,
    assignedAt: value.assignedAt,
  }
}

/** The session's range is OPTIONAL: a device may legitimately own none. */
const parseBadgeRange = (value: unknown): DeviceBadgeRange | null | 'invalid' => {
  if (value === null || value === undefined) {
    return null
  }

  return parseDeviceBadgeRange(value) ?? 'invalid'
}

/**
 * Builds the context from an UNTRUSTED body, or returns `null`.
 *
 * Projected field by field. The body is never spread, so a field the server
 * adds later cannot slip through into anything this application stores.
 */
export const parseDeviceSessionContext = (
  body: unknown,
): DeviceSessionContext | null => {
  if (!isRecord(body) || !isRecord(body.device) || !isRecord(body.event)) {
    return null
  }

  const device = body.device
  const event = body.event

  if (
    !isUuid(device.id) ||
    !isUuid(device.eventId) ||
    !isNonEmpty(device.name) ||
    !isNonEmpty(device.loginName) ||
    !isUuid(event.id) ||
    !isNonEmpty(event.slug) ||
    !isNonEmpty(event.name) ||
    !isNonEmpty(event.timezone)
  ) {
    return null
  }

  // The device must belong to the event it was returned with.
  if (device.eventId !== event.id) {
    return null
  }

  const attributes = parseAttributes(device.attributes)

  if (attributes === null) {
    return null
  }

  if (device.lastSeenAt !== null && !isNonEmpty(device.lastSeenAt)) {
    return null
  }

  const activeBadgeRange = parseBadgeRange(body.activeBadgeRange)

  if (activeBadgeRange === 'invalid') {
    return null
  }

  return {
    device: {
      id: device.id,
      eventId: device.eventId,
      name: device.name,
      loginName: device.loginName,
      attributes,
      lastSeenAt: device.lastSeenAt === null ? null : (device.lastSeenAt as string),
    },
    event: {
      id: event.id,
      slug: event.slug,
      name: event.name,
      timezone: event.timezone,
    },
    activeBadgeRange,
  }
}

/**
 * The same context, carrying a DIFFERENT active badge range.
 *
 * Used where an authoritative range arrives separately from the session that
 * proved the identity — a freshly reserved one from the claim endpoint, or a
 * hypothetical one being tested for local compatibility before anything is
 * reserved at all.
 *
 * Projected field by field, exactly as the parser builds it, so a future
 * server field can never ride along into something that gets persisted.
 */
export const withActiveBadgeRange = (
  context: DeviceSessionContext,
  activeBadgeRange: DeviceBadgeRange | null,
): DeviceSessionContext => ({
  device: {
    id: context.device.id,
    eventId: context.device.eventId,
    name: context.device.name,
    loginName: context.device.loginName,
    attributes: [...context.device.attributes],
    lastSeenAt: context.device.lastSeenAt,
  },
  event: {
    id: context.event.id,
    slug: context.event.slug,
    name: context.event.name,
    timezone: context.event.timezone,
  },
  activeBadgeRange,
})

/**
 * The offline-authorization envelope that rides beside a device context.
 *
 * `configured: false` is a normal answer: a deployment without signing keys
 * still authenticates devices online. The token is NOT validated here — only
 * its SHAPE is. A token means nothing until `verifyOfflineAuthorization`
 * checks the signature, so nothing may act on it before that.
 */
export type OfflineAuthorizationEnvelope =
  | { configured: false }
  | { configured: true; token: string; expiresAt: string }

export const parseOfflineAuthorizationEnvelope = (
  value: unknown,
): OfflineAuthorizationEnvelope => {
  if (!isRecord(value) || value.configured !== true) {
    // Anything unrecognised is treated as "not configured" rather than as an
    // error: an unusable lease and an absent one permit exactly the same
    // things, which is nothing.
    return { configured: false }
  }

  if (!isNonEmpty(value.token) || !isNonEmpty(value.expiresAt)) {
    return { configured: false }
  }

  return { configured: true, token: value.token, expiresAt: value.expiresAt }
}
