export const state = { status: 'loading', config: null, reloads: 0 }
export const useEventConfig = () => ({
  status: state.status, config: state.config,
  applyConfig: () => {}, reload: () => { state.reloads++ },
})
