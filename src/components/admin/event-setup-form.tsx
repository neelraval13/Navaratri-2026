import { CircleAlert, Save } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { createEvent, type AdminEvent } from '@/admin/admin-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CURRENT_EVENT_SLUG } from '@/shared/event'

interface EventSetupFormProps {
  onCreated: (event: AdminEvent) => void
}

/**
 * Creates the first central event.
 *
 * The values below are UI defaults an operator can change, not a database
 * seed: nothing creates an event automatically anywhere, and the server
 * validates whatever is submitted.
 */
const EventSetupForm: React.FC<EventSetupFormProps> = ({ onCreated }) => {
  const [name, setName] = useState('Navaratri 2026')
  // The slug this build is wired to, so Admin and the device login agree.
  const [slug, setSlug] = useState(CURRENT_EVENT_SLUG)
  const [timezone, setTimezone] = useState('Asia/Kolkata')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (submitEvent: React.FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()

    if (isSaving) {
      return
    }

    setIsSaving(true)
    setError(null)

    const result = await createEvent({ name, slug, timezone })

    setIsSaving(false)

    if (result.ok) {
      onCreated(result.value)

      return
    }

    setError(result.message)
  }

  return (
    <form
      onSubmit={(submitEvent) => {
        void handleSubmit(submitEvent)
      }}
      className="space-y-6"
    >
      <div className="space-y-2">
        <Label htmlFor="event-name">
          Event name
        </Label>

        <Input
          id="event-name"
          value={name}
          onChange={(changeEvent) => {
            setName(changeEvent.target.value)
          }}
          className="h-12"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="event-slug">
          Slug
        </Label>

        <Input
          id="event-slug"
          value={slug}
          onChange={(changeEvent) => {
            setSlug(changeEvent.target.value)
          }}
          className="h-12"
        />

        <p className="text-xs text-muted-foreground">
          Lowercase letters, numbers and single hyphens.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="event-timezone">
          Timezone
        </Label>

        <Input
          id="event-timezone"
          value={timezone}
          onChange={(changeEvent) => {
            setTimezone(changeEvent.target.value)
          }}
          className="h-12"
        />

        <p className="text-xs text-muted-foreground">
          An IANA timezone, for example Asia/Kolkata.
        </p>
      </div>

      {error === null ? null : (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSaving}
        className="h-12 w-full sm:w-auto sm:min-w-48"
      >
        <Save data-icon="inline-start" />
        {isSaving ? 'Creating…' : 'Create Event'}
      </Button>
    </form>
  )
}

export default EventSetupForm
