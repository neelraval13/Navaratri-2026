import { useSyncExternalStore } from 'react'

import {
  getAdminAccess,
  subscribeAdminAccess,
  type AdminAccessState,
} from '@/admin/admin-access-store'

/** Admin access state, from the one store the admin layer writes to. */
export const useAdminAccess = (): AdminAccessState => {
  return useSyncExternalStore(subscribeAdminAccess, getAdminAccess, getAdminAccess)
}
