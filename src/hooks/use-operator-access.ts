import { useSyncExternalStore } from 'react'

import {
  getOperatorAccess,
  subscribeOperatorAccess,
  type OperatorAccessState,
} from '@/auth/operator-access-store'

/** Operator access state, from the one store the auth layer writes to. */
export const useOperatorAccess = (): OperatorAccessState => {
  return useSyncExternalStore(
    subscribeOperatorAccess,
    getOperatorAccess,
    getOperatorAccess,
  )
}
