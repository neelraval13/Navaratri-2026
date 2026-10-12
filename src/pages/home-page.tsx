import { ArrowRight, IdCard, Music, Trophy, Users } from 'lucide-react'
import type * as React from 'react'
import { Link } from 'wouter'

import { ROUTES } from '@/app/routes'
import DeviceReadiness from '@/components/device/device-readiness'
import { Badge } from '@/components/ui/badge'
import { isDeviceRegistered } from '@/db/device'
import { useDeviceEventAuthorization } from '@/device-auth/device-event-authorization-context'
import { useEventConfig } from '@/hooks/use-event-config'
import type { DeviceAttribute } from '@/shared/device-attributes'
import { cn } from '@/lib/utils'

/**
 * Why a card cannot be opened.
 *
 *   coming-soon    the module does not exist yet
 *   not-permitted  it exists, and this Device was not granted it
 *
 * Two different facts, so two different labels. Telling a prize volunteer
 * that Badge Registration is "Coming soon" would be a lie, and telling them
 * nothing at all would send them into a screen that refuses them.
 */
type ModuleAccess =
  /** Built, granted to this Device, and openable. */
  | { kind: 'available'; href: string }
  /** Built, but this Device was not granted it. */
  | { kind: 'not-permitted' }
  /** Does not exist yet. */
  | { kind: 'coming-soon' }

interface ModuleCardProps {
  icon: React.ReactNode
  title: string
  description: string
  /**
   * The destination travels WITH the verdict, so an openable card without a
   * route and an inert card that still carries one are both unrepresentable
   * rather than merely unlikely.
   */
  access: ModuleAccess
}

/**
 * Two different facts, so two different labels. Telling a prize volunteer
 * that Badge Registration is "Coming soon" would be a lie, and saying nothing
 * at all would send them into a screen that refuses them.
 */
const INERT_LABEL = {
  'coming-soon': 'Coming soon',
  'not-permitted': 'Not on this device',
} as const

/**
 * One operations module. Only an `available` card navigates — the other two
 * render no link at all, so neither can be opened by a tap or by a keyboard.
 */
const ModuleCard: React.FC<ModuleCardProps> = ({
  icon,
  title,
  description,
  access,
}) => {
  const body = (
    <>
      <div className="flex items-start justify-between gap-4">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border',
            access.kind === 'available' ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {icon}
        </span>

        {access.kind === 'available' ? (
          <ArrowRight className="mt-3 size-5 shrink-0 text-muted-foreground transition-transform group-hover/module:translate-x-0.5" />
        ) : (
          <Badge variant="secondary">
            {INERT_LABEL[access.kind]}
          </Badge>
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

  if (access.kind !== 'available') {
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
      href={access.href}
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
 * ATTRIBUTE-AWARE. Home renders only for a device that holds at least one
 * capability, and each card reflects whether THIS device holds the one its
 * module needs. The attributes are INDEPENDENT: `prizes` does not offer
 * Attendees and `registration` does not either, because the prize desk lists
 * attendees as part of awarding a prize while the standalone directory is
 * separately granted.
 *
 * The card is still not the security boundary — every module authorizes
 * itself at its own route, and `/badge-registration`, `/prizes`,
 * `/attendees` and `/dandiya` each refuse a device that lacks their attribute
 * whatever Home drew. What this avoids is inviting a volunteer into a screen
 * that will turn them away.
 *
 * Since Phase D3 every card is a real module: there is no `coming-soon` card
 * left, and the state survives only because the next module to be designed
 * will need it again.
 *
 * The grant comes from the ONE provider that already owns the session check.
 * Home performs no request of its own, and an absent grant simply means
 * nothing is offered — it never means everything is.
 *
 * The device line here is STATIC generic identity only. It names the device,
 * never whether it distributes badges, and never `nextBadge`, remaining or
 * the pending queue — Home holds its own configuration instance and would
 * show those stale. They live in Device Readiness, which reads fresh from
 * IndexedDB every time it is opened.
 */
const HomePage: React.FC = () => {
  const eventConfig = useEventConfig()
  const device = useDeviceEventAuthorization()

  const registered =
    eventConfig.config !== null && isDeviceRegistered(eventConfig.config)
      ? eventConfig.config
      : null

  const moduleAccess = (attribute: DeviceAttribute, href: string): ModuleAccess =>
    device.grant !== null && device.grant.attributes.includes(attribute)
      ? { kind: 'available', href }
      : { kind: 'not-permitted' }

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
          access={moduleAccess('registration', ROUTES.badgeRegistration)}
        />

        <ModuleCard
          icon={<Users className="size-5" />}
          title="Attendees"
          description="Read-only directory of everyone registered for the event."
          access={moduleAccess('attendees', ROUTES.attendees)}
        />

        <ModuleCard
          icon={<Trophy className="size-5" />}
          title="Prizes"
          description="Award prizes to registered attendees and review what has been given."
          access={moduleAccess('prizes', ROUTES.prizes)}
        />

        <ModuleCard
          icon={<Music className="size-5" />}
          title="Dandiya"
          description="Issue a dandiya pair to two attendees, and take it back."
          access={moduleAccess('dandiya', ROUTES.dandiya)}
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
