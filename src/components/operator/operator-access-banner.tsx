import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import OperatorAccessForm from '@/components/operator/operator-access-form'
import { Button } from '@/components/ui/button'
import { useOperatorAccess } from '@/hooks/use-operator-access'

/**
 * Shown when the server has rejected this device's session but the device has
 * been legitimately unlocked before.
 *
 * Amber, not destructive: registration, Hold and Issue Badge all keep working
 * locally. Only synchronization is parked, and every pending row is retained
 * until an unlock releases it.
 */
const OperatorAccessBanner: React.FC = () => {
  const access = useOperatorAccess()
  const [isUnlocking, setIsUnlocking] = useState(false)

  if (access.phase !== 'expired') {
    return null
  }

  return (
    <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-4" />
            Operator session expired — Unlock to resume synchronization
          </p>

          <p className="mt-1 text-sm text-muted-foreground">
            Registration continues normally. Pending records are safe and will
            be sent once you unlock.
          </p>
        </div>

        {isUnlocking ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setIsUnlocking(true)
            }}
          >
            Unlock
          </Button>
        )}
      </div>

      {isUnlocking ? (
        <div className="mt-4 max-w-sm">
          <OperatorAccessForm
            idPrefix="operator-banner"
            autoFocus
          />
        </div>
      ) : null}
    </div>
  )
}

export default OperatorAccessBanner
