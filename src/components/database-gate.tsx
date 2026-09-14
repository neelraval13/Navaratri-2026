import { CircleAlert, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { bootstrapDatabase } from '@/db/bootstrap'

type DatabaseStatus = 'initializing' | 'ready' | 'failed'

/**
 * A settled bootstrap outcome, tagged with the attempt it answered.
 */
interface BootstrapOutcome {
  attempt: number
  status: 'ready' | 'failed'
}

interface DatabaseGateProps {
  children: React.ReactNode
}

/**
 * Registration depends on IndexedDB for duplicate detection, so nothing
 * database-dependent is rendered until `bootstrapDatabase()` has resolved.
 * This is the only place that bootstraps; feature components never do.
 *
 * A failure keeps registration unavailable rather than letting duplicate checks
 * silently fail open. The database is never deleted or recreated — a retry only
 * attempts the same bootstrap again.
 */
const DatabaseGate: React.FC<DatabaseGateProps> = ({ children }) => {
  const [outcome, setOutcome] = useState<BootstrapOutcome | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    bootstrapDatabase()
      .then(() => {
        if (cancelled) {
          return
        }

        setOutcome({ attempt, status: 'ready' })
      })
      .catch((error: unknown) => {
        console.error('Navaratri: local database bootstrap failed.', error)

        if (cancelled) {
          return
        }

        setOutcome({ attempt, status: 'failed' })
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  /**
   * Derived rather than synced, so a retry falls straight back to the
   * initializing state without an extra render pass.
   */
  const status: DatabaseStatus =
    outcome !== null && outcome.attempt === attempt
      ? outcome.status
      : 'initializing'

  if (status === 'ready') {
    return <>{children}</>
  }

  if (status === 'failed') {
    return (
      <Card>
        <CardContent className="space-y-4 text-center">
          <p className="flex items-center justify-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            Unable to prepare registration data
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Registration is unavailable until the local database is ready.
            Nothing has been changed or deleted.
          </p>

          <Button
            type="button"
            variant="outline"
            className="h-12 sm:min-w-32"
            onClick={() => setAttempt((previous) => previous + 1)}
          >
            <RotateCcw data-icon="inline-start" />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent>
        <p className="text-center text-sm text-muted-foreground">
          Preparing registration data…
        </p>
      </CardContent>
    </Card>
  )
}

export default DatabaseGate
