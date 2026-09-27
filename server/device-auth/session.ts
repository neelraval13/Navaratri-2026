import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stateless signed DEVICE sessions.
 *
 * A third realm, with its own implementation rather than a shared one with
 * Operator Access or Admin: they are separate realms, and a shared signer
 * would make a change for one silently a change for all three. Nothing here
 * imports `server/auth/` or `server/admin-auth/`.
 *
 * Realm isolation is CRYPTOGRAPHIC, not configuration-dependent. Each realm
 * signs a different message:
 *
 *   operator:  HMAC(secret, encodedPayload)
 *   admin:     HMAC(secret, "navaratri-admin-session-v1:"  + encodedPayload)
 *   device:    HMAC(secret, "navaratri-device-session-v1:" + encodedPayload)
 *
 * Therefore, EVEN IF all three secrets were accidentally identical, every
 * cross-realm token is rejected. The `t` claim is a second, independent
 * barrier. The operator and admin implementations are untouched, so every
 * session live in production stays valid.
 *
 * Rotating `EVENT_DEVICE_SESSION_SECRET` invalidates every device session at
 * once. There is NO session store, and none should be added — per-device
 * revocation is `session_version`, checked against the database on every
 * authenticated request.
 */
const TOKEN_VERSION = 1

const TOKEN_TYPE = 'device'

/**
 * Domain separation for device signatures. Changing this string invalidates
 * every existing device session, which is why it is versioned.
 */
const DEVICE_SIGNING_CONTEXT = 'navaratri-device-session-v1:'

/** Event desks may run across several days, so this matches Operator Access. */
export const DEVICE_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60

/**
 * What the token carries, and deliberately nothing more.
 *
 * `sv` is `devices.session_version` at login time. It is the revocation
 * mechanism: an Admin password reset increments the stored value, and every
 * cookie issued under the old one stops verifying on its next online check.
 *
 * NOT in the token: the password, the hash, the login name, the device name,
 * the attributes, the badge range, `enabled` or `lastSeenAt`. Every one of
 * those can change centrally, and a stale claim would keep authorizing after
 * an Admin had already changed it. They are fetched fresh from Postgres.
 */
export interface DeviceSessionPayload {
  v: number
  t: string
  deviceId: string
  eventId: string
  sv: number
  iat: number
  exp: number
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * `Buffer.from(value, 'base64url')` silently ignores characters it does not
 * understand, so two different strings can decode identically. Both the
 * character check and the round trip are needed to fail closed.
 */
const decodeBase64Url = (value: string): Buffer | null => {
  if (!BASE64URL_PATTERN.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, 'base64url')

  return decoded.toString('base64url') === value ? decoded : null
}

/**
 * The context prefix is part of the signed message, so a signature produced
 * for another realm can never validate here.
 */
const sign = (secret: string, encodedPayload: string): Buffer => {
  return createHmac('sha256', secret)
    .update(`${DEVICE_SIGNING_CONTEXT}${encodedPayload}`, 'utf8')
    .digest()
}

/** HMAC-SHA256 output is always 32 bytes, so a length mismatch leaks nothing. */
const isSameBuffer = (left: Buffer, right: Buffer): boolean => {
  return left.length === right.length && timingSafeEqual(left, right)
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export const createDeviceSessionToken = (
  sessionSecret: string,
  claims: { deviceId: string; eventId: string; sessionVersion: number },
  issuedAt: number = nowSeconds(),
): string => {
  const payload: DeviceSessionPayload = {
    v: TOKEN_VERSION,
    t: TOKEN_TYPE,
    deviceId: claims.deviceId,
    eventId: claims.eventId,
    sv: claims.sessionVersion,
    iat: issuedAt,
    exp: issuedAt + DEVICE_SESSION_TTL_SECONDS,
  }

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )

  return `${encodedPayload}.${sign(sessionSecret, encodedPayload).toString('base64url')}`
}

const isValidPayload = (value: unknown): value is DeviceSessionPayload => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    candidate.v === TOKEN_VERSION &&
    candidate.t === TOKEN_TYPE &&
    typeof candidate.deviceId === 'string' &&
    UUID_PATTERN.test(candidate.deviceId) &&
    typeof candidate.eventId === 'string' &&
    UUID_PATTERN.test(candidate.eventId) &&
    Number.isInteger(candidate.sv) &&
    (candidate.sv as number) >= 1 &&
    Number.isInteger(candidate.iat) &&
    Number.isInteger(candidate.exp) &&
    (candidate.exp as number) > (candidate.iat as number)
  )
}

/**
 * Verifies an UNTRUSTED cookie value and returns its claims, or `null`.
 *
 * It never throws: malformed, tampered, expired, wrongly-signed, wrong-realm
 * and wrong-version tokens are all simply `null`. The caller cannot tell them
 * apart, and neither can the browser.
 *
 * The signature is checked BEFORE the payload is parsed, so unsigned input
 * never reaches `JSON.parse`.
 *
 * A verified token proves only that THIS SERVER issued it and it has not
 * expired. It is not authorization on its own: the caller must still check
 * `sv` against the stored `session_version`, that the device is enabled and
 * that the event is active. See `authenticate.ts`.
 */
export const verifyDeviceSessionToken = (
  token: string | undefined,
  sessionSecret: string,
  atSeconds: number = nowSeconds(),
): DeviceSessionPayload | null => {
  if (typeof token !== 'string' || token === '') {
    return null
  }

  const parts = token.split('.')

  if (parts.length !== 2) {
    return null
  }

  const [encodedPayload, encodedSignature] = parts

  if (encodedPayload === undefined || encodedSignature === undefined) {
    return null
  }

  const payloadBytes = decodeBase64Url(encodedPayload)
  const signatureBytes = decodeBase64Url(encodedSignature)

  if (payloadBytes === null || signatureBytes === null) {
    return null
  }

  if (!isSameBuffer(signatureBytes, sign(sessionSecret, encodedPayload))) {
    return null
  }

  let payload: unknown

  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return null
  }

  if (!isValidPayload(payload) || atSeconds >= payload.exp) {
    return null
  }

  return payload
}
