import { createContext, useContext } from 'react'

import type { CentralDeviceEnrollment, EventConfig } from '@/db/types'
import type { DeviceOperationalGrant } from '@/device-auth/event-authorization'

/**
 * The in-memory event access state. NOTHING here is persisted.
 *
 * A grant is authorization, and authorization that survives a reload without
 * being re-established is authorization nobody checked. The signed lease is
 * what persists; the conclusion drawn from it is not.
 */
export interface DeviceEventAuthorizationState {
  /** The first check has not settled; no verdict exists yet. */
  isChecking: boolean
  /** Normalised authority, from a live session or a VERIFIED lease. */
  grant: DeviceOperationalGrant | null
  /** Local facts the authorization rules need, read once per settle. */
  config: EventConfig | undefined
  enrollment: CentralDeviceEnrollment | undefined
  /** The device's display name, for the access banner only. */
  deviceName: string | null
  isRefreshing: boolean
  /** One explicit Device access re-check. Never automatic. */
  refresh: () => void
}

const UNAVAILABLE: DeviceEventAuthorizationState = {
  isChecking: false,
  grant: null,
  config: undefined,
  enrollment: undefined,
  deviceName: null,
  isRefreshing: false,
  refresh: () => undefined,
}

/**
 * Defaults to NO authority, so a component rendered outside the provider can
 * only ever fall back to Operator Access — never accidentally open.
 */
export const DeviceEventAuthorizationContext =
  createContext<DeviceEventAuthorizationState>(UNAVAILABLE)

export const useDeviceEventAuthorization = (): DeviceEventAuthorizationState =>
  useContext(DeviceEventAuthorizationContext)
