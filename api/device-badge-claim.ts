import { BADGE_RANGE_REQUIRED_ATTRIBUTE } from '../src/shared/device-attributes.js'
import { PUBLIC_BADGE_CLAIM_CONFLICT } from '../server/badge-assignments/conflicts.js'
import { isSameBadgeRange, type BadgeRangeInput } from '../server/badge-assignments/range.js'
import {
  readActiveBadgeAssignment,
  reserveBadgeRange,
  type CentralBadgeRange,
} from '../server/badge-assignments/reserve.js'
import type { AuthenticatedDeviceContext } from '../server/device-auth/authenticate.js'
import { authorizeDeviceRequest } from '../server/device-auth/authorize.js'
import { issueDeviceOfflineAuthorization } from '../server/device-auth/offline-authorization.js'
import { deviceJson, readDeviceBody } from '../server/device-auth/http.js'
import { parseDeviceBadgeClaimInput } from '../server/device-auth/requests.js'

/**
 * AUTHENTICATED ONLINE BADGE-RANGE SELF-CLAIM.
 *
 * An operator standing at a desk with a physical badge stack asks central
 * Postgres to record that THIS device owns those numbers. Postgres decides
 * ownership; the device keeps allocating locally, because issuing a badge
 * must work with no network.
 *
 * The server knows nothing about local state — not `nextBadge`, not the local
 * device id, not which badges this browser already issued, not whether it
 * holds a binding. It answers exactly one question:
 *
 *   "May this authenticated central device own this central range?"
 *
 * Whether the browser can then SAFELY adopt the range is the browser's own
 * question, answered against IndexedDB before this endpoint is ever called.
 *
 * IDENTITY COMES FROM THE COOKIE. `deviceId`, `eventId`, `eventSlug` and
 * `loginName` are refused in the body rather than ignored.
 */

const MESSAGES = {
  registrationRequired:
    'This device does not have Registration access, so it cannot own a badge range.',
  overlap: 'That badge range is already assigned.',
  alreadyAssigned: 'This device already has a central badge assignment.',
  eventMismatch: 'That badge range could not be claimed for this device.',
  unexpected: 'That badge range could not be claimed. Try again.',
} as const

/**
 * A successful claim CHANGES central badge ownership, so the lease the
 * browser is holding is stale the moment it returns. A fresh one is issued
 * from the authoritative post-claim state, which spares the caller an extra
 * session round trip purely to catch up.
 *
 * A REFUSED claim issues none: nothing changed, and a new lease would imply
 * it had.
 */
const claimed = (
  range: CentralBadgeRange,
  status: 200 | 201,
  authorized: { context: AuthenticatedDeviceContext; eventEndsAt: Date | null },
): Response =>
  deviceJson(
    {
      ok: true,
      outcome: status === 201 ? 'claimed' : 'already-claimed',
      activeBadgeRange: range,
      offlineAuthorization: issueDeviceOfflineAuthorization({
        // The range the device now owns, not the one the session was loaded
        // with: the claim is what made them differ.
        context: { ...authorized.context, activeBadgeRange: range },
        eventEndsAt: authorized.eventEndsAt,
      }),
    },
    status,
  )

/**
 * This device already owns a DIFFERENT active range.
 *
 * It is never replaced and a second is never created. Its own range travels
 * back so the browser can reconcile against the truth rather than against
 * what it asked for.
 */
const alreadyAssigned = (range: CentralBadgeRange | null): Response =>
  deviceJson(
    {
      ok: false,
      conflict: PUBLIC_BADGE_CLAIM_CONFLICT['badge-range-already-assigned'],
      activeBadgeRange: range,
      message: MESSAGES.alreadyAssigned,
    },
    409,
  )

/**
 * Resolves an insert that the one-active-per-device index refused.
 *
 * Two requests from the SAME device can both see no assignment; one commits
 * and the other lands here. Re-reading tells which happened: if the committed
 * range is the one this request asked for, the caller's claim did in fact
 * succeed and the answer is an idempotent success. The same path recovers a
 * retry after a response was lost in flight.
 */
const resolveExistingAssignment = async (
  deviceId: string,
  requested: BadgeRangeInput,
  authorized: { context: AuthenticatedDeviceContext; eventEndsAt: Date | null },
): Promise<Response> => {
  const current = await readActiveBadgeAssignment(deviceId)

  if (current !== null && isSameBadgeRange(current, requested)) {
    return claimed(current, 200, authorized)
  }

  return alreadyAssigned(current)
}

export async function POST(request: Request): Promise<Response> {
  const authorized = await authorizeDeviceRequest(request, { mutating: true })

  if (authorized.ok === false) {
    return authorized.response
  }

  const { device, event } = authorized.context

  const body = await readDeviceBody(request)

  if (body.ok === false) {
    return body.response
  }

  const input = parseDeviceBadgeClaimInput(body.body)

  if (input.ok === false) {
    return deviceJson({ ok: false, message: input.message }, 400)
  }

  /**
   * The CURRENT central attribute set, re-read with the session. An Admin may
   * have removed `registration` after this form was rendered, and the browser
   * guard is only a courtesy — this is the one that decides.
   */
  if (!device.attributes.includes(BADGE_RANGE_REQUIRED_ATTRIBUTE)) {
    return deviceJson(
      {
        ok: false,
        blocked: 'registration-required',
        message: MESSAGES.registrationRequired,
      },
      403,
    )
  }

  try {
    /**
     * A precheck, for a useful answer rather than for safety: it turns the
     * ordinary retry and double-click into a clean idempotent success instead
     * of a constraint violation. The constraint below is what actually
     * prevents a second assignment.
     */
    const existing = await readActiveBadgeAssignment(device.id)

    if (existing !== null) {
      return isSameBadgeRange(existing, input.value)
        ? claimed(existing, 200, authorized)
        : alreadyAssigned(existing)
    }

    const reserved = await reserveBadgeRange({
      eventId: event.id,
      deviceId: device.id,
      range: input.value,
    })

    if (reserved.ok === false) {
      if (reserved.conflict === 'badge-range-already-assigned') {
        return await resolveExistingAssignment(device.id, input.value, authorized)
      }

      /**
       * Translated through the ONE internal-to-public map. The identifier on
       * the wire is a stable public name the browser shares the definition
       * of; a Postgres constraint name never leaves the server.
       *
       * `range-overlap` means another device in this event owns part of these
       * numbers. Nothing is written, and nothing is said about WHICH device —
       * the operator needs to check the physical stack, not the registry.
       *
       * `device-event-mismatch` should be unreachable, since both come from
       * one authenticated session. It fails closed anyway: a guarantee that
       * is never exercised is a guarantee that quietly lapses.
       */
      const conflict = PUBLIC_BADGE_CLAIM_CONFLICT[reserved.conflict]

      return deviceJson(
        {
          ok: false,
          conflict,
          message: conflict === 'range-overlap' ? MESSAGES.overlap : MESSAGES.eventMismatch,
        },
        409,
      )
    }

    return claimed(reserved.value, 201, authorized)
  } catch (error: unknown) {
    // The operation and, where available, the SQLSTATE. Never the body, never
    // the connection string, never a raw driver error.
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown'

    console.error(`Navaratri device badge claim: failed (SQLSTATE ${code}).`)

    return deviceJson({ ok: false, message: MESSAGES.unexpected }, 500)
  }
}
