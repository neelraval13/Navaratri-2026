import { CircleAlert, RotateCcw } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface EventConfigGateProps {
  status: 'loading' | 'failed'
  onRetry: () => void
}

/**
 * Shown instead of the registration form while the authoritative event
 * configuration is unavailable.
 *
 * The badge number comes from that configuration, so registration must not run
 * without it rather than display a guessed number.
 */
const EventConfigGate: React.FC<EventConfigGateProps> = ({
  status,
  onRetry,
}) => {
  if (status === 'loading') {
    return (
      <Card>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Loading event configuration…
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-4 text-center">
        <p className="flex items-center justify-center gap-2 font-semibold text-destructive">
          <CircleAlert className="size-5" />
          Event configuration unavailable
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Registration cannot start without the current badge number. Nothing
          has been changed or deleted.
        </p>

        <Button
          type="button"
          variant="outline"
          className="h-12 sm:min-w-32"
          onClick={onRetry}
        >
          <RotateCcw data-icon="inline-start" />
          Retry
        </Button>
      </CardContent>
    </Card>
  )
}

export default EventConfigGate
