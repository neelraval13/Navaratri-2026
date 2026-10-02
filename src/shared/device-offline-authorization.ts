import { isDeviceAttribute, type DeviceAttribute } from './device-attributes.js'

/**
 * The SIGNED OFFLINE AUTHORIZATION LEASE: shape, codec and parser.
 *
 * A device desk must keep working through a venue internet outage, but a
 * boolean in IndexedDB is not authorization — anyone can edit it. So the
 * server signs a short-lived statement of what a device was allowed to do,
 * and the browser verifies that signature offline with a PUBLIC key.
 *
 * ASYMMETRIC on purpose. An HMAC would mean shipping the signing secret in
 * the bundle, which is the same as publishing it: anyone could then mint
 * themselves Registration access. The browser holds only the verification
 * half, and being readable is expected of it.
 *
 * WHAT THE LEASE IS NOT: a credential. No server endpoint accepts it. It
 * authorizes LOCAL event-route decisions until `exp`, and nothing else; the
 * `__Host-navaratri_device_session` cookie remains the only thing that
 * authenticates a request.
 *
 * Framework-free and shared, so the signer and the verifier cannot disagree
 * about a single field.
 */

export const DEVICE_OFFLINE_AUTHORIZATION_VERSION = 1

export const DEVICE_OFFLINE_AUTHORIZATION_TYPE = 'device-offline'

/**
 * Domain separation, prepended to the signed bytes. Even if a key were ever
 * reused, a token of another kind cannot verify as this one.
 */
export const DEVICE_OFFLINE_SIGNING_CONTEXT = 'navaratri-device-offline-v1:'

/** Offline authority ALWAYS expires. There is no indefinite lease. */
export const MAX_DEVICE_OFFLINE_LEASE_SECONDS = 24 * 60 * 60

/**
 * Tolerated clock difference between the signing server and a desk tablet.
 * Small on purpose: a generous skew is extra offline authority.
 */
export const DEVICE_OFFLINE_CLOCK_SKEW_SECONDS = 5 * 60

/** The central assignment as it stood when the lease was signed. */
export interface DeviceOfflineBadgeRange {
  rangeStart: number
  rangeEnd: number
  assignedAt: string
}

/**
 * MINIMAL claims.
 *
 * Deliberately absent, and none may be added: any password or hash, a session
 * token or cookie, `sessionVersion`, an Admin or operator credential, ANY
 * attendee data, `nextBadge`, and this browser's local Phase 7 `deviceId` or
 * `deviceName`.
 *
 * `activeBadgeRange` is present because offline Registration eventually has
 * to prove more than "this device once had Registration" — it must say which
 * central assignment was authorized. It is NOT an allocator: `nextBadge`
 * stays local and never appears here.
 */
export interface DeviceOfflineClaims {
  v: typeof DEVICE_OFFLINE_AUTHORIZATION_VERSION
  t: typeof DEVICE_OFFLINE_AUTHORIZATION_TYPE
  deviceId: string
  eventId: string
  eventSlug: string
  attributes: DeviceAttribute[]
  activeBadgeRange: DeviceOfflineBadgeRange | null
  /** Epoch SECONDS. */
  iat: number
  exp: number
}

/**
 * base64url, implemented with arithmetic rather than `btoa`/`Buffer`.
 *
 * This module is compiled into both the Node functions (no DOM lib) and the
 * browser bundle (no Node types). Reaching for a global that exists in one
 * configuration and arrives through a heuristic in the other is precisely how
 * this repository has been broken before, so the codec depends on nothing.
 */
const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export const toBase64Url = (bytes: Uint8Array): string => {
  let out = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = bytes[index + 1]
    const c = bytes[index + 2]

    out += BASE64URL_ALPHABET[a >> 2]
    out += BASE64URL_ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)]

    if (b === undefined) {
      break
    }

    out += BASE64URL_ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)]

    if (c === undefined) {
      break
    }

    out += BASE64URL_ALPHABET[c & 0b111111]
  }

  return out
}

export const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return null
  }

  const remainder = value.length % 4

  // A single trailing character cannot encode any byte.
  if (remainder === 1) {
    return null
  }

  const bytes: number[] = []
  let buffer = 0
  let bits = 0

  for (const character of value) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(character)
    bits += 6

    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

/**
 * Returned over an `ArrayBuffer` explicitly, not the `ArrayBufferLike` a
 * `TextEncoder` yields. Web Crypto's `BufferSource` excludes
 * `SharedArrayBuffer`, and the alternative to this copy is a blind cast at
 * every call site — which is exactly what the parity suite forbids. The
 * payloads are a few hundred bytes.
 */
export const encodeUtf8 = (value: string): Uint8Array<ArrayBuffer> => {
  const encoded = TEXT_ENCODER.encode(value)
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength))

  bytes.set(encoded)

  return bytes
}

export const decodeUtf8 = (bytes: Uint8Array): string => TEXT_DECODER.decode(bytes)

