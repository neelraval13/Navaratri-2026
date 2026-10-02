import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

import {
  DEVICE_OFFLINE_AUTHORIZATION_TYPE,
  DEVICE_OFFLINE_AUTHORIZATION_VERSION,
  MAX_DEVICE_OFFLINE_LEASE_SECONDS,
  encodeUtf8,
  offlineAuthorizationSignedMessage,
  toBase64Url,
  type DeviceOfflineClaims,
} from '../../src/shared/device-offline-authorization.js'
import type { AuthenticatedDeviceContext } from './authenticate.js'

/**
 * Issuing the signed offline authorization lease.
 *
 * SERVER ONLY. It holds the private half of a P-256 key pair and must never
 * be imported from `src/`; the browser gets the public half through a
 * `VITE_` variable, which is exactly where a verification key belongs.
 *
 * It does NOT authenticate anything. It takes a context the device realm has
 * ALREADY authenticated and states, under signature, what that device was
 * allowed to do and until when. Authentication remains the session cookie.
 */

export const DEVICE_OFFLINE_PRIVATE_KEY_NAME =
  'EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64'

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type OfflineSigningDisabledReason =
  | 'private-key-missing'
  | 'private-key-unreadable'
  | 'private-key-wrong-curve'

/** Names the variable and the problem. NEVER any part of the value. */
export const OFFLINE_SIGNING_LOG_MESSAGES: Record<
  OfflineSigningDisabledReason,
  string
> = {
  'private-key-missing': `${DEVICE_OFFLINE_PRIVATE_KEY_NAME} is not set.`,
  'private-key-unreadable': `${DEVICE_OFFLINE_PRIVATE_KEY_NAME} is not a base64 PKCS#8 key.`,
  'private-key-wrong-curve': `${DEVICE_OFFLINE_PRIVATE_KEY_NAME} is not a P-256 (prime256v1) key.`,
}

export type OfflineSigningKeyResult =
  | { ok: true; privateKey: KeyObject }
  | { ok: false; reason: OfflineSigningDisabledReason }

/**
 * Reads and validates the signing key.
 *
 * PKCS#8 DER, base64 — not PEM — so the value survives a Vercel environment
 * variable without multiline handling. The curve is checked rather than
 * assumed: a P-384 key would sign happily and produce a 96-byte signature
 * the browser's P-256 verifier could never accept, and that failure would
 * only appear at a desk with no internet.
 */
export const readOfflineSigningKey = (
  source: EnvironmentSource = process.env,
): OfflineSigningKeyResult => {
  const encoded = source[DEVICE_OFFLINE_PRIVATE_KEY_NAME] ?? ''

  if (encoded === '') {
    return { ok: false, reason: 'private-key-missing' }
  }

  let privateKey: KeyObject

  try {
    privateKey = createPrivateKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    // The thrown error can quote key bytes, so it is never logged or returned.
    return { ok: false, reason: 'private-key-unreadable' }
  }

  const details = privateKey.asymmetricKeyDetails

  if (privateKey.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') {
    return { ok: false, reason: 'private-key-wrong-curve' }
  }

  return { ok: true, privateKey }
}

/**
 * What the endpoints put beside the safe device context.
 *
 * `configured: false` is an honest answer, not a failure: online device
 * authentication must keep working on a deployment that has not set up
 * offline signing. A fake lease is never invented.
 */
export type OfflineAuthorizationEnvelope =
  | { configured: false }
  | { configured: true; token: string; expiresAt: string }

const toEpochSeconds = (value: Date): number => Math.floor(value.getTime() / 1000)

/**
 * Signs a lease for an ALREADY AUTHENTICATED device.
 *
 * EXPIRY IS THE WHOLE POINT, so it is capped twice:
 *
 *   exp = min(now + 24h, event.endsAt)
 *
 * An event that has already ended yields NO lease — offline authority for a
 * finished event is authority nobody is watching. There is no indefinite
 * lease and no local extension; only this function may issue one.
 *
 * The claims are built field by field from the live context, never spread, so
 * a field added to the context later cannot become signed authority by
 * accident.
 */
export const issueDeviceOfflineAuthorization = (input: {
  context: AuthenticatedDeviceContext
  /** `events.ends_at`, when the event has one. */
  eventEndsAt: Date | null
  now?: Date
  source?: EnvironmentSource
}): OfflineAuthorizationEnvelope => {
  const key = readOfflineSigningKey(input.source)

  if (key.ok === false) {
    /**
     * An ABSENT key is a supported state in this phase, not an error: a
     * deployment without offline signing authenticates devices online
     * exactly as before. Logging it would print on every login and every
     * session check, and a log that cries wolf on a normal configuration is
     * a log nobody reads when something is actually wrong.
     *
     * A key that is PRESENT and unusable is a real misconfiguration — the
     * operator believes offline authorization works and it does not — so it
     * is reported. The message names the variable and the problem, never any
     * part of the value.
     */
    if (key.reason !== 'private-key-missing') {
      console.error(
        `Navaratri device offline authorization: unavailable. ${OFFLINE_SIGNING_LOG_MESSAGES[key.reason]}`,
      )
    }

    return { configured: false }
  }

  const now = input.now ?? new Date()
  const issuedAt = toEpochSeconds(now)
  const ceiling = issuedAt + MAX_DEVICE_OFFLINE_LEASE_SECONDS
  const eventEnd = input.eventEndsAt === null ? null : toEpochSeconds(input.eventEndsAt)
  const expiresAt = eventEnd === null ? ceiling : Math.min(ceiling, eventEnd)

  // Already over, or so close that the lease would be born expired.
  if (expiresAt <= issuedAt) {
    return { configured: false }
  }

  const claims: DeviceOfflineClaims = {
    v: DEVICE_OFFLINE_AUTHORIZATION_VERSION,
    t: DEVICE_OFFLINE_AUTHORIZATION_TYPE,
    deviceId: input.context.device.id,
    eventId: input.context.event.id,
    eventSlug: input.context.event.slug,
    attributes: [...input.context.device.attributes],
    activeBadgeRange:
      input.context.activeBadgeRange === null
        ? null
        : {
            rangeStart: input.context.activeBadgeRange.rangeStart,
            rangeEnd: input.context.activeBadgeRange.rangeEnd,
            assignedAt: input.context.activeBadgeRange.assignedAt,
          },
    iat: issuedAt,
    exp: expiresAt,
  }

  const encodedPayload = toBase64Url(encodeUtf8(JSON.stringify(claims)))

  /**
   * `ieee-p1363` produces the raw r‖s pair WebCrypto expects. Node's default
   * for ECDSA is DER, which `crypto.subtle.verify` rejects outright — and it
   * would do so only on an offline desk, where nobody can diagnose it.
   */
  const signature = sign('sha256', offlineAuthorizationSignedMessage(encodedPayload), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })

  return {
    configured: true,
    token: `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}
