import {
  adoptCentralBadgeRange,
  checkCentralBadgeRangeClaimable,
  type AdoptionPlan,
} from '@/db/central-badge-range'

import { claimDeviceBadgeRange } from '@/device-auth/device-api'
import {
  withActiveBadgeRange,
  type DeviceBadgeRange,
  type DeviceSessionContext,
  type OfflineAuthorizationEnvelope,
} from '@/device-auth/device-session-contract'

/**
 * ONE deliberate operator action: reserve a badge range centrally, then set
 * it up locally.
 *
 * There is no distributed transaction across Postgres and IndexedDB and
 * there cannot be, so the order is chosen for what each failure leaves
 * behind:
 *
 *   1. the LOCAL preflight, because discovering a local conflict after the
 *      central reservation would leave this desk owning numbers it cannot
 *      issue — and nothing releases a central range in this phase
 *   2. the CENTRAL reservation, which Postgres alone decides
 *   3. the LOCAL adoption, from the range the SERVER returned
 *
 * Step 3 writes nothing itself. It calls the existing adoption transaction,
 * which stays the only thing in this application that writes a local badge
 * range from a central assignment.
 */

export type BadgeClaimFlowResult =
  /** Reserved centrally and set up locally. */
  | {
      outcome: 'claimed'
      activeBadgeRange: DeviceBadgeRange
      adoption: 'adopted' | 'aligned' | 'already-adopted'
      /** Re-issued by the server for the POST-CLAIM central state. */
      offlineAuthorization: OfflineAuthorizationEnvelope
    }
  /**
   * Central ownership SUCCEEDED and local setup did not. The reservation is
   * deliberately NOT rolled back: it is real, the operator must know, and
   * undoing it automatically would hand the numbers back while a human still
   * believes this desk owns them.
   */
  | {
      outcome: 'claimed-not-adopted'
      activeBadgeRange: DeviceBadgeRange
      /** Central ownership IS real here, so its lease is real too. */
      offlineAuthorization: OfflineAuthorizationEnvelope
      /**
       * The refusal, when it is one the shared block can explain. `null`
       * covers only the unconfirmed-stack branch, which this flow cannot
       * reach — it passes `true` — and which is therefore typed away rather
       * than described with a message that would not be true.
       */
      plan: AdoptionPlan | null
    }
  /** Local state could not safely adopt the range. Nothing was requested. */
  | { outcome: 'preflight-blocked'; plan: AdoptionPlan }
  /**
   * The request may or may not have committed. Nothing local was changed and
   * nothing is retried: central state must be re-checked first.
   */
  | { outcome: 'unconfirmed'; message: string }
  /** Central refused. Nothing local was changed. */
  | {
      outcome: 'refused'
      reason:
        | 'stack-not-confirmed'
        | 'already-assigned'
        | 'range-overlap'
        | 'registration-required'
        | 'unauthenticated'
        | 'invalid'
        | 'not-configured'
        | 'unexpected'
      message: string
      /** This device's real range, when the refusal was `already-assigned`. */
      activeBadgeRange: DeviceBadgeRange | null
      /**
       * What the OPERATOR asked for. Carried so a refusal can name it back —
       * "#401-#500 overlap a range already assigned" is actionable where "that
       * range is taken" is not. It is their own input, so showing it reveals
       * nothing about the registry.
       */
      requested: { rangeStart: number; rangeEnd: number }
    }

const STACK_NOT_CONFIRMED =
  'Confirm the physical badges are at this device before claiming the range.'

export const claimCentralBadgeRange = async (input: {
  context: DeviceSessionContext
  rangeStart: number
  rangeEnd: number
  physicalStackConfirmed: boolean
}): Promise<BadgeClaimFlowResult> => {
  const requested = { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd }

  if (!input.physicalStackConfirmed) {
    return {
      outcome: 'refused',
      reason: 'stack-not-confirmed',
      message: STACK_NOT_CONFIRMED,
      activeBadgeRange: null,
      requested,
    }
  }

  const preflight = await checkCentralBadgeRangeClaimable({
    context: input.context,
    requested,
  })

  if (preflight.ok === false) {
    return { outcome: 'preflight-blocked', plan: preflight.plan }
  }

  const claimed = await claimDeviceBadgeRange({
    rangeStart: requested.rangeStart,
    rangeEnd: requested.rangeEnd,
    physicalStackConfirmed: true,
  })

  if (claimed.status === 'unreachable') {
    return { outcome: 'unconfirmed', message: claimed.message }
  }

  if (claimed.status !== 'claimed' && claimed.status !== 'already-claimed') {
    return {
      outcome: 'refused',
      reason: claimed.status,
      message: claimed.message,
      activeBadgeRange:
        claimed.status === 'already-assigned' ? claimed.activeBadgeRange : null,
      requested,
    }
  }

  /**
   * The AUTHORITATIVE assignment, as Postgres recorded it — never the numbers
   * the operator typed. `assignedAt` in particular is the server's.
   */
  const adoption = await adoptCentralBadgeRange({
    context: withActiveBadgeRange(input.context, claimed.activeBadgeRange),
    // Carried through from the confirmation that opened this flow. Adoption
    // asks again because it is the write, and the write has its own guard.
    physicalStackConfirmed: true,
  })

  if (
    adoption.outcome === 'adopted' ||
    adoption.outcome === 'aligned' ||
    adoption.outcome === 'already-adopted'
  ) {
    return {
      outcome: 'claimed',
      activeBadgeRange: claimed.activeBadgeRange,
      adoption: adoption.outcome,
      offlineAuthorization: claimed.offlineAuthorization,
    }
  }

  return {
    outcome: 'claimed-not-adopted',
    activeBadgeRange: claimed.activeBadgeRange,
    plan: adoption.outcome === 'stack-not-confirmed' ? null : adoption,
    offlineAuthorization: claimed.offlineAuthorization,
  }
}

/**
 * The session context, updated with whatever the SERVER just proved about
 * central state.
 *
 * A successful reservation makes the context this page is holding stale the
 * instant it returns: it was fetched before the range existed. Re-planning
 * against that stale copy is what briefly told a desk that had just claimed
 * #401-#500 that its "badge ownership history does not match the current
 * central state" — the local binding was real and central looked empty.
 *
 * ONLY an outcome carrying a reservation this request CONFIRMED updates it,
 * and the range installed is the one Postgres returned, never the one the
 * operator typed:
 *
 * - `claimed` and `claimed-not-adopted` carry a confirmed assignment. The
 *   second matters most: central ownership is real there, so the page must
 *   keep saying so while it reports that local setup failed.
 * - `unconfirmed` carries NOTHING authoritative. Manufacturing central state
 *   from a request whose outcome is unknown is exactly the guess that case
 *   exists to avoid.
 * - `preflight-blocked` never reached the server.
 * - `refused` is left alone. `already-assigned` does report this device's real
 *   range, but reconciling it is a deliberate Refresh Device Status, not a
 *   silent swap of the context underneath the operator.
 */
export const contextAfterClaim = (
  context: DeviceSessionContext,
  result: BadgeClaimFlowResult,
): DeviceSessionContext => {
  if (result.outcome === 'claimed' || result.outcome === 'claimed-not-adopted') {
    return withActiveBadgeRange(context, result.activeBadgeRange)
  }

  return context
}