/**
 * The exact bytes that are signed and verified.
 *
 * The signature covers the ENCODED payload, not a re-serialisation of the
 * decoded object, so there is no canonical-JSON problem: the bytes on the
 * wire are the bytes that were signed.
 */
export const offlineAuthorizationSignedMessage = (
  encodedPayload: string,
): Uint8Array<ArrayBuffer> => {
  return encodeUtf8(`${DEVICE_OFFLINE_SIGNING_CONTEXT}${encodedPayload}`)
}

export interface SplitOfflineToken {
  encodedPayload: string
  signature: Uint8Array<ArrayBuffer>
}

/**
 * Splits `<payload>.<signature>` WITHOUT interpreting the payload.
 *
 * It returns the raw halves only. Nothing here decodes claims, because a
 * caller must not be able to read an unverified claim by accident — the
 * verifier parses them only after the signature holds.
 */
export const splitOfflineAuthorizationToken = (
  token: unknown,
): SplitOfflineToken | null => {
  if (typeof token !== 'string') {
    return null
  }

  const parts = token.split('.')

  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return null
  }

  const signature = fromBase64Url(parts[1])

  // P-256 `ieee-p1363`: r‖s, 32 bytes each. WebCrypto accepts nothing else.
  if (signature === null || signature.length !== 64) {
    return null
  }

  return { encodedPayload: parts[0], signature }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isEpochSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** One unknown entry rejects the WHOLE lease. */
const parseAttributes = (value: unknown): DeviceAttribute[] | null => {
  if (!Array.isArray(value) || !value.every(isDeviceAttribute)) {
    return null
  }

  return [...new Set(value)].sort()
}

const parseRange = (value: unknown): DeviceOfflineBadgeRange | null | 'invalid' => {
  if (value === null) {
    return null
  }

  if (
    !isRecord(value) ||
    !isPositiveInteger(value.rangeStart) ||
    !isPositiveInteger(value.rangeEnd) ||
    value.rangeStart > value.rangeEnd ||
    !isNonEmpty(value.assignedAt)
  ) {
    return 'invalid'
  }

  return {
    rangeStart: value.rangeStart,
    rangeEnd: value.rangeEnd,
    assignedAt: value.assignedAt,
  }
}

/**
 * Builds claims from an UNTRUSTED decoded payload, or returns `null`.
 *
 * Projected field by field so a field added later cannot ride along, and
 * FAIL CLOSED on anything unexpected — an unknown attribute must never become
 * a granted capability.
 */
export const parseDeviceOfflineClaims = (value: unknown): DeviceOfflineClaims | null => {
  if (!isRecord(value)) {
    return null
  }

  if (
    value.v !== DEVICE_OFFLINE_AUTHORIZATION_VERSION ||
    value.t !== DEVICE_OFFLINE_AUTHORIZATION_TYPE ||
    !isNonEmpty(value.deviceId) ||
    !isNonEmpty(value.eventId) ||
    !isNonEmpty(value.eventSlug) ||
    !isEpochSeconds(value.iat) ||
    !isEpochSeconds(value.exp) ||
    value.exp <= value.iat ||
    value.exp - value.iat > MAX_DEVICE_OFFLINE_LEASE_SECONDS
  ) {
    return null
  }

  const attributes = parseAttributes(value.attributes)

  if (attributes === null) {
    return null
  }

  const activeBadgeRange = parseRange(value.activeBadgeRange)

  if (activeBadgeRange === 'invalid') {
    return null
  }

  return {
    v: DEVICE_OFFLINE_AUTHORIZATION_VERSION,
    t: DEVICE_OFFLINE_AUTHORIZATION_TYPE,
    deviceId: value.deviceId,
    eventId: value.eventId,
    eventSlug: value.eventSlug,
    attributes,
    activeBadgeRange,
    iat: value.iat,
    exp: value.exp,
  }
}

/** Decodes the payload half of a token. Says nothing about its signature. */
export const decodeOfflineAuthorizationPayload = (
  encodedPayload: string,
): DeviceOfflineClaims | null => {
  const bytes = fromBase64Url(encodedPayload)

  if (bytes === null) {
    return null
  }

  try {
    return parseDeviceOfflineClaims(JSON.parse(decodeUtf8(bytes)))
  } catch {
    return null
  }
}

export type OfflineClockFailure = 'expired' | 'not-yet-valid'

/**
 * The clock rules, shared so the issuer's tests and the verifier agree.
 *
 * An expired lease is NEVER extended locally; only the server may issue a
 * fresh one.
 */
export const checkOfflineClaimsClock = (
  claims: DeviceOfflineClaims,
  nowSeconds: number,
): OfflineClockFailure | null => {
  if (claims.iat > nowSeconds + DEVICE_OFFLINE_CLOCK_SKEW_SECONDS) {
    return 'not-yet-valid'
  }

  if (claims.exp <= nowSeconds - DEVICE_OFFLINE_CLOCK_SKEW_SECONDS) {
    return 'expired'
  }

  return null
}
