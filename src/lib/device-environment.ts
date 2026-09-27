export type ServiceWorkerReadiness = 'active' | 'not-controlling' | 'unsupported'

export type DisplayModeReadiness = 'standalone' | 'browser'

export type PersistentStorageReadiness = 'granted' | 'not-granted' | 'unsupported'

export interface DeviceEnvironment {
  network: 'online' | 'offline'
  serviceWorker: ServiceWorkerReadiness
  displayMode: DisplayModeReadiness
  persistentStorage: PersistentStorageReadiness
}

const readServiceWorker = (): ServiceWorkerReadiness => {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) {
    return 'unsupported'
  }

  // Whether THIS page is controlled. A registered-but-not-controlling worker
  // means the page was loaded before the worker took over.
  return navigator.serviceWorker.controller === null ? 'not-controlling' : 'active'
}

/**
 * iOS Safari historically reports installed state through `navigator.standalone`
 * rather than the display-mode media query, so it is consulted as a fallback
 * only.
 */
const readDisplayMode = (): DisplayModeReadiness => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return 'standalone'
    }
  }

  const legacyStandalone = (
    globalThis.navigator as Navigator & { standalone?: boolean } | undefined
  )?.standalone

  return legacyStandalone === true ? 'standalone' : 'browser'
}

const readPersistentStorage = async (): Promise<PersistentStorageReadiness> => {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage

  if (storage === undefined || typeof storage.persisted !== 'function') {
    return 'unsupported'
  }

  try {
    return (await storage.persisted()) ? 'granted' : 'not-granted'
  } catch {
    // A browser that refuses to answer is reported as unsupported, never as a
    // problem with the stored data.
    return 'unsupported'
  }
}

/**
 * Reads browser and installation state for the readiness panel.
 *
 * STRICTLY READ ONLY. It never calls `navigator.storage.persist()`, never
 * registers, updates or replaces a service worker, and never calls
 * `skipWaiting`. StorageManager owns the one persistence request per session;
 * this must not duplicate or fight it.
 */
export const readDeviceEnvironment = async (): Promise<DeviceEnvironment> => {
  return {
    network:
      typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'offline'
        : 'online',
    serviceWorker: readServiceWorker(),
    displayMode: readDisplayMode(),
    persistentStorage: await readPersistentStorage(),
  }
}
