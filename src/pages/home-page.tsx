import { ArrowRight, IdCard, MonitorSmartphone, Music, Trophy } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
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
 * Any device line here is STATIC generic identity only. It shows whether the
 * hardware is registered, never whether it distributes badges, and never
 * `nextBadge`, remaining or the pending queue — Home holds its own
 * configuration instance and would show those stale. They live in Device
 * Readiness, which reads fresh.
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
          badges: "registered" must never be read as "distributes badges",
          because a prize or dandiya desk is registered and owns none.
        */}
        {eventConfig.status !== 'loaded' ? null : registered === null ? (
          <p className="text-sm text-muted-foreground">
            Device not registered ·{' '}
            <Link
              href={ROUTES.deviceRegistration}
              className="text-primary underline-offset-4 hover:underline"
            >
              Register this device
            </Link>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {registered.deviceName}
            </span>
            {' · Registered'}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModuleCard
          icon={<IdCard className="size-5" />}
          title="Badge Registration"
          description="Register attendees, manage holds, payment and badge issuance."
          href={ROUTES.badgeRegistration}
        />

        {/*
          Two device routes, deliberately named for what they each do. Device
          Registration is the transitional LOCAL badge-device setup this desk
          already runs on; Device Sign-In is the CENTRAL identity, which
          authorizes nothing here yet.
        */}
        <ModuleCard
          icon={<MonitorSmartphone className="size-5" />}
          title="Device Registration"
          description="Configure this event device locally and verify operational readiness."
          href={ROUTES.deviceRegistration}
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
          operation. Admin is a control plane, and Device Sign-In identifies
          this browser centrally without unlocking anything here. */}
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
