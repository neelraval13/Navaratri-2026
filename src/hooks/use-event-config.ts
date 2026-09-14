import { useCallback, useEffect, useState } from 'react'

import { readEventConfig } from '@/db/event-config'
import type { EventConfig } from '@/db/types'

export type EventConfigStatus = 'loading' | 'loaded' | 'failed'

export interface EventConfigState {
  status: EventConfigStatus
  /** Only non-null when status is 'loaded'. */
  config: EventConfig | null
  /** Replaces the local snapshot after a write that changed the stored row. */
  applyConfig: (config: EventConfig) => void
  reload: () => void
}

/**
 * A settled read, tagged with the attempt it answered.
 */
interface SettledConfig {
  attempt: number
  status: 'loaded' | 'failed'
  config: EventConfig | null
}

/**
 * Loads the authoritative event configuration.
 *
 * `DatabaseGate` has already completed bootstrap before anything using this
 * mounts, so this only reads — it never bootstraps. A missing row is treated as
 * a failure rather than an empty default: the registration UI must never
 * pretend a badge number is current while the configuration is unavailable.
 *
 * `applyConfig` lets a write that already returned the authoritative stored row
 * refresh the snapshot without a second read, so the displayed badge number can
 * never be recomputed independently and drift from IndexedDB.
 */
export const useEventConfig = (): EventConfigState => {
  const [settled, setSettled] = useState<SettledConfig | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    readEventConfig()
      .then((config) => {
        if (cancelled) {
          return
        }

        setSettled(
          config === undefined
            ? { attempt, status: 'failed', config: null }
            : { attempt, status: 'loaded', config },
        )
      })
      .catch((error: unknown) => {
        console.error('Navaratri: reading event configuration failed.', error)

        if (cancelled) {
          return
        }

        setSettled({ attempt, status: 'failed', config: null })
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1)
  }, [])

  const applyConfig = useCallback(
    (config: EventConfig) => {
      setSettled({ attempt, status: 'loaded', config })
    },
    [attempt],
  )

  /**
   * Derived rather than synced, so a reload falls straight back to loading
   * without an extra render pass.
   */
  const isCurrent = settled !== null && settled.attempt === attempt

  if (!isCurrent) {
    return { status: 'loading', config: null, applyConfig, reload }
  }

  return {
    status: settled.status,
    config: settled.config,
    applyConfig,
    reload,
  }
}
