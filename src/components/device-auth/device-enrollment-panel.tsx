import { CircleAlert, LogOut, RotateCcw, ShieldOff, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type * as React from 'react'

import DeviceIdentitySummary from '@/components/device-auth/device-identity-summary'
import LocalBadgeSetup from '@/components/device-auth/local-badge-setup'
import DeviceLoginForm from '@/components/device-auth/device-login-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  adoptCentralBadgeRange,
  readCentralBadgeRangeBinding,
  readCentralBadgeRangePlan,
  type AdoptionPlan,
} from '@/db/central-badge-range'
import {
  clearCentralDeviceEnrollment,
  readCentralDeviceEnrollment,
  saveCentralDeviceEnrollment,
} from '@/db/central-enrollment'
import type { CentralDeviceEnrollment, EventConfig } from '@/db/types'
import { getDeviceSession, logoutDevice } from '@/device-auth/device-api'
import type { DeviceSessionContext } from '@/device-auth/device-session-contract'
import { formatBadgeRange } from '@/db/device'
import { formatEventDateTime } from '@/lib/datetime'

/**
 * What this browser currently knows about its central device identity.
 *
 * `authenticated` is only ever reached from a SERVER answer. A cached
 * enrollment can produce `last-verified`, never `authenticated`: the HttpOnly
 * cookie is the credential, `GET /api/device-auth` is the only way to
 * check it, and offline trust rules do not exist yet.
 */
type PanelState =
  | { phase: 'checking' }
  | {
      phase: 'authenticated'
      context: DeviceSessionContext
      verifiedAt: string
      /**
       * Local badge state, read from the COMMITTED config row rather than
       * assumed from the central assignment. Adoption re-reads it, so the UI
       * never claims a write that did not happen.
       */
      badge: { plan: AdoptionPlan; config: EventConfig | undefined }
    }
  | { phase: 'signed-out'; enrollment: CentralDeviceEnrollment | null }
  | { phase: 'last-verified'; enrollment: CentralDeviceEnrollment }
  | { phase: 'not-configured' }
  | {
      phase: 'mismatch'
      enrolled: CentralDeviceEnrollment
      attempted: { deviceId: string; deviceName: string }
      logoutFailed: boolean
      /** An adopted central badge range that clearing will NOT remove. */
      adoptedRange: { rangeStart: number; rangeEnd: number } | null
    }
  | { phase: 'failed'; message: string }

/**
 * Central device login and enrollment for this browser.
 *
 * PARALLEL to the event application, not in front of it. Signing in here does
 * not unlock `/`, `/badge-registration` or `/device-registration` — those
 * still answer to Operator Access exactly as before — and signing out here
 * does not lock them.
 *
 * There is NO polling. The session is checked on mount, after a login, and
 * when the operator explicitly refreshes. A background timer would be a
 * heartbeat, which this phase deliberately does not have.
 */
