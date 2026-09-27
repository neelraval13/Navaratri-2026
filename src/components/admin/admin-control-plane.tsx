import { CircleAlert, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type * as React from 'react'

import {
  fetchDevices,
  fetchEvents,
  type AdminDevice,
  type AdminEvent,
} from '@/admin/admin-api'
import DeviceCard from '@/components/admin/device-card'
import DeviceDialog from '@/components/admin/device-dialog'
import EventSetupForm from '@/components/admin/event-setup-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface LoadedState {
  /** Which fetch produced this, so a refresh in flight can be derived. */
  attempt: number
  eventId: string | null
  events: AdminEvent[]
  devices: AdminDevice[]
  error: string | null
}

/**
 * The central device registry for one event.
 *
 * Online-only by design: this is a control plane, not a desk. Mutable
 * registry data is never cached in IndexedDB, so losing the network shows a
 * retry state rather than stale device records.
 *
 * Mutations update this state from what the SERVER returned, rather than
 * re-fetching the whole registry. That is not optimism — nothing changes here
 * until the server has accepted it — it just means a successful edit repaints
 * one card instead of replacing the screen with a loading state.
 */
const AdminControlPlane: React.FC = () => {
  const [attempt, setAttempt] = useState(0)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedState | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const eventsResult = await fetchEvents()

      if (cancelled) {
        return
      }

      if (!eventsResult.ok) {
        // A failed REFRESH keeps what is already on screen. Only a failed
        // first load has nothing to show.
        setLoaded((previous) => ({
          attempt,
          eventId: previous?.eventId ?? null,
          events: previous?.events ?? [],
          devices: previous?.devices ?? [],
          error: eventsResult.message,
        }))

        return
      }

      const events = eventsResult.value
      // One event selects itself; several offer a choice. Neither is assumed.
      const eventId =
        selectedEventId ?? (events.length === 1 ? events[0].id : null)

      if (eventId === null) {
        setLoaded({ attempt, eventId: null, events, devices: [], error: null })

        return
      }

      const devicesResult = await fetchDevices(eventId)

      if (cancelled) {
        return
      }

      setLoaded((previous) => ({
        attempt,
        eventId,
        events,
        devices: devicesResult.ok ? devicesResult.value : (previous?.devices ?? []),
        error: devicesResult.ok ? null : devicesResult.message,
      }))
    })()

    return () => {
      cancelled = true
    }
  }, [attempt, selectedEventId])

  const refresh = () => {
    setAttempt((previous) => previous + 1)
  }

  /**
   * Server-confirmed local updates. The device the server returned replaces
   * the matching card, or is appended when it is new.
   */
  const upsertDevice = (device: AdminDevice) => {
    setLoaded((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            devices: previous.devices.some((existing) => existing.id === device.id)
              ? previous.devices.map((existing) =>
                  existing.id === device.id ? device : existing,
                )
              : [...previous.devices, device],
          },
    )
  }

  const addEvent = (event: AdminEvent) => {
    setSelectedEventId(event.id)
    setLoaded((previous) => ({
      attempt,
      eventId: event.id,
      events: [...(previous?.events ?? []), event],
      devices: [],
      error: null,
    }))
  }

  if (loaded === null) {
    return (
      <Card>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Loading the central registry…
          </p>
        </CardContent>
      </Card>
    )
  }

  if (loaded.error !== null && loaded.events.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-4 text-center">
          <p className="flex items-center justify-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-5" />
            The registry is unavailable
          </p>

          <p className="text-sm leading-relaxed text-muted-foreground">
            {loaded.error}
          </p>

          <Button
            type="button"
            variant="outline"
            className="h-12 sm:min-w-32"
            onClick={refresh}
          >
            <RotateCcw data-icon="inline-start" />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (loaded.events.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              First run
            </p>

            <h2 className="font-heading text-2xl font-semibold">
              Event Setup
            </h2>

            <p className="text-sm leading-relaxed text-muted-foreground">
              No event exists in the central database yet. Create one to begin
              registering devices.
            </p>
          </div>

          <EventSetupForm onCreated={addEvent} />
        </CardContent>
      </Card>
    )
  }

  const activeEventId =
    selectedEventId ?? (loaded.events.length === 1 ? loaded.events[0].id : null)

  /**
   * Derived, never stored: a state update inside the effect would repaint the
   * screen before the request it describes has even been sent.
   */
  const isFetching = loaded.attempt !== attempt || loaded.eventId !== activeEventId

  /**
   * Switching event is the one case where the loaded devices must NOT stay on
   * screen: they belong to the other event. That is scoped to the device
   * list, not the page.
   */
  const devicesMatchSelection = loaded.eventId === activeEventId

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          Event
        </p>

        {loaded.events.length === 1 ? (
          <p className="font-heading text-xl font-semibold">
            {loaded.events[0].name}
          </p>
        ) : (
          <select
            value={activeEventId ?? ''}
            onChange={(event) => {
              setSelectedEventId(event.target.value === '' ? null : event.target.value)
            }}
            aria-label="Select event"
            className="h-12 w-full rounded-4xl border border-input bg-transparent px-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:max-w-sm"
          >
            <option value="">
              Select an event…
            </option>

            {loaded.events.map((event) => (
              <option
                key={event.id}
                value={event.id}
              >
                {event.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {activeEventId === null ? (
        <p className="text-sm text-muted-foreground">
          Select an event to see its devices.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-heading text-2xl font-semibold">
              Devices
            </h2>

            <div className="flex items-center gap-2">
              {/*
                Refreshing is scoped to this button: the devices already on
                screen stay exactly where they are while it runs.
              */}
              <Button
                type="button"
                variant="outline"
                disabled={isFetching}
                onClick={refresh}
              >
                <RotateCcw data-icon="inline-start" />
                {isFetching ? 'Refreshing…' : 'Refresh'}
              </Button>

              <DeviceDialog
                eventId={activeEventId}
                onSaved={upsertDevice}
              />
            </div>
          </div>

          {loaded.error === null ? null : (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {loaded.error}
            </p>
          )}

          {!devicesMatchSelection || loaded.devices.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-center text-sm text-muted-foreground">
                  {devicesMatchSelection
                    ? 'No devices yet. Add the first one for this event.'
                    : 'Loading devices…'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {loaded.devices.map((device) => (
                <DeviceCard
                  key={device.id}
                  eventId={activeEventId}
                  device={device}
                  onChanged={upsertDevice}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default AdminControlPlane
