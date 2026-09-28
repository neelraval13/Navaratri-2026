import { CircleAlert } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/**
 * An unknown client route. It deliberately renders nothing operational — a
 * mistyped path must never quietly land on the registration workflow.
 */
const NotFoundPage: React.FC = () => {
  return (
    <Card>
      <CardContent className="space-y-4 text-center">
        <p className="flex items-center justify-center gap-2 font-semibold">
          <CircleAlert className="size-5 text-muted-foreground" />
          Page not found
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          That address does not match any part of this application.
        </p>

        {/* A real link with the button's appearance — see device-login-page. */}
        <Link
          href={ROUTES.home}
          className={buttonVariants({ variant: 'outline', className: 'h-12 sm:min-w-32' })}
        >
          Back to Home
        </Link>
      </CardContent>
    </Card>
  )
}

export default NotFoundPage