const DeviceEnrollmentPanel: React.FC = () => {
  const [state, setState] = useState<PanelState>({ phase: 'checking' })
  const [isBusy, setIsBusy] = useState(false)
  const [badgeError, setBadgeError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  /**
   * Reconciles a SERVER-confirmed context with what this browser is bound to.
   *
   * A different central device is refused rather than swapped in: badge
   * ownership will depend on this binding, so rebinding is an explicit
   * operator decision. The impostor session is ended immediately so the
   * browser is not left holding a cookie it declined to enroll.
   */
  const persist = async (context: DeviceSessionContext) => {
    const saved = await saveCentralDeviceEnrollment(context)

    if (saved.outcome === 'saved') {
      /**
       * READ ONLY. Verifying a session never adopts a badge range: a central
       * assignment proves ownership, not that the physical badges are at this
       * desk. Only the explicit operator action below writes anything.
       */
      const badge = await readCentralBadgeRangePlan(context)

      setState({
        phase: 'authenticated',
        context,
        verifiedAt: saved.enrollment.verifiedAt,
        badge,
      })

      return
    }

    if (saved.outcome === 'missing-config') {
      setState({
        phase: 'failed',
        message: 'Local storage is not ready. Reload and try again.',
      })

      return
    }

    const endedSession = await logoutDevice()
    const binding = await readCentralBadgeRangeBinding()

    setState({
      phase: 'mismatch',
      enrolled: saved.enrolled,
      attempted: saved.attempted,
      logoutFailed: !endedSession.ok,
      adoptedRange:
        binding === undefined
          ? null
          : { rangeStart: binding.rangeStart, rangeEnd: binding.rangeEnd },
    })
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const [session, enrollment] = await Promise.all([
        getDeviceSession(),
        readCentralDeviceEnrollment(),
      ])

      if (cancelled) {
        return
      }

      if (session.status === 'authenticated') {
        await persist(session.context)

        return
      }

      if (session.status === 'not-configured') {
        setState({ phase: 'not-configured' })

        return
      }

      /**
       * Offline, or the server could not be reached. A cached enrollment is
       * shown as the LAST VERIFIED identity — never as an authenticated one.
       */
      if (session.status === 'unreachable') {
        setState(
          enrollment === undefined
            ? { phase: 'signed-out', enrollment: null }
            : { phase: 'last-verified', enrollment },
        )

        return
      }

      setState({ phase: 'signed-out', enrollment: enrollment ?? null })
    })()

    return () => {
      cancelled = true
    }
  }, [attempt])

  const refresh = () => {
    setState({ phase: 'checking' })
    setAttempt((previous) => previous + 1)
  }

  const signOut = async () => {
    if (isBusy) {
      return
    }

    setIsBusy(true)

    const endedSession = await logoutDevice()

    if (!endedSession.ok) {
      setIsBusy(false)
      // The local enrollment is KEPT: claiming the server cookie is gone when
      // the request never arrived would be a lie the operator acts on.
      setState({
        phase: 'failed',
        message:
          'Could not reach the server to sign this device out. The device session is still active. Try again when the connection returns.',
      })

      return
    }

    await clearCentralDeviceEnrollment()
    setIsBusy(false)
    setState({ phase: 'signed-out', enrollment: null })
  }

  /**
   * The ONLY caller of the adoption write, and only from an authenticated
   * state. The result is re-read from the committed row, so the summary cannot
   * show a range this browser did not actually store.
   */
  const adopt = async (physicalStackConfirmed: boolean) => {
    if (isBusy || state.phase !== 'authenticated') {
      return
    }

    setIsBusy(true)
    setBadgeError(null)

    const result = await adoptCentralBadgeRange({
      context: state.context,
      physicalStackConfirmed,
    })

    const badge = await readCentralBadgeRangePlan(state.context)

    setIsBusy(false)
    setState({ ...state, badge })

    if (result.outcome === 'stack-not-confirmed') {
      setBadgeError('Confirm the physical badges are at this device first.')

      return
    }

    if (
      result.outcome !== 'adopted' &&
      result.outcome !== 'aligned' &&
      result.outcome !== 'already-adopted'
    ) {
      setBadgeError('That badge range could not be set up. See the status below.')
    }
  }

  const clearEnrollment = async () => {
    if (isBusy) {
      return
    }

    setIsBusy(true)
    await clearCentralDeviceEnrollment()
    setIsBusy(false)
    setState({ phase: 'signed-out', enrollment: null })
  }

  if (state.phase === 'checking') {
    return (
      <Card>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Checking the central device session…
          </p>
        </CardContent>
      </Card>
    )
  }

  if (state.phase === 'not-configured') {
    return (
      <Card>
        <CardContent className="space-y-4 text-center">
          <p className="flex items-center justify-center gap-2 font-semibold">
            <ShieldOff className="size-5" />
            Device sign-in is unavailable
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Device authentication is not configured right now. Event operations
            are unaffected and continue to use Operator Access.
          </p>

          <Button
            type="button"
            variant="outline"
            className="h-12 sm:min-w-32"
            onClick={refresh}
          >
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (state.phase === 'mismatch') {
    return (
      <Card>
        <CardContent className="space-y-4">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            This browser is already a different device
          </p>

          <p className="text-sm leading-relaxed">
            This browser is enrolled as{' '}
            <strong>{state.enrolled.deviceName}</strong>. It cannot silently
            switch to <strong>{state.attempted.deviceName}</strong>.
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            {state.logoutFailed
              ? 'The other device session could not be ended from here. Sign it out once the connection returns.'
              : 'That sign-in has been ended. Nothing was changed.'}
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            To bind this browser to a different central device, clear the
            enrollment first. This removes only the central device identity —
            it does not touch this desk&rsquo;s badge range, its registrations
            or its operator access.
          </p>

          {/*
            Said explicitly, because it is the surprising part: an adopted
            badge range is durable operational state and survives clearing the
            identity. Nothing cascades.
          */}
          {state.adoptedRange === null ? null : (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              This browser has an adopted central badge range{' '}
              {formatBadgeRange(state.adoptedRange.rangeStart, state.adoptedRange.rangeEnd)}.
              Clearing the identity does not remove that local badge range.
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            disabled={isBusy}
            className="h-12"
            onClick={() => {
              void clearEnrollment()
            }}
          >
            Clear Central Enrollment
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (state.phase === 'last-verified') {
    return (
      <Card>
        <CardContent className="space-y-4">
          <p className="flex items-center gap-2 font-semibold">
            <WifiOff className="size-5" />
            Not verified right now
          </p>

          <p className="text-sm leading-relaxed">
            Last verified device:{' '}
            <strong>{state.enrollment.deviceName}</strong>
            {' · '}
            {formatEventDateTime(state.enrollment.verifiedAt)}
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Internet is required to verify or change the central device in this
            phase. Event operations are unaffected and continue to use Operator
            Access.
          </p>

          <Button
            type="button"
            variant="outline"
            className="h-12 sm:min-w-44"
            onClick={refresh}
          >
            <RotateCcw data-icon="inline-start" />
            Refresh Device Status
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (state.phase === 'failed') {
    return (
      <Card>
        <CardContent className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>

          <Button
            type="button"
            variant="outline"
            className="h-12 sm:min-w-44"
            onClick={refresh}
          >
            <RotateCcw data-icon="inline-start" />
            Refresh Device Status
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (state.phase === 'authenticated') {
    return (
      <Card>
        <CardContent className="space-y-6">
          <DeviceIdentitySummary
            context={state.context}
            verifiedAt={state.verifiedAt}
          />

          <LocalBadgeSetup
            deviceName={state.context.device.name}
            plan={state.badge.plan}
            config={state.badge.config}
            isBusy={isBusy}
            error={badgeError}
            onAdopt={(physicalStackConfirmed) => {
              void adopt(physicalStackConfirmed)
            }}
          />

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={isBusy}
              className="h-12"
              onClick={refresh}
            >
              <RotateCcw data-icon="inline-start" />
              Refresh Device Status
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={isBusy}
              className="h-12"
              onClick={() => {
                void signOut()
              }}
            >
              <LogOut data-icon="inline-start" />
              Sign Out Device
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        {state.enrollment === null ? null : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            This browser was last verified as{' '}
            <strong>{state.enrollment.deviceName}</strong>. Sign in again to
            confirm it.
          </p>
        )}

        <DeviceLoginForm
          onAuthenticated={(context) => {
            void persist(context)
          }}
        />
      </CardContent>
    </Card>
  )
}

export default DeviceEnrollmentPanel
