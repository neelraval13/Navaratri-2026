import {
  checkOfflineClaimsClock,
  decodeOfflineAuthorizationPayload,
  fromBase64Url,
  offlineAuthorizationSignedMessage,
  splitOfflineAuthorizationToken,
  type DeviceOfflineClaims,
} from '@/shared/device-offline-authorization'

/**
 * Verifying a signed offline authorization lease, in the browser, with no
 * network.
 *
 * It holds the PUBLIC half of the server's P-256 key pair. That half being
 * readable in the bundle is expected and harmless: it can verify a lease and
 * cannot mint one. The private half never leaves the server.
 *
 * NOTHING IS TRUSTED BEFORE THE SIGNATURE HOLDS. The payload is split off
 * only to locate the bytes to verify; claims are decoded afterwards, and a
 * caller can never receive unverified claims from this module.
 *
 * A verified lease authorizes LOCAL decisions only. It is not a credential,
 * no endpoint accepts it, and this module never sends it anywhere.
 */

export const DEVICE_OFFLINE_PUBLIC_KEY_NAME =
  'VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64'

export type OfflineAuthorizationVerification =
  /** Signature holds, claims parse, and it is inside its lifetime. */
  | { status: 'valid'; claims: DeviceOfflineClaims }
  /** No public key is configured in this build. Never a reason to allow. */
  | { status: 'not-configured' }
  /** Signed correctly, but outside its lifetime. Never extended locally. */
  | { status: 'expired'; claims: DeviceOfflineClaims }
  /** Bad signature, bad shape, unknown attribute, or an implausible clock. */
  | { status: 'invalid' }
  /** Web Crypto is unavailable, so nothing can be proven. Fails closed. */
  | { status: 'unverifiable' }

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' } as const

/**
 * Imported once per page. A failure is cached as `null` rather than retried
 * on every verification: a malformed key does not become valid by asking
 * again, and a verifier that retries silently invites a fail-open.
 */
let importedKey: Promise<CryptoKey | null> | null = null

const configuredPublicKey = (): string =>
  import.meta.env.VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64 ?? ''

const loadPublicKey = async (): Promise<CryptoKey | null> => {
  const encoded = configuredPublicKey()

  if (encoded === '') {
    return null
  }

  // Standard base64 (SPKI DER), not base64url: it comes from `openssl`.
  const bytes = fromBase64Url(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))

  if (bytes === null) {
    return null
  }

  try {
    return await crypto.subtle.importKey(
      'spki',
      bytes,
      ALGORITHM,
      false,
      ['verify'],
    )
  } catch {
    return null
  }
}

const publicKey = async (): Promise<CryptoKey | null> => {
  importedKey ??= loadPublicKey()

  return await importedKey
}

/** Whether this build carries a verification key at all. */
export const isOfflineAuthorizationConfigured = (): boolean =>
  configuredPublicKey() !== ''

/** Test seam only: forces the next verification to re-import the key. */
export const resetOfflineAuthorizationKeyCache = (): void => {
  importedKey = null
}

/**
 * Verifies a token end to end.
 *
 * ORDER MATTERS and is the whole security property:
 *
 *   1. split the token — no claim is read
 *   2. verify the ECDSA signature over the domain-separated bytes
 *   3. only then decode and validate the claims
 *   4. only then apply the clock rules
 */
export const verifyOfflineAuthorization = async (
  token: unknown,
  now: Date = new Date(),
): Promise<OfflineAuthorizationVerification> => {
  if (!isOfflineAuthorizationConfigured()) {
    return { status: 'not-configured' }
  }

  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    return { status: 'unverifiable' }
  }

  const key = await publicKey()

  if (key === null) {
    return { status: 'not-configured' }
  }

  const split = splitOfflineAuthorizationToken(token)

  if (split === null) {
    return { status: 'invalid' }
  }

  let verified: boolean

  try {
    verified = await crypto.subtle.verify(
      SIGNATURE,
      key,
      split.signature,
      offlineAuthorizationSignedMessage(split.encodedPayload),
    )
  } catch {
    return { status: 'invalid' }
  }

  if (!verified) {
    return { status: 'invalid' }
  }

  // Only now are the claims allowed to mean anything.
  const claims = decodeOfflineAuthorizationPayload(split.encodedPayload)

  if (claims === null) {
    return { status: 'invalid' }
  }

  const clock = checkOfflineClaimsClock(claims, Math.floor(now.getTime() / 1000))

  if (clock === 'expired') {
    return { status: 'expired', claims }
  }

  if (clock === 'not-yet-valid') {
    return { status: 'invalid' }
  }

  return { status: 'valid', claims }
}
