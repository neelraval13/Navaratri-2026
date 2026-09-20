import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stateless signed operator sessions.
 *
 * There is no session store, and deliberately none: no database, no KV, no
 * external service. A session is a signed statement about its own validity
 * window, so rotating `EVENT_SESSION_SECRET` invalidates every issued session
 * at once.
 *
 * Nothing here is a JWT library and no JWT package is installed — the format is
 * fixed, the algorithm is fixed, and there is no `alg` field an attacker could
 * negotiate downwards.
 */
const TOKEN_VERSION = 1

export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60

interface SessionPayload {
  v: number
  iat: number
  exp: number
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * `Buffer.from(value, 'base64url')` is lenient: it silently ignores characters
 * it does not understand, so two different strings can decode identically. Both
 * a character check and a round-trip are required to fail closed.
 */
const decodeBase64Url = (value: string): Buffer | null => {
  if (!BASE64URL_PATTERN.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, 'base64url')

  if (decoded.toString('base64url') !== value) {
    return null
  }

  return decoded
}

const sign = (secret: string, encodedPayload: string): Buffer => {
  return createHmac('sha256', secret).update(encodedPayload, 'utf8').digest()
}

/**
 * Length is compared before content. HMAC-SHA256 output is always 32 bytes, so
 * a length mismatch only tells an attacker their forgery is the wrong shape —
 * it reveals nothing about the key.
 */
const isSameBuffer = (left: Buffer, right: Buffer): boolean => {
  if (left.length !== right.length) {
    return false
  }

  return timingSafeEqual(left, right)
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export const createOperatorSessionToken = (
  sessionSecret: string,
  issuedAt: number = nowSeconds(),
): string => {
  const payload: SessionPayload = {
    v: TOKEN_VERSION,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  }

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )

  return `${encodedPayload}.${sign(sessionSecret, encodedPayload).toString('base64url')}`
}

const isValidPayload = (value: unknown): value is SessionPayload => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    candidate.v === TOKEN_VERSION &&
    Number.isInteger(candidate.iat) &&
    Number.isInteger(candidate.exp) &&
    (candidate.exp as number) > (candidate.iat as number)
  )
}

/**
 * Verifies an UNTRUSTED cookie value. It never throws: every malformed,
 * tampered, expired or wrongly-signed token is simply `false`.
 *
 * The signature is checked BEFORE the payload is parsed, so unsigned input
 * never reaches `JSON.parse`.
 */
export const verifyOperatorSessionToken = (
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

  if (!isValidPayload(payload)) {
    return false
  }

  return atSeconds < payload.exp
}

/**
 * Constant-time access-code comparison.
 *
 * The two values are hashed first so the comparison always runs over 32 bytes:
 * `timingSafeEqual` throws on differing lengths, and branching on length would
 * leak the configured code's length to anyone able to time the endpoint.
 *
 * Neither value is trimmed. The submitted code must match EXACTLY.
 */
export const isOperatorAccessCodeValid = (
  submitted: string,
  configured: string,
): boolean => {
  const submittedDigest = createHash('sha256').update(submitted, 'utf8').digest()
  const configuredDigest = createHash('sha256')
    .update(configured, 'utf8')
    .digest()

  return timingSafeEqual(submittedDigest, configuredDigest)
}
