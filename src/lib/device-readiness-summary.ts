import { formatBadgeRange } from '@/db/device'
import type { LocalReadiness } from '@/db/readiness'
import { formatBadgeNumber } from '@/lib/badge'
import type { DeviceEnvironment } from '@/lib/device-environment'

export interface ReadinessSnapshot {
  local: LocalReadiness
  environment: DeviceEnvironment
}

export type ReadinessTone = 'good' | 'warning' | 'attention' | 'neutral'

export interface ReadinessLabel {
  value: string
  tone: ReadinessTone
  hint?: string
}

export const SERVICE_WORKER_LABELS: Record<
  DeviceEnvironment['serviceWorker'],
  ReadinessLabel
> = {
  active: { value: 'Active', tone: 'good' },
  'not-controlling': {
    value: 'Not controlling this page',
    tone: 'warning',
    hint: 'Reopen the app to let the worker take over.',
  },
  unsupported: { value: 'Unsupported', tone: 'warning' },
}

export const DISPLAY_MODE_LABELS: Record<
  DeviceEnvironment['displayMode'],
  ReadinessLabel
> = {
  standalone: { value: 'Installed / standalone', tone: 'good' },
  browser: {
    value: 'Browser mode',
    tone: 'warning',
    hint: 'Install this app on the event device before opening registration.',
  },
}

export const PERSISTENCE_LABELS: Record<
  DeviceEnvironment['persistentStorage'],
  ReadinessLabel
> = {
  granted: { value: 'Granted', tone: 'good' },
  'not-granted': {
    value: 'Not granted',
    tone: 'warning',
    hint: 'Storage may be evicted under pressure. Keep pending sync low.',
  },
  unsupported: { value: 'Unsupported', tone: 'warning' },
}

const environmentLines = (environment: DeviceEnvironment): string[] => {
  return [
    `Network: ${environment.network === 'online' ? 'Online' : 'Offline'}`,
    `PWA: ${DISPLAY_MODE_LABELS[environment.displayMode].value}`,
    `Persistent Storage: ${PERSISTENCE_LABELS[environment.persistentStorage].value}`,
    `Service Worker: ${SERVICE_WORKER_LABELS[environment.serviceWorker].value}`,
  ]
}

/**
 * The clipboard summary for the Device Range Plan.
 *
 * Counts and capability states ONLY. It carries no attendee name, phone, age
 * or badge assignment, and no access code, session, cookie or credential — it
 * is written down on paper and passed around while provisioning.
 */
export const buildDeviceSummary = (snapshot: ReadinessSnapshot): string => {
  const { local, environment } = snapshot

  if (!local.ok) {
    return [
      'Navaratri 2026',
      'Device: NOT REGISTERED',
      `Completed: ${String(local.counts.completed)}`,
      `Held: ${String(local.counts.held)}`,
      `Pending Sync: ${String(local.counts.pendingSync)}`,
      ...environmentLines(environment),
    ].join('\n')
  }

  const badge = local.badgeDistribution

  return [
    'Navaratri 2026',
    `Device: ${local.device.deviceName}`,
    `Device ID: ${local.device.deviceId}`,
    ...(badge.configured
      ? [
          'Badge Distribution: Configured',
          `Badge Range: ${formatBadgeRange(badge.badgeStart, badge.badgeEnd)}`,
          `Next Badge: ${formatBadgeNumber(badge.nextBadge)}`,
          `Remaining: ${String(badge.remaining)}`,
        ]
      : ['Badge Distribution: Not configured']),
    `Completed: ${String(local.counts.completed)}`,
    `Held: ${String(local.counts.held)}`,
    `Pending Sync: ${String(local.counts.pendingSync)}`,
    ...environmentLines(environment),
  ].join('\n')
}
