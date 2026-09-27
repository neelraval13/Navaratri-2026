/**
 * Passthrough stand-in for DatabaseGate.
 *
 * The real gate resolves bootstrap in an effect, and effects do not run under
 * server rendering, so it would never reach its children here. These suites
 * test ROUTING and SECURITY REALMS; DatabaseGate's own fail-closed behaviour
 * is covered by the prior-phase suite.
 */
import { createElement, Fragment } from 'react'

const DatabaseGate = ({ children }) => createElement(Fragment, null, children)

export default DatabaseGate
