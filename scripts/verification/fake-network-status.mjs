/**
 * Browser connectivity, driven by the suite rather than by `navigator`.
 *
 * Components may be called as plain functions here, so the real hook's
 * `useState`/`useEffect` would need a React render just to answer a question
 * the test already knows the answer to.
 */
export const state = { status: 'online' }

export const useNetworkStatus = () => state.status
