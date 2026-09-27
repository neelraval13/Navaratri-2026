import { CircleAlert } from 'lucide-react'
import { useEffect } from 'react'
import type * as React from 'react'

import { refreshAdminAccess } from '@/admin/admin-api'
import AdminLoginForm from '@/components/admin/admin-login-form'
import { Card, CardContent } from '@/components/ui/card'
import { useAdminAccess } from '@/hooks/use-admin-access'

interface AdminAccessGateProps {
  children: React.ReactNode
}

const UNAVAILABLE_MESSAGES = {
  'not-configured':
    'Admin access is not configured on this deployment. The event application is unaffected.',
  'database-unavailable':
    'The central database is not configured on this deployment. The event application is unaffected.',
  unreachable: 'Could not reach the server. Admin needs a connection.',
}

/**
 * Scoped to `/admin` ONLY. The event application is never wrapped in Admin
 * auth: they are separate security realms, and unlocking one must not unlock
 * the other.
 *
 * Fails closed. Missing Admin or database configuration shows a clear message
 * here and changes nothing about the rest of the app.
 */
const AdminAccessGate: React.FC<AdminAccessGateProps> = ({ children }) => {
  const access = useAdminAccess()

  useEffect(() => {
    void refreshAdminAccess()
  }, [])

  if (access.phase === 'authenticated') {
    return <>{children}</>
  }

  if (access.phase === 'checking') {
    return (
      <Card>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Checking admin access…
          </p>
        </CardContent>
      </Card>
    )
  }

  if (access.phase === 'unavailable') {
    return (
      <Card>
        <CardContent className="space-y-3 text-center">
          <p className="flex items-center justify-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
            <CircleAlert className="size-5" />
            Admin is unavailable
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            {UNAVAILABLE_MESSAGES[access.reason ?? 'unreachable']}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Navaratri 2026
          </p>

          <h1 className="font-heading text-2xl font-semibold">
            Admin Access
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Admin is a separate sign-in from the event desks.
          </p>
        </div>

        <AdminLoginForm />
      </CardContent>
    </Card>
  )
}

export default AdminAccessGate
