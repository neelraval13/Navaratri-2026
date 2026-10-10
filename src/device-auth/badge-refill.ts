import {
  extendLocalBadgeRange,
  planCentralBadgeRangeRefill,
  type RangeExtensionResult,
  type RefillPlan,
} from '@/db/central-badge-range'
import { db } from '@/db/database'
import { EVENT_CONFIG_ID } from '@/db/types'

import { refillDeviceBadgeRange } from '@/device-auth/device-api'
import {
  withActiveBadgeRange,
  type DeviceBadgeRange,
  type DeviceSessionContext,
  type OfflineAuthorizationEnvelope,
} from '@/device-auth/device-session-contract'

/**
 * ONE deliberate operator action: extend this device's central badge range,
 * then extend the local one to match.
 *
 * There is no distributed transaction across Postgres and IndexedDB and there
 * cannot be, so the order is chosen for what each failure leaves behind:
 *
 *   1. the LOCAL preflight, because discovering a local disagreement after
 *      the central extension would leave this desk owning numbers it cannot
 *      issue — and nothing shrinks a central range
 *   2. the CENTRAL extension, which Postgres alone decides, guarded by the
 *      end this browser believes is current
 *   3. the LOCAL extension, from the range the SERVER returned
 *
 * Step 3 writes nothing itself. It calls the extension transaction, which
 * stays the only implementation of "local badge state follows a central
 * extension".
 *
 * `nextBadge` is never passed, computed or sent. It is the local allocator
 * and a refill adds numbers above it.
 */

export type BadgeRefillFlowResult =
  /** Extended centrally and locally. */
  | {
      outcome: 'refilled'
      activeBadgeRange: DeviceBadgeRange
      local: 'extended' | 'already-extended'
      /** Re-issued by the server for the POST-EXTENSION central state. */
      offlineAuthorization: OfflineAuthorizationEnvelope
    }
  /**
   * CENTRAL ownership SUCCEEDED and the local write did not. The extension is
   * deliberately NOT rolled back: it is real, the operator must know, and
   * undoing it would hand the numbers back while a human believes this desk
   * owns them. The next Refresh Device Status can finish it safely, because
   * the result is exactly the recoverable safe-superset shape.
   */
  | {
      outcome: 'refilled-not-extended'
      activeBadgeRange: DeviceBadgeRange
      offlineAuthorization: OfflineAuthorizationEnvelope
      reason: string
    }
  /** Local state could not safely be extended. Nothing was requested. */
  | { outcome: 'preflight-blocked'; plan: RefillPlan }
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
        | 'not-an-increase'
        | 'stale-range'
        | 'no-active-range'
        | 'range-overlap'
        | 'registration-required'
        | 'unauthenticated'
        | 'invalid'
        | 'not-configured'
        | 'unexpected'
      message: string
      /** This device's real range, when the refusal reported one. */
      activeBadgeRange: DeviceBadgeRange | null
      /** The last badge the OPERATOR asked for, so a refusal can name it. */
      requestedRangeEnd: number
    }

const STACK_NOT_CONFIRMED =
  'Confirm the additional physical badges are at this device before adding them.'

const NOT_AN_INCREASE =
  'Enter a last badge higher than the one this device already owns.'

export const refillCentralBadgeRange = async (input: {
  context: DeviceSessionContext
  newRangeEnd: number
  physicalStackConfirmed: boolean
}): Promise<BadgeRefillFlowResult> => {
  const requestedRangeEnd = input.newRangeEnd

  if (!input.physicalStackConfirmed) {
    return {
      outcome: 'refused',
      reason: 'stack-not-confirmed',
      message: STACK_NOT_CONFIRMED,
      activeBadgeRange: null,
      requestedRangeEnd,
    }
  }

  /**
   * The preflight is the REAL planner against the REAL stored row. There is
   * no second copy of the safety matrix: a refill is offered only where
   * central, local and the binding already agree.
   */
  const config = await db.config.get(EVENT_CONFIG_ID)
  const plan = planCentralBadgeRangeRefill({ config, context: input.context })

  if (plan.outcome !== 'refillable') {
    return { outcome: 'preflight-blocked', plan }
  }

  if (requestedRangeEnd <= plan.current.rangeEnd) {
    return {
      outcome: 'refused',
      reason: 'not-an-increase',
      message: NOT_AN_INCREASE,
      activeBadgeRange: null,
      requestedRangeEnd,
    }
  }

  const refilled = await refillDeviceBadgeRange({
    // The end this browser just read, so a range that moved underneath it is
    // refused centrally rather than overwritten.
    expectedRangeEnd: plan.current.rangeEnd,
    newRangeEnd: requestedRangeEnd,
    physicalStackConfirmed: true,
  })

  if (refilled.status === 'unreachable') {
    return { outcome: 'unconfirmed', message: refilled.message }
  }

  if (refilled.status !== 'extended' && refilled.status !== 'already-extended') {
    return {
      outcome: 'refused',
      reason: refilled.status,
      message: refilled.message,
      activeBadgeRange:
        refilled.status === 'stale-range' ? refilled.activeBadgeRange : null,
      requestedRangeEnd,
    }
  }

  /**
   * The AUTHORITATIVE range, as Postgres recorded it — never the number the
   * operator typed. The local write reads it from this context.
   */
  const extension: RangeExtensionResult = await extendLocalBadgeRange({
    context: withActiveBadgeRange(input.context, refilled.activeBadgeRange),
  })

  if (extension.outcome === 'extended' || extension.outcome === 'already-extended') {
    return {
      outcome: 'refilled',
      activeBadgeRange: refilled.activeBadgeRange,
      local: extension.outcome,
      offlineAuthorization: refilled.offlineAuthorization,
    }
  }

  return {
    outcome: 'refilled-not-extended',
    activeBadgeRange: refilled.activeBadgeRange,
    offlineAuthorization: refilled.offlineAuthorization,
    reason: extension.reason,
  }
}

/**
 * The session context, updated with whatever the SERVER just proved about
 * central state.
 *
 * A successful extension makes the context this page is holding stale the
 * instant it returns: it was fetched before the range grew. ONLY an outcome
 * carrying an extension this request CONFIRMED updates it, and the range
 * installed is the one Postgres returned, never the one the operator typed.
 *
 * `unconfirmed` carries nothing authoritative, and `refused` is left alone —
 * `stale-range` does report this device's real range, but reconciling it is a
 * deliberate Refresh Device Status, not a silent swap underneath the operator.
 */
export const contextAfterRefill = (
  context: DeviceSessionContext,
  result: BadgeRefillFlowResult,
): DeviceSessionContext => {
  if (result.outcome === 'refilled' || result.outcome === 'refilled-not-extended') {
    return withActiveBadgeRange(context, result.activeBadgeRange)
  }

  return context
}
