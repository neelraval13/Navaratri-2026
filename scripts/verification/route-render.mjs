/**
 * Renders the real router at a given path with react-dom/server, so route
 * resolution and the device gates are genuinely exercised rather than grepped.
 *
 * The registration form is stubbed with a marker: this harness verifies which
 * page a path resolves to, not the workflow inside it.
 */
import { createJiti } from 'jiti'
import { resolve } from 'node:path'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')

const jiti = createJiti(import.meta.url, {
  alias: {
    '@/hooks/use-event-config': `${HERE}/fake-event-config.mjs`,
    '@/components/registration/registration-form': `${HERE}/fake-registration-form.mjs`,
    '@/db/database': `${HERE}/fake-db.mjs`,
    '@/components/database-gate': `${HERE}/fake-database-gate.mjs`,
    '@/hooks/use-network-status': `${HERE}/fake-network-status.mjs`,
    '@/device-auth/device-event-authorization-context': `${HERE}/fake-device-authorization.mjs`,
    '@/components/device-auth/device-event-authorization-provider':
      `${HERE}/fake-device-authorization-provider.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
  jsx: { runtime: 'automatic' },
})

const React = await jiti.import('react')
const { renderToStaticMarkup } = await jiti.import('react-dom/server')
const { Router } = await jiti.import('wouter')
const { state } = await jiti.import(`${HERE}/fake-event-config.mjs`)
const adminStore = await jiti.import(`${root}/src/admin/admin-access-store.ts`)
const deviceAuthorization = await jiti.import(`${HERE}/fake-device-authorization.mjs`)

/**
 * Drives DEVICE event authority, which since Phase D2 is the ONLY event
 * authority there is: no operator store to set, and nothing else a route
 * could accept instead.
 */
export const setDeviceGrant = (grant, extra = {}) => {
  deviceAuthorization.reset()
  deviceAuthorization.state.grant = grant
  Object.assign(deviceAuthorization.state, extra)
}

export const clearDeviceGrant = () => {
  deviceAuthorization.reset()
}

const AppRouterMod = await jiti.import(`${root}/src/components/app-router.tsx`)

/** Drives the admin realm for route tests, from the same module instance. */
export const setAdminAccess = (phase, reason = null) => {
  adminStore.setAdminAccess({ phase, reason })
}
const AppRouter = AppRouterMod.default ?? AppRouterMod

export const renderRoute = (path, config = null, status = 'loaded') => {
  state.status = status
  state.config = config
  // `ssrPath` is wouter's documented server-rendering entry point; it needs
  // no location hook and gives the tree a stable snapshot.
  try {
    return {
      html: renderToStaticMarkup(
        React.createElement(Router, { ssrPath: path }, React.createElement(AppRouter)),
      ),
    }
  } catch (error) {
    return { html: '', error: error.message.split('\n')[0] }
  }
}

const networkStatus = await jiti.import(`${HERE}/fake-network-status.mjs`)

/**
 * Connectivity, driven explicitly. Node's own `navigator` has no `onLine`,
 * so the real hook would read `undefined` and every route test would render
 * the OFFLINE copy by accident.
 */
export const setNetworkStatus = (status) => {
  networkStatus.state.status = status
}

/** Every href the rendered page offers, in order. */
export const hrefsIn = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
