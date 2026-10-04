import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stateless signed ADMIN sessions.
 *
 * Deliberately its own implementation rather than one shared with device
 * auth: they are separate realms, and a shared signer would make a change
 * for one silently a change for the other.
 *
 * Realm isolation is CRYPTOGRAPHIC, not configuration-dependent.
 *
 * Admin signatures cover a domain-separation context string prepended to the
 * payload, so each realm signs a different message even when handed the same
 * key:
 *
 *   admin:   HMAC(secret, ADMIN_SIGNING_CONTEXT + encodedPayload)
 *   device:  HMAC(secret, DEVICE_SIGNING_CONTEXT + encodedPayload)
 *
 * Therefore, EVEN IF `EVENT_ADMIN_SESSION_SECRET` and
 * `EVENT_DEVICE_SESSION_SECRET` were accidentally identical, each verifier
 * rejects the other realm's token. That closes the replay in code rather
 * than relying on an operational rule.
 *
 * Distinct secrets remain recommended as defence in depth, but realm
 * separation no longer depends on them.
 *
 * The `t` claim is kept as a second, independent barrier.
 *
 * Rotating `EVENT_ADMIN_SESSION_SECRET` invalidates every admin session.
 */
const TOKEN_VERSION = 1

const TOKEN_TYPE = 'admin'

/**
 * Domain separation for admin signatures. Changing this string invalidates
 * every existing admin session, which is why it is versioned.
 */
const ADMIN_SIGNING_CONTEXT = 'navaratri-admin-session-v1:'

/** Short by design: Admin is a privileged online control plane, not a desk. */
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60

interface AdminSessionPayload {
  v: number
  t: string
  iat: number
  exp: number
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

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
 * for one realm can never validate in the other.
 */
const sign = (secret: string, encodedPayload: string): Buffer => {
  return createHmac('sha256', secret)
    .update(`${ADMIN_SIGNING_CONTEXT}${encodedPayload}`, 'utf8')
    .digest()
}

/** HMAC-SHA256 output is always 32 bytes, so a length mismatch leaks nothing. */
const isSameBuffer = (left: Buffer, right: Buffer): boolean => {
  return left.length === right.length && timingSafeEqual(left, right)
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export const createAdminSessionToken = (
  sessionSecret: string,
  issuedAt: number = nowSeconds(),
): string => {
  const payload: AdminSessionPayload = {
    v: TOKEN_VERSION,
    t: TOKEN_TYPE,
    iat: issuedAt,
    exp: issuedAt + ADMIN_SESSION_TTL_SECONDS,
  }

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )

  return `${encodedPayload}.${sign(sessionSecret, encodedPayload).toString('base64url')}`
}

const isValidPayload = (value: unknown): value is AdminSessionPayload => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    candidate.v === TOKEN_VERSION &&
    candidate.t === TOKEN_TYPE &&
    Number.isInteger(candidate.iat) &&
    Number.isInteger(candidate.exp) &&
    (candidate.exp as number) > (candidate.iat as number)
  )
}

/**
 * Verifies an UNTRUSTED cookie value. It never throws: malformed, tampered,
 * expired, wrongly-signed and wrong-type tokens are all simply `false`.
 *
 * The signature is checked BEFORE the payload is parsed, so unsigned input
 * never reaches `JSON.parse`.
 */
export const verifyAdminSessionToken = (
  token: string | undefined,
  sessionSecret: string,
  atSeconds: number = nowSeconds(),
): boolean => {
  if (typeof token !== 'string' || token === '') {
    return false
  }

  const parts = token.split('.')

  if (parts.length !== 2) {
    return false
  }

  const [encodedPayload, encodedSignature] = parts

  if (encodedPayload === undefined || encodedSignature === undefined) {
    return false
  }

  const payloadBytes = decodeBase64Url(encodedPayload)
  const signatureBytes = decodeBase64Url(encodedSignature)

  if (payloadBytes === null || signatureBytes === null) {
    return false
  }

  if (!isSameBuffer(signatureBytes, sign(sessionSecret, encodedPayload))) {
    return false
  }

  let payload: unknown

  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return false
  }

  return isValidPayload(payload) && atSeconds < payload.exp
}

/**
 * Constant-time access-code comparison over SHA-256 digests, so the
 * comparison always runs over 32 bytes and never branches on length.
 *
 * Neither value is trimmed or case folded.
 */
export const isAdminAccessCodeValid = (
  submitted: string,
  configured: string,
): boolean => {
  return timingSafeEqual(
    createHash('sha256').update(submitted, 'utf8').digest(),
    createHash('sha256').update(configured, 'utf8').digest(),
  )
}
