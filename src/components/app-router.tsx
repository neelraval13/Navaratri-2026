import type * as React from 'react'
import { Route, Switch } from 'wouter'

import { EVENT_ROUTE_PATTERN, ROUTES } from '@/app/routes'
import EventAppGate from '@/components/event-app-gate'
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
 * `/device-login` unlocks no event route. Holding a device session does not
 * open `/badge-registration`, and event routes keep answering to Operator
 * Access until the offline device bridge exists.
 *
 * Every event route shares one EventAppGate, so Operator Access, the database
 * gate and SyncManager mount once and survive navigation between pages rather
 * than restarting per route.
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
              <HomePage />
            </Route>

            <Route path={ROUTES.badgeRegistration}>
              <BadgeRegistrationPage />
            </Route>

            <Route path={ROUTES.deviceRegistration}>
              <DeviceRegistrationPage />
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
