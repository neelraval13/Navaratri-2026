import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'

import { DeviceEventAuthorizationContext } from '@/device-auth/device-event-authorization-context'
import {
  resolveFromCachedLease,
  resolveFromServer,
  type AuthorizationSettlement,
} from '@/device-auth/event-authorization-runtime'
import { useNetworkStatus } from '@/hooks/use-network-status'

interface DeviceEventAuthorizationProviderProps {
  children: React.ReactNode
}

/**
 * The ONE owner of device event authorization.
 *
 * Mounted once around the event routes, so a page never performs its own
 * session check and navigating between modules never starts another. The
 * decisions live in `event-authorization-runtime`; this is the shell that
 * owns state, timers and staleness.
 *
 * TWO TRIGGERS, DELIBERATELY SEPARATE:
 *
 *   sessionAttempt + network   the ONLINE path, one `GET /api/device-auth`
 *   the expiry timer           the LOCAL path, which reaches no network
 *
 * They used to share one counter, which meant the lease-expiry timer re-ran
 * the online check and issued a request nobody had asked for. A timer that
 * fires because a local clock passed a number must not talk to a server —
 * on an offline desk it would fail pointlessly, and on an online one it
 * would quietly become the heartbeat this design does not have.
 *
 * THERE IS NO POLLING. The server is asked on mount, on an offline → online
 * transition, and when an operator explicitly refreshes.
 */
const DeviceEventAuthorizationProvider: React.FC<
  DeviceEventAuthorizationProviderProps
> = ({ children }) => {
  const network = useNetworkStatus()

  const [settled, setSettled] = useState<AuthorizationSettlement | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sessionAttempt, setSessionAttempt] = useState(0)

  /**
   * LATEST RESULT WINS, by sequence rather than by timing.
   *
   * A manual refresh can start while the mount check is still in flight, and
   * an expiry can land between the two. If an older resolution answered last
   * it would reinstate access a newer one had just withdrawn, so every
   * settle is stamped and a stale one is dropped.
   */
  const sequence = useRef(0)

  const settle = useCallback(
    async (resolve: () => Promise<AuthorizationSettlement>) => {
      const ticket = sequence.current + 1

      sequence.current = ticket

      const next = await resolve()

      if (sequence.current !== ticket) {
        return
      }

      setSettled(next)
      setIsRefreshing(false)
    },
    [],
  )

  useEffect(() => {
    void settle(resolveFromServer)
  }, [settle, sessionAttempt, network])

  /**
   * ONE timer, armed from the VERIFIED signed expiry.
   *
   * It is not a heartbeat and must never become one: it resolves LOCALLY, so
   * no request of any kind results from a lease running out. The lease is
   * never extended and nothing is retried — authority simply ends, and the
   * gate asks the desk to verify the device again.
   */
  const expiresAt = settled?.grant?.expiresAt

  useEffect(() => {
    if (expiresAt === undefined) {
      return
    }

    // Clamped rather than branched: an already-expired lease re-evaluates on
    // the next tick, which keeps this a single timer with a single exit.
    const delay = Math.max(0, expiresAt * 1000 - Date.now())

    const timer = setTimeout(() => {
      void settle(() => resolveFromCachedLease())
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [settle, expiresAt])

  const refresh = useCallback(() => {
    setIsRefreshing(true)
    setSessionAttempt((previous) => previous + 1)
  }, [])

  const value = useMemo(
    () => ({
      isChecking: settled === null,
      grant: settled?.grant ?? null,
      config: settled?.config,
      enrollment: settled?.enrollment,
      deviceName: settled?.deviceName ?? null,
      isRefreshing,
      refresh,
    }),
    [settled, isRefreshing, refresh],
  )

  return (
    <DeviceEventAuthorizationContext.Provider value={value}>
      {children}
    </DeviceEventAuthorizationContext.Provider>
  )
}

export default DeviceEventAuthorizationProvider
