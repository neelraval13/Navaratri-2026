import { readCentralDeviceEnrollment } from '@/db/central-enrollment'
import { db } from '@/db/database'
import { EVENT_CONFIG_ID, type CentralDeviceEnrollment, type EventConfig } from '@/db/types'
import { getDeviceSession, type DeviceSessionResult } from '@/device-auth/device-api'
import {
  grantFromDeviceSession,
  grantFromOfflineClaims,
  type DeviceOperationalGrant,
} from '@/device-auth/event-authorization'
import {
  acceptOfflineAuthorization,
  readVerifiedOfflineAuthorization,
  revokeOfflineAuthorization,
  type CachedOfflineLease,
} from '@/device-auth/offline-lease'

/**
 * How device event authority is established, as two plain async functions.
 *
 * Deliberately OUTSIDE React. The security-relevant question — "does this
 * path reach the network?" — is answered by counting calls on a fake, which
 * is impossible to do honestly inside an effect graph. The provider is left
 * as a thin shell that owns timers and state, nothing more.
 *
 * TWO PATHS, and keeping them apart is the whole point:
 *
 *   resolveFromServer       one session check; the online authority
 *   resolveFromCachedLease  LOCAL ONLY; touches no network at all
 *
 * They were once the same path behind a shared trigger, which meant the
 * lease-expiry timer re-ran the online check and quietly issued a
 * `GET /api/device-auth` that nothing had asked for.
 */

export interface AuthorizationSettlement {
  grant: DeviceOperationalGrant | null
  config: EventConfig | undefined
  enrollment: CentralDeviceEnrollment | undefined
  deviceName: string | null
}

/**
 * Every effect either path may have. Injected so a test can count them —
 * above all `checkSession`, which must never be reached locally.
 */
export interface AuthorizationSources {
  checkSession: () => Promise<DeviceSessionResult>
  acceptLease: typeof acceptOfflineAuthorization
  revokeLease: () => Promise<void>
  readVerifiedLease: (now?: Date) => Promise<CachedOfflineLease>
  readLocalFacts: () => Promise<{
    config: EventConfig | undefined
    enrollment: CentralDeviceEnrollment | undefined
  }>
}

export const defaultAuthorizationSources: AuthorizationSources = {
  checkSession: getDeviceSession,
  acceptLease: acceptOfflineAuthorization,
  revokeLease: revokeOfflineAuthorization,
  readVerifiedLease: readVerifiedOfflineAuthorization,
  readLocalFacts: async () => {
    const [config, enrollment] = await Promise.all([
      db.config.get(EVENT_CONFIG_ID),
      readCentralDeviceEnrollment(),
    ])

    return { config, enrollment }
  },
}

/**
 * The ONLINE path: ask the server, and let its answer decide.
 *
 * An authenticated answer is the authority and its fresh lease replaces the
 * cached one, so a changed attribute set or badge range takes effect at once
 * with no stale lease to fall back on. A DEFINITIVE rejection revokes. Any
 * other outcome — offline, timeout, 503 — is the absence of an answer, not a
 * revocation, and falls back to the verified cached lease.
 */
export const resolveFromServer = async (
  sources: AuthorizationSources = defaultAuthorizationSources,
): Promise<AuthorizationSettlement> => {
  const session = await sources.checkSession()

  let grant: DeviceOperationalGrant | null = null
  let deviceName: string | null = null

  if (session.status === 'authenticated') {
    await sources.acceptLease({
      context: session.context,
      envelope: session.offlineAuthorization,
    })

    grant = grantFromDeviceSession(session.context)
    deviceName = session.context.device.name
  } else if (session.status === 'unauthenticated') {
    await sources.revokeLease()
  } else {
    const cached = await sources.readVerifiedLease()

    grant = cached.status === 'valid' ? grantFromOfflineClaims(cached.claims) : null
  }

  const { config, enrollment } = await sources.readLocalFacts()

  return { grant, config, enrollment, deviceName: deviceName ?? enrollment?.deviceName ?? null }
}

/**
 * The LOCAL path: re-verify the cached lease and settle from what it proves
 * NOW. It makes no request of any kind, by construction — `checkSession` is
 * never called here.
 *
 * This is what a lease expiry runs. An expired lease simply stops being
 * authority: it is never refreshed, never extended, and nothing is retried.
 * If Operator Access happens to be unlocked the route continues on that
 * authority; otherwise the access gate appears.
 */
export const resolveFromCachedLease = async (
  sources: AuthorizationSources = defaultAuthorizationSources,
  now: Date = new Date(),
): Promise<AuthorizationSettlement> => {
  const cached = await sources.readVerifiedLease(now)
  const grant = cached.status === 'valid' ? grantFromOfflineClaims(cached.claims) : null
  const { config, enrollment } = await sources.readLocalFacts()

  return { grant, config, enrollment, deviceName: enrollment?.deviceName ?? null }
}
