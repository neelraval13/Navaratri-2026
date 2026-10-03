/**
 * Stand-in for the device event authorization CONTEXT.
 *
 * The real provider settles in an effect, and effects do not run under server
 * rendering, so the gate would render its "checking" state forever. These
 * suites test ROUTE POLICY — which authority opens which module — so the
 * grant is supplied directly and the provider's own lifecycle is covered by
 * its unit tests instead.
 *
 * It defaults to NO grant, which is exactly how a legacy browser behaves:
 * every event route falls back to Operator Access.
 */
export const state = {
  isChecking: false,
  grant: null,
  config: undefined,
  enrollment: undefined,
  deviceName: null,
  isRefreshing: false,
}

export const reset = () => {
  state.isChecking = false
  state.grant = null
  state.config = undefined
  state.enrollment = undefined
  state.deviceName = null
  state.isRefreshing = false
}

export const useDeviceEventAuthorization = () => ({ ...state, refresh: () => undefined })

/** The real provider is aliased away, so this is never rendered. */
export const DeviceEventAuthorizationContext = {
  Provider: ({ children }) => children,
}
