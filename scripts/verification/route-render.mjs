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
const operatorStore = await jiti.import(`${root}/src/auth/operator-access-store.ts`)

/** Drives the OPERATOR realm independently, so the two can be tested apart. */
export const setOperatorAccess = (phase, lockReason = null) => {
  operatorStore.setOperatorAccess({ phase, lockReason })
}
const deviceAuthorization = await jiti.import(`${HERE}/fake-device-authorization.mjs`)

/**
 * Drives DEVICE event authority independently of the operator realm, so the
 * two can be proven apart: a device grant must open a module with Operator
 * locked, and a badge conflict must stay blocked with Operator unlocked.
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

/** Every href the rendered page offers, in order. */
export const hrefsIn = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
