/**
 * Passthrough stand-in for the device event authorization provider.
 *
 * The real one performs a session check in an effect; under server rendering
 * no effect runs and no network exists. Route suites drive the grant through
 * `fake-device-authorization.mjs` instead.
 */
import { createElement, Fragment } from 'react'

const DeviceEventAuthorizationProvider = ({ children }) =>
  createElement(Fragment, null, children)

export default DeviceEventAuthorizationProvider
