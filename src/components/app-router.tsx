import type * as React from 'react'
import { Route, Switch } from 'wouter'

import { ROUTES } from '@/app/routes'
import BadgeRegistrationPage from '@/pages/badge-registration-page'
import DeviceRegistrationPage from '@/pages/device-registration-page'
import HomePage from '@/pages/home-page'
import NotFoundPage from '@/pages/not-found-page'

/**
 * Real pathname routing on one origin.
 *
 * Mounted INSIDE DatabaseGate, so every page is free to read the local
 * database. SyncManager deliberately sits OUTSIDE this router: a pending
 * registration must keep draining while the operator is on Home, on Device
 * Registration, or on any future module.
 *
 * `Switch` renders the first match only, and the trailing bare `Route` is the
 * catch-all — an unknown path renders Not Found rather than quietly falling
 * through to a workflow.
 */
const AppRouter: React.FC = () => {
  return (
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

      <Route>
        <NotFoundPage />
      </Route>
    </Switch>
  )
}

export default AppRouter
