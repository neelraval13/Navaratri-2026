import type * as React from 'react'
import { Redirect, Route, Switch } from 'wouter'

import { EVENT_ROUTE_PATTERN, ROUTES } from '@/app/routes'
import EventAccessGate from '@/components/event-access/event-access-gate'
import EventAppGate from '@/components/event-app-gate'
import AdminPage from '@/pages/admin-page'
import BadgeRegistrationPage from '@/pages/badge-registration-page'
import DeviceLoginPage from '@/pages/device-login-page'
import HomePage from '@/pages/home-page'
import NotFoundPage from '@/pages/not-found-page'

/**
 * Real pathname routing on one origin, split by SECURITY REALM.
 *
 * `/admin` and `/device-login` are matched first and rendered outside the
 * event shell. Each is its own realm: Admin has its own gate, device sign-in
 * has its own session, and neither may mount the offline registration
 * workflow.
 *
 * Event routes are authorized by the CENTRAL DEVICE and nothing else:
 *
 *   /                      a device grant for this event, on a converged browser
 *   /badge-registration    the same, plus Registration authority and a
 *                          badge range that agrees with central
 *
 * `/device-registration` is RETIRED. Phase D2 removed the local provisioning
 * workflow, so the path survives only for old bookmarks and redirects to
 * Device Sign-In — the single supported provisioning path. It is matched
 * before the event pattern and therefore never mounts the event shell, never
 * asks for authority, and cannot write anything.
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

      {/* TRANSITION ONLY. No form, no gate, no writer — just the router. */}
      <Route path={ROUTES.deviceRegistration}>
        <Redirect to={ROUTES.deviceLogin} />
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
