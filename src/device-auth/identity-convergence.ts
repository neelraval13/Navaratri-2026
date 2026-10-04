import {
  convergeDeviceIdentity,
  type ConvergencePlan,
  type ConvergenceResult,
} from '@/db/device-identity-convergence'
import { getDeviceSession } from '@/device-auth/device-api'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'

/**
 * Running the one identity migration, against a FRESHLY verified session.
 *
 * Convergence rewrites the identity stamped onto every future attendee
 * record, so it is the one action worth spending a round trip on: the button
 * may have been rendered minutes ago, and in between the session can expire,
 * the device can be disabled, its event can be deactivated, or an Admin can
 * reset its password. A cached context — and emphatically a signed offline
 * lease — is not good enough to migrate an identity from.
 *
 * The recheck uses the EXISTING `GET /api/device-auth`. No endpoint was added.
 */

export type ConvergenceFlowResult =
  | { outcome: 'converged'; result: ConvergenceResult }
  /** The live recheck refused, so nothing was written. */
  | { outcome: 'session-invalid' }
  /** The server could not be reached. Never converge on a guess. */
  | { outcome: 'unreachable' }
  /** The live device is not the one the operator was looking at. */
  | { outcome: 'device-changed' }
  /** The domain refused: a gap or a safety conflict. */
  | { outcome: 'refused'; plan: ConvergencePlan }

export const convergeDeviceIdentityOnline = async (input: {
  /** What the operator was shown. Used only to detect a swap, never to write. */
  expected: DeviceSessionContext
}): Promise<ConvergenceFlowResult> => {
  const session = await getDeviceSession()

  if (session.status === 'unauthenticated') {
    return { outcome: 'session-invalid' }
  }

  if (session.status !== 'authenticated') {
    /**
     * Offline, a timeout, or an unavailable server. NOT a rejection — but
     * also not permission to migrate. Identity convergence is online-only by
     * design, so the absence of an answer is simply a no.
     */
    return { outcome: 'unreachable' }
  }

  /**
   * The screen said one device; the server now says another. Converging
   * would bind this browser's future records to a device the operator never
   * agreed to.
   */
  if (
    session.context.device.id !== input.expected.device.id ||
    session.context.event.id !== input.expected.event.id
  ) {
    return { outcome: 'device-changed' }
  }

  // The FRESH context is what is written from, never the one on screen.
  const result = await convergeDeviceIdentity({ context: session.context })

  if (result.outcome !== 'converged' && result.outcome !== 'already-converged') {
    return { outcome: 'refused', plan: result }
  }

  return { outcome: 'converged', result }
}
