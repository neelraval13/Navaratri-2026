import { ArrowRight, IdCard, Music, Trophy } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import DeviceReadiness from '@/components/device/device-readiness'
import { Badge } from '@/components/ui/badge'
import { isDeviceRegistered } from '@/db/device'
import { useEventConfig } from '@/hooks/use-event-config'
import { cn } from '@/lib/utils'

interface ModuleCardProps {
  icon: React.ReactNode
  title: string
  description: string
  href?: string
}

/**
 * One operations module. A module without an `href` is not yet built and is
 * deliberately inert — it renders no link, so it cannot navigate anywhere.
 */
const ModuleCard: React.FC<ModuleCardProps> = ({
  icon,
  title,
  description,
  href,
}) => {
  const body = (
    <>
      <div className="flex items-start justify-between gap-4">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border',
            href === undefined ? 'text-muted-foreground' : 'text-primary',
          )}
        >
          {icon}
        </span>

        {href === undefined ? (
          <Badge variant="secondary">
            Coming soon
          </Badge>
        ) : (
          <ArrowRight className="mt-3 size-5 shrink-0 text-muted-foreground transition-transform group-hover/module:translate-x-0.5" />
        )}
      </div>

      <div className="space-y-1">
        <h2 className="font-heading text-xl font-semibold">
          {title}
        </h2>

        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </>
  )

  const shell =
    'flex min-h-44 flex-col justify-between gap-6 rounded-3xl border border-border bg-card p-6'

  if (href === undefined) {
    return (
      <div
        aria-disabled="true"
        className={cn(shell, 'opacity-60')}
      >
        {body}
      </div>
    )
  }

  return (
    <Link
      href={href}
      className={cn(
        shell,
        'group/module outline-none transition-colors hover:border-primary/50 focus-visible:ring-3 focus-visible:ring-ring/50',
      )}
    >
      {body}
    </Link>
  )
}

/**
 * The module launcher.
 *
 * The device line here is STATIC generic identity only. It names the device,
 * never whether it distributes badges, and never `nextBadge`, remaining or
 * the pending queue — Home holds its own configuration instance and would
 * show those stale. They live in Device Readiness, which reads fresh from
 * IndexedDB every time it is opened.
 *
 * Since Phase D2 this page renders only for a browser whose identity IS the
 * signed-in central device, so the identity is always present. It is still
 * read defensively rather than asserted.
 */
const HomePage: React.FC = () => {
  const eventConfig = useEventConfig()

  const registered =
    eventConfig.config !== null && isDeviceRegistered(eventConfig.config)
      ? eventConfig.config
      : null

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Navaratri 2026
        </p>

        <h1 className="font-heading text-3xl font-semibold sm:text-4xl">
          Event Operations
        </h1>

        {/*
          GENERIC device identity only. It deliberately says nothing about
          badges: a prize or dandiya desk is a real central device and owns
          none. Device Readiness sits beside it because retiring the old
          device page left no other way to open the read-only diagnostics.
        */}
        {eventConfig.status !== 'loaded' || registered === null ? null : (
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {registered.deviceName}
              </span>
              {' · Central device'}
            </p>

            <DeviceReadiness />
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModuleCard
          icon={<IdCard className="size-5" />}
          title="Badge Registration"
          description="Register attendees, manage holds, payment and badge issuance."
          href={ROUTES.badgeRegistration}
        />

        <ModuleCard
          icon={<Music className="size-5" />}
          title="Dandiya"
          description="Dandiya operations for the event."
        />

        <ModuleCard
          icon={<Trophy className="size-5" />}
          title="Prizes"
          description="Prize allocation and handover."
        />
      </div>

      {/* Deliberately subtle links, not module cards: neither is an event
          operation. Admin is a control plane, and Device Sign-In is where
          this browser's central identity, badge range and sign-out live. */}
      <p className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <Link
          href={ROUTES.deviceLogin}
          className="underline-offset-4 hover:underline"
        >
          Device Sign-In
        </Link>

        <Link
          href={ROUTES.admin}
          className="underline-offset-4 hover:underline"
        >
          Admin
        </Link>
      </p>
    </div>
  )
}

export default HomePage
