import { registerSW } from 'virtual:pwa-register'

/**
 * Registers the generated service worker.
 *
 * Offline support is a resilience enhancement, never a prerequisite: every
 * failure path here only logs, so a browser without service workers, a blocked
 * registration or an insecure origin can never stop registration from loading.
 *
 * Nothing in here reloads the page. A newly downloaded version stays waiting and
 * takes over once every tab is closed, so an operator mid-registration is never
 * interrupted.
 */
export const registerServiceWorker = (): void => {
  try {
    registerSW({
      immediate: true,
      onOfflineReady() {
        console.info(
          'Navaratri: the application is cached and will open without a network.',
        )
      },
      onNeedRefresh() {
        // Passive by design: no prompt, no reload. The update applies the next
        // time the application is opened fresh.
        console.info(
          'Navaratri: a new version is ready and will be used after all tabs are closed.',
        )
      },
      onRegisterError(error: unknown) {
        console.error('Navaratri: service worker registration failed.', error)
      },
    })
  } catch (error: unknown) {
    console.error('Navaratri: service worker registration failed.', error)
  }
}
