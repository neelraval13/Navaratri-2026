import type * as React from 'react'
import { Route, Switch } from 'wouter'

import { EVENT_ROUTE_PATTERN, ROUTES } from '@/app/routes'
import EventAccessGate from '@/components/event-access/event-access-gate'
import EventAppGate from '@/components/event-app-gate'
import OperatorAccessGate from '@/components/operator/operator-access-gate'
import AdminPage from '@/pages/admin-page'
import BadgeRegistrationPage from '@/pages/badge-registration-page'
import DeviceLoginPage from '@/pages/device-login-page'
import DeviceRegistrationPage from '@/pages/device-registration-page'
import HomePage from '@/pages/home-page'
import NotFoundPage from '@/pages/not-found-page'

/**
 * Real pathname routing on one origin, split by SECURITY REALM.
 *
 * `/admin` and `/device-login` are matched first and rendered outside the
 * event shell. Each is its own security realm: Admin has its own gate, device
 * sign-in has its own session, and neither may require Operator Access or
 * mount the offline registration workflow.
 *
 * Event routes are authorized PER MODULE, because the answer differs:
 *
 *   /                      a device grant OR Operator Access
 *   /badge-registration    device Registration authority OR Operator Access
 *   /device-registration   OPERATOR ONLY
 *
 * The last one is deliberate. A signed device lease must not unlock the page
 * that rewrites this browser's own transitional Phase 7 identity — the very
 * identity the lease's badge checks are measured against. Phase D converges
 * them; until then it keeps its own gate.
 *
 * Every event route shares one EventAppGate, so the database gate, the
 * authorization provider and SyncManager mount once and survive navigation
 * between pages rather than restarting per route.
 *
 * Not Found sits outside both, so a mistyped path never demands a credential
 * and never quietly falls through to a workflow.
 */
const AppRouter: React.FC = () => {
  return (
    <Switch>
      <Route path={ROUTES.admin}>
        <AdminPage />
      </Route>

      <Route path={ROUTES.deviceLogin}>
        <DeviceLoginPage />
      </Route>

      <Route path={EVENT_ROUTE_PATTERN}>
        <EventAppGate>
          <Switch>
            <Route path={ROUTES.home}>
              <EventAccessGate module="home">
                <HomePage />
              </EventAccessGate>
            </Route>

            <Route path={ROUTES.badgeRegistration}>
              <EventAccessGate module="registration">
                <BadgeRegistrationPage />
              </EventAccessGate>
            </Route>

            {/* Operator ONLY: a device lease never unlocks the page that
                rewrites this browser's own local device identity. */}
            <Route path={ROUTES.deviceRegistration}>
              <OperatorAccessGate>
                <DeviceRegistrationPage />
              </OperatorAccessGate>
            </Route>
          </Switch>
        </EventAppGate>
      </Route>

      <Route>
        <NotFoundPage />
      </Route>
    </Switch>
  )
}

export default AppRouter
