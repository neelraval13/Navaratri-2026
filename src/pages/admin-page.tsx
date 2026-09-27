import { LogOut } from 'lucide-react'
import type * as React from 'react'

import { adminLogout } from '@/admin/admin-api'
import AdminAccessGate from '@/components/admin/admin-access-gate'
import AdminControlPlane from '@/components/admin/admin-control-plane'
import { Button } from '@/components/ui/button'
import { useAdminAccess } from '@/hooks/use-admin-access'

/**
 * The Admin control plane.
 *
 * Deliberately NOT an event-operation module: it manages the central device
 * registry, never attendees. It is online-only and lives in its own security
 * realm.
 */
const AdminPage: React.FC = () => {
  const access = useAdminAccess()

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Navaratri 2026
          </p>

          <h1 className="font-heading text-3xl font-semibold sm:text-4xl">
            Admin
          </h1>
        </div>

        {access.phase === 'authenticated' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void adminLogout()
            }}
          >
            <LogOut data-icon="inline-start" />
            Sign out
          </Button>
        ) : null}
      </div>

      <AdminAccessGate>
        <AdminControlPlane />
      </AdminAccessGate>
    </div>
  )
}

export default AdminPage
