import { useEffect } from 'react'
import type * as React from 'react'

import { requestPersistentStorage } from '@/storage/persistence'

/**
 * Asks for persistent storage once, after the database is ready.
 *
 * Mounted under DatabaseGate so the request happens only for a session that
 * actually has a working local store. It renders nothing, blocks nothing and
 * never surfaces a dialog — a refusal is simply the browser's answer, and
 * registration is unaffected either way.
 */
const StorageManager: React.FC = () => {
  useEffect(() => {
    void requestPersistentStorage()
  }, [])

  return null
}

export default StorageManager
